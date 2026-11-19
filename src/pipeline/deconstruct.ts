import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  loadRecipe,
  renderTemplate,
  type RuntimeConfig,
} from '../config.js';
import type { LLMClient } from '../core/llm.js';
import {
  DeconstructDNASchema,
  type CostRecord,
  type DeconstructDNA,
  type TextMetrics,
} from '../memory/schema.js';
import { analyzeTextMetrics } from './linter.js';

export interface SampleChapter {
  index: number;
  fileName: string;
  title: string;
  content: string;
  metrics: TextMetrics;
}

export interface QuantitativeAggregate {
  chapterCount: number;
  avgChineseChars: number;
  minChineseChars: number;
  maxChineseChars: number;
  avgDialogueRatio: number;
  avgParagraphChars: number;
  avgShortSentenceRatio: number;
  chapters: Array<{
    index: number;
    title: string;
    chinese_chars: number;
    dialogue_ratio: number;
    avg_paragraph_chars: number;
    max_paragraph_chars: number;
  }>;
}

export interface DeconstructOutput {
  sourceName: string;
  quantitative: QuantitativeAggregate;
  dna: DeconstructDNA;
  reportPath: string;
  dnaPath: string;
  recipePath?: string;
  cost: CostRecord;
}

const CHAPTER_HEADING_RE =
  /^[ \t\u3000]*(?:#{1,3}\s*)?(第[零一二三四五六七八九十百千万0-9]+[章回节](?:[\s\u3000:：\-—].*)?)$/gm;

// 单文件拆书只读取前 180KB 切片（足够覆盖前 10-15 章，避免读取几十 MB 整本小说）
const MAX_SINGLE_FILE_BYTES = 180 * 1024;

function readFileHeadAutoDecode(filePath: string, maxBytes = MAX_SINGLE_FILE_BYTES): string {
  const stat = fs.statSync(filePath);
  const bytesToRead = Math.min(stat.size, maxBytes);
  const buf = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, bytesToRead, 0);
  } finally {
    fs.closeSync(fd);
  }

  // 若发生截断，去掉末尾最多 3 字节以防多字节字符被腰斩
  const safeSlice =
    stat.size > maxBytes && buf.length > 4
      ? buf.subarray(0, buf.length - 4)
      : buf;

  // 优先尝试严格 UTF-8 解码，失败则自动回退 GB18030（兼容绝大多数中文 TXT）
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(safeSlice);
  } catch {
    return new TextDecoder('gb18030').decode(safeSlice);
  }
}

export function loadReferenceChapters(
  refInputPath: string,
  maxChapters = 10,
): {
  sourceName: string;
  chapters: SampleChapter[];
} {
  const resolved = path.resolve(refInputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`参考样章路径不存在：${resolved}`);
  }

  const stat = fs.statSync(resolved);
  const sourceName = path.basename(resolved, path.extname(resolved));
  const rawChapters: Array<{ fileName: string; title: string; content: string }> = [];

  if (stat.isDirectory()) {
    const files = fs
      .readdirSync(resolved)
      .filter((f) => f.endsWith('.txt') || f.endsWith('.md'))
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));

    for (const file of files) {
      if (rawChapters.length >= maxChapters) break;
      const content = readFileHeadAutoDecode(path.join(resolved, file)).trim();
      if (!content) continue;
      const split = splitIfMultiChapter(file, content);
      rawChapters.push(...split);
    }
  } else {
    const content = readFileHeadAutoDecode(resolved).trim();
    if (content) {
      rawChapters.push(...splitIfMultiChapter(path.basename(resolved), content));
    }
  }

  if (rawChapters.length === 0) {
    throw new Error(`在 ${resolved} 未找到有效的 .txt 或 .md 样章内容`);
  }

  const chapters: SampleChapter[] = rawChapters.slice(0, maxChapters).map((ch, i) => ({
    index: i + 1,
    fileName: ch.fileName,
    title: ch.title,
    content: ch.content,
    metrics: analyzeTextMetrics(ch.content),
  }));

  return { sourceName, chapters };
}

function splitIfMultiChapter(
  fileName: string,
  content: string,
): Array<{ fileName: string; title: string; content: string }> {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const matches = [...normalized.matchAll(CHAPTER_HEADING_RE)];
  if (matches.length <= 1) {
    const title = matches[0]?.[1]?.trim() || fileName.replace(/\.(txt|md)$/i, '');
    const body = normalized.replace(/^#\s+.*\n+/, '').trim();
    return [{ fileName, title, content: body }];
  }

  const results: Array<{ fileName: string; title: string; content: string }> = [];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]!;
    const next = matches[i + 1];
    const startIdx = (current.index ?? 0) + current[0].length;
    const endIdx = next?.index ?? normalized.length;
    // 若最后一段是因文件切片截断导致的不完整章，跳过它
    if (!next && endIdx - startIdx < 500) continue;
    const body = normalized.slice(startIdx, endIdx).trim();
    if (body.length > 100) {
      results.push({
        fileName,
        title: current[1]!.trim(),
        content: body,
      });
    }
  }
  return results;
}

