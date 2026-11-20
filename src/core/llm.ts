import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateObject, generateText, streamText, zodSchema } from 'ai';
import type { z } from 'zod';
import {
  resolveModelForStage,
  resolveReasoningEffortForStage,
  type RecipeConfig,
  type RuntimeConfig,
} from '../config.js';
import type { CostRecord, PipelineStage, ReasoningEffort } from '../memory/schema.js';

export interface LLMCallOptions {
  stage: PipelineStage;
  system?: string;
  prompt: string;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  chapter?: number;
  recipe?: RecipeConfig;
}

export interface LLMTextResult {
  text: string;
  cost: CostRecord;
}

export interface LLMObjectResult<T> {
  object: T;
  cost: CostRecord;
}

export interface LLMClient {
  generateText(options: LLMCallOptions): Promise<LLMTextResult>;
  generateObject<T extends z.ZodTypeAny>(
    options: LLMCallOptions & { schema: T },
  ): Promise<LLMObjectResult<z.infer<T>>>;
}

export interface VercelLLMClientOptions {
  onTelemetry?: (record: CostRecord) => void;
}

interface RawUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export class VercelLLMClient implements LLMClient {
  private readonly runtime: RuntimeConfig;
  private readonly isDeepSeek: boolean;
  private readonly provider: ReturnType<typeof createOpenAICompatible>;
  private readonly onTelemetry?: (record: CostRecord) => void;

  constructor(runtime: RuntimeConfig, opts?: VercelLLMClientOptions) {
    this.runtime = runtime;
    this.onTelemetry = opts?.onTelemetry;
    if (!runtime.apiKey) {
      throw new Error(
        '未检测到 SILKCANTO_API_KEY。请先复制 .env.example 为 .env 并填入你的 API Key。',
      );
    }
    this.isDeepSeek = /deepseek/i.test(runtime.baseUrl);
    this.provider = createOpenAICompatible({
      name: 'openai-compatible',
      baseURL: runtime.baseUrl,
      apiKey: runtime.apiKey,
      includeUsage: true,
      supportsStructuredOutputs: !this.isDeepSeek,
      convertUsage: (usage) => {
        const raw = usage as Record<string, any> | undefined;
        const cached =
          raw?.prompt_tokens_details?.cached_tokens ??
          raw?.prompt_cache_hit_tokens ??
          undefined;
        const reasoning =
          raw?.completion_tokens_details?.reasoning_tokens ?? undefined;
        return {
          inputTokens: raw?.prompt_tokens ?? undefined,
          outputTokens: raw?.completion_tokens ?? undefined,
          totalTokens: raw?.total_tokens ?? undefined,
          cachedInputTokens: cached,
          reasoningTokens: reasoning,
        };
      },
    });
  }

  private buildCostRecord(params: {
    stage: PipelineStage;
    modelId: string;
    effort?: ReasoningEffort;
    chapter?: number;
    usage?: RawUsageLike;
    durationMs: number;
    ttftMs?: number;
    retries: number;
    usedFallback: boolean;
  }): CostRecord {
    const promptTokens = params.usage?.inputTokens ?? 0;
    const cachedInputTokens = params.usage?.cachedInputTokens ?? 0;
    const completionTokens = params.usage?.outputTokens ?? 0;
    const reasoningTokens = params.usage?.reasoningTokens ?? 0;

    // 缓存命中部分通常享低价（估算按 25% 输入单价折算）
    const uncachedInput = Math.max(0, promptTokens - cachedInputTokens);
    const effectiveInput = uncachedInput + cachedInputTokens * 0.25;
    const cost =
      (effectiveInput / 1_000_000) * this.runtime.inputCostPer1M +
      (completionTokens / 1_000_000) * this.runtime.outputCostPer1M;

    const record: CostRecord = {
      timestamp: new Date().toISOString(),
      stage: params.stage,
      model: params.modelId,
      reasoning_effort: params.effort,
      chapter: params.chapter,
      prompt_tokens: promptTokens,
      cached_input_tokens: cachedInputTokens,
      completion_tokens: completionTokens,
      reasoning_tokens: reasoningTokens,
      duration_ms: Math.round(params.durationMs),
      ttft_ms: params.ttftMs !== undefined ? Math.round(params.ttftMs) : undefined,
      retries: params.retries,
      used_fallback: params.usedFallback,
      estimated_cost_cny: Number(cost.toFixed(6)),
    };

    this.onTelemetry?.(record);
    return record;
  }

