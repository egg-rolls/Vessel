/**
 * CLI / serve 的诊断日志装配（0.10 R2-14）。
 *
 * 规则：
 * - 日志只写 stderr；stdout 保留给命令结果 / JSON / UX 输出。
 * - 级别 / 格式 / 脱敏统一由 core 进程级日志中枢（log-hub）控制：
 *   `VESSEL_DEBUG` / `VESSEL_LOG_LEVEL` / `VESSEL_LOG_JSON` 在中枢加载时生效；
 *   config `observability.log` 经 `configureLoggingFromConfig` 应用（启动一次 +
 *   config-watch 热应用），环境变量覆盖仍然优先。
 * - 返回 core 的 `Logger` 端口（中枢薄封装，阈值实时读取，构造后不固定）。
 *
 * @module vessel/logging
 */

import { DEFAULT_LOG_OPTIONS, type VesselConfig } from '../../packages/config/src/index';
import {
  configureLogging,
  createStderrLogger,
  type Logger,
  type LoggingConfig,
} from '../../packages/core/src/index';

/**
 * 创建 CLI / serve 共用的 stderr logger。
 * 环境变量覆盖由中枢在模块加载时读取；config 覆盖经 configureLoggingFromConfig 注入。
 */
export function createCliLogger(): Logger {
  return createStderrLogger();
}

/** observability.log → 中枢配置（补齐默认值；modules 键是事件名，原样透传）。 */
export function resolveLogOptions(config: Pick<VesselConfig, 'observability'>): LoggingConfig {
  const log = config.observability?.log;
  return {
    level: log?.level ?? DEFAULT_LOG_OPTIONS.level,
    modules: { ...(log?.modules ?? DEFAULT_LOG_OPTIONS.modules) },
    color: log?.color ?? DEFAULT_LOG_OPTIONS.color,
    format: log?.format ?? DEFAULT_LOG_OPTIONS.format,
    time: log?.time ?? DEFAULT_LOG_OPTIONS.time,
  };
}

/**
 * 把配置应用到日志中枢（启动时配置加载后调一次；热应用由 log applier 复用）。
 * 返回解析后的完整配置（供热应用做差异基线）。环境变量覆盖不被冲掉（中枢内优先）。
 */
export function configureLoggingFromConfig(
  config: Pick<VesselConfig, 'observability'>,
): LoggingConfig {
  const options = resolveLogOptions(config);
  configureLogging(options);
  return options;
}

/**
 * 日志配置差异行（只有 log 字段变化才产出，进 runtime.notice；格式 `log: level info→debug`）。
 * modules 按前缀逐条给差异（新增 / 删除 / 改级别），排序稳定。
 */
export function diffLogOptions(previous: LoggingConfig, next: LoggingConfig): string[] {
  const lines: string[] = [];
  for (const key of ['level', 'color', 'format', 'time'] as const) {
    if (previous[key] !== next[key]) lines.push(`log: ${key} ${previous[key]}→${next[key]}`);
  }
  const prefixes = new Set([...Object.keys(previous.modules), ...Object.keys(next.modules)]);
  for (const prefix of [...prefixes].sort()) {
    const before = previous.modules[prefix];
    const after = next.modules[prefix];
    if (before === after) continue;
    lines.push(`log: modules ${prefix} ${before ?? '(off)'}→${after ?? '(off)'}`);
  }
  return lines;
}