export function aggregateQuantitativeStats(
  chapters: SampleChapter[],
): QuantitativeAggregate {
  const charCounts = chapters.map((c) => c.metrics.chinese_chars);
  const avg = (arr: number[]) =>
    arr.length > 0
      ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3))
      : 0;

  return {
    chapterCount: chapters.length,
    avgChineseChars: Math.round(avg(charCounts)),
    minChineseChars: Math.min(...charCounts),
    maxChineseChars: Math.max(...charCounts),
    avgDialogueRatio: avg(chapters.map((c) => c.metrics.dialogue_ratio)),
    avgParagraphChars: Number(
      avg(chapters.map((c) => c.metrics.avg_paragraph_chars)).toFixed(1),
    ),
    avgShortSentenceRatio: avg(
      chapters.map((c) => c.metrics.short_sentence_ratio),
    ),
    chapters: chapters.map((c) => ({
      index: c.index,
      title: c.title,
      chinese_chars: c.metrics.chinese_chars,
      dialogue_ratio: c.metrics.dialogue_ratio,
      avg_paragraph_chars: c.metrics.avg_paragraph_chars,
      max_paragraph_chars: c.metrics.max_paragraph_chars,
    })),
  };
}

export function formatQuantitativeSummary(agg: QuantitativeAggregate): string {
  const lines = [
    `样章数量：${agg.chapterCount} 章`,
    `单章字数：均值 ${agg.avgChineseChars} 字（范围 ${agg.minChineseChars}–${agg.maxChineseChars} 字）`,
    `平均对话占比：${(agg.avgDialogueRatio * 100).toFixed(1)}%`,
    `平均段落长度：${agg.avgParagraphChars} 字`,
    `短句比例（≤20字）：${(agg.avgShortSentenceRatio * 100).toFixed(1)}%`,
    '逐章指标：',
    ...agg.chapters.map(
      (c) =>
        `- 第${c.index}章《${c.title}》：${c.chinese_chars}字 | 对话${(c.dialogue_ratio * 100).toFixed(1)}% | 均段${c.avg_paragraph_chars}字（最长${c.max_paragraph_chars}字）`,
    ),
  ];
  return lines.join('\n');
}

export async function runDeconstruct(params: {
  refPath: string;
  runtime: RuntimeConfig;
  llm: LLMClient;
  baseRecipeName?: string;
  outRecipeName?: string;
}): Promise<DeconstructOutput> {
  const { sourceName, chapters } = loadReferenceChapters(params.refPath);
  const quantitative = aggregateQuantitativeStats(chapters);
  const quantSummary = formatQuantitativeSummary(quantitative);

  const baseRecipeName = params.baseRecipeName || 'fanqie_urban_brainhole';
  const baseRecipe = loadRecipe(baseRecipeName, params.runtime.recipesDir);

  // 控制送入 LLM 的参考样章总长度（约 12000 字，覆盖完整的黄金三章 + 首个高潮闭环，前 10 章定量统计已全部注入）
  let sampleBudget = 12000;
  const sampleChunks: string[] = [];
  for (const ch of chapters) {
    if (sampleBudget <= 0) break;
    const excerpt =
      ch.content.length > sampleBudget
        ? `${ch.content.slice(0, sampleBudget)}\n...(本章后段已截断)`
        : ch.content;
    sampleChunks.push(`### 第${ch.index}章 ${ch.title}\n\n${excerpt}`);
    sampleBudget -= excerpt.length;
  }

  const promptTemplate =
    baseRecipe.prompts.deconstruct ||
    '请分析以下网文样章的结构与节奏基因：\n{{quantitative_summary}}\n\n{{sample_text}}';
  const prompt = renderTemplate(promptTemplate, {
    quantitative_summary: quantSummary,
    sample_text: sampleChunks.join('\n\n---\n\n'),
  });

  const { object: dna, cost } = await params.llm.generateObject({
    stage: 'deconstruct',
    recipe: baseRecipe.config,
    schema: DeconstructDNASchema,
    prompt,
  });

  dna.source_name = sourceName;

  const outDir = path.join(params.runtime.workspaceDir, 'deconstruct', sourceName);
  fs.mkdirSync(outDir, { recursive: true });

  const dnaPath = path.join(outDir, 'dna.json');
  fs.writeFileSync(
    dnaPath,
    JSON.stringify({ quantitative, dna, cost }, null, 2),
    'utf-8',
  );

  const reportPath = path.join(outDir, 'analysis.md');
  fs.writeFileSync(reportPath, renderAnalysisMarkdown(sourceName, quantitative, dna), 'utf-8');

  let recipePath: string | undefined;
  if (params.outRecipeName) {
    recipePath = materializeRecipeFromDNA({
      baseRecipeDir: baseRecipe.dir,
      targetRecipeDir: path.join(params.runtime.recipesDir, params.outRecipeName),
      recipeName: params.outRecipeName,
      dna,
      quantitative,
    });
  }

  return {
    sourceName,
    quantitative,
    dna,
    reportPath,
    dnaPath,
    recipePath,
    cost,
  };
}

