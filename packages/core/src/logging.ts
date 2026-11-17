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
 * @module @vessel-agent/core/logging
 */

import { createDefaultTraceRedactor } from './observability/trace-redactor.js';
import type { LogFields, Logger, LoggerOptions, LogLevel } from './types/logging.js';
import type { TraceRedactor } from './types/trace.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 丢弃全部日志；`ExecutionUnitOptions.logger` 缺省值 */
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
 * 进程级 stderr 是否已经坏掉（EPIPE / EIO / 已关闭的管道）。
 *
 * 一旦坏掉就**永久**停止写：故障处理路径（`createProcessErrorHandler`）本身会写日志，
 * 而「写一个已死的 sink」在 Bun/Node 上会以流错误的形式抛出来，绕过写调用处的 try/catch
 * 变成 `uncaughtException` —— 那会再进一次故障处理器、再写一次日志，形成无界自激。
 * 这里做一个进程级的一次性报废：坏一次之后所有日志变成 no-op（**有界**，最多损失日志，
 * 绝不损失进程）。
 */
let stderrBroken = false;

function markStderrBroken(): void {
  stderrBroken = true;
}

// 模块加载时给 stderr 挂一次 error 监听（每个进程一份，幂等）。
// 没有监听时，流的写失败会被当成未捕获异常抛出；有监听则只标记报废。
// 一个日志 sink 的错误**不该**升级成进程级异常。
try {
  process.stderr.on('error', markStderrBroken);
} catch {
  // 某些运行形态下 stderr 可能不是 EventEmitter：忽略，退化到只靠下面的同步 catch
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
    if (stderrBroken) return;
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
      // 日志 sink 故障不得影响调用方；且这个 sink 就此报废，免得故障处理路径
      // 每写一次就再炸一次（自激的燃料）。
      markStderrBroken();
    }
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
