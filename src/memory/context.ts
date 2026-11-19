import type { BookState } from './schema.js';
import { readChapterBody } from './store.js';

const MAX_CONTEXT_CHARS = 9500;

export function buildFoundationSummary(state: BookState): string {
  const f = state.foundation;
  return [
    `书名：${f.title}`,
    `题材：${f.genre}`,
    `简介：${f.blurb}`,
    `核心卖点：${f.core_selling_point}`,
    `金手指名称：${f.golden_finger_name}`,
    `金手指规则：${f.golden_finger_rules}`,
    `金手指硬性限制：${f.golden_finger_limits}`,
    `主线目标：${f.main_goal}`,
  ].join('\n');
}

export function buildStateContext(state: BookState, targetChapter: number): string {
  const recentSummaries = state.chapters
    .filter((c) => c.chapter < targetChapter && c.summary)
    .slice(-5)
    .map((c) => `- 第${c.chapter}章《${c.title}》：${c.summary}`);

  const activeForeshadowing = state.foreshadowing
    .filter((f) => f.status !== 'resolved')
    .map((f) => `- (${f.id}, ${f.status}, 第${f.planted_chapter}章) ${f.summary} | 计划回收：${f.payoff_plan}`);

  const characters = state.characters.map(
    (c) =>
      `- ${c.name}（${c.role}）| 性格：${c.personality} | 说话习惯：${c.speech_style} | 当前状态：${c.current_status} | 与主角关系：${c.relationship_to_mc}` +
      (c.known_facts.length > 0 ? ` | 已知：${c.known_facts.slice(-4).join('；')}` : ''),
  );

  const assets = state.assets
    .filter((a) => a.status !== 'consumed' && a.status !== 'lost')
    .map((a) => `- ${a.name}（持有：${a.owner} | 数量/等级：${a.quantity_or_level}）：${a.description}`);

  const authorTruth = state.author_truth
    .slice(-15)
    .map((t) => `- [第${t.chapter}章] ${t.fact}`);

  const readerKnown = state.reader_known
    .slice(-20)
    .map((k) => `- [第${k.chapter}章] ${k.fact}`);

  const sections = [
    `【近期已发生章节摘要】`,
    recentSummaries.length > 0 ? recentSummaries.join('\n') : '- 本书刚开篇，暂无前序章节。',
    '',
    `【当前核心角色账本】`,
    characters.length > 0 ? characters.join('\n') : '- 暂无',
    '',
    `【当前有效道具/资源】`,
    assets.length > 0 ? assets.join('\n') : '- 暂无',
    '',
    `【未回收伏笔清单】`,
    activeForeshadowing.length > 0 ? activeForeshadowing.join('\n') : '- 暂无',
    '',
    `【双时间线 A — author_truth（仅作者上帝视角知晓，禁止角色越界提前说出！）】`,
    authorTruth.length > 0 ? authorTruth.join('\n') : '- 暂无',
    '',
    `【双时间线 B — reader_known（主角与读者截至上一章已明确知晓的事实）】`,
    readerKnown.length > 0 ? readerKnown.join('\n') : '- 暂无',
  ];

  const merged = sections.join('\n');
  if (merged.length <= MAX_CONTEXT_CHARS) return merged;
  return `${merged.slice(0, MAX_CONTEXT_CHARS)}\n...(上下文已按上限截断)`;
}

export function buildPrevChapterTail(
  workspaceDir: string,
  state: BookState,
  targetChapter: number,
  maxChars = 700,
): string {
  const prev = state.chapters.find(
    (c) => c.chapter === targetChapter - 1 && c.file_path,
  );
  if (!prev || !prev.file_path) {
    return '（本章为开篇第 1 章，无前章衔接，请直接用强冲突开局。）';
  }
  const body = readChapterBody(workspaceDir, state.book_id, prev.file_path);
  if (!body) return '（未读取到上一章正文）';
  const tail = body.length > maxChars ? `...${body.slice(-maxChars)}` : body;
  return `上一章（第${prev.chapter}章《${prev.title}》）末尾：\n${tail}`;
}
