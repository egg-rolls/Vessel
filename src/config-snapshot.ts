/**
 * 配置快照副本（A6-10 / A-3 §10.6）。
 *
 * 0.49 T4：`VesselConfig.tenant` 注册表已删除，快照不再需要剔除其它 tenant
 * 的 overlay；保留本导出只作为“深拷贝后再下发”的边界，供 bootstrap / cli 复用。
 *
 * @module vessel/config-snapshot
 */

import type { VesselConfig } from '../packages/config/src/index';

/** 返回可安全下发的配置副本。 */
export function sanitizeConfigForSnapshot(config: VesselConfig): VesselConfig {
  return structuredClone(config);
}
