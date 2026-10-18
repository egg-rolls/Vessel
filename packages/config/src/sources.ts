/**
 * 配置快照（0.5 E12 / A-3 §10.6）
 *
 * CLI `config show --sources` 与 web RPC 共用同一形状，保证输出一致。
 * 快照内 config 始终脱敏；sources 只含来源标签，不含值。
 *
 * @module @vessel/config
 */

import { redactConfig } from './secrets.js';
import type { ConfigSnapshot, ConfigSources, VesselConfig } from './types.js';

/** buildConfigSnapshot 输入 */
export interface BuildConfigSnapshotInput {
  config: VesselConfig;
  sources: ConfigSources;
  paths: { user: string; project: string };
  tenantId?: string;
  tenantOverlayKeys?: string[];
}

/** 构造已脱敏的配置快照（不修改入参） */
export function buildConfigSnapshot(input: BuildConfigSnapshotInput): ConfigSnapshot {
  return {
    schema_version: 1,
    config: redactConfig(input.config),
    sources: { ...input.sources },
    paths: { user: input.paths.user, project: input.paths.project },
    ...(input.tenantId !== undefined ? { tenant_id: input.tenantId } : {}),
    ...(input.tenantOverlayKeys && input.tenantOverlayKeys.length > 0
      ? { tenant_overlay_keys: [...input.tenantOverlayKeys] }
      : {}),
  };
}
