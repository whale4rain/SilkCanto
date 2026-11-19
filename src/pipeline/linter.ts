import type { AntiSlopConfig } from '../config.js';
import type { LintIssue, LintResult, TextMetrics } from '../memory/schema.js';

const CHINESE_CHAR_RE = /[\u4e00-\u9fff]/g;
const DIALOGUE_RE = /[“"]([^”"\n]+)[”"]/g;
const EM_DASH_RE = /——|--/g;
const NOT_BUT_RE = /(?:不是[^。！？\n]{1,28}而是|与其说?[^。！？\n]{1,24}不如)/g;
const MECHANIC_SHELL_RE =
  /(?:不仅[^。！？\n]{1,24}而且|既有[^。！？\n]{1,20}又有|首先[^。！？\n]{1,35}其次)/g;

export function countChineseChars(text: string): number {
  const matches = text.match(CHINESE_CHAR_RE);
  return matches ? matches.length : 0;
}

export function analyzeTextMetrics(
  text: string,
  antiSlop?: AntiSlopConfig,
): TextMetrics {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  const paragraphs = cleaned
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chineseChars = countChineseChars(cleaned);
  const totalChars = cleaned.replace(/\s+/g, '').length;

  const paragraphLengths = paragraphs.map((p) => countChineseChars(p));
  const avgParagraphChars =
    paragraphs.length > 0
      ? Number(
          (
            paragraphLengths.reduce((acc, n) => acc + n, 0) / paragraphs.length
          ).toFixed(1),
        )
      : 0;
  const maxParagraphChars =
    paragraphLengths.length > 0 ? Math.max(...paragraphLengths) : 0;
  const longLimit = antiSlop?.limits.max_paragraph_chars ?? 180;
  const longParagraphCount = paragraphLengths.filter((n) => n > longLimit).length;

  let dialogueChars = 0;
  for (const match of cleaned.matchAll(DIALOGUE_RE)) {
    dialogueChars += countChineseChars(match[1] || '');
  }
  const dialogueRatio =
    chineseChars > 0 ? Number((dialogueChars / chineseChars).toFixed(3)) : 0;

  const sentences = cleaned
    .split(/[。！？!?…\n]+/)
    .map((s) => countChineseChars(s))
    .filter((n) => n > 0);
  const shortSentenceCount = sentences.filter((n) => n <= 20).length;
  const shortSentenceRatio =
    sentences.length > 0
      ? Number((shortSentenceCount / sentences.length).toFixed(3))
      : 0;

  const emDashCount = (cleaned.match(EM_DASH_RE) || []).length;
  const notButCount =
    (cleaned.match(NOT_BUT_RE) || []).length +
    (cleaned.match(MECHANIC_SHELL_RE) || []).length;

  const bannedHits: Record<string, number> = {};
  for (const phrase of antiSlop?.banned_phrases ?? []) {
    const count = countOccurrences(cleaned, phrase);
    if (count > 0) bannedHits[phrase] = count;
  }

  const clicheHits: Record<string, number> = {};
  for (const phrase of antiSlop?.cliche_phrases ?? []) {
    const count = countOccurrences(cleaned, phrase);
    if (count > 0) clicheHits[phrase] = count;
  }

  return {
    chinese_chars: chineseChars,
    total_chars: totalChars,
    paragraph_count: paragraphs.length,
    avg_paragraph_chars: avgParagraphChars,
    max_paragraph_chars: maxParagraphChars,
    long_paragraph_count: longParagraphCount,
    dialogue_ratio: dialogueRatio,
    short_sentence_ratio: shortSentenceRatio,
    em_dash_count: emDashCount,
    not_but_count: notButCount,
    banned_hits: bannedHits,
    cliche_hits: clicheHits,
  };
}

export function lintChapterText(
  text: string,
  antiSlop: AntiSlopConfig,
): LintResult {
  const metrics = analyzeTextMetrics(text, antiSlop);
  const issues: LintIssue[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let score = 10;

  // 1. 字数门禁
  if (metrics.chinese_chars < antiSlop.limits.min_chars) {
    issues.push({
      rule: 'min_chars',
      severity: 'error',
      message: `正文有效汉字 ${metrics.chinese_chars} 字，低于下限 ${antiSlop.limits.min_chars} 字`,
    });
    score -= 2.5;
  } else if (metrics.chinese_chars > antiSlop.limits.max_chars) {
    issues.push({
      rule: 'max_chars',
      severity: 'warning',
      message: `正文有效汉字 ${metrics.chinese_chars} 字，超过建议上限 ${antiSlop.limits.max_chars} 字`,
    });
    score -= 0.8;
  }

  // 2. 对话占比
  if (metrics.dialogue_ratio < antiSlop.limits.min_dialogue_ratio) {
    issues.push({
      rule: 'dialogue_ratio',
      severity: 'error',
      message: `对话占比 ${(metrics.dialogue_ratio * 100).toFixed(1)}%，低于阈值 ${(antiSlop.limits.min_dialogue_ratio * 100).toFixed(0)}%，叙述过重易显枯燥`,
    });
    score -= 1.5;
  }

  // 3. 手机端长段落检查
  if (metrics.long_paragraph_count > antiSlop.limits.max_long_paragraphs) {
    issues.push({
      rule: 'long_paragraphs',
      severity: 'error',
      message: `发现 ${metrics.long_paragraph_count} 个超过 ${antiSlop.limits.max_paragraph_chars} 字的砖头长段（上限 ${antiSlop.limits.max_long_paragraphs} 个），影响手机端阅读`,
    });
    score -= 1.5;
  }

  // 4. 破折号与否定排比滥用
  if (metrics.em_dash_count > antiSlop.limits.max_em_dash_count) {
    issues.push({
      rule: 'em_dash_overuse',
      severity: 'warning',
      message: `破折号出现 ${metrics.em_dash_count} 次（建议 ≤ ${antiSlop.limits.max_em_dash_count} 次），易显翻译腔`,
    });
    score -= 0.7;
  }

  if (metrics.not_but_count > antiSlop.limits.max_not_but_count) {
    issues.push({
      rule: 'not_but_overuse',
      severity: 'error',
      message: `“不是……而是……”否定排比出现 ${metrics.not_but_count} 次（上限 ${antiSlop.limits.max_not_but_count} 次），AI 腔过重`,
    });
    score -= 1.5;
  }

  // 5. 绝对禁止的讲义腔 / AI 总结腔
  for (const [phrase, count] of Object.entries(metrics.banned_hits)) {
    const lineNum = findFirstLine(lines, phrase);
    issues.push({
      rule: 'banned_phrase',
      severity: 'error',
      message: `命中禁用 AI 腔词“${phrase}” ${count} 次`,
      line: lineNum,
      snippet: lineNum ? lines[lineNum - 1]?.trim().slice(0, 60) : undefined,
    });
    score -= 1.5 * count;
  }

  // 6. 高频网文 AI 套话密度
  const totalCliche = Object.values(metrics.cliche_hits).reduce((a, b) => a + b, 0);
  for (const [phrase, count] of Object.entries(metrics.cliche_hits)) {
    if (count > antiSlop.limits.max_single_cliche) {
      const lineNum = findFirstLine(lines, phrase);
      issues.push({
        rule: 'cliche_repeat',
        severity: 'error',
        message: `AI 套话“${phrase}”单章重复 ${count} 次（单词上限 ${antiSlop.limits.max_single_cliche}）`,
        line: lineNum,
      });
      score -= 1.0;
    }
  }
  if (totalCliche > antiSlop.limits.max_cliche_total) {
    const summary = Object.entries(metrics.cliche_hits)
      .map(([k, v]) => `${k}×${v}`)
      .join('、');
    issues.push({
      rule: 'cliche_total',
      severity: 'error',
      message: `高频 AI 套话总计 ${totalCliche} 次（上限 ${antiSlop.limits.max_cliche_total}）：${summary}`,
    });
    score -= 1.5;
  }

  const boundedScore = Number(Math.max(1, Math.min(10, score)).toFixed(1));
  const hasError = issues.some((i) => i.severity === 'error');
  return {
    passed: !hasError,
    score: boundedScore,
    metrics,
    issues,
  };
}

export function formatLintSummary(result: LintResult): string {
  const m = result.metrics;
  const header = [
    `Linter 判定：${result.passed ? '通过' : '未通过'}（得分 ${result.score}/10）`,
    `统计：${m.chinese_chars} 汉字 | ${m.paragraph_count} 段（均长 ${m.avg_paragraph_chars} 字，最长 ${m.max_paragraph_chars} 字）| 对话占比 ${(m.dialogue_ratio * 100).toFixed(1)}% | 短句占比 ${(m.short_sentence_ratio * 100).toFixed(1)}%`,
  ];
  if (result.issues.length === 0) {
    header.push('问题清单：无');
  } else {
    header.push('问题清单：');
    for (const issue of result.issues) {
      const loc = issue.line ? ` [第${issue.line}行]` : '';
      header.push(`- [${issue.severity.toUpperCase()}] (${issue.rule})${loc} ${issue.message}`);
    }
  }
  return header.join('\n');
}

function countOccurrences(text: string, sub: string): number {
  if (!sub) return 0;
  let count = 0;
  let idx = text.indexOf(sub);
  while (idx !== -1) {
    count += 1;
    idx = text.indexOf(sub, idx + sub.length);
  }
  return count;
}

function findFirstLine(lines: string[], phrase: string): number | undefined {
  const idx = lines.findIndex((line) => line.includes(phrase));
  return idx >= 0 ? idx + 1 : undefined;
}
