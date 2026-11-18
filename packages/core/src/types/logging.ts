/**
 * 日志端口类型（0.10 R2-14）
 *
 * 纯类型模块：`types/**` 不得依赖实现，实现（`logging.ts`）反过来 import 这里。
 *
 * @module @vessel-agent/core/types
 */

/** 日志等级（debug < info < warn < error） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 结构化字段；值会经默认 redactor 处理 */
export type LogFields = Record<string, unknown>;

/**
 * 诊断日志端口（0.10 R2-14）。
 * 消息是给人看的短句，字段承载结构化元信息（run_id / tool_name / count ...）。
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** 日志输出格式：pretty = vite 式单行；json = 单行 JSON（机器接口） */
export type LogFormat = 'pretty' | 'json';

/** 时间显示：auto = TTY 用 clock、非 TTY（落盘）用 iso */
export type LogTimeMode = 'auto' | 'none' | 'clock' | 'iso';

/** 着色：auto = 按 stderr.isTTY 与 NO_COLOR / FORCE_COLOR 判定 */
export type LogColorMode = 'auto' | 'always' | 'never';

/**
 * 进程级日志中枢配置（config 的 `observability.log`；运行时可反复设置）。
 * 级别阈值不再在 logger 构造时固定 —— 全部由中枢统一控制（ADR-069 端口不变）。
 */
export interface LoggingConfig {
  /** 全局最低输出等级 */
  level: LogLevel;
  /** 事件名前缀 → 级别（最长前缀匹配，按点分段） */
  modules: Record<string, LogLevel>;
  format: LogFormat;
  time: LogTimeMode;
  color: LogColorMode;
}
