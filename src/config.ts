import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import YAML from 'yaml';
import { z } from 'zod';
import {
  ReasoningEffortSchema,
  type PipelineStage,
  type ReasoningEffort,
} from './memory/schema.js';

dotenv.config();

export const AntiSlopConfigSchema = z.object({
  limits: z.object({
    min_chars: z.number().int().default(1900),
    max_chars: z.number().int().default(2800),
    min_dialogue_ratio: z.number().default(0.18),
    max_staged_dialogue_ratio: z.number().default(0.68),
    max_paragraph_chars: z.number().int().default(180),
    max_long_paragraphs: z.number().int().default(3),
    max_em_dash_count: z.number().int().default(4),
    max_not_but_count: z.number().int().default(3),
    max_cliche_total: z.number().int().default(4),
    max_single_cliche: z.number().int().default(2),
    max_force_adverbs: z.number().int().default(6),
    max_body_cliches: z.number().int().default(2),
  }),
  banned_phrases: z.array(z.string()).default([]),
  cliche_phrases: z.array(z.string()).default([]),
  force_adverbs: z.array(z.string()).default([
    '猛地',
    '死死',
    '狠狠',
    '骤然',
    '陡然',
    '轰然',
    '硬生生',
  ]),
  body_cliches: z.array(z.string()).default([
    '喉结',
    '眼皮狂跳',
    '后槽牙',
    '喉咙发干',
    '浑身一僵',
    '鼻腔发酸',
    '彻底懵了',
    '咽了口',
  ]),
});
export type AntiSlopConfig = z.infer<typeof AntiSlopConfigSchema>;

export const RecipeConfigSchema = z.object({
  name: z.string(),
  display_name: z.string(),
  platform: z.string().default('fanqie'),
  genre: z.string(),
  description: z.string().default(''),
  targets: z.object({
    target_chapters_for_contract: z.number().int().default(10),
    chapter_min_chars: z.number().int().default(2000),
    chapter_max_chars: z.number().int().default(2500),
    opening_race_variants: z.number().int().default(3),
    max_rewrite_retries: z.number().int().default(2),
    critic_pass_score: z.number().default(7.0),
  }),
  style_guide: z.object({
    pov: z.string(),
    pacing: z.string(),
    paragraph_style: z.string(),
    forbidden_habits: z.array(z.string()).default([]),
  }),
  models: z
    .object({
      deconstruct: z.string().default(''),
      foundation: z.string().default(''),
      beat: z.string().default(''),
      draft: z.string().default(''),
      deslop: z.string().default(''),
      critic: z.string().default(''),
      commit: z.string().default(''),
    })
    .default({}),
  temperatures: z
    .object({
      deconstruct: z.number().default(0.3),
      foundation: z.number().default(0.7),
      beat: z.number().default(0.5),
      draft: z.number().default(0.85),
      deslop: z.number().default(0.65),
      critic: z.number().default(0.2),
      commit: z.number().default(0.1),
    })
    .default({}),
  reasoning_effort: z
    .object({
      deconstruct: ReasoningEffortSchema.default('medium'),
      foundation: ReasoningEffortSchema.default('medium'),
      beat: ReasoningEffortSchema.default('low'),
      draft: ReasoningEffortSchema.default('low'),
      deslop: ReasoningEffortSchema.default('low'),
      critic: ReasoningEffortSchema.default('low'),
      commit: ReasoningEffortSchema.default('low'),
    })
    .default({}),
});
export type RecipeConfig = z.infer<typeof RecipeConfigSchema>;

export interface LoadedRecipe {
  dir: string;
  config: RecipeConfig;
  antiSlop: AntiSlopConfig;
  prompts: Record<string, string>;
  dnaJson?: string;
}

export interface RuntimeConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  stageModels: Partial<Record<PipelineStage, string>>;
  defaultReasoningEffort?: ReasoningEffort;
  inputCostPer1M: number;
  outputCostPer1M: number;
  workspaceDir: string;
  recipesDir: string;
}

