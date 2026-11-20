import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getRuntimeConfig,
  loadRecipe,
  type RuntimeConfig,
} from './config.js';
import { runChapterPipeline } from './core/engine.js';
import { formatCostTelemetry, VercelLLMClient } from './core/llm.js';
import { exportBookForFanqie } from './exporter.js';
import type { BookState, CostRecord } from './memory/schema.js';
import {
  getBookPaths,
  listAllBookIds,
  loadBeatSheet,
  loadBookState,
  padChapter,
  readChapterBody,
  readLatestCheckpoint,
  saveBookState,
  saveChapterText,
} from './memory/store.js';
import {
  aggregateQuantitativeStats,
  formatQuantitativeSummary,
  loadReferenceChapters,
  runDeconstruct,
} from './pipeline/deconstruct.js';
import { runFoundationInit } from './pipeline/foundation.js';
import { lintChapterText } from './pipeline/linter.js';
import { runOpeningRace, selectRaceVariant } from './pipeline/racer.js';

interface JobRecord {
  id: string;
  type: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  cancelled: boolean;
  logs: string[];
  result?: unknown;
  error?: string;
  clients: Set<ServerResponse>;
}

const jobs = new Map<string, JobRecord>();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveWebRoot(): string {
  const candidates = [
    path.resolve(process.cwd(), 'web'),
    path.resolve(__dirname, '../web'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  throw new Error('找不到 web/ 前端静态资源目录');
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody<T = Record<string, any>>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function resolveRuntimeWithOverrides(
  base: RuntimeConfig,
  overrides?: { provider?: string; model?: string; effort?: string },
): RuntimeConfig {
  const next: RuntimeConfig = {
    ...base,
    stageModels: { ...base.stageModels },
  };
  if (overrides?.provider === 'deepseek') {
    next.apiKey = process.env.DEEPSEEK_API_KEY || base.apiKey;
    next.baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
    next.defaultModel = overrides.model?.trim() || process.env.DEEPSEEK_MODEL || 'deepseek-flash';
  } else if (overrides?.provider === 'gemini') {
    next.apiKey = process.env.SILKCANTO_API_KEY || base.apiKey;
    next.baseUrl =
      process.env.SILKCANTO_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta/openai/';
    next.defaultModel =
      overrides.model?.trim() || process.env.SILKCANTO_DEFAULT_MODEL || 'gemini-3.8-flash';
  } else if (overrides?.model?.trim()) {
    next.defaultModel = overrides.model.trim();
  }

  if (
    overrides?.effort === 'low' ||
    overrides?.effort === 'medium' ||
    overrides?.effort === 'high'
  ) {
    next.defaultReasoningEffort = overrides.effort;
  }
  return next;
}

function computeBookMetrics(st: BookState) {
  const calls = st.cost.calls;
  const committed = st.chapters.filter((c) => c.status === 'committed');
  const finalChars = committed.reduce((acc, c) => acc + (c.chinese_chars ?? 0), 0);
  const totalIn = st.cost.total_prompt_tokens;
  const totalCached = st.cost.total_cached_input_tokens;
  const totalOut = st.cost.total_completion_tokens;
  const totalReason = st.cost.total_reasoning_tokens;
  const totalTok = totalIn + totalOut;

  const stageMap = new Map<
    string,
    {
      stage: string;
      calls: number;
      inTok: number;
      cachedTok: number;
      outTok: number;
      reasonTok: number;
      durMs: number;
      retries: number;
      fallbacks: number;
    }
  >();

  for (const c of calls) {
    const prev = stageMap.get(c.stage) ?? {
      stage: c.stage,
      calls: 0,
      inTok: 0,
      cachedTok: 0,
      outTok: 0,
      reasonTok: 0,
      durMs: 0,
      retries: 0,
      fallbacks: 0,
    };
    prev.calls += 1;
    prev.inTok += c.prompt_tokens;
    prev.cachedTok += c.cached_input_tokens ?? 0;
    prev.outTok += c.completion_tokens;
    prev.reasonTok += c.reasoning_tokens ?? 0;
    prev.durMs += c.duration_ms ?? 0;
    prev.retries += c.retries ?? 0;
    prev.fallbacks += c.used_fallback ? 1 : 0;
    stageMap.set(c.stage, prev);
  }

  const chapterStats = st.chapters
    .filter((c) => c.status === 'committed' || c.status === 'needs_review')
    .map((ch) => {
      const chCalls = calls.filter((c) => c.chapter === ch.chapter);
      const inSum = chCalls.reduce((a, b) => a + b.prompt_tokens, 0);
      const cacheSum = chCalls.reduce((a, b) => a + (b.cached_input_tokens ?? 0), 0);
      const outSum = chCalls.reduce((a, b) => a + b.completion_tokens, 0);
      const reasonSum = chCalls.reduce((a, b) => a + (b.reasoning_tokens ?? 0), 0);
      const durSum = chCalls.reduce((a, b) => a + (b.duration_ms ?? 0), 0);
      const chars = ch.chinese_chars ?? 0;
      return {
        chapter: ch.chapter,
        title: ch.title,
        status: ch.status,
        chinese_chars: chars,
        calls: chCalls.length,
        in_tokens: inSum,
        cached_tokens: cacheSum,
        out_tokens: outSum,
        reasoning_tokens: reasonSum,
        tokens_per_char: chars > 0 ? Number(((inSum + outSum) / chars).toFixed(2)) : 0,
        cache_hit_rate: inSum > 0 ? Number(((cacheSum / inSum) * 100).toFixed(1)) : 0,
        duration_ms: durSum,
        critic_score: ch.critic_score ?? null,
        lint_passed: ch.lint_passed ?? null,
      };
    });

  return {
    committed_chapters: committed.length,
    planned_chapters: st.volume_plan.length,
    final_chars: finalChars,
    total_tokens: totalTok,
    total_in_tokens: totalIn,
    total_cached_tokens: totalCached,
    total_out_tokens: totalOut,
    total_reasoning_tokens: totalReason,
    tokens_per_char: finalChars > 0 ? Number((totalTok / finalChars).toFixed(2)) : 0,
    out_tokens_per_char: finalChars > 0 ? Number((totalOut / finalChars).toFixed(2)) : 0,
    cache_hit_rate: totalIn > 0 ? Number(((totalCached / totalIn) * 100).toFixed(1)) : 0,
    reasoning_ratio: totalOut > 0 ? Number(((totalReason / totalOut) * 100).toFixed(1)) : 0,
    total_duration_ms: st.cost.total_duration_ms,
    total_cost_cny: st.cost.total_cost_cny,
    stages: [...stageMap.values()],
    chapters: chapterStats,
  };
}

function createJob(type: string): JobRecord {
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const job: JobRecord = {
    id,
    type,
    status: 'running',
    cancelled: false,
    logs: [],
    clients: new Set(),
  };
  jobs.set(id, job);
  return job;
}

function pushJobEvent(job: JobRecord, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (event === 'log' && typeof data === 'string') {
    job.logs.push(data);
  }
  for (const client of job.clients) {
    client.write(payload);
  }
}

function finishJob(job: JobRecord, result?: unknown, error?: string): void {
  job.status = error ? 'error' : 'done';
  job.result = result;
  job.error = error;
  pushJobEvent(job, error ? 'job_error' : 'job_done', {
    status: job.status,
    result,
    error,
  });
  for (const client of job.clients) {
    client.end();
  }
  job.clients.clear();
}

function listReferenceCandidates(cwd: string, workspaceDir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.txt')) {
      results.push(`./${entry.name}`);
    }
  }
  const refsDir = path.join(workspaceDir, 'references');
  if (fs.existsSync(refsDir)) {
    for (const entry of fs.readdirSync(refsDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      results.push(`./workspace/references/${entry.name}`);
    }
  }
  return results;
}

function listDeconstructReports(workspaceDir: string) {
  const dir = path.join(workspaceDir, 'deconstruct');
  if (!fs.existsSync(dir)) return [];
  const items: Array<{ name: string; report: string; dna: unknown }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const reportFile = path.join(dir, entry.name, 'analysis.md');
    const dnaFile = path.join(dir, entry.name, 'dna.json');
    if (fs.existsSync(reportFile)) {
      items.push({
        name: entry.name,
        report: fs.readFileSync(reportFile, 'utf-8'),
        dna: fs.existsSync(dnaFile) ? JSON.parse(fs.readFileSync(dnaFile, 'utf-8')) : null,
      });
    }
  }
  return items;
}

function findLatestReportFile(
  reportsDir: string,
  chapterNum: number,
  kind: 'lint' | 'critic',
): unknown {
  if (!fs.existsSync(reportsDir)) return null;
  const prefix = `ch${padChapter(chapterNum)}_${kind}`;
  const files = fs
    .readdirSync(reportsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const latest = files.at(-1);
  if (!latest) return null;
  return JSON.parse(fs.readFileSync(path.join(reportsDir, latest), 'utf-8'));
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function startWebServer(options?: { port?: number; host?: string }) {
  const port = options?.port ?? 4173;
  const host = options?.host ?? '127.0.0.1';
  const webRoot = resolveWebRoot();
  const baseRuntime = getRuntimeConfig();

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || '/', `http://${host}:${port}`);
      const pathname = decodeURIComponent(urlObj.pathname);
      const method = req.method || 'GET';

      // === API Routes ===
      if (pathname === '/api/meta' && method === 'GET') {
        const recipes = fs.existsSync(baseRuntime.recipesDir)
          ? fs
              .readdirSync(baseRuntime.recipesDir, { withFileTypes: true })
              .filter(
                (e) =>
                  e.isDirectory() &&
                  fs.existsSync(path.join(baseRuntime.recipesDir, e.name, 'recipe.yaml')),
              )
              .map((e) => {
                const loaded = loadRecipe(e.name, baseRuntime.recipesDir);
                return {
                  name: loaded.config.name,
                  display_name: loaded.config.display_name,
                  genre: loaded.config.genre,
                  description: loaded.config.description,
                  has_dna: Boolean(loaded.dnaJson),
                };
              })
          : [];

        return sendJson(res, 200, {
          recipes,
          providers: {
            deepseek_configured: Boolean(process.env.DEEPSEEK_API_KEY),
            gemini_configured: Boolean(process.env.SILKCANTO_API_KEY),
            default_model: baseRuntime.defaultModel,
            default_base_url: baseRuntime.baseUrl,
          },
          references: listReferenceCandidates(process.cwd(), baseRuntime.workspaceDir),
        });
      }

      if (pathname === '/api/books' && method === 'GET') {
        const ids = listAllBookIds(baseRuntime.workspaceDir);
        const books = ids.map((id) => {
          const st = loadBookState(baseRuntime.workspaceDir, id);
          const metrics = computeBookMetrics(st);
          const latestCp = readLatestCheckpoint(baseRuntime.workspaceDir, id);
          const suspended = st.chapters
            .filter((c) => c.status === 'needs_review')
            .map((c) => c.chapter);
          return {
            book_id: st.book_id,
            title: st.foundation.title,
            genre: st.foundation.genre,
            recipe: st.recipe,
            phase: st.phase,
            updated_at: st.updated_at,
            suspended_chapters: suspended,
            latest_checkpoint: latestCp ? `ch${latestCp.chapter}:${latestCp.step}` : null,
            metrics,
          };
        });
        return sendJson(res, 200, { books });
      }

      const bookDetailMatch = pathname.match(/^\/api\/books\/([^/]+)$/);
      if (bookDetailMatch && method === 'GET') {
        const bookId = bookDetailMatch[1]!;
        const st = loadBookState(baseRuntime.workspaceDir, bookId);
        const paths = getBookPaths(baseRuntime.workspaceDir, bookId);
        const raceReportPath = path.join(paths.raceDir, 'race_report.md');
        const raceJudgePath = path.join(paths.reportsDir, 'race_judge.json');
        return sendJson(res, 200, {
          state: st,
          metrics: computeBookMetrics(st),
          race_report: fs.existsSync(raceReportPath)
            ? fs.readFileSync(raceReportPath, 'utf-8')
            : null,
          race_judge: fs.existsSync(raceJudgePath)
            ? JSON.parse(fs.readFileSync(raceJudgePath, 'utf-8'))
            : null,
        });
      }

      const chapterMatch = pathname.match(/^\/api\/books\/([^/]+)\/chapters\/(\d+)$/);
      if (chapterMatch) {
        const bookId = chapterMatch[1]!;
        const chapterNum = Number(chapterMatch[2]);
        const st = loadBookState(baseRuntime.workspaceDir, bookId);
        const paths = getBookPaths(baseRuntime.workspaceDir, bookId);
        const recipe = loadRecipe(st.recipe, baseRuntime.recipesDir);
        const rec = st.chapters.find((c) => c.chapter === chapterNum);

        if (method === 'GET') {
          const content =
            rec?.file_path ? readChapterBody(baseRuntime.workspaceDir, bookId, rec.file_path) : '';
          const liveLint = content ? lintChapterText(content, recipe.antiSlop) : null;
          const critic = findLatestReportFile(paths.reportsDir, chapterNum, 'critic');
          const beat = loadBeatSheet(baseRuntime.workspaceDir, bookId, chapterNum) ?? null;
          return sendJson(res, 200, {
            chapter: chapterNum,
            record: rec ?? null,
            content,
            lint: liveLint,
            critic,
            beat,
          });
        }

        if (method === 'PUT') {
          const body = await readJsonBody<{
            title?: string;
            content: string;
            markCommitted?: boolean;
          }>(req);
          const title = body.title?.trim() || rec?.title || `第${chapterNum}章`;
          const relPath = saveChapterText(
            baseRuntime.workspaceDir,
            bookId,
            chapterNum,
            title,
            body.content || '',
          );
          const liveLint = lintChapterText(body.content || '', recipe.antiSlop);
          if (rec) {
            rec.title = title;
            rec.file_path = relPath;
            rec.chinese_chars = liveLint.metrics.chinese_chars;
            rec.lint_passed = liveLint.passed;
            if (body.markCommitted) {
              rec.status = 'committed';
              rec.review_notes = [];
              if (st.phase === 'NEEDS_REVIEW') {
                st.phase = 'RUNNING';
              }
            }
            rec.updated_at = new Date().toISOString();
          }
          saveBookState(baseRuntime.workspaceDir, st);
          return sendJson(res, 200, {
            ok: true,
            lint: liveLint,
            record: rec ?? null,
          });
        }
      }

      const selectMatch = pathname.match(/^\/api\/books\/([^/]+)\/select$/);
      if (selectMatch && method === 'POST') {
        const bookId = selectMatch[1]!;
        const body = await readJsonBody<{ variantId: string }>(req);
        const updated = selectRaceVariant({
          bookId,
          variantId: body.variantId,
          runtime: baseRuntime,
        });
        return sendJson(res, 200, { ok: true, state: updated });
      }

      const exportMatch = pathname.match(/^\/api\/books\/([^/]+)\/export$/);
      if (exportMatch && method === 'POST') {
        const bookId = exportMatch[1]!;
        const result = exportBookForFanqie({ bookId, runtime: baseRuntime });
        const summary = fs.readFileSync(result.summaryPath, 'utf-8');
        const mergedText = fs.readFileSync(result.mergedTxtPath, 'utf-8');
        return sendJson(res, 200, { ok: true, result, summary, mergedText });
      }

      const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (cancelMatch && method === 'POST') {
        const jobId = cancelMatch[1]!;
        const job = jobs.get(jobId);
        if (!job) return sendJson(res, 404, { error: 'Job not found' });
        job.cancelled = true;
        pushJobEvent(job, 'log', '⚠ 收到停止请求：将在当前原子步骤完成后安全停止...');
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/deconstruct' && method === 'GET') {
        return sendJson(res, 200, {
          items: listDeconstructReports(baseRuntime.workspaceDir),
        });
      }

      // === Async Jobs + SSE Stream ===
      if (pathname === '/api/jobs' && method === 'POST') {
        const body = await readJsonBody<Record<string, any>>(req);
        const type = String(body.type || '');
        const job = createJob(type);
        const runtime = resolveRuntimeWithOverrides(baseRuntime, {
          provider: body.provider,
          model: body.model,
          effort: body.effort,
        });

        const log = (msg: string) => pushJobEvent(job, 'log', msg);
        const makeLLM = () =>
          new VercelLLMClient(runtime, {
            onTelemetry: (rec: CostRecord) => log(formatCostTelemetry(rec)),
          });

        // 后台异步执行，立即返回 jobId 供前端订阅 SSE
        void (async () => {
          try {
            log(
              `[任务启动] ${type} | Provider=${runtime.baseUrl} | Model=${runtime.defaultModel}`,
            );

            if (type === 'init') {
              const st = await runFoundationInit({
                bookId: String(body.bookId),
                idea: String(body.idea),
                recipeName: String(body.recipe || 'dafeng_mystery'),
                runtime,
                llm: makeLLM(),
                overwrite: Boolean(body.force),
              });
              log(`✔ 地基初始化完成：《${st.foundation.title}》（规划 ${st.volume_plan.length} 章）`);
              finishJob(job, { book_id: st.book_id, title: st.foundation.title });
              return;
            }

            if (type === 'run') {
              const summary = await runChapterPipeline({
                bookId: String(body.bookId),
                toChapter: Number(body.toChapter || 10),
                forceChapter: body.forceChapter ? Number(body.forceChapter) : undefined,
                runtime,
                llm: makeLLM(),
                shouldStop: () => job.cancelled,
                onLog: log,
              });
              finishJob(job, summary);
              return;
            }

            if (type === 'race') {
              const resRace = await runOpeningRace({
                bookId: String(body.bookId),
                variantsCount: Number(body.variants || 3),
                runtime,
                llm: makeLLM(),
                onLog: log,
              });
              log(`✔ 赛马完成！推荐胜出：${resRace.judge.winner_id}`);
              finishJob(job, { winner_id: resRace.judge.winner_id });
              return;
            }

            if (type === 'deconstruct') {
              const refPath = String(body.refPath || '');
              if (body.statsOnly) {
                const { sourceName, chapters } = loadReferenceChapters(refPath);
                const agg = aggregateQuantitativeStats(chapters);
                const summaryText = formatQuantitativeSummary(agg);
                log(summaryText);
                finishJob(job, { sourceName, quantitative: agg, summaryText });
                return;
              }
              const out = await runDeconstruct({
                refPath,
                runtime,
                llm: makeLLM(),
                baseRecipeName: body.baseRecipe || 'fanqie_urban_brainhole',
                outRecipeName: body.outRecipe || undefined,
              });
              log(`✔ 拆书完成！报告已写入 ${out.reportPath}`);
              finishJob(job, { sourceName: out.sourceName, reportPath: out.reportPath });
              return;
            }

            throw new Error(`未知任务类型：${type}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`✖ 任务失败：${msg}`);
            finishJob(job, undefined, msg);
          }
        })();

        return sendJson(res, 200, { jobId: job.id });
      }

      const sseMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/stream$/);
      if (sseMatch && method === 'GET') {
        const jobId = sseMatch[1]!;
        const job = jobs.get(jobId);
        if (!job) return sendJson(res, 404, { error: 'Job not found' });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });

        for (const line of job.logs) {
          res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
        }

        if (job.status !== 'running') {
          res.write(
            `event: ${job.status === 'error' ? 'job_error' : 'job_done'}\ndata: ${JSON.stringify({ status: job.status, result: job.result, error: job.error })}\n\n`,
          );
          res.end();
          return;
        }

        job.clients.add(res);
        req.on('close', () => {
          job.clients.delete(res);
        });
        return;
      }

      // === Static Web Assets ===
      const relAsset = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const fullAsset = path.resolve(webRoot, relAsset);
      if (!fullAsset.startsWith(webRoot) || !fs.existsSync(fullAsset)) {
        const indexHtml = path.join(webRoot, 'index.html');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(indexHtml));
        return;
      }
      const ext = path.extname(fullAsset);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(fs.readFileSync(fullAsset));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    }
  });

  server.listen(port, host, () => {
    console.log(`\n✨ SilkCanto（锦章）Web 中控台已启动：http://${host}:${port}\n`);
  });

  return server;
}
