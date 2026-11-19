import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeConfig } from './config.js';
import {
  ensureBookDirs,
  getBookPaths,
  loadBookState,
  padChapter,
  readChapterBody,
  sanitizeFilename,
} from './memory/store.js';

export interface ExportResult {
  exportDir: string;
  chapterFiles: string[];
  mergedTxtPath: string;
  summaryPath: string;
  totalChineseChars: number;
}

export function formatFanqieTxt(body: string): string {
  const paragraphs = body
    .replace(/\r\n/g, '\n')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return paragraphs.map((p) => `　　${p}`).join('\n\n');
}

export function exportBookForFanqie(params: {
  bookId: string;
  runtime: RuntimeConfig;
}): ExportResult {
  const { bookId, runtime } = params;
  const state = loadBookState(runtime.workspaceDir, bookId);
  const paths = getBookPaths(runtime.workspaceDir, bookId);
  ensureBookDirs(paths);

  const chaptersExportDir = path.join(paths.exportDir, 'chapters_txt');
  fs.mkdirSync(chaptersExportDir, { recursive: true });

  const exportedChapters = state.chapters
    .filter((c) => c.file_path && (c.status === 'committed' || c.status === 'needs_review'))
    .sort((a, b) => a.chapter - b.chapter);

  const chapterFiles: string[] = [];
  const mergedBlocks: string[] = [];
  let totalChineseChars = 0;

  for (const ch of exportedChapters) {
    const rawBody = readChapterBody(runtime.workspaceDir, bookId, ch.file_path!);
    const cleanBody = formatFanqieTxt(rawBody);
    const heading = `第${ch.chapter}章 ${ch.title}`;
    const filePath = path.join(
      chaptersExportDir,
      `${padChapter(ch.chapter)}_${sanitizeFilename(ch.title)}.txt`,
    );
    fs.writeFileSync(filePath, `${heading}\n\n${cleanBody}\n`, 'utf-8');
    chapterFiles.push(filePath);
    mergedBlocks.push(`${heading}\n\n${cleanBody}`);
    totalChineseChars += ch.chinese_chars ?? 0;
  }

  const mergedTxtPath = path.join(
    paths.exportDir,
    `${sanitizeFilename(state.foundation.title)}_番茄投稿合集.txt`,
  );
  fs.writeFileSync(mergedTxtPath, mergedBlocks.join('\n\n\n'), 'utf-8');

  const summaryLines = [
    `# 《${state.foundation.title}》番茄 2 万字签约投稿摘要`,
    '',
    `## 作品基本信息`,
    `- **书籍 ID**：${state.book_id}`,
    `- **配方**：${state.recipe}`,
    `- **题材**：${state.foundation.genre}`,
    `- **候选书名**：${state.foundation.title_candidates.join(' / ')}`,
    `- **简介**：\n\n> ${state.foundation.blurb}`,
    '',
    `## 签约体量与质检汇总`,
    `- **已导出章数**：${exportedChapters.length} 章`,
    `- **有效总汉字数**：${totalChineseChars} 字（番茄签约门槛：20,000 字）`,
    `- **赛马锁定版本**：${state.selected_race_variant || '未运行赛马'}`,
    `- **累计 Token 消耗**：输入 ${state.cost.total_prompt_tokens.toLocaleString()} / 输出 ${state.cost.total_completion_tokens.toLocaleString()}`,
    `- **估算总费用**：¥${state.cost.total_cost_cny.toFixed(4)}`,
    '',
    `## 逐章清单`,
    `| 章节 | 标题 | 状态 | 汉字数 | Linter | Critic 评分 | 重写次数 |`,
    `| :--- | :--- | :--- | ---: | :---: | ---: | ---: |`,
    ...exportedChapters.map(
      (c) =>
        `| 第${c.chapter}章 | ${c.title} | ${c.status} | ${c.chinese_chars ?? '-'} | ${c.lint_passed === undefined ? '-' : c.lint_passed ? 'PASS' : 'FAIL'} | ${c.critic_score ?? '-'} | ${c.retries} |`,
    ),
    '',
  ];

  const summaryPath = path.join(paths.exportDir, 'summary.md');
  fs.writeFileSync(summaryPath, summaryLines.join('\n'), 'utf-8');

  return {
    exportDir: paths.exportDir,
    chapterFiles,
    mergedTxtPath,
    summaryPath,
    totalChineseChars,
  };
}
