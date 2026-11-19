import { renderTemplate, type LoadedRecipe } from '../config.js';
import type { LLMClient } from '../core/llm.js';
import { buildFoundationSummary, buildStateContext } from '../memory/context.js';
import {
  CriticReportSchema,
  type BeatSheet,
  type BookState,
  type CostRecord,
  type CriticReport,
  type LintResult,
} from '../memory/schema.js';
import { formatBeatSheet } from './chapter.js';
import { formatLintSummary } from './linter.js';

export async function runChapterCritic(params: {
  state: BookState;
  beat: BeatSheet;
  chapterContent: string;
  lintResult: LintResult;
  recipe: LoadedRecipe;
  llm: LLMClient;
}): Promise<{ report: CriticReport; cost: CostRecord }> {
  const { state, beat, chapterContent, lintResult, recipe, llm } = params;

  const prompt = renderTemplate(recipe.prompts.critic || '', {
    foundation_summary: buildFoundationSummary(state),
    state_context: buildStateContext(state, beat.chapter),
    beat_sheet: formatBeatSheet(beat),
    lint_summary: formatLintSummary(lintResult),
    chapter_number: beat.chapter,
    chapter_title: beat.title,
    chapter_content: chapterContent,
  });

  const { object: report, cost } = await llm.generateObject({
    stage: 'critic',
    chapter: beat.chapter,
    recipe: recipe.config,
    schema: CriticReportSchema,
    prompt,
  });

  // 确定性安全门禁：一旦检测到剧透或得分低于配方阈值，强制不放行
  if (
    report.truth_leak_detected ||
    report.overall_score < recipe.config.targets.critic_pass_score
  ) {
    report.pass = false;
  }

  return { report, cost };
}
