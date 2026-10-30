/**
 * Usage 归一化（0.29 U1）
 * @module @vessel-agent/core/provider
 *
 * 不变式（CONTRACT-0.29 §1）：
 *  - `prompt_tokens` = 本次请求的**全部输入** token，含缓存读与缓存写
 *    （= OTel `gen_ai.usage.input_tokens`；OpenAI 原生就是这个口径）；
 *  - `cache_read_input_tokens` / `cache_creation_input_tokens` 是 `prompt_tokens`
 *    的**子集**，读取方禁止再把它们加到 `prompt_tokens` 上；
 *  - provider 不支持缓存时两个 cache 字段**缺省**（undefined），不是 0；
 *  - `total_tokens` 必须与归一化后的两项自洽，不得出现 `total_tokens < prompt_tokens`。
 *
 * 归一化只在 adapter 层做一次；展示层按 provider 分支换算是禁止的（§1.2）。
 */

import type { Usage } from '../types/provider.js';

/** Anthropic 原生 usage（排他语义：input_tokens 不含缓存） */
export interface AnthropicRawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * OpenAI 兼容端点的原生 usage。
 *
 * `prompt_tokens` 已含缓存命中量；缓存命中从两个位置读取（见 `fromOpenAiUsage`）。
 */
export interface OpenAiRawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** OpenAI / Gemini(OpenAI 兼容) 的缓存命中明细 */
  prompt_tokens_details?: { cached_tokens?: number };
  /** DeepSeek 的命中字段（与 prompt_tokens_details.cached_tokens 同义） */
  prompt_cache_hit_tokens?: number;
}

/**
 * total 的自洽取值：provider 原生值可用时保留（不篡改厂商口径），
 * 但前提是与归一化后的 prompt 不矛盾（`total_tokens < prompt_tokens` 属自相矛盾，
 * CONTRACT-0.29 §1 之外的一致性要求）。矛盾或缺失时按 prompt + completion 派生。
 */
function consistentTotal(raw: number | undefined, prompt: number, completion: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= prompt) return raw;
  return prompt + completion;
}

/**
 * Anthropic → Usage：把排他的 `input_tokens` 抬成含缓存的全部输入。
 *
 * Anthropic 的缓存字段只在显式缓存（`cache_control`）生效时出现；缺省按 0 参与求和，
 * 但归一化后的 cache 字段仍按「出现才写入」保留缺省语义。
 */
export function fromAnthropicUsage(raw: AnthropicRawUsage): Usage {
  const cacheRead = raw.cache_read_input_tokens;
  const cacheCreation = raw.cache_creation_input_tokens;
  const prompt = (raw.input_tokens ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
  const completion = raw.output_tokens ?? 0;
  const usage: Usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  if (cacheCreation !== undefined) usage.cache_creation_input_tokens = cacheCreation;
  if (cacheRead !== undefined) usage.cache_read_input_tokens = cacheRead;
  return usage;
}

/**
 * OpenAI 兼容 → Usage：`prompt_tokens` 原生已含缓存，**不改**，只补 cache 读取量。
 *
 * 缓存命中量的来源（按优先级）：
 *  1. `prompt_tokens_details.cached_tokens` —— OpenAI、Gemini 的 OpenAI 兼容端点；
 *  2. `prompt_cache_hit_tokens` —— DeepSeek（拆分式：`prompt_tokens = hit + miss`，
 *     所以 `prompt_tokens` 无需换算，`cache_creation` 免费因此缺省）。
 *
 * 都不出现时两个 cache 字段缺省（undefined），表示该 provider 不报告缓存（§1.1 末行）。
 */
export function fromOpenAiUsage(raw: OpenAiRawUsage): Usage {
  const details = raw.prompt_tokens_details;
  const cached =
    typeof details?.cached_tokens === 'number'
      ? details.cached_tokens
      : typeof raw.prompt_cache_hit_tokens === 'number'
        ? raw.prompt_cache_hit_tokens
        : undefined;

  const prompt = raw.prompt_tokens ?? 0;
  const completion = raw.completion_tokens ?? 0;
  const usage: Usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: consistentTotal(raw.total_tokens, prompt, completion),
  };
  if (cached !== undefined) usage.cache_read_input_tokens = cached;
  return usage;
}
