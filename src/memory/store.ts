import fs from 'node:fs';
import path from 'node:path';
import {
  BookStateSchema,
  CheckpointSchema,
  type BeatSheet,
  type BookState,
  type Checkpoint,
  type CostRecord,
} from './schema.js';

export interface BookPaths {
  root: string;
  stateFile: string;
  contextFile: string;
  checkpointsDir: string;
  raceDir: string;
  outlinesDir: string;
  chaptersDir: string;
  reportsDir: string;
  exportDir: string;
}

export function getBookPaths(workspaceDir: string, bookId: string): BookPaths {
  const root = path.join(workspaceDir, 'books', bookId);
  return {
    root,
    stateFile: path.join(root, 'state.json'),
    contextFile: path.join(root, 'context.md'),
    checkpointsDir: path.join(root, 'checkpoints'),
    raceDir: path.join(root, 'race'),
    outlinesDir: path.join(root, 'outlines'),
    chaptersDir: path.join(root, 'chapters'),
    reportsDir: path.join(root, 'reports'),
    exportDir: path.join(root, 'export'),
  };
}

export function ensureBookDirs(paths: BookPaths): void {
  const dirs = [
    paths.root,
    paths.checkpointsDir,
    paths.raceDir,
    paths.outlinesDir,
    paths.chaptersDir,
    paths.reportsDir,
    paths.exportDir,
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function padChapter(num: number): string {
  return String(num).padStart(3, '0');
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'untitled';
}

export function loadBookState(workspaceDir: string, bookId: string): BookState {
  const paths = getBookPaths(workspaceDir, bookId);
  if (!fs.existsSync(paths.stateFile)) {
    throw new Error(`书籍 "${bookId}" 不存在，请先运行 silkcanto init ${bookId}`);
  }
  const raw = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8'));
  return BookStateSchema.parse(raw);
}

export function saveBookState(workspaceDir: string, state: BookState): void {
  const paths = getBookPaths(workspaceDir, state.book_id);
  ensureBookDirs(paths);
  state.updated_at = new Date().toISOString();
  const validated = BookStateSchema.parse(state);
  const tmpFile = `${paths.stateFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(validated, null, 2), 'utf-8');
  fs.renameSync(tmpFile, paths.stateFile);
  writeContextSnapshot(paths, validated);
}

export function recordCost(state: BookState, record: CostRecord): void {
  state.cost.total_prompt_tokens += record.prompt_tokens;
  state.cost.total_completion_tokens += record.completion_tokens;
  state.cost.total_cost_cny = Number(
    (state.cost.total_cost_cny + record.estimated_cost_cny).toFixed(6),
  );
  state.cost.calls.push(record);
}

export function writeCheckpoint(
  workspaceDir: string,
  bookId: string,
  chapter: number,
  step: string,
  metadata: Record<string, unknown> = {},
): Checkpoint {
  const paths = getBookPaths(workspaceDir, bookId);
  ensureBookDirs(paths);
  const cp: Checkpoint = CheckpointSchema.parse({
    book_id: bookId,
    chapter,
    step,
    timestamp: new Date().toISOString(),
    metadata,
  });
  const file = path.join(paths.checkpointsDir, `ch${padChapter(chapter)}_${step}.json`);
  fs.writeFileSync(file, JSON.stringify(cp, null, 2), 'utf-8');
  return cp;
}

export function readLatestCheckpoint(workspaceDir: string, bookId: string): Checkpoint | undefined {
  const paths = getBookPaths(workspaceDir, bookId);
  if (!fs.existsSync(paths.checkpointsDir)) return undefined;
  const files = fs
    .readdirSync(paths.checkpointsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(paths.checkpointsDir, f);
      return { full, data: CheckpointSchema.parse(JSON.parse(fs.readFileSync(full, 'utf-8'))) };
    })
    .sort((a, b) => a.data.timestamp.localeCompare(b.data.timestamp));
  return files.at(-1)?.data;
}

export function saveBeatSheet(workspaceDir: string, bookId: string, beat: BeatSheet): string {
  const paths = getBookPaths(workspaceDir, bookId);
  ensureBookDirs(paths);
  const file = path.join(paths.outlinesDir, `beat_${padChapter(beat.chapter)}.json`);
  fs.writeFileSync(file, JSON.stringify(beat, null, 2), 'utf-8');
  return file;
}

export function loadBeatSheet(
  workspaceDir: string,
  bookId: string,
  chapter: number,
): BeatSheet | undefined {
  const paths = getBookPaths(workspaceDir, bookId);
  const file = path.join(paths.outlinesDir, `beat_${padChapter(chapter)}.json`);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as BeatSheet;
}

export function saveChapterText(
  workspaceDir: string,
  bookId: string,
  chapter: number,
  title: string,
  content: string,
): string {
  const paths = getBookPaths(workspaceDir, bookId);
  ensureBookDirs(paths);
  const fileName = `${padChapter(chapter)}_${sanitizeFilename(title)}.md`;
  const file = path.join(paths.chaptersDir, fileName);
  const body = `# 第${chapter}章 ${title}\n\n${content.trim()}\n`;
  fs.writeFileSync(file, body, 'utf-8');
  return path.relative(paths.root, file);
}

export function readChapterBody(workspaceDir: string, bookId: string, relPath: string): string {
  const paths = getBookPaths(workspaceDir, bookId);
  const full = path.join(paths.root, relPath);
  if (!fs.existsSync(full)) return '';
  const raw = fs.readFileSync(full, 'utf-8');
  // 去掉首行 Markdown 标题，返回纯正文
  return raw.replace(/^#\s+.*\n+/, '').trim();
}

export function saveJsonReport(
  workspaceDir: string,
  bookId: string,
  fileName: string,
  data: unknown,
): string {
  const paths = getBookPaths(workspaceDir, bookId);
  ensureBookDirs(paths);
  const full = path.join(paths.reportsDir, fileName);
  fs.writeFileSync(full, JSON.stringify(data, null, 2), 'utf-8');
  return full;
}

export function listAllBookIds(workspaceDir: string): string[] {
  const booksDir = path.join(workspaceDir, 'books');
  if (!fs.existsSync(booksDir)) return [];
  return fs
    .readdirSync(booksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(booksDir, entry.name, 'state.json')))
    .map((entry) => entry.name)
    .sort();
}

export function writeContextSnapshot(paths: BookPaths, state: BookState): void {
  const lines: string[] = [
    `# ${state.foundation.title}（${state.book_id}）运行态上下文视图`,
    '',
    `> 此文件由 \`state.json\` 自动渲染生成，请勿直接手工修改派生内容。`,
    '',
    `## 基础设定`,
    `- 赛道配方：${state.recipe}`,
    `- 当前阶段：${state.phase}`,
    `- 核心卖点：${state.foundation.core_selling_point}`,
    `- 金手指：${state.foundation.golden_finger_name} — ${state.foundation.golden_finger_rules}`,
    `- 金手指限制：${state.foundation.golden_finger_limits}`,
    '',
    `## 角色状态`,
    ...state.characters.map(
      (c) =>
        `- **${c.name}**（${c.role}）| 性格：${c.personality} | 状态：${c.current_status} | 关系：${c.relationship_to_mc}`,
    ),
    '',
    `## 道具与资源`,
    ...(state.assets.length > 0
      ? state.assets.map(
          (a) => `- **${a.name}**（持有：${a.owner}，${a.quantity_or_level}，${a.status}）：${a.description}`,
        )
      : ['- 暂无']),
    '',
    `## 伏笔追踪`,
    ...(state.foreshadowing.length > 0
      ? state.foreshadowing.map(
          (f) => `- [${f.status}] (${f.id}, 第${f.planted_chapter}章) ${f.summary} -> ${f.payoff_plan}`,
        )
      : ['- 暂无']),
    '',
    `## 双时间线：作者真相（未公开信息禁止角色提前剧透）`,
    ...state.author_truth.map((t) => `- [第${t.chapter}章] ${t.fact}`),
    '',
    `## 双时间线：读者与主角已知事实`,
    ...state.reader_known.map((k) => `- [第${k.chapter}章] ${k.fact}`),
    '',
  ];
  fs.writeFileSync(paths.contextFile, lines.join('\n'), 'utf-8');
}
