/**
 * tenant 工具策略（0.18，DECISION-032 §1）。
 *
 * `tenant.tenants.<id>.tools.allow/deny` 的解析与判定纯函数：
 * - `allow` 缺省 = 不限制；存在（含空数组）= 白名单，`allow: []` 一个都不允许；
 * - `deny` 命中即拒绝，即使同名也在 `allow`；
 * - 工具名精确匹配、区分大小写，不做 glob / 前缀；未知名字静默忽略。
 *
 * 无 core 依赖，供 TenantToolHost（asm）与 `--tools` 复用。
 *
 * @module @vessel-agent/config/tenant-tools
 */

import type { VesselConfig } from './types.js';

/** 已解析的 tenant 工具策略；缺省字段表示该维度不限制 */
export interface TenantToolPolicy {
  allow?: readonly string[];
  deny?: readonly string[];
}

/**
 * 解析某 tenant 的 `tools.allow/deny`。
 * 未配置 tools 或两个维度都缺省时返回 undefined（不限制）。
 */
export function resolveTenantToolPolicy(
  config: Pick<VesselConfig, 'tenant'>,
  tenantId: string,
): TenantToolPolicy | undefined {
  const tools = config.tenant?.tenants?.[tenantId]?.tools;
  if (!tools) return undefined;
  const policy: TenantToolPolicy = {};
  if (tools.allow !== undefined) policy.allow = [...tools.allow];
  if (tools.deny !== undefined) policy.deny = [...tools.deny];
  return policy.allow === undefined && policy.deny === undefined ? undefined : policy;
}

/**
 * 工具是否允许在此 tenant 注册 / 暴露。
 * 判定顺序：deny 优先；其次 allow 白名单（存在即限制，空数组拒绝全部）。
 */
export function isTenantToolAllowed(name: string, policy?: TenantToolPolicy): boolean {
  if (!policy) return true;
  if (policy.deny?.includes(name)) return false;
  if (policy.allow !== undefined && !policy.allow.includes(name)) return false;
  return true;
}
