import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRecipe, resolveModelForStage, type RuntimeConfig } from '../src/config.js';
import { runChapterPipeline } from '../src/core/engine.js';
import { extractJsonObject, type LLMClient } from '../src/core/llm.js';
import { exportBookForFanqie } from '../src/exporter.js';
import { buildStateContext } from '../src/memory/context.js';
import { loadBookState } from '../src/memory/store.js';
import {
  aggregateQuantitativeStats,
  loadReferenceChapters,
  runDeconstruct,
} from '../src/pipeline/deconstruct.js';
import { runFoundationInit } from '../src/pipeline/foundation.js';
import { lintChapterText } from '../src/pipeline/linter.js';
import { runOpeningRace, selectRaceVariant } from '../src/pipeline/racer.js';

const tempDirs: string[] = [];

function makeTempRuntime(): RuntimeConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silkcanto-test-'));
  tempDirs.push(dir);
  const recipesCopy = path.join(dir, 'recipes');
  fs.cpSync(path.resolve(process.cwd(), 'recipes'), recipesCopy, { recursive: true });

  return {
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'ds-pro',
    stageModels: {},
    inputCostPer1M: 2.0,
    outputCostPer1M: 8.0,
    workspaceDir: path.join(dir, 'workspace'),
    recipesDir: recipesCopy,
  };
}

function makeCleanNovelChapter(seed = 1): string {
  const block = [
    `“陈默，这单外卖已经超时十二分钟了，差评你背定了！”电话那头传来尖锐的吼声。`,
    `林陈默把电瓶车停在写字楼门口，抹了一把额头上的雨水，顺手点开接单屏幕。`,
    `“王主管，电梯坏了，我正爬楼梯呢，马上到十六楼。”他喘着气往上迈了两级台阶。`,
    `就在指尖碰触到扶手的一瞬间，一行淡蓝色的倒计时数字突然浮现在他的视网膜正中。`,
    `“这是什么玩意儿？眼前发花了？”他用力眨了两下眼，数字不但没消失，反而弹出一条提示。`,
    `提示清晰地标出了楼上三分钟后会发生的意外，以及一份即将被错扔进垃圾桶的标书。`,
    `“站住！送外卖的谁让你走贵宾通道的？”走廊拐角冲出一名保安，伸手就要扯他衣领。`,
    `陈默侧身避开，盯着倒计时还剩四十五秒的提示，抬手指向走廊尽头的茶水间。`,
    `“里面咖啡机漏电了，再不去拉闸，整层楼的服务器都得烧毁。”陈默语速又快又稳。`,
    `保安愣了一下，刚要骂街，茶水间里“啪”地一声炸出一团蓝白色电火花，焦糊味瞬间散开。`,
    `围观的白领们吓得连连后退，刚才还冷眼嘲讽的行政主管脸色发白，手里的文件夹啪嗒掉在地上。`,
    `“你……你怎么提前知道的？”主管声音都在打颤，瞪大眼睛看着这个满身雨水的年轻人。`,
    `陈默没有急着回答，弯腰捡起地上那份标书扫了一眼，心里已经有了底。`,
    `“不止漏电，你们三分钟后要签的那家供应商，公章都是假的。”他把标书递回去，声音不大却字字落地。`,
    `大厅瞬间炸开了锅，第${seed}次验证完金手指的精度，陈默看着视网膜上跳出的新奖励，彻底松了口气。`,
  ];
  // 重复拼接至约 2150 汉字，保持短段落和高对话比
  const paras: string[] = [];
  for (let i = 0; i < 4; i++) {
    paras.push(...block);
  }
  return paras.join('\n\n');
}

