#!/usr/bin/env node
import Table from 'cli-table3';
import { Command } from 'commander';
import pc from 'picocolors';
import { getRuntimeConfig, loadRecipe } from './config.js';
import { runChapterPipeline } from './core/engine.js';
import { VercelLLMClient } from './core/llm.js';
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

const program = new Command();

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
    const llm = new VercelLLMClient(runtime);
    const res = await llm.generateText({
      stage: 'beat',
      prompt: '请只回复两个字：联通',
      temperature: 0,
    });
    console.log(pc.green(`✔ API 连通成功！模型回复：${res.text}`));
    console.log(
      pc.dim(
        `Token：输入 ${res.cost.prompt_tokens} / 输出 ${res.cost.completion_tokens}`,
      ),
    );
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

      const llm = new VercelLLMClient(runtime);
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
      const llm = new VercelLLMClient(runtime);
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
      const llm = new VercelLLMClient(runtime);
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
      head: ['Book ID', '书名', '阶段', '已Commit/规划', '总汉字数', '挂起章', '费用(¥)', '最近断点'],
    });

    for (const id of ids) {
      const st = loadBookState(runtime.workspaceDir, id);
      const committed = st.chapters.filter((c) => c.status === 'committed');
      const suspended = st.chapters
        .filter((c) => c.status === 'needs_review')
        .map((c) => `第${c.chapter}章`);
      const totalChars = committed.reduce((acc, c) => acc + (c.chinese_chars ?? 0), 0);
      const latestCp = readLatestCheckpoint(runtime.workspaceDir, id);

      table.push([
        st.book_id,
        st.foundation.title,
        st.phase === 'NEEDS_REVIEW' ? pc.red(st.phase) : pc.cyan(st.phase),
        `${committed.length}/${st.volume_plan.length}`,
        totalChars.toLocaleString(),
        suspended.length > 0 ? pc.red(suspended.join(',')) : pc.green('无'),
        st.cost.total_cost_cny.toFixed(4),
        latestCp ? `ch${latestCp.chapter}:${latestCp.step}` : '-',
      ]);
    }

    console.log(table.toString());

    if (bookId) {
      const st = loadBookState(runtime.workspaceDir, bookId);
      console.log(
        pc.dim(
          `\nToken 累计：输入 ${st.cost.total_prompt_tokens.toLocaleString()} / 输出 ${st.cost.total_completion_tokens.toLocaleString()} | 调用次数：${st.cost.calls.length}`,
        ),
      );
    }
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

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(pc.red(`✖ 错误：${msg}`));
  process.exit(1);
});
