/**
 * 配置快照的 tenant 隔离（A6-10 / A-3 §10.6）。
 *
 * tenant 合并后的 `config` 仍保留全局 `tenant.tenants` 注册表；直接快照会把
 * 其它 tenant 的 overlay 内容暴露给当前 tenant。快照只保留当前 tenant 的
 * 有效配置与 `tenant.default` 元数据。
 *
 * @module vessel/config-snapshot
 */

import type { VesselConfig } from '../packages/config/src/index';

/** 返回可安全下发的配置副本：剔除 `tenant.tenants` 注册表。 */
export function sanitizeConfigForSnapshot(config: VesselConfig): VesselConfig {
  const clone = structuredClone(config);
  if (!clone.tenant) return clone;

  clone.tenant = { ...clone.tenant };
  delete clone.tenant.tenants;
  if (Object.keys(clone.tenant).length === 0) {
    delete clone.tenant;
  }
  return clone;
}