  private resolveTemperature(options: LLMCallOptions): number {
    if (options.temperature !== undefined) return options.temperature;
    return options.recipe?.temperatures?.[options.stage] ?? 0.5;
  }

  private resolveEffort(options: LLMCallOptions): ReasoningEffort | undefined {
    if (options.reasoningEffort) return options.reasoningEffort;
    return resolveReasoningEffortForStage(this.runtime, options.recipe, options.stage);
  }

  private buildProviderOptions(
    modelId: string,
    effort?: ReasoningEffort,
    extra?: Record<string, any>,
  ) {
    const opts: Record<string, any> = { ...(extra || {}) };
    if (this.isDeepSeek) {
      // DeepSeek-V4 / deepseek-flash 默认开启思考，常规阶段(low)显式关闭思考可提速 5-10 倍并砍掉 80% 隐藏输出 Token
      if (effort === 'low') {
        opts.thinking = { type: 'disabled' };
      }
    } else if (/^(gemini-|o[134]|gpt-5)/i.test(modelId) && effort) {
      opts.reasoningEffort = effort;
    }
    if (Object.keys(opts).length === 0) return undefined;
    return {
      'openai-compatible': opts,
    };
  }

  async generateText(options: LLMCallOptions): Promise<LLMTextResult> {
    const modelId = resolveModelForStage(this.runtime, options.recipe, options.stage);
    const effort = this.resolveEffort(options);
    const model = this.provider.chatModel(modelId);
    const startTime = Date.now();
    let ttftMs: number | undefined;

    const { value, retries } = await withRateLimitRetry(async () => {
      const attemptStart = Date.now();
      ttftMs = undefined;
      let streamErr: unknown;
      const result = streamText({
        model,
        system: options.system,
        prompt: options.prompt,
        temperature: this.resolveTemperature(options),
        providerOptions: this.buildProviderOptions(modelId, effort),
        maxRetries: 1,
        onError: ({ error }) => {
          streamErr = error;
        },
      });

      const chunks: string[] = [];
      for await (const delta of result.textStream) {
        if (ttftMs === undefined && delta.length > 0) {
          ttftMs = Date.now() - attemptStart;
        }
        chunks.push(delta);
      }
      if (streamErr) {
        throw streamErr;
      }
      const usage = await result.usage;
      return { text: chunks.join('').trim(), usage };
    });

    return {
      text: value.text,
      cost: this.buildCostRecord({
        stage: options.stage,
        modelId,
        effort,
        chapter: options.chapter,
        usage: value.usage as RawUsageLike | undefined,
        durationMs: Date.now() - startTime,
        ttftMs,
        retries,
        usedFallback: false,
      }),
    };
  }

  async generateObject<T extends z.ZodTypeAny>(
    options: LLMCallOptions & { schema: T },
  ): Promise<LLMObjectResult<z.infer<T>>> {
    const modelId = resolveModelForStage(this.runtime, options.recipe, options.stage);
    const effort = this.resolveEffort(options);
    const model = this.provider.chatModel(modelId);
    const temperature = this.resolveTemperature(options);
    const startTime = Date.now();

    const runJsonObjectCall = async (usedFallback: boolean) => {
      const schemaJson = JSON.stringify(zodSchema(options.schema).jsonSchema, null, 2);
      const { value: textRes, retries } = await withRateLimitRetry(() =>
        generateText({
          model,
          system: options.system,
          prompt: `${options.prompt}\n\n【强制输出格式】请严格按照以下 JSON Schema 仅输出合法纯 JSON 对象（字段名与类型必须完全匹配，禁止输出额外说明文字）：\n\`\`\`json\n${schemaJson}\n\`\`\``,
          temperature,
          providerOptions: this.buildProviderOptions(modelId, effort, {
            response_format: { type: 'json_object' },
          }),
          maxRetries: 1,
        }),
      );

      const parsed = extractJsonObject(textRes.text);
      const validated = options.schema.parse(parsed);
      return {
        object: validated as z.infer<T>,
        cost: this.buildCostRecord({
          stage: options.stage,
          modelId,
          effort,
          chapter: options.chapter,
          usage: textRes.usage as RawUsageLike | undefined,
          durationMs: Date.now() - startTime,
          retries,
          usedFallback,
        }),
      };
    };

    // DeepSeek 官方 API 不支持 OpenAI json_schema structuredOutputs，直接走单次 json_object 避免双重请求浪费
    if (this.isDeepSeek) {
      return runJsonObjectCall(false);
    }

    try {
      const { value: result, retries } = await withRateLimitRetry(() =>
        generateObject({
          model,
          schema: options.schema,
          system: options.system,
          prompt: options.prompt,
          temperature,
          providerOptions: this.buildProviderOptions(modelId, effort),
          maxRetries: 1,
        }),
      );

      return {
        object: result.object as z.infer<T>,
        cost: this.buildCostRecord({
          stage: options.stage,
          modelId,
          effort,
          chapter: options.chapter,
          usage: result.usage as RawUsageLike | undefined,
          durationMs: Date.now() - startTime,
          retries,
          usedFallback: false,
        }),
      };
    } catch (err) {
      if (isAuthOrNotFoundError(err)) {
        throw new Error(formatDetailedError(err));
      }
      try {
        return await runJsonObjectCall(true);
      } catch (fallbackErr) {
        throw new Error(
          `结构化调用失败：\n- 主路径：${formatDetailedError(err)}\n- JSON降级路径：${formatDetailedError(fallbackErr)}`,
        );
      }
    }
  }
}