function renderAnalysisMarkdown(
  sourceName: string,
  agg: QuantitativeAggregate,
  dna: DeconstructDNA,
): string {
  return [
    `# 拆书分析报告：${sourceName}`,
    '',
    `## 一、定量节奏指标（代码实测）`,
    formatQuantitativeSummary(agg),
    '',
    `## 二、爆款核心卖点与开篇切入`,
    `- **赛道判断**：${dna.genre_guess}`,
    `- **核心情绪爽点**：${dna.core_emotion_hook}`,
    `- **开篇前 500 字切入策略**：${dna.opening_500_strategy}`,
    `- **金手指亮相时机**：${dna.golden_finger_reveal_timing}`,
    '',
    `## 三、黄金三章情绪弧线`,
    ...dna.golden_three_arcs.map(
      (a) =>
        `- **第 ${a.chapter_index} 章**：职责=${a.function} | 情绪曲线=${a.emotion_arc} | 断章钩子=${a.cliffhanger_technique}`,
    ),
    '',
    `## 四、人设反差公式`,
    ...dna.character_contrast_formula.map((s) => `- ${s}`),
    '',
    `## 五、高频章末钩子手法`,
    ...dna.cliffhanger_patterns.map((s) => `- ${s}`),
    '',
    `## 六、语言质感与避坑点`,
    '### 值得复用',
    ...dna.prose_features.map((s) => `- ${s}`),
    '### 规避雷区',
    ...dna.pitfalls_to_avoid.map((s) => `- ${s}`),
    '',
    `## 七、建议写入配方的量化目标`,
    `- 单章字数：${dna.recommended_targets.min_chars}–${dna.recommended_targets.max_chars} 字`,
    `- 最低对话占比：${(dna.recommended_targets.min_dialogue_ratio * 100).toFixed(0)}%`,
    `- 手机端段落上限：${dna.recommended_targets.max_paragraph_chars} 字`,
    '',
  ].join('\n');
}

function materializeRecipeFromDNA(params: {
  baseRecipeDir: string;
  targetRecipeDir: string;
  recipeName: string;
  dna: DeconstructDNA;
  quantitative: QuantitativeAggregate;
}): string {
  const { baseRecipeDir, targetRecipeDir, recipeName, dna, quantitative } = params;
  fs.mkdirSync(targetRecipeDir, { recursive: true });

  // 复制提示词目录（如目标非同一目录）
  const basePrompts = path.join(baseRecipeDir, 'prompts');
  const targetPrompts = path.join(targetRecipeDir, 'prompts');
  if (path.resolve(basePrompts) !== path.resolve(targetPrompts) && fs.existsSync(basePrompts)) {
    fs.cpSync(basePrompts, targetPrompts, { recursive: true });
  }

  // 更新 recipe.yaml
  const baseRecipeYaml = YAML.parse(
    fs.readFileSync(path.join(baseRecipeDir, 'recipe.yaml'), 'utf-8'),
  );
  baseRecipeYaml.name = recipeName;
  baseRecipeYaml.display_name = `${dna.genre_guess}（源自拆书：${dna.source_name}）`;
  baseRecipeYaml.genre = dna.genre_guess;
  baseRecipeYaml.targets.chapter_min_chars = Math.max(
    1800,
    dna.recommended_targets.min_chars,
  );
  baseRecipeYaml.targets.chapter_max_chars = Math.max(
    baseRecipeYaml.targets.chapter_min_chars + 400,
    dna.recommended_targets.max_chars,
  );
  fs.writeFileSync(
    path.join(targetRecipeDir, 'recipe.yaml'),
    YAML.stringify(baseRecipeYaml),
    'utf-8',
  );

  // 更新 anti_slop.yaml 量化阈值
  const baseAntiSlopPath = path.join(baseRecipeDir, 'anti_slop.yaml');
  if (fs.existsSync(baseAntiSlopPath)) {
    const antiSlop = YAML.parse(fs.readFileSync(baseAntiSlopPath, 'utf-8'));
    antiSlop.limits.min_chars = Math.max(
      1700,
      dna.recommended_targets.min_chars - 100,
    );
    antiSlop.limits.max_chars = Math.max(
      2600,
      dna.recommended_targets.max_chars + 300,
    );
    antiSlop.limits.min_dialogue_ratio = Number(
      Math.max(
        0.15,
        Math.min(0.4, dna.recommended_targets.min_dialogue_ratio),
      ).toFixed(2),
    );
    antiSlop.limits.max_paragraph_chars = Math.max(
      140,
      Math.min(220, dna.recommended_targets.max_paragraph_chars),
    );
    fs.writeFileSync(
      path.join(targetRecipeDir, 'anti_slop.yaml'),
      YAML.stringify(antiSlop),
      'utf-8',
    );
  }

  // 将拆书 DNA 写入配方目录，init 阶段会自动注入
  fs.writeFileSync(
    path.join(targetRecipeDir, 'dna.json'),
    JSON.stringify({ quantitative, dna }, null, 2),
    'utf-8',
  );

  return targetRecipeDir;
}