export function getRuntimeConfig(cwd = process.cwd()): RuntimeConfig {
  const workspaceDir = path.resolve(
    cwd,
    process.env.SILKCANTO_WORKSPACE_DIR || './workspace',
  );
  const recipesDir = path.resolve(cwd, './recipes');

  const stageModels: Partial<Record<PipelineStage, string>> = {
    deconstruct: process.env.SILKCANTO_MODEL_DECONSTRUCT || undefined,
    foundation: process.env.SILKCANTO_MODEL_FOUNDATION || undefined,
    beat: process.env.SILKCANTO_MODEL_BEAT || undefined,
    draft: process.env.SILKCANTO_MODEL_DRAFT || undefined,
    deslop: process.env.SILKCANTO_MODEL_DESLOP || undefined,
    critic: process.env.SILKCANTO_MODEL_CRITIC || undefined,
    commit: process.env.SILKCANTO_MODEL_COMMIT || undefined,
  };

  const envEffortRaw = process.env.SILKCANTO_REASONING_EFFORT?.trim();
  const defaultReasoningEffort = envEffortRaw
    ? ReasoningEffortSchema.parse(envEffortRaw)
    : undefined;

  const providerMode = process.env.SILKCANTO_PROVIDER?.trim().toLowerCase();
  const useDeepSeekPreset =
    providerMode === 'deepseek' ||
    (!process.env.SILKCANTO_API_KEY && Boolean(process.env.DEEPSEEK_API_KEY));

  const apiKey = useDeepSeekPreset
    ? process.env.DEEPSEEK_API_KEY || process.env.SILKCANTO_API_KEY || ''
    : process.env.SILKCANTO_API_KEY || '';
  const baseUrl = useDeepSeekPreset
    ? process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'
    : process.env.SILKCANTO_BASE_URL || 'https://api.deepseek.com/v1';
  const defaultModel = useDeepSeekPreset
    ? process.env.DEEPSEEK_MODEL || 'deepseek-flash'
    : process.env.SILKCANTO_DEFAULT_MODEL || 'deepseek-v4-pro';

  return {
    apiKey,
    baseUrl,
    defaultModel,
    stageModels,
    defaultReasoningEffort,
    inputCostPer1M: Number(process.env.SILKCANTO_INPUT_COST_PER_1M || 2.0),
    outputCostPer1M: Number(process.env.SILKCANTO_OUTPUT_COST_PER_1M || 8.0),
    workspaceDir,
    recipesDir,
  };
}

export function resolveReasoningEffortForStage(
  runtime: RuntimeConfig,
  recipe: RecipeConfig | undefined,
  stage: PipelineStage,
): ReasoningEffort | undefined {
  if (runtime.defaultReasoningEffort) return runtime.defaultReasoningEffort;
  return recipe?.reasoning_effort?.[stage];
}

export function resolveModelForStage(
  runtime: RuntimeConfig,
  recipe: RecipeConfig | undefined,
  stage: PipelineStage,
): string {
  const fromRecipe = recipe?.models?.[stage]?.trim();
  if (fromRecipe) return fromRecipe;
  const fromEnv = runtime.stageModels[stage]?.trim();
  if (fromEnv) return fromEnv;
  return runtime.defaultModel;
}

export function loadRecipe(recipeName: string, recipesDir?: string): LoadedRecipe {
  const baseDir = recipesDir || path.resolve(process.cwd(), './recipes');
  const dir = path.join(baseDir, recipeName);
  const recipePath = path.join(dir, 'recipe.yaml');
  const antiSlopPath = path.join(dir, 'anti_slop.yaml');

  if (!fs.existsSync(recipePath)) {
    throw new Error(`找不到配方 "${recipeName}"：${recipePath} 不存在`);
  }

  const rawRecipe = YAML.parse(fs.readFileSync(recipePath, 'utf-8'));
  const config = RecipeConfigSchema.parse(rawRecipe);

  const rawAntiSlop = fs.existsSync(antiSlopPath)
    ? YAML.parse(fs.readFileSync(antiSlopPath, 'utf-8'))
    : {};
  const antiSlop = AntiSlopConfigSchema.parse(rawAntiSlop);

  const promptsDir = path.join(dir, 'prompts');
  const prompts: Record<string, string> = {};
  if (fs.existsSync(promptsDir)) {
    for (const file of fs.readdirSync(promptsDir)) {
      if (file.endsWith('.md')) {
        const key = file.replace(/\.md$/, '');
        prompts[key] = fs.readFileSync(path.join(promptsDir, file), 'utf-8');
      }
    }
  }

  const dnaPath = path.join(dir, 'dna.json');
  const dnaJson = fs.existsSync(dnaPath)
    ? fs.readFileSync(dnaPath, 'utf-8')
    : undefined;

  return { dir, config, antiSlop, prompts, dnaJson };
}

export function renderTemplate(
  template: string,
  variables: Record<string, string | number | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = variables[key];
    return value === undefined ? '' : String(value);
  });
}

export function formatStyleGuide(recipe: RecipeConfig): string {
  const lines = [
    `赛道：${recipe.display_name}（${recipe.genre}）`,
    `视角：${recipe.style_guide.pov}`,
    `节奏：${recipe.style_guide.pacing}`,
    `段落风格：${recipe.style_guide.paragraph_style}`,
  ];
  if (recipe.style_guide.forbidden_habits.length > 0) {
    lines.push('禁区：');
    for (const item of recipe.style_guide.forbidden_habits) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join('\n');
}
