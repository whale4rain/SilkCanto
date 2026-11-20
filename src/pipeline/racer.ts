import fs from 'node:fs';
import path from 'node:path';
import {
  loadRecipe,
  renderTemplate,
  type RuntimeConfig,
} from '../config.js';
import type { LLMClient } from '../core/llm.js';
import { buildFoundationSummary } from '../memory/context.js';
import {
  RaceJudgeReportSchema,
  type BeatSheet,
  type BookState,
  type CommitDelta,
  type CostRecord,
  type LintResult,
  type RaceJudgeReport,
} from '../memory/schema.js';
import {
  ensureBookDirs,
  getBookPaths,
  loadBookState,
  padChapter,
  recordCost,
  saveBeatSheet,
  saveBookState,
  saveChapterText,
  saveJsonReport,
  writeCheckpoint,
} from '../memory/store.js';
import { generateBeatSheet, generateChapterDraft } from './chapter.js';
import { applyCommitDelta, extractChapterCommit } from './committer.js';
import { formatLintSummary, lintChapterText } from './linter.js';

const VARIANT_STRATEGIES = [
  '【变体风格 A：极致冲突秒开局】第 1 章前 300 字直接切入最屈辱/最紧急的现实困境与反派嘲讽，第 1 章中段立刻觉醒金手指并当场拿第一个小甜头，节奏极快、情绪拉满。',
  '【变体风格 B：反差悬念信息差开局】开篇先抛出一个违背常识的反常细节或悬疑事件抓住好奇心，主角保持冷静扮猪吃虎，靠金手指信息差在众人轻视下精准降维打击。',
  '【变体风格 C：生活流强代入+爆点反杀】先用 200 字极具共鸣的都市生活窘境与接地气脏细节拉满代入感，随后突发意外激活金手指，在第 2–3 章形成层层加码的爽点爆发与围观震惊。',
];

export interface RaceVariantChapter {
  chapter: number;
  title: string;
  beat: BeatSheet;
  content: string;
  lint: LintResult;
  delta: CommitDelta;
}

export interface RaceVariantResult {
  variant_id: string;
  strategy: string;
  chapters: RaceVariantChapter[];
  avg_lint_score: number;
}

export interface RaceOutput {
  bookId: string;
  variants: RaceVariantResult[];
  judge: RaceJudgeReport;
  reportPath: string;
}

