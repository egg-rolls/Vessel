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
 * ## 不变量（重要，重写日志层前必读）：**日志 sink 的失败绝不能升级成进程级问题**
 *
 * 具体地说：sink 断开（EPIPE，典型来源是后台启动后启动 shell / 管道对端退出）时，
 * 写失败**只允许**导致「日志丢失」，绝不允许导致「进程不再工作」。
 *
 * 反面教材（0.56 的 P0）：`process.stderr.write` 在 sink 断开时以**流错误**异步抛出，
 * 绕过了写调用处的 `try/catch`，被升级成 `uncaughtException`；而进程级错误处理器
 * 为了记录错误**又去写同一个 sink**，于是
 * `写失败 → uncaughtException → 处理器写日志 → 再写失败 → …`
 * 形成**无界自激**：主线程 100% CPU（纯用户态自旋，`wchan=0`）、定时器全停、
 * 端口不响应、RSS 持续上涨，而且 **SIGTERM 杀不掉**（信号处理也要事件循环），
 * 只能 SIGKILL。一次 EPIPE 就能让整个进程既不工作也不退出。
 *
 * 因此这里做两件事，二者都不能省：
 * 1. 给 `process.stderr` 挂 `error` 监听，把流错误**吸收**成「标记报废」而不是进程级异常；
 * 2. 报废后所有写入变成 no-op（**有界**：最多损失日志）。
 *
 * 任何新的 stderr 写入路径都必须走 {@link writeStderrNotice} 或 logger，
 * 不得再出现裸 `process.stderr.write`——同类路径不该有第二个入口。
 *
 * 边界：这条不变量只约束**日志 sink**（长驻服务进程里可缺失的旁路通道）。
 * 短命命令的**结果输出**（如 `vessel completion` / `vessel plugin` 的 stdout/stderr）
 * 不在此列：那里写不出去说明用户拿不到结果，报错退出才是对的。
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

/**
 * 向 stderr 写一行**非日志**提示（插件缺省、fallback warning 等）。
 *
 * 与 logger 共用同一个 sink 报废状态：sink 一旦坏掉，这里也一律 no-op。
 * **所有** stderr 写入都必须走这里或 logger，不要新增裸 `process.stderr.write`
 * —— 见文件头「不变量」一节。
 */
export function writeStderrNotice(text: string): void {
  if (stderrBroken) return;
  try {
    process.stderr.write(text);
  } catch {
    markStderrBroken();
  }
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
