import { renderTemplate, type LoadedRecipe } from '../config.js';
import type { LLMClient } from '../core/llm.js';
import type { BeatSheet, CostRecord } from '../memory/schema.js';
import { cleanModelProse } from './chapter.js';
import { formatLintSummary, lintChapterText } from './linter.js';

export async function runChapterDeslop(params: {
  draft: string;
  beat: BeatSheet;
  recipe: LoadedRecipe;
  llm: LLMClient;
}): Promise<{ text: string; cost: CostRecord } | null> {
  const { draft, beat, recipe, llm } = params;
  const template = recipe.prompts.deslop;
  if (!template) return null;

  const preLint = lintChapterText(draft, recipe.antiSlop);
  const prompt = renderTemplate(template, {
    chapter_number: beat.chapter,
    chapter_title: beat.title,
    min_chars: recipe.config.targets.chapter_min_chars,
    max_chars: recipe.config.targets.chapter_max_chars,
    reader_known_guard:
      beat.reader_known_guard.length > 0
        ? beat.reader_known_guard.join('；')
        : '严禁提前泄露任何未公开的幕后真相。',
    pre_lint_summary: formatLintSummary(preLint),
    draft_content: draft,
  });

  const { text, cost } = await llm.generateText({
    stage: 'deslop',
    chapter: beat.chapter,
    recipe: recipe.config,
    prompt,
  });

  return {
    text: cleanModelProse(text),
    cost,
  };
}
