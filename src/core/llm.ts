import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateObject, generateText, zodSchema } from 'ai';
import type { z } from 'zod';
import {
  resolveModelForStage,
  type RecipeConfig,
  type RuntimeConfig,
} from '../config.js';
import type { CostRecord, PipelineStage } from '../memory/schema.js';

export interface LLMCallOptions {
  stage: PipelineStage;
  system?: string;
  prompt: string;
  temperature?: number;
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

export class VercelLLMClient implements LLMClient {
  private readonly runtime: RuntimeConfig;
  private readonly provider: ReturnType<typeof createOpenAICompatible>;

  constructor(runtime: RuntimeConfig) {
    this.runtime = runtime;
    if (!runtime.apiKey) {
      throw new Error(
        '未检测到 SILKCANTO_API_KEY。请先复制 .env.example 为 .env 并填入你的 DeepSeek API Key。',
      );
    }
    this.provider = createOpenAICompatible({
      name: 'openai-compatible',
      baseURL: runtime.baseUrl,
      apiKey: runtime.apiKey,
      includeUsage: true,
      supportsStructuredOutputs: true,
    });
  }

  private buildCostRecord(
    stage: PipelineStage,
    modelId: string,
    chapter: number | undefined,
    usage: { inputTokens?: number; outputTokens?: number } | undefined,
  ): CostRecord {
    const promptTokens = usage?.inputTokens ?? 0;
    const completionTokens = usage?.outputTokens ?? 0;
    const cost =
      (promptTokens / 1_000_000) * this.runtime.inputCostPer1M +
      (completionTokens / 1_000_000) * this.runtime.outputCostPer1M;

    return {
      timestamp: new Date().toISOString(),
      stage,
      model: modelId,
      chapter,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      estimated_cost_cny: Number(cost.toFixed(6)),
    };
  }

  private resolveTemperature(options: LLMCallOptions): number {
    if (options.temperature !== undefined) return options.temperature;
    return options.recipe?.temperatures?.[options.stage] ?? 0.5;
  }

  async generateText(options: LLMCallOptions): Promise<LLMTextResult> {
    const modelId = resolveModelForStage(this.runtime, options.recipe, options.stage);
    const model = this.provider.chatModel(modelId);
    const result = await withRateLimitRetry(() =>
      generateText({
        model,
        system: options.system,
        prompt: options.prompt,
        temperature: this.resolveTemperature(options),
        maxRetries: 1,
      }),
    );

    return {
      text: result.text.trim(),
      cost: this.buildCostRecord(options.stage, modelId, options.chapter, result.usage),
    };
  }

  async generateObject<T extends z.ZodTypeAny>(
    options: LLMCallOptions & { schema: T },
  ): Promise<LLMObjectResult<z.infer<T>>> {
    const modelId = resolveModelForStage(this.runtime, options.recipe, options.stage);
    const model = this.provider.chatModel(modelId);
    const temperature = this.resolveTemperature(options);

    try {
      const result = await withRateLimitRetry(() =>
        generateObject({
          model,
          schema: options.schema,
          system: options.system,
          prompt: options.prompt,
          temperature,
          maxRetries: 1,
        }),
      );

      return {
        object: result.object as z.infer<T>,
        cost: this.buildCostRecord(options.stage, modelId, options.chapter, result.usage),
      };
    } catch (err) {
      if (isAuthOrNotFoundError(err)) {
        throw new Error(formatDetailedError(err));
      }

      const schemaJson = JSON.stringify(zodSchema(options.schema).jsonSchema, null, 2);
      const jsonSystem = [
        options.system || '',
        '你必须仅返回一个合法的 JSON 对象（用 ```json ... ``` 包裹或纯 JSON），严格遵守给定的 JSON Schema 字段名与类型，严禁输出任何解释性文字。',
      ]
        .filter(Boolean)
        .join('\n\n');

      try {
        const textRes = await withRateLimitRetry(() =>
          generateText({
            model,
            system: jsonSystem,
            prompt: `${options.prompt}\n\n请严格按照以下 JSON Schema 返回纯 JSON 对象（字段名必须完全一致）：\n\`\`\`json\n${schemaJson}\n\`\`\``,
            temperature,
            maxRetries: 1,
          }),
        );

        const parsed = extractJsonObject(textRes.text);
        const validated = options.schema.parse(parsed);
        return {
          object: validated as z.infer<T>,
          cost: this.buildCostRecord(options.stage, modelId, options.chapter, textRes.usage),
        };
      } catch (fallbackErr) {
        throw new Error(
          `结构化调用失败：\n- 主路径：${formatDetailedError(err)}\n- JSON降级路径：${formatDetailedError(fallbackErr)}`,
        );
      }
    }
  }
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
  const msg = err instanceof Error ? err.message : String(err);
  return /429|RESOURCE_EXHAUSTED|rate.?limit|quota|too many requests|503|overloaded/i.test(
    msg,
  );
}

function isAuthOrNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /401|403|404|API_KEY_INVALID|invalid api key|not found/i.test(msg);
}

async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRateLimitError(err) || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = 2500 * Math.pow(2, attempt - 1);
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