export async function runOpeningRace(params: {
  bookId: string;
  variantsCount?: number;
  runtime: RuntimeConfig;
  llm: LLMClient;
  onLog?: (msg: string) => void;
}): Promise<RaceOutput> {
  const { bookId, runtime, llm, onLog } = params;
  const state = loadBookState(runtime.workspaceDir, bookId);
  const recipe = loadRecipe(state.recipe, runtime.recipesDir);
  const count = Math.max(
    2,
    Math.min(5, params.variantsCount ?? recipe.config.targets.opening_race_variants),
  );
  const paths = getBookPaths(runtime.workspaceDir, bookId);
  ensureBookDirs(paths);

  const openingPlans = state.volume_plan.filter((p) => p.chapter >= 1 && p.chapter <= 3);
  if (openingPlans.length < 3) {
    throw new Error(`卷纲中前 3 章规划不完整（当前仅 ${openingPlans.length} 章），无法进行黄金三章赛马`);
  }

  state.phase = 'RACING';
  saveBookState(runtime.workspaceDir, state);

  const allCosts: CostRecord[] = [];

  const runSingleVariant = async (idx: number): Promise<RaceVariantResult> => {
    const variantId = `v${idx + 1}`;
    const strategy =
      VARIANT_STRATEGIES[idx % VARIANT_STRATEGIES.length]!;
    onLog?.(`[赛马 ${variantId}] 开始生成黄金三章（第 1–3 章）...`);

    // 每个变体在独立的深拷贝 state 上推进，互不污染
    const simState: BookState = structuredClone(state);
    const variantDir = path.join(paths.raceDir, variantId);
    fs.mkdirSync(variantDir, { recursive: true });
    const simWorkspaceBookChapters: RaceVariantChapter[] = [];

    for (const plan of openingPlans) {
      const { beat, cost: beatCost } = await generateBeatSheet({
        workspaceDir: runtime.workspaceDir,
        state: simState,
        plan,
        recipe,
        llm,
        extraInstruction: strategy,
      });
      allCosts.push(beatCost);

      // 为了让 buildPrevChapterTail 在变体隔离内工作，直接临时写入变体目录并挂接
      const { text: draft, cost: draftCost } = await generateChapterDraft({
        workspaceDir: runtime.workspaceDir,
        state: simState,
        beat,
        recipe,
        llm,
      });
      allCosts.push(draftCost);

      const lint = lintChapterText(draft, recipe.antiSlop);

      const { delta, cost: commitCost } = await extractChapterCommit({
        workspaceDir: runtime.workspaceDir,
        state: simState,
        chapterNumber: plan.chapter,
        chapterContent: draft,
        recipe,
        llm,
      });
      allCosts.push(commitCost);

      applyCommitDelta(simState, plan.chapter, delta);

      const chapterFile = path.join(
        variantDir,
        `${padChapter(plan.chapter)}_${beat.title.replace(/[\\/:*?"<>|\s]+/g, '_')}.md`,
      );
      fs.writeFileSync(
        chapterFile,
        `# 第${plan.chapter}章 ${beat.title}\n\n${draft}\n`,
        'utf-8',
      );
      const relFromBook = path.relative(paths.root, chapterFile);
      const chRec = simState.chapters.find((c) => c.chapter === plan.chapter);
      if (chRec) {
        chRec.title = beat.title;
        chRec.status = 'committed';
        chRec.file_path = relFromBook;
        chRec.summary = delta.chapter_summary;
        chRec.chinese_chars = lint.metrics.chinese_chars;
        chRec.lint_passed = lint.passed;
      }

      simWorkspaceBookChapters.push({
        chapter: plan.chapter,
        title: beat.title,
        beat,
        content: draft,
        lint,
        delta,
      });
    }

    const avgLint = Number(
      (
        simWorkspaceBookChapters.reduce((sum, c) => sum + c.lint.score, 0) /
        simWorkspaceBookChapters.length
      ).toFixed(2),
    );

    const variantResult: RaceVariantResult = {
      variant_id: variantId,
      strategy,
      chapters: simWorkspaceBookChapters,
      avg_lint_score: avgLint,
    };

    fs.writeFileSync(
      path.join(variantDir, 'variant.json'),
      JSON.stringify(variantResult, null, 2),
      'utf-8',
    );
    onLog?.(`[赛马 ${variantId}] 完成，代码 Linter 均分 ${avgLint}/10`);
    return variantResult;
  };

  // 并行跑多个开篇变体
  const variants = await Promise.all(
    Array.from({ length: count }, (_v, i) => runSingleVariant(i)),
  );

  // 横向对比评审
  onLog?.('正在进行黄金三章横向评审对比...');
  const variantsBundle = variants
    .map((v) => {
      const chText = v.chapters
        .map(
          (c) =>
            `#### [${v.variant_id}] 第${c.chapter}章《${c.title}》\n${formatLintSummary(c.lint)}\n\n${c.content.slice(0, 2600)}`,
        )
        .join('\n\n');
      return `### 候选版本 ${v.variant_id}（Linter 均分 ${v.avg_lint_score}/10）\n策略：${v.strategy}\n\n${chText}`;
    })
    .join('\n\n====================\n\n');

  const judgePrompt = renderTemplate(recipe.prompts.race_judge || '', {
    variant_count: variants.length,
    foundation_summary: buildFoundationSummary(state),
    variants_bundle: variantsBundle,
  });

  const { object: judge, cost: judgeCost } = await llm.generateObject({
    stage: 'critic',
    recipe: recipe.config,
    schema: RaceJudgeReportSchema,
    prompt: judgePrompt,
  });
  allCosts.push(judgeCost);

  for (const c of allCosts) {
    recordCost(state, c);
  }
  state.phase = 'RACE_DONE';
  saveBookState(runtime.workspaceDir, state);

  saveJsonReport(runtime.workspaceDir, bookId, 'race_judge.json', judge);
  const reportPath = path.join(paths.raceDir, 'race_report.md');
  fs.writeFileSync(reportPath, renderRaceReportMarkdown(variants, judge), 'utf-8');

  writeCheckpoint(runtime.workspaceDir, bookId, 3, 'race_done', {
    variants: variants.map((v) => v.variant_id),
    recommended_winner: judge.winner_id,
  });

  return { bookId, variants, judge, reportPath };
}

