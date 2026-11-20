#!/usr/bin/env node
import Table from 'cli-table3';
import { Command } from 'commander';
import pc from 'picocolors';
import { getRuntimeConfig, loadRecipe } from './config.js';
import { runChapterPipeline } from './core/engine.js';
import { formatCostTelemetry, VercelLLMClient } from './core/llm.js';
import { exportBookForFanqie } from './exporter.js';
import {
  listAllBookIds,
  loadBookState,
  readChapterBody,
  readLatestCheckpoint,
} from './memory/store.js';
import {
  aggregateQuantitativeStats,
  formatQuantitativeSummary,
  loadReferenceChapters,
  runDeconstruct,
} from './pipeline/deconstruct.js';
import { runFoundationInit } from './pipeline/foundation.js';
import { formatLintSummary, lintChapterText } from './pipeline/linter.js';
import { runOpeningRace, selectRaceVariant } from './pipeline/racer.js';
import { startWebServer } from './server.js';

const program = new Command();

function createObservedLLM(runtime: ReturnType<typeof getRuntimeConfig>) {
  return new VercelLLMClient(runtime, {
    onTelemetry: (record) => {
      console.log(pc.dim(formatCostTelemetry(record)));
    },
  });
}

program
  .name('silkcanto')
  .description('SilkCanto (锦章) — 状态驱动、可批量调度的网文生产 CLI 引擎')
  .version('0.1.0');

// ping: 一键检测 API Key 与默认模型连通性
program
  .command('ping')
  .description('测试 .env 中的 API Key、Base URL 与默认模型连通性')
  .action(async () => {
    const runtime = getRuntimeConfig();
    console.log(
      pc.cyan(
        `正在测试连接：${runtime.baseUrl} | 模型：${runtime.defaultModel} ...`,
      ),
    );
    const llm = createObservedLLM(runtime);
    const res = await llm.generateText({
      stage: 'beat',
      prompt: '请只回复两个字：联通',
      temperature: 0,
      reasoningEffort: 'low',
    });
    console.log(pc.green(`✔ API 连通成功！模型回复：${res.text}`));
  });

