/**
 * opt-in 用量计价（0.51）。
 *
 * 用户配置 `pricing.models.<provider.model>` 的四项单价（计价货币 / 百万 token），
 * 装配层把它编译成 core 的 `UsagePricing` 端口。没有配置 / 模型未命中时返回
 * `undefined`，`total_cost` 保持 0，`total_cost_limit` 不生效。
 *
 * **必须按分项计价，不能拿累计 token × 一个单价**：
 * - `prompt_tokens` 已含缓存（CONTRACT-0.29 U1），其中 cache read 与 cache write
 *   的单价和 fresh input 不同；
 * - 缓存单价低但 agentic loop 会反复读同一前缀，绝对金额并不小。
 *
 * fresh input = `prompt_tokens - cache_read - cache_creation`（Anthropic 的
 * `prompt_tokens` 同时含两类缓存；OpenAI 兼容端点没有 cache_creation）。
 *
 * @module vessel/usage-pricing
 */

import type { ModelEntry, PricingConfig } from '@vessel-agent/config';
import type { Usage, UsagePricing } from '@vessel-agent/core';

const PER_MILLION = 1_000_000;

/** 非负有限数；负值 / NaN / 缺省按 0。 */
function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 由配置生成计价表；没有配置任何模型时返回 undefined（保持旧行为）。
 *
 * 两面重构 §10.1 合并视图：注册模型价格唯一源 = entry.pricing（按 wire 名覆盖
 * 顶层 pricing.models 同名键）；顶层块降级为 legacy / 未注册 wire 的兜底（H8）。
 * 同 wire 名多 entry 价格不同 → 确定性取条目键序首个（H4；写前校验已 warning）。
 * 模型名按 wire 字符串精确匹配（D7：usage 聚合键无 entry/vendor 维度）。
 */
export function createUsagePricing(
  pricing: PricingConfig | undefined,
  entries?: Record<string, ModelEntry>,
): UsagePricing | undefined {
  const models: Record<string, NonNullable<ModelEntry['pricing']>> = { ...(pricing?.models ?? {}) };
  const entryWires = new Set<string>();
  for (const [key, entry] of Object.entries(entries ?? {})) {
    if (entry.pricing === undefined) continue;
    const wire = entry.name ?? key;
    if (entryWires.has(wire)) continue;
    entryWires.add(wire);
    models[wire] = entry.pricing;
  }
  if (Object.keys(models).length === 0) return undefined;

  return {
    costOf(model: string, usage: Usage): number | undefined {
      const price = models[model];
      if (price === undefined) return undefined;

      const inputRate = nonNegative(price.inputPerMillion);
      const outputRate = nonNegative(price.outputPerMillion);
      // 缓存单价缺省回落到 input 单价：宁可高估，不把已产生的成本算成 0。
      // 缓存单价缺省回落到 input 单价：不猜厂商倍率（Anthropic 写缓存可能 >1x，
      // 建议显式配置 cacheWritePerMillion）。
      const cacheReadRate = nonNegative(price.cacheReadPerMillion ?? inputRate);
      const cacheWriteRate = nonNegative(price.cacheWritePerMillion ?? inputRate);

      const prompt = nonNegative(usage.prompt_tokens);
      const cacheRead = nonNegative(usage.cache_read_input_tokens);
      const cacheWrite = nonNegative(usage.cache_creation_input_tokens);
      const freshInput = Math.max(0, prompt - cacheRead - cacheWrite);
      const completion = nonNegative(usage.completion_tokens);

      return (
        (freshInput * inputRate +
          cacheRead * cacheReadRate +
          cacheWrite * cacheWriteRate +
          completion * outputRate) /
        PER_MILLION
      );
    },
  };
}
