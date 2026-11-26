/**
 * models 块 camelCase DTO → snake_case 磁盘形状（两面重构 §3.2 / §4.1）。
 *
 * 唯一序列化口径：registry-store 写事务与一次性迁移共用（loader 的
 * snakeToCamel + preserveConfigMapKeys 是反向映射口径）。map 键（凭证 id /
 * 条目键 / param.extra / info 未知键）原样保留。
 *
 * @module @vessel-agent/config/models-disk
 */

import type { CredentialEntry, ModelEntry } from './types.js';

/** camelCase 价格四元组 → snake_case 磁盘形状（pricing.models 与 entry.pricing 共用）。 */
export function pricingToYaml(
  pricing: NonNullable<ModelEntry['pricing']>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    input_per_million: pricing.inputPerMillion,
    output_per_million: pricing.outputPerMillion,
  };
  if (pricing.cacheReadPerMillion !== undefined) {
    out.cache_read_per_million = pricing.cacheReadPerMillion;
  }
  if (pricing.cacheWritePerMillion !== undefined) {
    out.cache_write_per_million = pricing.cacheWritePerMillion;
  }
  return out;
}

/** camelCase param → snake_case 磁盘形状（extra 子树原样）。 */
function paramToYaml(param: NonNullable<ModelEntry['param']>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (param.temperature !== undefined) out.temperature = param.temperature;
  if (param.maxTokens !== undefined) out.max_tokens = param.maxTokens;
  if (param.topP !== undefined) out.top_p = param.topP;
  if (param.promptCache !== undefined) out.prompt_cache = param.promptCache;
  if (param.extra !== undefined) out.extra = param.extra;
  return out;
}

/** camelCase info → snake_case 磁盘形状（已知键映射；未知键读容忍原样，§10.3）。 */
function infoToYaml(info: NonNullable<ModelEntry['info']>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(info)) {
    if (value === undefined) continue;
    if (key === 'displayName') out.display_name = value;
    else if (key === 'contextWindow') out.context_window = value;
    else if (key === 'maxOutputTokens') out.max_output_tokens = value;
    else out[key] = value;
  }
  return out;
}

/** camelCase 模型条目 DTO → snake_case 磁盘条目（整条替换口径）。 */
export function entryToYaml(entry: ModelEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { credential: entry.credential };
  if (entry.name !== undefined) out.name = entry.name;
  if (entry.alias !== undefined) out.alias = entry.alias;
  if (entry.provider !== undefined) out.provider = entry.provider;
  if (entry.mode !== undefined) out.mode = entry.mode;
  if (entry.pricing !== undefined) out.pricing = pricingToYaml(entry.pricing);
  if (entry.param !== undefined) out.param = paramToYaml(entry.param);
  if (entry.info !== undefined) out.info = infoToYaml(entry.info);
  return out;
}

/** camelCase 凭证元数据 DTO → snake_case 磁盘形状（无密钥值）。 */
export function credentialToYaml(meta: CredentialEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { base_url: meta.baseUrl };
  if (meta.apiKeyEnv !== undefined) out.api_key_env = meta.apiKeyEnv;
  return out;
}
