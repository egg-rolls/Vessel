/**
 * Trace 类型定义（0.5 F2 / DECISION-010 §2.2、Addendum A-3/A-4）
 *
 * @module @vessel-agent/core/types
 */

import type { RunEvent } from './event.js';

/** trace 级别（§2.2 冻结） */
export type TraceLevel = 'full' | 'metadata' | 'off';

/**
 * trace 配置的权威形状在 core（A-4 §11.3）。
 * 默认值由 `packages/config` 的 DEFAULT_CONFIG 提供，core 不定义默认配置。
 */
export interface TraceConfig {
  enabled?: boolean;
  level?: TraceLevel;
  retentionDays?: number;
  maxRuns?: number;
  maxBytes?: number;
}

/**
 * trace 记录 port（§2.2 冻结）。
 *
 * `append` 必须是非阻塞入队；写失败通过 `trace.write.failed` 上报，不向调用方抛错。
 */
export interface TraceRecorder {
  append(event: RunEvent): void;
  flush(runId?: string): Promise<void>;
  close(): Promise<void>;
}

/** 脱敏 port（§2.2 冻结） */
export interface TraceRedactor {
  redact(event: RunEvent): RunEvent;
}
