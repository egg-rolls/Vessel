/**
 * 最小 Logger 端口（0.10 R2-14）
 *
 * 诊断日志与 UX 输出分开：core 只定义端口与 stderr 实现，
 * CLI / serve / TUI 自行决定是否注入（宿主可替换为文件或远程 sink）。
 *
 * P2 起 `createStderrLogger` 是**进程级日志中枢**（`log-hub.ts`）的薄封装：
 * - 每次写都转发到 `emitLogLine`，阈值**每次读取当前配置**（不再构造时固定），
 *   模块级单例（event-stream / mcp / provider retry）无需改动即跟随热应用；
 * - 输出格式由中枢决定（pretty 单行 / json 单行），脱敏统一在中枢完成；
 * - sink 写失败一律吞掉：日志不得改变运行语义。
 *
 * **EPIPE 自激防护不变量**（sink 报废、error 监听、禁止裸 `process.stderr.write`）
 * 见 `log-hub.ts` 文件头 —— 重写日志层前必读。`writeStderrNotice` 自中枢 re-export，
 * 保持既有导入路径不变。
 *
 * @module @vessel-agent/core/logging
 */

import { emitLogLine } from './log-hub.js';
import type { LogFields, Logger } from './types/logging.js';

export { writeStderrNotice } from './log-hub.js';

/** 丢弃全部日志；注入式 logger 端口的缺省值 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * 创建写入 stderr 的 logger（中枢薄封装）。
 *
 * 级别 / 格式 / 脱敏全部由进程级日志中枢控制：构造后行为**不**固定，
 * 跟随 `configureLogging` 与环境变量覆盖实时变化。
 */
export function createStderrLogger(): Logger {
  return {
    debug: (message, fields) => emitLogLine('debug', message, fields),
    info: (message, fields) => emitLogLine('info', message, fields),
    warn: (message, fields) => emitLogLine('warn', message, fields),
    error: (message, fields) => emitLogLine('error', message, fields),
  };
}

/**
 * 携 base 字段的同形 Logger 助手（q-error-e2 §3.7，裁定④）。
 *
 * correlation 走**显式字段**（不用 AsyncLocalStorage、不引 OTel）：调用方把
 * run_id/session_id/agent_id/request_id/error_id 等约定键（见 types/logging.ts
 * LogFields 注释与 docs LogFields 约定键文档）绑进 base，逐层透传。
 * 调用点字段覆盖 base；Logger 端口形状不变，log-hub 脱敏/级别/EPIPE 不变量全不动。
 */
export function withFields(logger: Logger, base: LogFields): Logger {
  const merge = (fields?: LogFields): LogFields => ({ ...base, ...fields });
  return {
    debug: (message, fields) => logger.debug(message, merge(fields)),
    info: (message, fields) => logger.info(message, merge(fields)),
    warn: (message, fields) => logger.warn(message, merge(fields)),
    error: (message, fields) => logger.error(message, merge(fields)),
  };
}