function createMockLLM(opts?: { failCritic?: boolean; sloppyDraft?: boolean }): LLMClient {
  let callIdx = 0;
  const makeCost = (stage: any, chapter?: number) => ({
    timestamp: new Date().toISOString(),
    stage,
    model: 'ds-pro',
    chapter,
    prompt_tokens: 500,
    cached_input_tokens: 200,
    completion_tokens: 400,
    reasoning_tokens: 50,
    duration_ms: 1200,
    retries: 0,
    used_fallback: false,
    estimated_cost_cny: 0.0042,
  });

  return {
    async generateText(options) {
      callIdx += 1;
      if (opts?.sloppyDraft) {
        return {
          text: '总而言之，值得注意的是，他眼神微眯，嘴角勾起一抹冷笑，空气仿佛凝固，倒吸一口凉气。',
          cost: makeCost(options.stage, options.chapter),
        };
      }
      return {
        text: makeCleanNovelChapter(options.chapter ?? callIdx),
        cost: makeCost(options.stage, options.chapter),
      };
    },
    async generateObject(options) {
      callIdx += 1;
      const stage = options.stage;

      if (stage === 'deconstruct') {
        const obj = {
          source_name: 'sample',
          genre_guess: '都市脑洞',
          core_emotion_hook: '信息差预知+当众打脸反转',
          opening_500_strategy: '雨夜超时危机直接切入冲突',
          golden_finger_reveal_timing: '第1章前800字亮相',
          golden_three_arcs: [
            {
              chapter_index: 1,
              function: '立困境亮金手指',
              emotion_arc: '压抑->反转->小爽',
              cliffhanger_technique: '抛出假公章悬念',
            },
          ],
          character_contrast_formula: ['底层外卖员 vs 傲慢高管'],
          cliffhanger_patterns: ['危机截停式断章'],
          prose_features: ['短段快节奏', '强生活脏细节'],
          pitfalls_to_avoid: ['切忌开头大段科普设定'],
          recommended_targets: {
            min_chars: 2000,
            max_chars: 2400,
            min_dialogue_ratio: 0.2,
            max_paragraph_chars: 160,
          },
        };
        return { object: options.schema.parse(obj), cost: makeCost(stage) };
      }

      if (stage === 'foundation') {
        const volume_plan = Array.from({ length: 10 }, (_v, i) => ({
          chapter: i + 1,
          title: `预知危机第${i + 1}步`,
          summary: `第${i + 1}章围绕三分钟预知金手指解决现实危机并收获阶层跃迁。`,
          goal: '干脆打脸并推进主线',
          hook_hint: '引出更强的幕后对手',
        }));
        const obj = {
          foundation: {
            idea: '外卖员获得三分钟未来提示',
            title: '我能看见三分钟后的灾难',
            title_candidates: [
              '我能看见三分钟后的灾难',
              '送外卖的我，靠预知三分钟成了首富',
              '开局预知漏电，全公司跪求我别走',
            ],
            blurb: '雨夜送外卖被刁难，陈默眼前突然跳出三分钟后的倒计时提示。',
            genre: '都市脑洞',
            core_selling_point: '精准三分钟预知信息差',
            golden_finger_name: '三分钟灾变视界',
            golden_finger_rules: '接触高危或高价值目标时触发未来三分钟关键画面',
            golden_finger_limits: '每天限触发三次，连续触发会剧烈头痛',
            main_goal: '从底层逆袭并查明视界背后的幕后操控者',
          },
          characters: [
            {
              id: 'mc',
              name: '陈默',
              role: '主角',
              personality: '冷静务实、有仇必报',
              speech_style: '简短直接不废话',
              current_status: '雨夜兼职外卖员',
              relationship_to_mc: '本人',
              known_facts: ['刚刚获得三分钟预知能力'],
            },
            {
              id: 'c2',
              name: '王主管',
              role: '前期反派靶子',
              personality: '刻薄势利',
              speech_style: '颐指气使',
              current_status: '写字楼行政主管',
              relationship_to_mc: '轻视主角',
              known_facts: [],
            },
          ],
          assets: [
            {
              id: 'a1',
              name: '二手电瓶车',
              owner: '陈默',
              description: '谋生工具',
              quantity_or_level: '1辆',
              status: 'active',
            },
          ],
          foreshadowing: [
            {
              id: 'fs_1',
              summary: '假公章背后牵扯到集团高层内鬼',
              planted_chapter: 1,
              status: 'planted',
              payoff_plan: '第10章揭晓真正幕后主使',
            },
          ],
          volume_plan,
          initial_author_truth: ['集团副总周明远是假公章幕后黑手'],
          initial_reader_known: ['陈默是负债外卖员，刚触发三分钟预知'],
        };
        return { object: options.schema.parse(obj), cost: makeCost(stage) };
      }

      if (stage === 'beat') {
        const ch = options.chapter ?? 1;
        const obj = {
          chapter: ch,
          title: `破局第${ch}章`,
          core_goal: '化解冲突并展示金手指',
          conflict_target: '傲慢主管与保安阻拦',
          golden_finger_usage: '提前预知漏电与假公章',
          beats: [
            { order: 1, scene: '写字楼门口', conflict_or_action: '被催单威胁差评', payoff_or_shift: '激活预知视界' },
            { order: 2, scene: '走廊拐角', conflict_or_action: '保安阻拦', payoff_or_shift: '预言漏电成真打脸' },
            { order: 3, scene: '大厅', conflict_or_action: '指出假公章', payoff_or_shift: '全场震惊留钩子' },
          ],
          cliffhanger_hook: '幕后黑手电话打来威胁',
          reader_known_guard: ['不可提前提及副总周明远的名字'],
        };
        return { object: options.schema.parse(obj), cost: makeCost(stage, ch) };
      }

      if (stage === 'critic') {
        // 区分赛马评审与单章审校
        if (options.prompt.includes('候选版本')) {
          const obj = {
            winner_id: 'v1',
            winner_reason: '开篇前500字冲突最强，金手指兑现最快',
            transition_advice: '第4章立刻让集团高层亲自下场拉升冲突层级',
            scores: [
              {
                variant_id: 'v1',
                hook_power: 9,
                golden_finger_payoff: 9,
                human_feel: 8.5,
                contract_readiness: 8.8,
                overall_score: 8.8,
                strengths: ['节奏干脆'],
                weaknesses: ['可再加一处细节反差'],
              },
              {
                variant_id: 'v2',
                hook_power: 8,
                golden_finger_payoff: 8,
                human_feel: 8,
                contract_readiness: 8,
                overall_score: 8.0,
                strengths: ['悬念感不错'],
                weaknesses: ['前300字稍慢'],
              },
            ],
          };
          return { object: options.schema.parse(obj), cost: makeCost(stage) };
        }

        const obj = opts?.failCritic
          ? {
              consistency: 5,
              pacing: 5,
              hook: 4,
              human_feel: 4,
              overall_score: 4.5,
              pass: false,
              truth_leak_detected: false,
              issues: ['字数不足且存在明显 AI 腔'],
              rewrite_instructions: ['扩写冲突细节并删除所有禁用套话'],
            }
          : {
              consistency: 9,
              pacing: 8.5,
              hook: 8.5,
              human_feel: 8.5,
              overall_score: 8.6,
              pass: true,
              truth_leak_detected: false,
              issues: [],
              rewrite_instructions: [],
            };
        return { object: options.schema.parse(obj), cost: makeCost(stage, options.chapter) };
      }

      // commit
      const ch = options.chapter ?? 1;
      const obj = {
        chapter_summary: `第${ch}章中陈默成功预言漏电并当众揭穿假公章。`,
        character_updates: [
          {
            name: '王主管',
            current_status: '当众丢脸且开始忌惮陈默',
            relationship_to_mc: '从轻视转为畏惧',
            new_known_facts: ['陈默准确预言了咖啡机漏电'],
          },
        ],
        asset_updates: [],
        foreshadowing_updates: [],
        new_author_truth: [],
        new_reader_known: [`第${ch}章陈默揭穿了供应商公章造假`],
      };
      return { object: options.schema.parse(obj), cost: makeCost(stage, ch) };
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('SilkCanto Core Modules', () => {
  it('resolves model routing defaulting to ds-pro', () => {
    const runtime = makeTempRuntime();
    const recipe = loadRecipe('fanqie_urban_brainhole', runtime.recipesDir);
    expect(resolveModelForStage(runtime, recipe.config, 'draft')).toBe('ds-pro');
  });

  it('extracts JSON safely from fenced markdown output', () => {
    const parsed = extractJsonObject('说明如下：\n```json\n{"ok": true, "score": 9}\n```');
    expect(parsed).toEqual({ ok: true, score: 9 });
  });

  it('zero-token Linter rejects AI slop and passes clean Fanqie chapter', () => {
    const runtime = makeTempRuntime();
    const recipe = loadRecipe('fanqie_urban_brainhole', runtime.recipesDir);

    const sloppy =
      '总而言之，值得注意的是，他眼神微眯，嘴角勾起一抹冷笑，空气仿佛凝固。这不是偶然，而是必然。不是运气，而是实力。不是巧合，而是命定。不是天意，而是人心。';
    const badRes = lintChapterText(sloppy, recipe.antiSlop);
    expect(badRes.passed).toBe(false);
    expect(badRes.issues.some((i) => i.rule === 'banned_phrase')).toBe(true);
    expect(badRes.issues.some((i) => i.rule === 'min_chars')).toBe(true);

    const clean = makeCleanNovelChapter(1);
    const goodRes = lintChapterText(clean, recipe.antiSlop);
    expect(goodRes.passed).toBe(true);
    expect(goodRes.metrics.chinese_chars).toBeGreaterThanOrEqual(1900);
    expect(goodRes.metrics.dialogue_ratio).toBeGreaterThanOrEqual(0.18);
  });

  it('deconstructs reference samples and materializes a reusable recipe', async () => {
    const runtime = makeTempRuntime();
    const refDir = path.join(runtime.workspaceDir, 'references', 'hot_urban');
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(
      path.join(refDir, '001.txt'),
      `第一章 雨夜倒计时\n\n${makeCleanNovelChapter(1)}`,
      'utf-8',
    );

    const loaded = loadReferenceChapters(refDir);
    expect(loaded.chapters).toHaveLength(1);
    const agg = aggregateQuantitativeStats(loaded.chapters);
    expect(agg.avgChineseChars).toBeGreaterThan(1900);

    const res = await runDeconstruct({
      refPath: refDir,
      runtime,
      llm: createMockLLM(),
      outRecipeName: 'custom_urban_test',
    });

    expect(fs.existsSync(res.reportPath)).toBe(true);
    expect(fs.existsSync(res.dnaPath)).toBe(true);
    expect(res.recipePath).toBeTruthy();

    const newRecipe = loadRecipe('custom_urban_test', runtime.recipesDir);
    expect(newRecipe.dnaJson).toBeTruthy();
  });

  it('runs full lifecycle: init -> race -> select -> run -> export', async () => {
    const runtime = makeTempRuntime();
    const llm = createMockLLM();

    // Phase 0: init
    const initState = await runFoundationInit({
      bookId: 'demo_01',
      idea: '外卖员获得三分钟未来提示',
      recipeName: 'fanqie_urban_brainhole',
      runtime,
      llm,
    });
    expect(initState.phase).toBe('FOUNDATION_DONE');
    expect(initState.author_truth.length).toBeGreaterThan(0);

    // Dual timeline isolation present in rendered context
    const ctx = buildStateContext(initState, 1);
    expect(ctx).toContain('author_truth');
    expect(ctx).toContain('reader_known');

    // Phase 1: opening race (2 variants) & select winner
    const raceRes = await runOpeningRace({
      bookId: 'demo_01',
      variantsCount: 2,
      runtime,
      llm,
    });
    expect(raceRes.variants).toHaveLength(2);
    expect(raceRes.judge.winner_id).toBe('v1');

    const selected = selectRaceVariant({
      bookId: 'demo_01',
      variantId: 'v1',
      runtime,
    });
    expect(selected.selected_race_variant).toBe('v1');
    expect(selected.chapters.filter((c) => c.status === 'committed')).toHaveLength(3);

    // Phase 2-4: run chapters 4..5 (chapters 1..3 skipped automatically via checkpoint/state)
    const runRes = await runChapterPipeline({
      bookId: 'demo_01',
      toChapter: 5,
      runtime,
      llm,
    });
    expect(runRes.suspendedChapter).toBeUndefined();
    expect(runRes.committedChapters).toEqual([4, 5]);

    const finalState = loadBookState(runtime.workspaceDir, 'demo_01');
    expect(finalState.chapters.filter((c) => c.status === 'committed')).toHaveLength(5);
    expect(finalState.cost.total_cost_cny).toBeGreaterThan(0);

    // Export Fanqie clean TXT
    const exported = exportBookForFanqie({ bookId: 'demo_01', runtime });
    expect(exported.chapterFiles).toHaveLength(5);
    expect(fs.existsSync(exported.mergedTxtPath)).toBe(true);
    expect(fs.existsSync(exported.summaryPath)).toBe(true);
  });

  it('suspends chapter as NEEDS_REVIEW after exceeding max retries', async () => {
    const runtime = makeTempRuntime();
    await runFoundationInit({
      bookId: 'fail_book',
      idea: '测试挂起机制',
      recipeName: 'fanqie_urban_brainhole',
      runtime,
      llm: createMockLLM(),
    });

    const res = await runChapterPipeline({
      bookId: 'fail_book',
      toChapter: 2,
      runtime,
      llm: createMockLLM({ failCritic: true, sloppyDraft: true }),
    });

    expect(res.suspendedChapter).toBe(1);
    expect(res.phase).toBe('NEEDS_REVIEW');
    const st = loadBookState(runtime.workspaceDir, 'fail_book');
    expect(st.chapters[0]?.status).toBe('needs_review');
    expect(st.chapters[0]?.review_notes.length).toBeGreaterThan(0);
  });
});
