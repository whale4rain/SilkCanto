import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  formatStyleGuide,
  loadRecipe,
  renderTemplate,
  type RuntimeConfig,
} from '../config.js';
import type { LLMClient } from '../core/llm.js';
import {
  AssetSchema,
  BookStateSchema,
  ChapterPlanSchema,
  CharacterSchema,
  ForeshadowingSchema,
  FoundationSchema,
  type BookState,
} from '../memory/schema.js';
import {
  ensureBookDirs,
  getBookPaths,
  recordCost,
  saveBookState,
  writeCheckpoint,
} from '../memory/store.js';

const FoundationGenerationSchema = z.object({
  foundation: FoundationSchema,
  characters: z.array(CharacterSchema).min(2),
  assets: z.array(AssetSchema).default([]),
  foreshadowing: z.array(ForeshadowingSchema).default([]),
  volume_plan: z.array(ChapterPlanSchema).min(10),
  initial_author_truth: z.array(z.string()).min(1),
  initial_reader_known: z.array(z.string()).min(1),
});

export async function runFoundationInit(params: {
  bookId: string;
  idea: string;
  recipeName: string;
  runtime: RuntimeConfig;
  llm: LLMClient;
  overwrite?: boolean;
}): Promise<BookState> {
  const { bookId, idea, recipeName, runtime, llm, overwrite } = params;
  const paths = getBookPaths(runtime.workspaceDir, bookId);

  if (fs.existsSync(paths.stateFile) && !overwrite) {
    throw new Error(`书籍 "${bookId}" 已存在。如需覆盖请加 --force，或换一个 book_id。`);
  }

  const recipe = loadRecipe(recipeName, runtime.recipesDir);
  const promptTemplate = recipe.prompts.foundation;
  if (!promptTemplate) {
    throw new Error(`配方 "${recipeName}" 缺少 prompts/foundation.md`);
  }

  const dnaContext = recipe.dnaJson
    ? `以下是基于同赛道拆书沉淀的节奏基因（请吸收其节奏与钩子结构，严禁抄袭原书剧情）：\n${recipe.dnaJson.slice(0, 4000)}`
    : '（无前置拆书文件，直接按配方赛道规则规划。）';

  const prompt = renderTemplate(promptTemplate, {
    idea,
    style_guide: formatStyleGuide(recipe.config),
    dna_context: dnaContext,
  });

  const { object: generated, cost } = await llm.generateObject({
    stage: 'foundation',
    recipe: recipe.config,
    schema: FoundationGenerationSchema,
    prompt,
  });

  generated.foundation.idea = idea;
  const now = new Date().toISOString();

  const state: BookState = BookStateSchema.parse({
    book_id: bookId,
    recipe: recipeName,
    phase: 'FOUNDATION_DONE',
    created_at: now,
    updated_at: now,
    foundation: generated.foundation,
    volume_plan: generated.volume_plan
      .slice()
      .sort((a, b) => a.chapter - b.chapter),
    characters: generated.characters,
    assets: generated.assets,
    foreshadowing: generated.foreshadowing,
    author_truth: generated.initial_author_truth.map((fact) => ({
      chapter: 0,
      fact,
    })),
    reader_known: generated.initial_reader_known.map((fact) => ({
      chapter: 0,
      fact,
    })),
    chapters: generated.volume_plan
      .slice()
      .sort((a, b) => a.chapter - b.chapter)
      .map((plan) => ({
        chapter: plan.chapter,
        title: plan.title,
        status: 'planned',
        retries: 0,
        review_notes: [],
        updated_at: now,
      })),
    cost: {
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      total_cost_cny: 0,
      calls: [],
    },
  });

  recordCost(state, cost);
  ensureBookDirs(paths);
  saveBookState(runtime.workspaceDir, state);

  // 保存人类可读的大纲文件
  const outlineMd = [
    `# ${state.foundation.title} — 卷纲与设定`,
    '',
    `## 简介`,
    state.foundation.blurb,
    '',
    `## 候选书名`,
    ...state.foundation.title_candidates.map((t) => `- ${t}`),
    '',
    `## 金手指规则`,
    `- 名称：${state.foundation.golden_finger_name}`,
    `- 规则：${state.foundation.golden_finger_rules}`,
    `- 限制：${state.foundation.golden_finger_limits}`,
    '',
    `## 分章卷纲（前 ${state.volume_plan.length} 章）`,
    ...state.volume_plan.map(
      (p) =>
        `### 第 ${p.chapter} 章：${p.title}\n- 目标：${p.goal}\n- 摘要：${p.summary}\n- 钩子提示：${p.hook_hint}\n`,
    ),
  ].join('\n');
  fs.writeFileSync(path.join(paths.outlinesDir, 'volume_01.md'), outlineMd, 'utf-8');

  writeCheckpoint(runtime.workspaceDir, bookId, 0, 'foundation_done', {
    title: state.foundation.title,
    planned_chapters: state.volume_plan.length,
  });

  return state;
}
