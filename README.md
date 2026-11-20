# SilkCanto（锦章）v0.1

状态驱动、可批量调度、可人工介入的网文生产 CLI 引擎（TypeScript + Vercel AI SDK + DeepSeek 兼容路由）。

## 快速开始

### 1. 配置 DeepSeek API
复制 `.env.example` 为 `.env`，填入你的 Key、Base URL 与模型名（默认 `ds-pro`）：

```bash
cp .env.example .env
```

### 2. 启动 Web GUI 中控台（推荐）

```bash
pnpm ui
# 启动后访问 http://127.0.0.1:4173
# 支持：多书看板、一键开新书/拆书/续跑/黄金三章赛马、章节人工精修与 Linter 复检、
#       唯一底账与双时间线视图、深度观测仪表盘（Token/字比、缓存命中率、耗时）、SSE 实时遥测
```

### 3. CLI 全链路命令

```bash
# 测通模型与列出当前 Provider 可用模型 ID
pnpm silkcanto ping
pnpm silkcanto models

# 查看单书深度观测仪表盘（Token/汉字比、缓存命中率、思考占比、各阶段耗时）
pnpm silkcanto metrics book_01
# 0. 初始化前：拆解番茄爆款样章（支持单文件或章节目录）
#    先零 Token 跑定量节奏统计：
pnpm silkcanto deconstruct ./workspace/references/sample_dir --stats-only

#    完整拆书并沉淀为新配方（可选）：
pnpm silkcanto deconstruct ./workspace/references/sample_dir --out-recipe my_urban_recipe

# 1. 初始化新书地基、角色、前 10–15 章滚动卷纲与唯一底账 state.json
pnpm silkcanto init book_01 --idea "雨夜送外卖时获得三分钟未来灾变提示" --recipe fanqie_urban_brainhole

# 2. 黄金三章赛马（并行生成 3 版第 1–3 章并输出横向评审报告）
pnpm silkcanto race book_01 --variants 3

# 3. 锁定胜出开篇（如 v1）并合并回写主线底账
pnpm silkcanto select book_01 v1

# 4. 断点续跑单章流水线至第 10 章（2 万字签约评估线）
pnpm silkcanto run book_01 --to-chapter 10

# 5. 单独运行零 Token 代码去 AI 味 Linter
pnpm silkcanto lint book_01

# 6. 查看单书或多书批量状态看板与费用账单
pnpm silkcanto status

# 7. 导出番茄投稿纯净分章 TXT 与签约质检摘要
pnpm silkcanto export book_01
```

## 开发与测试

```bash
pnpm typecheck
pnpm test
pnpm build
```
