import { loadRecipe, type RuntimeConfig } from '../config.js';
import type { LLMClient } from './llm.js';
import type { BookState, ChapterPlan, ChapterRecord } from '../memory/schema.js';
import {
  loadBeatSheet,
  loadBookState,
  padChapter,
  recordCost,
  saveBeatSheet,
  saveBookState,
  saveChapterText,
  saveJsonReport,
  writeCheckpoint,
} from '../memory/store.js';
import { generateBeatSheet, generateChapterDraft } from '../pipeline/chapter.js';
import { applyCommitDelta, extractChapterCommit } from '../pipeline/committer.js';
import { runChapterCritic } from '../pipeline/critic.js';
import { formatLintSummary, lintChapterText } from '../pipeline/linter.js';

export interface RunEngineOptions {
  bookId: string;
  toChapter: number;
  runtime: RuntimeConfig;
  llm: LLMClient;
  forceChapter?: number;
  onLog?: (msg: string) => void;
}

export interface RunEngineSummary {
  bookId: string;
  committedChapters: number[];
  suspendedChapter?: number;
  phase: BookState['phase'];
}

export async function runChapterPipeline(
  options: RunEngineOptions,
): Promise<RunEngineSummary> {
  const { bookId, toChapter, runtime, llm, forceChapter, onLog } = options;
  const state = loadBookState(runtime.workspaceDir, bookId);
  const recipe = loadRecipe(state.recipe, runtime.recipesDir);
  const maxRetries = recipe.config.targets.max_rewrite_retries;

  const committedChapters: number[] = [];
  state.phase = 'RUNNING';
  saveBookState(runtime.workspaceDir, state);

  for (let chNum = 1; chNum <= toChapter; chNum++) {
    let record = ensureChapterRecord(state, chNum);

    if (record.status === 'committed' && forceChapter !== chNum) {
      onLog?.(`[第 ${chNum} 章] 已完成 Commit，断点跳过。`);
      continue;
    }

    const plan = resolveChapterPlan(state, chNum);
    onLog?.(`[第 ${chNum} 章] 开始处理：《${plan.title}》`);

    // Step 1: 细纲门禁 (Beat Sheet Gate)
    let beat =
      forceChapter === chNum
        ? undefined
        : loadBeatSheet(runtime.workspaceDir, bookId, chNum);

    if (!beat) {
      onLog?.(`[第 ${chNum} 章] 生成细纲（Beat Gate）...`);
      const beatRes = await generateBeatSheet({
        workspaceDir: runtime.workspaceDir,
        state,
        plan,
        recipe,
        llm,
      });
      beat = beatRes.beat;
      recordCost(state, beatRes.cost);
      saveBeatSheet(runtime.workspaceDir, bookId, beat);
      record.title = beat.title;
      record.status = 'beat_ready';
      record.updated_at = new Date().toISOString();
      saveBookState(runtime.workspaceDir, state);
      writeCheckpoint(runtime.workspaceDir, bookId, chNum, 'beat_ready');
    } else {
      onLog?.(`[第 ${chNum} 章] 复用已有细纲：beat_${padChapter(chNum)}.json`);
    }

    // Step 2 & 3: 正文生成 + 双层质检（代码 Linter + LLM Critic）+ 限次局部重写
    let draft = '';
    let passed = false;
    let rewriteFeedback = '';
    let lastLint = undefined;
    let lastCritic = undefined;
    let attempts = 0;

    for (let retry = 0; retry <= maxRetries; retry++) {
      attempts = retry + 1;
      onLog?.(
        `[第 ${chNum} 章] 生成正文（第 ${attempts}/${maxRetries + 1} 次尝试）...`,
      );

      const draftRes = await generateChapterDraft({
        workspaceDir: runtime.workspaceDir,
        state,
        beat,
        recipe,
        llm,
        rewriteFeedback: rewriteFeedback || undefined,
      });
      draft = draftRes.text;
      recordCost(state, draftRes.cost);

      // Phase 3a: 零 Token 代码 Linter
      const lint = lintChapterText(draft, recipe.antiSlop);
      lastLint = lint;
      saveJsonReport(
        runtime.workspaceDir,
        bookId,
        `ch${padChapter(chNum)}_lint_try${attempts}.json`,
        lint,
      );
      onLog?.(
        `[第 ${chNum} 章] 代码 Linter：${lint.passed ? '通过' : '未通过'}（${lint.score}/10，${lint.metrics.chinese_chars}字，对话${(lint.metrics.dialogue_ratio * 100).toFixed(1)}%）`,
      );

      // Phase 3b: LLM 一致性与番茄读者评审
      const criticRes = await runChapterCritic({
        state,
        beat,
        chapterContent: draft,
        lintResult: lint,
        recipe,
        llm,
      });
      const critic = criticRes.report;
      lastCritic = critic;
      recordCost(state, criticRes.cost);
      saveJsonReport(
        runtime.workspaceDir,
        bookId,
        `ch${padChapter(chNum)}_critic_try${attempts}.json`,
        critic,
      );
      onLog?.(
        `[第 ${chNum} 章] LLM Critic：${critic.pass ? '通过' : '未通过'}（总分 ${critic.overall_score}/10，剧透检测=${critic.truth_leak_detected}）`,
      );

      if (lint.passed && critic.pass) {
        passed = true;
        break;
      }

      // 组装精准重写指令
      const feedbackParts: string[] = [];
      if (!lint.passed) {
        feedbackParts.push(`【必须修复的代码 Linter 硬性问题】\n${formatLintSummary(lint)}`);
      }
      if (!critic.pass) {
        feedbackParts.push(
          `【编辑与读者审校意见（总分 ${critic.overall_score}/10）】\n问题：\n- ${critic.issues.join('\n- ')}\n修改指令：\n- ${critic.rewrite_instructions.join('\n- ')}`,
        );
      }
      rewriteFeedback = feedbackParts.join('\n\n');
      record.retries = retry + 1;
      saveBookState(runtime.workspaceDir, state);
    }

    // 保存最终草稿文本
    const relPath = saveChapterText(
      runtime.workspaceDir,
      bookId,
      chNum,
      beat.title,
      draft,
    );
    record.file_path = relPath;
    record.title = beat.title;
    record.chinese_chars = lastLint?.metrics.chinese_chars;
    record.lint_passed = lastLint?.passed;
    record.critic_score = lastCritic?.overall_score;
    record.updated_at = new Date().toISOString();

    if (!passed) {
      // 超次未过：挂起等待人工审批/修改，不死循环烧 Token
      record.status = 'needs_review';
      record.review_notes = [
        ...(lastLint?.issues.map((i) => `[Linter] ${i.message}`) ?? []),
        ...(lastCritic?.issues.map((i) => `[Critic] ${i}`) ?? []),
      ];
      state.phase = 'NEEDS_REVIEW';
      saveBookState(runtime.workspaceDir, state);
      writeCheckpoint(runtime.workspaceDir, bookId, chNum, 'needs_review', {
        attempts,
        lint_score: lastLint?.score,
        critic_score: lastCritic?.overall_score,
      });
      onLog?.(
        `[第 ${chNum} 章] 超过最大重写次数仍未过门禁，已标记 NEEDS_REVIEW 挂起。请人工修改 ${relPath} 后继续。`,
      );
      return {
        bookId,
        committedChapters,
        suspendedChapter: chNum,
        phase: state.phase,
      };
    }

    // Step 4: Commit 事实抽取与唯一底账回写
    onLog?.(`[第 ${chNum} 章] 质检通过，正在抽取事实并回写 state.json...`);
    const commitRes = await extractChapterCommit({
      state,
      chapterNumber: chNum,
      chapterContent: draft,
      recipe,
      llm,
    });
    recordCost(state, commitRes.cost);
    applyCommitDelta(state, chNum, commitRes.delta);

    record.status = 'committed';
    record.summary = commitRes.delta.chapter_summary;
    record.review_notes = [];
    record.updated_at = new Date().toISOString();
    saveBookState(runtime.workspaceDir, state);

    writeCheckpoint(runtime.workspaceDir, bookId, chNum, 'committed', {
      chars: record.chinese_chars,
      critic_score: record.critic_score,
    });
    committedChapters.push(chNum);
    onLog?.(`[第 ${chNum} 章] Commit 完成！`);
  }

  const allCommitted = state.chapters
    .filter((c) => c.chapter <= toChapter)
    .every((c) => c.status === 'committed');
  if (allCommitted && toChapter >= recipe.config.targets.target_chapters_for_contract) {
    state.phase = 'COMPLETED';
    saveBookState(runtime.workspaceDir, state);
  }

  return {
    bookId,
    committedChapters,
    phase: state.phase,
  };
}

function ensureChapterRecord(state: BookState, chapter: number): ChapterRecord {
  let rec = state.chapters.find((c) => c.chapter === chapter);
  if (!rec) {
    const plan = resolveChapterPlan(state, chapter);
    rec = {
      chapter,
      title: plan.title,
      status: 'planned',
      retries: 0,
      review_notes: [],
      updated_at: new Date().toISOString(),
    };
    state.chapters.push(rec);
    state.chapters.sort((a, b) => a.chapter - b.chapter);
  }
  return rec;
}

function resolveChapterPlan(state: BookState, chapter: number): ChapterPlan {
  const found = state.volume_plan.find((p) => p.chapter === chapter);
  if (found) return found;
  return {
    chapter,
    title: `第${chapter}章`,
    summary: `承接第 ${chapter - 1} 章的悬念与冲突，推动主线与金手指升级。`,
    goal: '制造新的情绪冲突并给出干脆爽点，章末留强钩子。',
    hook_hint: '抛出更高层级的危机或意外反转。',
  };
}
