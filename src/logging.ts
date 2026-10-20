/**
 * CLI / serve 的诊断日志装配（0.10 R2-14）。
 *
 * 规则：
 * - 日志只写 stderr；stdout 保留给命令结果 / JSON / UX 输出。
 * - 级别来自 `VESSEL_LOG_LEVEL`（debug|info|warn|error）；`VESSEL_DEBUG` 只要非空即 debug。
 * - 非法 `VESSEL_LOG_LEVEL` 回退 info，不因日志配置阻断启动。
 * - 返回 core 的 `Logger` 端口；脱敏由 `createStderrLogger` 内置的 redactor 完成。
 *
 * @module vessel/logging
 */

import { createStderrLogger, type Logger, type LogLevel } from '../packages/core/src/index';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** `VESSEL_LOG_LEVEL` → LogLevel；缺省 / 非法返回 undefined */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return LEVELS.includes(normalized as LogLevel) ? (normalized as LogLevel) : undefined;
}

/**
 * 创建 CLI / serve 共用的 stderr logger。
 * `VESSEL_DEBUG` 优先于 `VESSEL_LOG_LEVEL`（调试开关是最显式的意图）。
 */
export function createCliLogger(env: Record<string, string | undefined> = process.env): Logger {
  const debugEnabled = (env.VESSEL_DEBUG ?? '').trim() !== '';
  const level: LogLevel = debugEnabled ? 'debug' : (parseLogLevel(env.VESSEL_LOG_LEVEL) ?? 'info');
  return createStderrLogger({ level });
}
