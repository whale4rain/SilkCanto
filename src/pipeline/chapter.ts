import {
  formatStyleGuide,
  renderTemplate,
  type LoadedRecipe,
} from '../config.js';
import type { LLMClient } from '../core/llm.js';
import {
  buildFoundationSummary,
  buildPrevChapterTail,
  buildStateContext,
} from '../memory/context.js';
import {
  BeatSheetSchema,
  type BeatSheet,
  type BookState,
  type ChapterPlan,
  type CostRecord,
} from '../memory/schema.js';

export function formatBeatSheet(beat: BeatSheet): string {
  const lines = [
    `第 ${beat.chapter} 章《${beat.title}》细纲`,
    `核心目标：${beat.core_goal}`,
    `冲突靶子：${beat.conflict_target}`,
    `金手指/信息差应用：${beat.golden_finger_usage}`,
    '场景节拍：',
    ...beat.beats.map(
      (b) =>
        `${b.order}. [${b.scene}] 冲突/行动：${b.conflict_or_action} -> 爽点/转折：${b.payoff_or_shift}`,
    ),
    `章末断章钩子：${beat.cliffhanger_hook}`,
  ];
  if (beat.reader_known_guard.length > 0) {
    lines.push(`信息隔离红线（本章禁止提前说漏）：${beat.reader_known_guard.join('；')}`);
  }
  return lines.join('\n');
}

export async function generateBeatSheet(params: {
  workspaceDir: string;
  state: BookState;
  plan: ChapterPlan;
  recipe: LoadedRecipe;
  llm: LLMClient;
  extraInstruction?: string;
}): Promise<{ beat: BeatSheet; cost: CostRecord }> {
  const { workspaceDir, state, plan, recipe, llm, extraInstruction } = params;
  const prompt = renderTemplate(recipe.prompts.beat || '', {
    foundation_summary: buildFoundationSummary(state),
    state_context: buildStateContext(state, plan.chapter),
    prev_chapter_tail: buildPrevChapterTail(workspaceDir, state, plan.chapter),
    chapter_number: plan.chapter,
    planned_title: plan.title,
    planned_summary: `${plan.summary}\n本章目标：${plan.goal}\n钩子提示：${plan.hook_hint}`,
    extra_instruction: extraInstruction || '无',
  });

  const { object: beat, cost } = await llm.generateObject({
    stage: 'beat',
    chapter: plan.chapter,
    recipe: recipe.config,
    schema: BeatSheetSchema,
    prompt,
  });

  beat.chapter = plan.chapter;
  return { beat, cost };
}

export async function generateChapterDraft(params: {
  workspaceDir: string;
  state: BookState;
  beat: BeatSheet;
  recipe: LoadedRecipe;
  llm: LLMClient;
  rewriteFeedback?: string;
}): Promise<{ text: string; cost: CostRecord }> {
  const { workspaceDir, state, beat, recipe, llm, rewriteFeedback } = params;

  // 细纲门禁：确保细纲有效才允许写正文
  const validatedBeat = BeatSheetSchema.parse(beat);

  const prompt = renderTemplate(recipe.prompts.draft || '', {
    style_guide: formatStyleGuide(recipe.config),
    state_context: buildStateContext(state, validatedBeat.chapter),
    prev_chapter_tail: buildPrevChapterTail(workspaceDir, state, validatedBeat.chapter),
    beat_sheet: formatBeatSheet(validatedBeat),
    rewrite_feedback: rewriteFeedback || '（本次为首稿，直接严格按细纲创作。）',
    min_chars: recipe.config.targets.chapter_min_chars,
    max_chars: recipe.config.targets.chapter_max_chars,
  });

  const { text, cost } = await llm.generateText({
    stage: 'draft',
    chapter: validatedBeat.chapter,
    recipe: recipe.config,
    prompt,
  });

  const cleaned = cleanModelProse(text);
  return { text: cleaned, cost };
}

export function cleanModelProse(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/^```[\w]*\n?/gm, '')
    .replace(/```$/gm, '')
    .replace(/^#+\s*第?[零一二三四五六七八九十百千万0-9]+章.*\n+/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
