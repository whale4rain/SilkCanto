import { renderTemplate, type LoadedRecipe } from '../config.js';
import type { LLMClient } from '../core/llm.js';
import { buildStateContext } from '../memory/context.js';
import {
  CommitDeltaSchema,
  type BookState,
  type CommitDelta,
  type CostRecord,
} from '../memory/schema.js';

export async function extractChapterCommit(params: {
  state: BookState;
  chapterNumber: number;
  chapterContent: string;
  recipe: LoadedRecipe;
  llm: LLMClient;
}): Promise<{ delta: CommitDelta; cost: CostRecord }> {
  const { state, chapterNumber, chapterContent, recipe, llm } = params;

  const prompt = renderTemplate(recipe.prompts.commit || '', {
    chapter_number: chapterNumber,
    state_context: buildStateContext(state, chapterNumber),
    chapter_content: chapterContent,
  });

  const { object: delta, cost } = await llm.generateObject({
    stage: 'commit',
    chapter: chapterNumber,
    recipe: recipe.config,
    schema: CommitDeltaSchema,
    prompt,
  });

  return { delta, cost };
}

export function applyCommitDelta(
  state: BookState,
  chapterNumber: number,
  delta: CommitDelta,
): void {
  // 1. 更新角色账本
  for (const upd of delta.character_updates) {
    const existing = state.characters.find((c) => c.name === upd.name);
    if (existing) {
      existing.current_status = upd.current_status;
      if (upd.role) existing.role = upd.role;
      if (upd.personality) existing.personality = upd.personality;
      if (upd.speech_style) existing.speech_style = upd.speech_style;
      if (upd.relationship_to_mc) existing.relationship_to_mc = upd.relationship_to_mc;
      for (const fact of upd.new_known_facts) {
        if (fact && !existing.known_facts.includes(fact)) {
          existing.known_facts.push(fact);
        }
      }
    } else {
      state.characters.push({
        id: `char_${state.characters.length + 1}`,
        name: upd.name,
        role: upd.role || '配角',
        personality: upd.personality || '待补充',
        speech_style: upd.speech_style || '自然口语',
        current_status: upd.current_status,
        relationship_to_mc: upd.relationship_to_mc || '初识',
        known_facts: upd.new_known_facts,
      });
    }
  }

  // 2. 更新道具与资源账本
  for (const upd of delta.asset_updates) {
    const existing = state.assets.find(
      (a) => a.name === upd.name && a.owner === upd.owner,
    );
    if (existing) {
      existing.description = upd.description;
      existing.quantity_or_level = upd.quantity_or_level;
      existing.status = upd.status;
    } else {
      state.assets.push({
        id: `asset_${state.assets.length + 1}`,
        name: upd.name,
        owner: upd.owner,
        description: upd.description,
        quantity_or_level: upd.quantity_or_level,
        status: upd.status,
      });
    }
  }

  // 3. 更新伏笔注册表
  for (const upd of delta.foreshadowing_updates) {
    const existing = state.foreshadowing.find(
      (f) => (upd.id && f.id === upd.id) || f.summary === upd.summary,
    );
    if (existing) {
      existing.status = upd.status;
      if (upd.payoff_plan) existing.payoff_plan = upd.payoff_plan;
      if (upd.status === 'resolved') {
        existing.resolved_chapter = chapterNumber;
      }
    } else {
      state.foreshadowing.push({
        id: upd.id || `fs_${state.foreshadowing.length + 1}`,
        summary: upd.summary,
        planted_chapter: chapterNumber,
        status: upd.status,
        payoff_plan: upd.payoff_plan || '待后续回收',
        resolved_chapter: upd.status === 'resolved' ? chapterNumber : undefined,
      });
    }
  }

  // 4. 更新双时间线（去重追加）
  const existingTruth = new Set(state.author_truth.map((t) => t.fact));
  for (const fact of delta.new_author_truth) {
    if (fact && !existingTruth.has(fact)) {
      state.author_truth.push({ chapter: chapterNumber, fact });
      existingTruth.add(fact);
    }
  }

  const existingKnown = new Set(state.reader_known.map((k) => k.fact));
  for (const fact of delta.new_reader_known) {
    if (fact && !existingKnown.has(fact)) {
      state.reader_known.push({ chapter: chapterNumber, fact });
      existingKnown.add(fact);
    }
  }
}
