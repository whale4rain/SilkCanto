import { z } from 'zod';

export const PipelineStageSchema = z.enum([
  'deconstruct',
  'foundation',
  'beat',
  'draft',
  'deslop',
  'critic',
  'commit',
]);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const BookPhaseSchema = z.enum([
  'INIT',
  'FOUNDATION_DONE',
  'RACING',
  'RACE_DONE',
  'RUNNING',
  'NEEDS_REVIEW',
  'COMPLETED',
]);
export type BookPhase = z.infer<typeof BookPhaseSchema>;

export const CharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(), // 主角 / 反派靶子 / 盟友 / 见证者
  personality: z.string(),
  speech_style: z.string(),
  current_status: z.string(),
  relationship_to_mc: z.string(),
  known_facts: z.array(z.string()).default([]),
});
export type Character = z.infer<typeof CharacterSchema>;

export const AssetSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  description: z.string(),
  quantity_or_level: z.string(),
  status: z.enum(['active', 'consumed', 'lost', 'upgraded']).default('active'),
});
export type Asset = z.infer<typeof AssetSchema>;

export const ForeshadowingSchema = z.object({
  id: z.string(),
  summary: z.string(),
  planted_chapter: z.number().int().min(0),
  status: z.enum(['planted', 'progressed', 'resolved']).default('planted'),
  payoff_plan: z.string(),
  resolved_chapter: z.number().int().optional(),
});
export type Foreshadowing = z.infer<typeof ForeshadowingSchema>;