// models: 拉取当前 Provider 可用的精确模型 ID 列表
program
  .command('models')
  .description('查询当前配置的 API Provider 返回的可用模型 ID 列表')
  .action(async () => {
    const runtime = getRuntimeConfig();
    const url = `${runtime.baseUrl.replace(/\/+$/, '')}/models`;
    console.log(pc.cyan(`正在查询可用模型列表：${url} ...`));
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${runtime.apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`查询失败 HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> };
    const list = json.data ?? [];
    for (const m of list) {
      console.log(`- ${pc.green(m.id)}${m.owned_by ? pc.dim(` (${m.owned_by})`) : ''}`);
    }
  });

// 0. 拆书分析
program
  .command('deconstruct <refPath>')
  .description('初始化前拆解爆款参考样章（支持单文件或章节目录）')
  .option('--base-recipe <name>', '基础配方模板名', 'fanqie_urban_brainhole')
  .option('--out-recipe <name>', '将拆书节奏基因沉淀为新配方目录名')
  .option('--stats-only', '仅执行零 Token 代码定量统计，不调用大模型', false)
  .action(
    async (
      refPath: string,
      opts: { baseRecipe: string; outRecipe?: string; statsOnly: boolean },
    ) => {
      const runtime = getRuntimeConfig();
      if (opts.statsOnly) {
        const { sourceName, chapters } = loadReferenceChapters(refPath);
        const agg = aggregateQuantitativeStats(chapters);
        console.log(pc.cyan(`\n=== 拆书定量统计（零 Token）：${sourceName} ===\n`));
        console.log(formatQuantitativeSummary(agg));
        return;
      }

      const llm = createObservedLLM(runtime);
      console.log(pc.cyan(`正在拆解参考样章：${refPath} ...`));
      const res = await runDeconstruct({
        refPath,
        runtime,
        llm,
        baseRecipeName: opts.baseRecipe,
        outRecipeName: opts.outRecipe,
      });

      console.log(pc.green('\n✔ 拆书完成！'));
      console.log(`- 分析报告：${res.reportPath}`);
      console.log(`- 节奏基因：${res.dnaPath}`);
      if (res.recipePath) {
        console.log(`- 已沉淀配方：${res.recipePath}`);
      }
      console.log(
        pc.dim(
          `Token：输入 ${res.cost.prompt_tokens} / 输出 ${res.cost.completion_tokens} | 估算 ¥${res.cost.estimated_cost_cny.toFixed(4)}`,
        ),
      );
    },
  );

// 1. 初始化新书地基
program
  .command('init <bookId>')
  .description('创建新书地基、角色与前 10–15 章滚动卷纲，并初始化 state.json')
  .requiredOption('--idea <text>', '一句话核心脑洞')
  .option('--recipe <name>', '使用的配方名称', 'fanqie_urban_brainhole')
  .option('--force', '覆盖已有同名书籍', false)
  .action(
    async (
      bookId: string,
      opts: { idea: string; recipe: string; force: boolean },
    ) => {
      const runtime = getRuntimeConfig();
      const llm = createObservedLLM(runtime);
      console.log(pc.cyan(`正在初始化书籍 "${bookId}"（配方：${opts.recipe}）...`));

      const state = await runFoundationInit({
        bookId,
        idea: opts.idea,
        recipeName: opts.recipe,
        runtime,
        llm,
        overwrite: opts.force,
      });

      console.log(pc.green(`\n✔ 地基初始化完成：《${state.foundation.title}》`));
      console.log(`- 候选书名：${state.foundation.title_candidates.join(' / ')}`);
      console.log(`- 金手指：${state.foundation.golden_finger_name}`);
      console.log(`- 规划章数：${state.volume_plan.length} 章 | 角色：${state.characters.length} 位`);
      console.log(
        pc.yellow(
          `\n下一步建议：运行 silkcanto race ${bookId} --variants 3 进行黄金三章赛马。`,
        ),
      );
    },
  );

// 2. 黄金三章赛马
program
  .command('race <bookId>')
  .description('并行生成多版黄金三章（第 1–3 章）并进行横向评审对比')
  .option('--variants <n>', '变体数量（2-5）', '3')
  .action(async (bookId: string, opts: { variants: string }) => {
    const runtime = getRuntimeConfig();
    const llm = new VercelLLMClient(runtime);
    const count = Number(opts.variants) || 3;

    const res = await runOpeningRace({
      bookId,
      variantsCount: count,
      runtime,
      llm,
      onLog: (msg) => console.log(pc.dim(msg)),
    });

    console.log(pc.green(`\n✔ 黄金三章赛马完成！推荐胜出：${pc.bold(res.judge.winner_id)}`));
    console.log(`- 胜出理由：${res.judge.winner_reason}`);
    console.log(`- 评审报告：${res.reportPath}`);
    console.log(
      pc.yellow(
        `\n下一步：运行 silkcanto select ${bookId} ${res.judge.winner_id} 锁定开篇并合并进主线底账。`,
      ),
    );
  });

// 3. 锁定胜出开篇
program
  .command('select <bookId> <variantId>')
  .description('锁定赛马胜出版本（如 v1/v2/v3），合并入主线章节与 state.json')
  .action((bookId: string, variantId: string) => {
    const runtime = getRuntimeConfig();
    const state = selectRaceVariant({ bookId, variantId, runtime });
    console.log(
      pc.green(
        `✔ 已锁定《${state.foundation.title}》开篇版本 ${variantId}（前 3 章已写入主线并回写底账）。`,
      ),
    );
    console.log(
      pc.yellow(`\n下一步：运行 silkcanto run ${bookId} --to-chapter 10 续跑至 2 万字签约线。`),
    );
  });

// 4. 断点续跑单章流水线
program
  .command('run <bookId>')
  .description('断点续跑单章确定性生产流水线（细纲门禁 -> 正文 -> 双层质检 -> 回写）')
  .option('--to-chapter <n>', '目标章节号', '10')
  .option('--force-chapter <n>', '强制重跑指定章节号（例如人工干预后重试）')
  .action(
    async (
      bookId: string,
      opts: { toChapter: string; forceChapter?: string },
    ) => {
      const runtime = getRuntimeConfig();
      const llm = createObservedLLM(runtime);
      const toChapter = Number(opts.toChapter) || 10;
      const forceChapter = opts.forceChapter
        ? Number(opts.forceChapter)
        : undefined;

      const summary = await runChapterPipeline({
        bookId,
        toChapter,
        runtime,
        llm,
        forceChapter,
        onLog: (msg) => console.log(msg),
      });

      if (summary.suspendedChapter) {
        console.log(
          pc.red(
            `\n⚠ 流水线在第 ${summary.suspendedChapter} 章挂起（NEEDS_REVIEW）。修改草稿或细纲后可用 --force-chapter ${summary.suspendedChapter} 继续。`,
          ),
        );
      } else {
        console.log(
          pc.green(
            `\n✔ 流水线执行完毕！本次 Commit 章节：${summary.committedChapters.join(', ') || '无新增'} | 当前阶段：${summary.phase}`,
          ),
        );
      }
    },
  );

// 5. 单独运行零 Token 去 AI 味 Linter
program
  .command('lint <bookId>')
  .description('对指定章节或全书已生成章节运行零 Token 代码去 AI 味 Linter')
  .option('--chapter <n>', '只检查指定章节号')
  .action((bookId: string, opts: { chapter?: string }) => {
    const runtime = getRuntimeConfig();
    const state = loadBookState(runtime.workspaceDir, bookId);
    const recipe = loadRecipe(state.recipe, runtime.recipesDir);
    const targetNum = opts.chapter ? Number(opts.chapter) : undefined;

    const chapters = state.chapters.filter(
      (c) => c.file_path && (targetNum === undefined || c.chapter === targetNum),
    );
    if (chapters.length === 0) {
      console.log(pc.yellow('暂无可检查的已生成正文章节。'));
      return;
    }

    for (const ch of chapters) {
      const body = readChapterBody(runtime.workspaceDir, bookId, ch.file_path!);
      const result = lintChapterText(body, recipe.antiSlop);
      const badge = result.passed ? pc.green('PASS') : pc.red('FAIL');
      console.log(`\n[${badge}] 第 ${ch.chapter} 章《${ch.title}》`);
      console.log(formatLintSummary(result));
    }
  });

// 6. 单书/多书批量状态看板
program
  .command('status [bookId]')
  .description('查看单书详情或全部书籍的批量生产进度、挂起告警与成本账单')
  .action((bookId?: string) => {
    const runtime = getRuntimeConfig();
    const ids = bookId ? [bookId] : listAllBookIds(runtime.workspaceDir);

    if (ids.length === 0) {
      console.log(
        pc.yellow('workspace/books/ 下暂无书籍。请先运行 silkcanto init <bookId> --idea "..."'),
      );
      return;
    }

    const table = new Table({
      head: [
        'Book ID',
        '书名',
        '阶段',
        '已Commit',
        '总汉字',
        'Token/字',
        '缓存命中',
        '费用(¥)',
        '最近断点',
      ],
    });

    for (const id of ids) {
      const st = loadBookState(runtime.workspaceDir, id);
      const committed = st.chapters.filter((c) => c.status === 'committed');
      const totalChars = committed.reduce((acc, c) => acc + (c.chinese_chars ?? 0), 0);
      const totalTokens = st.cost.total_prompt_tokens + st.cost.total_completion_tokens;
      const tokensPerChar =
        totalChars > 0 ? `${(totalTokens / totalChars).toFixed(1)}x` : '-';
      const cacheRate =
        st.cost.total_prompt_tokens > 0
          ? `${((st.cost.total_cached_input_tokens / st.cost.total_prompt_tokens) * 100).toFixed(1)}%`
          : '0.0%';
      const latestCp = readLatestCheckpoint(runtime.workspaceDir, id);

      table.push([
        st.book_id,
        st.foundation.title,
        st.phase === 'NEEDS_REVIEW' ? pc.red(st.phase) : pc.cyan(st.phase),
        `${committed.length}/${st.volume_plan.length}`,
        totalChars.toLocaleString(),
        tokensPerChar,
        cacheRate,
        st.cost.total_cost_cny.toFixed(4),
        latestCp ? `ch${latestCp.chapter}:${latestCp.step}` : '-',
      ]);
    }

    console.log(table.toString());

    if (bookId) {
      const st = loadBookState(runtime.workspaceDir, bookId);
      const cacheRate =
        st.cost.total_prompt_tokens > 0
          ? ((st.cost.total_cached_input_tokens / st.cost.total_prompt_tokens) * 100).toFixed(1)
          : '0.0';
      const reasonRate =
        st.cost.total_completion_tokens > 0
          ? ((st.cost.total_reasoning_tokens / st.cost.total_completion_tokens) * 100).toFixed(1)
          : '0.0';
      console.log(
        pc.dim(
          `\nToken 累计：输入 ${st.cost.total_prompt_tokens.toLocaleString()}（缓存 ${st.cost.total_cached_input_tokens.toLocaleString()} / ${cacheRate}%）| 输出 ${st.cost.total_completion_tokens.toLocaleString()}（思考 ${st.cost.total_reasoning_tokens.toLocaleString()} / ${reasonRate}%）| 调用 ${st.cost.calls.length} 次`,
        ),
      );
    }
  });

// 6b. 深度观测报表（Token 效率、缓存命中率、思考占比、各阶段耗时）
program
  .command('metrics <bookId>')
  .description('查看单书深度观测报表：Token/正文汉字比、缓存命中率、思考占比与各阶段耗时')
  .action((bookId: string) => {
    const runtime = getRuntimeConfig();
    const st = loadBookState(runtime.workspaceDir, bookId);
    const calls = st.cost.calls;

    const committed = st.chapters.filter((c) => c.status === 'committed');
    const finalChars = committed.reduce((acc, c) => acc + (c.chinese_chars ?? 0), 0);
    const totalIn = st.cost.total_prompt_tokens;
    const totalCached = st.cost.total_cached_input_tokens;
    const totalOut = st.cost.total_completion_tokens;
    const totalReason = st.cost.total_reasoning_tokens;
    const totalTok = totalIn + totalOut;

    console.log(pc.cyan(`\n=== SilkCanto 观测仪表盘：《${st.foundation.title}》(${bookId}) ===\n`));
    console.log(`- 已 Commit 正文：${committed.length} 章 / ${finalChars.toLocaleString()} 汉字`);
    console.log(
      `- 总 Token 消耗：${totalTok.toLocaleString()}（输入 ${totalIn.toLocaleString()} + 输出 ${totalOut.toLocaleString()}）`,
    );
    console.log(
      `- Token / 最终汉字比：${finalChars > 0 ? `${(totalTok / finalChars).toFixed(2)} tok/字（其中输出 ${(totalOut / finalChars).toFixed(2)} tok/字）` : '暂无成品章节'}`,
    );
    console.log(
      `- Prompt 缓存命中率：${totalIn > 0 ? `${((totalCached / totalIn) * 100).toFixed(1)}%（${totalCached.toLocaleString()} / ${totalIn.toLocaleString()}）` : '0.0%'}`,
    );
    console.log(
      `- 思考 Token 占比：${totalOut > 0 ? `${((totalReason / totalOut) * 100).toFixed(1)}%（${totalReason.toLocaleString()} / ${totalOut.toLocaleString()}）` : '0.0%'}`,
    );
    console.log(
      `- 累计记录耗时：${(st.cost.total_duration_ms / 1000).toFixed(1)}s | 估算总费用：¥${st.cost.total_cost_cny.toFixed(4)}`,
    );

    // 1. 按阶段汇总表
    const stageMap = new Map<
      string,
      {
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

    const stageTable = new Table({
      head: ['阶段', '次数', '输入Tok', '缓存命中', '输出Tok', '思考Tok', '总耗时', '均耗时', '重试/降级'],
    });
    for (const [stage, d] of stageMap.entries()) {
      const cachePct = d.inTok > 0 ? `${((d.cachedTok / d.inTok) * 100).toFixed(1)}%` : '0.0%';
      stageTable.push([
        stage,
        d.calls,
        d.inTok.toLocaleString(),
        cachePct,
        d.outTok.toLocaleString(),
        d.reasonTok.toLocaleString(),
        d.durMs > 0 ? `${(d.durMs / 1000).toFixed(1)}s` : '-',
        d.durMs > 0 ? `${(d.durMs / d.calls / 1000).toFixed(1)}s` : '-',
        `${d.retries}/${d.fallbacks}`,
      ]);
    }
    console.log(pc.bold('\n[按阶段消耗与耗时拆解]'));
    console.log(stageTable.toString());

    // 2. 按章节产出效率表
    const chTable = new Table({
      head: ['章节', '汉字数', '调用次', '输入Tok', '输出Tok', 'Token/字比', '缓存命中', '耗时'],
    });
    for (const ch of st.chapters.filter((c) => c.status === 'committed' || c.status === 'needs_review')) {
      const chCalls = calls.filter((c) => c.chapter === ch.chapter);
      const inSum = chCalls.reduce((a, b) => a + b.prompt_tokens, 0);
      const cacheSum = chCalls.reduce((a, b) => a + (b.cached_input_tokens ?? 0), 0);
      const outSum = chCalls.reduce((a, b) => a + b.completion_tokens, 0);
      const durSum = chCalls.reduce((a, b) => a + (b.duration_ms ?? 0), 0);
      const chars = ch.chinese_chars ?? 0;
      const ratio = chars > 0 ? `${((inSum + outSum) / chars).toFixed(1)}x` : '-';
      const cachePct = inSum > 0 ? `${((cacheSum / inSum) * 100).toFixed(1)}%` : '0.0%';
      chTable.push([
        `第${ch.chapter}章`,
        chars.toLocaleString(),
        chCalls.length,
        inSum.toLocaleString(),
        outSum.toLocaleString(),
        ratio,
        cachePct,
        durSum > 0 ? `${(durSum / 1000).toFixed(1)}s` : '-',
      ]);
    }
    console.log(pc.bold('\n[按章节产出效率（含历史重试总账）]'));
    console.log(chTable.toString());
  });

// 7. 番茄投稿导出
program
  .command('export <bookId>')
  .description('导出番茄作家后台纯净分章 TXT 与签约质检/成本汇总报告')
  .action((bookId: string) => {
    const runtime = getRuntimeConfig();
    const res = exportBookForFanqie({ bookId, runtime });
    console.log(pc.green('\n✔ 番茄投稿导出完成！'));
    console.log(`- 分章 TXT 目录：${res.exportDir}/chapters_txt/（共 ${res.chapterFiles.length} 章）`);
    console.log(`- 合并投稿文件：${res.mergedTxtPath}`);
    console.log(`- 质检与成本摘要：${res.summaryPath}`);
    console.log(`- 导出总汉字数：${res.totalChineseChars.toLocaleString()} 字`);
  });

// 8. 启动本地 Web GUI 中控台
program
  .command('ui')
  .description('启动 SilkCanto（锦章）Web GUI 中控台（含观测仪表盘、人工精修、拆书与实时 SSE 日志）')
  .option('-p, --port <port>', '监听端口', '4173')
  .action((opts: { port: string }) => {
    const port = Number(opts.port) || 4173;
    startWebServer({ port, host: '127.0.0.1' });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(pc.red(`✖ 错误：${msg}`));
  process.exit(1);
});
