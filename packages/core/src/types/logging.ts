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

/** stderr logger 选项 */
export interface LoggerOptions {
  /** 最低输出等级；默认 `info`（debug 需显式开启） */
  level?: LogLevel;
  /** 是否脱敏；默认 true */
  redact?: boolean;
}