export const TimelineEntrySchema = z.object({
  chapter: z.number().int().min(0),
  fact: z.string(),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const ChapterPlanSchema = z.object({
  chapter: z.number().int().min(1),
  title: z.string(),
  summary: z.string(),
  goal: z.string(),
  hook_hint: z.string(),
});
export type ChapterPlan = z.infer<typeof ChapterPlanSchema>;

export const FoundationSchema = z.object({
  idea: z.string(),
  title: z.string(),
  title_candidates: z.array(z.string()).min(1),
  blurb: z.string(),
  genre: z.string(),
  core_selling_point: z.string(),
  golden_finger_name: z.string(),
  golden_finger_rules: z.string(),
  golden_finger_limits: z.string(),
  main_goal: z.string(),
});
export type Foundation = z.infer<typeof FoundationSchema>;

export const BeatItemSchema = z.object({
  order: z.number().int().min(1),
  scene: z.string(),
  conflict_or_action: z.string(),
  payoff_or_shift: z.string(),
});

export const BeatSheetSchema = z.object({
  chapter: z.number().int().min(1),
  title: z.string(),
  core_goal: z.string(),
  conflict_target: z.string(),
  golden_finger_usage: z.string(),
  beats: z.array(BeatItemSchema).min(3).max(6),
  cliffhanger_hook: z.string(),
  reader_known_guard: z.array(z.string()).default([]),
});
export type BeatSheet = z.infer<typeof BeatSheetSchema>;

export const LintIssueSchema = z.object({
  rule: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  line: z.number().int().optional(),
  snippet: z.string().optional(),
});
export type LintIssue = z.infer<typeof LintIssueSchema>;

export const TextMetricsSchema = z.object({
  chinese_chars: z.number().int(),
  total_chars: z.number().int(),
  paragraph_count: z.number().int(),
  avg_paragraph_chars: z.number(),
  max_paragraph_chars: z.number().int(),
  long_paragraph_count: z.number().int(),
  dialogue_ratio: z.number(),
  staged_dialogue_ratio: z.number().default(0),
  short_sentence_ratio: z.number(),
  em_dash_count: z.number().int(),
  not_but_count: z.number().int(),
  banned_hits: z.record(z.number().int()),
  cliche_hits: z.record(z.number().int()),
  force_adverb_hits: z.record(z.number().int()).default({}),
  body_cliche_hits: z.record(z.number().int()).default({}),
});
export type TextMetrics = z.infer<typeof TextMetricsSchema>;

export const LintResultSchema = z.object({
  passed: z.boolean(),
  score: z.number(),
  metrics: TextMetricsSchema,
  issues: z.array(LintIssueSchema),
});
export type LintResult = z.infer<typeof LintResultSchema>;

export const CriticReportSchema = z.object({
  consistency: z.number().min(1).max(10),
  pacing: z.number().min(1).max(10),
  hook: z.number().min(1).max(10),
  human_feel: z.number().min(1).max(10),
  overall_score: z.number().min(1).max(10),
  pass: z.boolean(),
  truth_leak_detected: z.boolean(),
  issues: z.array(z.string()),
  rewrite_instructions: z.array(z.string()),
});
export type CriticReport = z.infer<typeof CriticReportSchema>;

export const CommitDeltaSchema = z.object({
  chapter_summary: z.string(),
  character_updates: z.array(
    z.object({
      name: z.string(),
      role: z.string().optional(),
      personality: z.string().optional(),
      speech_style: z.string().optional(),
      current_status: z.string(),
      relationship_to_mc: z.string().optional(),
      new_known_facts: z.array(z.string()).default([]),
    }),
  ),
  asset_updates: z.array(
    z.object({
      name: z.string(),
      owner: z.string(),
      description: z.string(),
      quantity_or_level: z.string(),
      status: z.enum(['active', 'consumed', 'lost', 'upgraded']).default('active'),
    }),
  ),
  foreshadowing_updates: z.array(
    z.object({
      id: z.string().optional(),
      summary: z.string(),
      status: z.enum(['planted', 'progressed', 'resolved']),
      payoff_plan: z.string().default(''),
    }),
  ),
  new_author_truth: z.array(z.string()),
  new_reader_known: z.array(z.string()),
});
export type CommitDelta = z.infer<typeof CommitDeltaSchema>;

export const ChapterRecordSchema = z.object({
  chapter: z.number().int().min(1),
  title: z.string(),
  status: z.enum(['planned', 'beat_ready', 'drafted', 'needs_review', 'committed']),
  file_path: z.string().optional(),
  summary: z.string().optional(),
  chinese_chars: z.number().int().optional(),
  lint_passed: z.boolean().optional(),
  critic_score: z.number().optional(),
  retries: z.number().int().default(0),
  review_notes: z.array(z.string()).default([]),
  updated_at: z.string(),
});
export type ChapterRecord = z.infer<typeof ChapterRecordSchema>;

export const CostRecordSchema = z.object({
  timestamp: z.string(),
  stage: PipelineStageSchema,
  model: z.string(),
  chapter: z.number().int().optional(),
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  estimated_cost_cny: z.number(),
});
export type CostRecord = z.infer<typeof CostRecordSchema>;

export const CostLedgerSchema = z.object({
  total_prompt_tokens: z.number().int().default(0),
  total_completion_tokens: z.number().int().default(0),
  total_cost_cny: z.number().default(0),
  calls: z.array(CostRecordSchema).default([]),
});
export type CostLedger = z.infer<typeof CostLedgerSchema>;

export const DeconstructDNASchema = z.object({
  source_name: z.string(),
  genre_guess: z.string(),
  core_emotion_hook: z.string(),
  opening_500_strategy: z.string(),
  golden_finger_reveal_timing: z.string(),
  golden_three_arcs: z.array(
    z.object({
      chapter_index: z.number().int().min(1),
      function: z.string(),
      emotion_arc: z.string(),
      cliffhanger_technique: z.string(),
    }),
  ),
  character_contrast_formula: z.array(z.string()),
  cliffhanger_patterns: z.array(z.string()),
  prose_features: z.array(z.string()),
  pitfalls_to_avoid: z.array(z.string()),
  recommended_targets: z.object({
    min_chars: z.number().int(),
    max_chars: z.number().int(),
    min_dialogue_ratio: z.number(),
    max_paragraph_chars: z.number().int(),
  }),
});
export type DeconstructDNA = z.infer<typeof DeconstructDNASchema>;

export const RaceVariantScoreSchema = z.object({
  variant_id: z.string(),
  hook_power: z.number().min(1).max(10),
  golden_finger_payoff: z.number().min(1).max(10),
  human_feel: z.number().min(1).max(10),
  contract_readiness: z.number().min(1).max(10),
  overall_score: z.number().min(1).max(10),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
});

export const RaceJudgeReportSchema = z.object({
  winner_id: z.string(),
  winner_reason: z.string(),
  transition_advice: z.string(),
  scores: z.array(RaceVariantScoreSchema),
});
export type RaceJudgeReport = z.infer<typeof RaceJudgeReportSchema>;

export const BookStateSchema = z.object({
  book_id: z.string(),
  recipe: z.string(),
  phase: BookPhaseSchema,
  selected_race_variant: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  foundation: FoundationSchema,
  volume_plan: z.array(ChapterPlanSchema),
  characters: z.array(CharacterSchema),
  assets: z.array(AssetSchema),
  foreshadowing: z.array(ForeshadowingSchema),
  author_truth: z.array(TimelineEntrySchema),
  reader_known: z.array(TimelineEntrySchema),
  chapters: z.array(ChapterRecordSchema),
  cost: CostLedgerSchema,
});
export type BookState = z.infer<typeof BookStateSchema>;

export const CheckpointSchema = z.object({
  book_id: z.string(),
  chapter: z.number().int().min(0),
  step: z.string(),
  timestamp: z.string(),
  metadata: z.record(z.unknown()).default({}),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
