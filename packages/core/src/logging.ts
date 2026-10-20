/**
 * 最小 Logger 端口（0.10 R2-14）
 *
 * 诊断日志与 UX 输出分开：core 只定义端口与 stderr 实现，
 * CLI / serve / TUI 自行决定是否注入（宿主可替换为文件或远程 sink）。
 *
 * - 默认输出 **stderr**，一行一个 JSON（`time` / `level` / `message` / `fields`）。
 * - 默认用 trace redactor 对 message 与 fields 脱敏（`redact: false` 可关闭）。
 * - sink 写失败一律吞掉：日志不得改变运行语义。
 *
 * @module @vessel/core/logging
 */

import { createDefaultTraceRedactor } from './observability/trace-redactor.js';
import type { TraceRedactor } from './types/trace.js';

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

/** `createStderrLogger` 选项 */
export interface LoggerOptions {
  /** 最低输出等级；默认 `info`（debug 需显式开启） */
  level?: LogLevel;
  /** 是否脱敏；默认 true */
  redact?: boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 丢弃全部日志；`AgentRuntimeOptions.logger` 缺省值 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 借 redactor 的字符串规则处理任意值（message 与 fields 走同一条路径） */
function redactValue(redactor: TraceRedactor, value: unknown): unknown {
  const redacted = redactor.redact({
    type: 'log',
    run_id: '-',
    data: { value },
    ts: 0,
  });
  return (redacted.data as Record<string, unknown>).value;
}

/**
 * 创建写入 stderr 的 logger。
 *
 * 输出格式：`{"time":"...","level":"warn","message":"...","fields":{...}}`
 * ——stdout 留给命令结果 / JSON 输出。构造后行为固定，不读取环境变量。
 */
export function createStderrLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? 'info'];
  const redactor = options.redact === false ? undefined : createDefaultTraceRedactor();

  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    try {
      const safeMessage =
        redactor === undefined ? message : String(redactValue(redactor, message) ?? '');
      const safeFields = redactor === undefined ? fields : redactValue(redactor, fields);
      const line: Record<string, unknown> = {
        time: new Date().toISOString(),
        level,
        message: safeMessage,
      };
      if (safeFields !== undefined) line.fields = safeFields;
      process.stderr.write(`${JSON.stringify(line)}\n`);
    } catch {
      // 日志 sink 故障不得影响调用方
    }
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