export function formatCostTelemetry(r: CostRecord): string {
  const sec = (r.duration_ms / 1000).toFixed(1);
  const ttft = r.ttft_ms !== undefined ? ` TTFT ${(r.ttft_ms / 1000).toFixed(1)}s` : '';
  const cacheRate =
    r.prompt_tokens > 0
      ? `${((r.cached_input_tokens / r.prompt_tokens) * 100).toFixed(1)}%`
      : '0.0%';
  const reasonPart =
    r.reasoning_tokens > 0 ? ` reason=${r.reasoning_tokens}` : '';
  const tokPerSec =
    r.duration_ms > 0
      ? ((r.completion_tokens / r.duration_ms) * 1000).toFixed(1)
      : '0.0';
  const flags: string[] = [];
  if (r.retries > 0) flags.push(`retry=${r.retries}`);
  if (r.used_fallback) flags.push('fallback=JSON');
  const flagStr = flags.length > 0 ? ` [${flags.join(' ')}]` : '';
  const effortStr = r.reasoning_effort ? ` effort=${r.reasoning_effort}` : '';

  return `  ↳ [${r.stage} | ${r.model}${effortStr}] ${sec}s${ttft} (${tokPerSec} tok/s) | in=${r.prompt_tokens} (cache ${r.cached_input_tokens}/${cacheRate}) | out=${r.completion_tokens}${reasonPart}${flagStr}`;
}

export function formatDetailedError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const anyErr = err as Error & {
    statusCode?: number;
    responseBody?: string;
    cause?: unknown;
    lastError?: unknown;
  };
  const parts: string[] = [err.message || err.name];
  if (anyErr.statusCode) parts.push(`HTTP ${anyErr.statusCode}`);
  if (anyErr.responseBody) {
    parts.push(`body=${String(anyErr.responseBody).slice(0, 300)}`);
  }
  if (anyErr.lastError) {
    parts.push(`lastError=${formatDetailedError(anyErr.lastError)}`);
  } else if (anyErr.cause) {
    parts.push(`cause=${formatDetailedError(anyErr.cause)}`);
  }
  return parts.join(' | ');
}

function isRateLimitError(err: unknown): boolean {
  const detail = formatDetailedError(err);
  const anyErr = err as { statusCode?: number; lastError?: { statusCode?: number } };
  const status = anyErr?.statusCode ?? anyErr?.lastError?.statusCode;
  if (status === 429 || status === 503 || status === 502 || status === 504) {
    return true;
  }
  return /429|503|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|rate.?limit|quota|too many requests|overloaded/i.test(
    detail,
  );
}

function isAuthOrNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /401|403|404|API_KEY_INVALID|invalid api key|not found/i.test(msg);
}

async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
): Promise<{ value: T; retries: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn();
      return { value, retries: attempt - 1 };
    } catch (err) {
      lastError = err;
      if (!isRateLimitError(err) || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = 2500 * Math.pow(2, attempt - 1);
      console.warn(
        `  ⚠ [重试 ${attempt}/${maxAttempts - 1}] 接口限流/高负载（${formatDetailedError(err).slice(0, 120)}），等待 ${(delayMs / 1000).toFixed(1)}s 后重试...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw new Error(`无法从模型输出中解析合法 JSON：${trimmed.slice(0, 200)}`);
  }
}