export function selectRaceVariant(params: {
  bookId: string;
  variantId: string;
  runtime: RuntimeConfig;
}): BookState {
  const { bookId, variantId, runtime } = params;
  const state = loadBookState(runtime.workspaceDir, bookId);
  const paths = getBookPaths(runtime.workspaceDir, bookId);
  const variantFile = path.join(paths.raceDir, variantId, 'variant.json');

  if (!fs.existsSync(variantFile)) {
    throw new Error(`赛马变体 "${variantId}" 不存在（未找到 ${variantFile}）。请先运行 silkcanto race ${bookId}`);
  }

  const variant = JSON.parse(
    fs.readFileSync(variantFile, 'utf-8'),
  ) as RaceVariantResult;

  const now = new Date().toISOString();
  for (const ch of variant.chapters) {
    saveBeatSheet(runtime.workspaceDir, bookId, ch.beat);
    const relPath = saveChapterText(
      runtime.workspaceDir,
      bookId,
      ch.chapter,
      ch.title,
      ch.content,
    );
    applyCommitDelta(state, ch.chapter, ch.delta);

    const existingRec = state.chapters.find((c) => c.chapter === ch.chapter);
    if (existingRec) {
      existingRec.title = ch.title;
      existingRec.status = 'committed';
      existingRec.file_path = relPath;
      existingRec.summary = ch.delta.chapter_summary;
      existingRec.chinese_chars = ch.lint.metrics.chinese_chars;
      existingRec.lint_passed = ch.lint.passed;
      existingRec.updated_at = now;
    } else {
      state.chapters.push({
        chapter: ch.chapter,
        title: ch.title,
        status: 'committed',
        file_path: relPath,
        summary: ch.delta.chapter_summary,
        chinese_chars: ch.lint.metrics.chinese_chars,
        lint_passed: ch.lint.passed,
        retries: 0,
        review_notes: [],
        updated_at: now,
      });
    }

    saveJsonReport(
      runtime.workspaceDir,
      bookId,
      `ch${padChapter(ch.chapter)}_lint.json`,
      ch.lint,
    );
    writeCheckpoint(runtime.workspaceDir, bookId, ch.chapter, 'committed', {
      source_variant: variantId,
    });
  }

  state.selected_race_variant = variantId;
  state.phase = 'RUNNING';
  saveBookState(runtime.workspaceDir, state);
  return state;
}

function renderRaceReportMarkdown(
  variants: RaceVariantResult[],
  judge: RaceJudgeReport,
): string {
  return [
    `# 黄金三章赛马评审报告`,
    '',
    `## 推荐胜出版本：**${judge.winner_id}**`,
    `- **胜出理由**：${judge.winner_reason}`,
    `- **第 4–10 章衔接建议**：${judge.transition_advice}`,
    '',
    `## 各版本横向打分`,
    ...judge.scores.map((s) => {
      const v = variants.find((item) => item.variant_id === s.variant_id);
      return [
        `### ${s.variant_id} — 综合 ${s.overall_score}/10（代码 Linter 均分 ${v?.avg_lint_score ?? '-'}/10）`,
        `- 开篇钩子：${s.hook_power} | 金手指爽点：${s.golden_finger_payoff} | 去AI味活人感：${s.human_feel} | 过签潜力：${s.contract_readiness}`,
        `- 亮点：${s.strengths.join('；')}`,
        `- 不足：${s.weaknesses.join('；')}`,
        '',
      ].join('\n');
    }),
    `> 运行 \`silkcanto select <book_id> ${judge.winner_id}\` 即可锁定该版本进入第 4–10 章连载流水线。`,
    '',
  ].join('\n');
}
