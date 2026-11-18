/**
 * 进程级日志中枢（P2）：级别阈值、按模块级别、格式、时间的唯一控制点。
 *
 * 三路汇流：core Logger（`createStderrLogger` 薄封装）、serve `logEvent`、
 * 插件侧注入的 Logger，最终都经 {@link emitLogLine} 写出 —— 过滤 → 脱敏 → 排版
 * → {@link writeStderrNotice}。排版只有一处（`log-format.ts`），脱敏只有一处（这里）。
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
 * ## 优先级（从高到低）
 *
 * 1. `VESSEL_DEBUG`（非空即强制 debug）；
 * 2. `VESSEL_LOG_LEVEL`（debug|info|warn|error）；
 * 3. `VESSEL_RUN_TIMING=1`（仅 run.timing / run.llm.gap 强制 debug）；
 * 4. config（`configureLogging`，P4 接 observability.log 热应用）；
 * 5. 默认（level=info，format=pretty，time=auto，color=auto）。
 *
 * 环境变量在模块加载时读一次（排障临时覆盖）；config 可运行时反复设置。
 * `VESSEL_LOG_JSON=1` 等价 format=json（机器接口）。
 *
 * @module @vessel-agent/core/log-hub
 */

import { formatJsonLine, formatLogLine } from './log-format.js';
import { createDefaultTraceRedactor } from './observability/trace-redactor.js';
import type { LogFields, LoggingConfig, LogLevel } from './types/logging.js';
import type { TraceRedactor } from './types/trace.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

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
 * 与日志中枢共用同一个 sink 报废状态：sink 一旦坏掉，这里也一律 no-op。
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

/** 借 redactor 的字符串规则处理任意值（事件名与 fields 走同一条路径）。 */
function redactValue(redactor: TraceRedactor, value: unknown): unknown {
  const redacted = redactor.redact({
    type: 'log',
    run_id: '-',
    data: { value },
    ts: 0,
  });
  return (redacted.data as Record<string, unknown>).value;
}

// 脱敏统一在 emitLogLine 里做（先脱敏再排版）：pretty 与 json 同一路径，
// logEvent 也由此第一次纳入 redactor。ANSI 只在排版之后添加（P3），规则看不到 ANSI。
const redactor = createDefaultTraceRedactor();

/** `VESSEL_LOG_LEVEL` → LogLevel；缺省 / 非法返回 undefined（不阻断启动）。 */
function parseLevel(raw: string | undefined): LogLevel | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : undefined;
}

// ── 环境变量覆盖（模块加载时读一次；优先于 config） ─────────────────────────
const ENV_LEVEL: LogLevel | undefined =
  (process.env.VESSEL_DEBUG ?? '').trim() !== ''
    ? 'debug'
    : parseLevel(process.env.VESSEL_LOG_LEVEL);

const ENV_FORMAT: 'json' | undefined =
  (process.env.VESSEL_LOG_JSON ?? '').trim() === '1' ? 'json' : undefined;

/** `VESSEL_RUN_TIMING=1/true/on`：run 耗时账强制 debug（优先于全局环境级别）。 */
const ENV_MODULES: Record<string, LogLevel> = {};
{
  const raw = (process.env.VESSEL_RUN_TIMING ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'on') {
    ENV_MODULES['run.timing'] = 'debug';
    ENV_MODULES['run.llm.gap'] = 'debug';
  }
}

// ── config 状态（configureLogging 运行时可反复设置；P4 接热应用） ───────────
const state: LoggingConfig = {
  level: 'info',
  modules: {},
  format: 'pretty',
  time: 'auto',
  color: 'auto',
};

/**
 * 设置进程级日志配置（增量合并；未给出的键保持原值）。
 * 环境变量覆盖仍然优先（排障临时覆盖不被 config 冲掉）。
 */
export function configureLogging(opts: Partial<LoggingConfig>): void {
  if (opts.level !== undefined) state.level = opts.level;
  if (opts.modules !== undefined) state.modules = { ...opts.modules };
  if (opts.format !== undefined) state.format = opts.format;
  if (opts.time !== undefined) state.time = opts.time;
  if (opts.color !== undefined) state.color = opts.color;
  thresholdCache.clear();
}

/** 事件名 → 生效阈值缓存（R7：高频路径只做一次 Map 查找；configure 时失效）。 */
const thresholdCache = new Map<string, number>();
/** Logger 的 message 是自由文本，缓存键可能无界：超限整体清空（有界内存）。 */
const THRESHOLD_CACHE_MAX = 512;

/** modules 最长前缀匹配（按点分段：`gateway.ws` 命中 `gateway.ws.closed`）。 */
function moduleThreshold(modules: Record<string, LogLevel>, event: string): number | undefined {
  let best: string | undefined;
  for (const prefix of Object.keys(modules)) {
    if (event === prefix || event.startsWith(`${prefix}.`)) {
      if (best === undefined || prefix.length > best.length) best = prefix;
    }
  }
  if (best === undefined) return undefined;
  const level = modules[best];
  return level === undefined ? undefined : LEVEL_ORDER[level];
}

/**
 * 该事件在这个级别下是否输出。优先级：
 * 环境模块强制（run.timing）→ 环境全局级别 → config modules 最长前缀 → config 全局。
 */
export function isLevelEnabled(level: LogLevel, event: string): boolean {
  let threshold = thresholdCache.get(event);
  if (threshold === undefined) {
    threshold =
      moduleThreshold(ENV_MODULES, event) ??
      (ENV_LEVEL !== undefined ? LEVEL_ORDER[ENV_LEVEL] : undefined) ??
      moduleThreshold(state.modules, event) ??
      LEVEL_ORDER[state.level];
    if (thresholdCache.size >= THRESHOLD_CACHE_MAX) thresholdCache.clear();
    thresholdCache.set(event, threshold);
  }
  return LEVEL_ORDER[level] >= threshold;
}

/** time=auto：TTY 用 clock（人读），非 TTY（daemon 落盘）用 iso（grep / 跨天）。 */
function resolveTime(): 'none' | 'clock' | 'iso' {
  if (state.time !== 'auto') return state.time;
  return process.stderr.isTTY === true ? 'clock' : 'iso';
}

/**
 * 唯一的日志写出口：过滤 → 脱敏 → 排版（pretty / json）→ writeStderrNotice。
 *
 * 不新增裸 `process.stderr.write`（EPIPE 自激防护见文件头不变量）。
 * 调用方自己做过级别判定的（如 run-timing 的强制开关）仍走这里 —— 判定口径同一份。
 */
export function emitLogLine(level: LogLevel, event: string, fields?: LogFields): void {
  if (!isLevelEnabled(level, event)) return;
  try {
    const safeEvent = String(redactValue(redactor, event) ?? '');
    const safeFields = redactValue(redactor, fields ?? {}) as LogFields;
    const line =
      (ENV_FORMAT ?? state.format) === 'json'
        ? formatJsonLine(level, safeEvent, safeFields)
        : formatLogLine(level, safeEvent, safeFields, resolveTime());
    writeStderrNotice(`${line}\n`);
  } catch {
    // 日志排版/脱敏故障不得影响调用方；sink 写失败由 writeStderrNotice 自行报废。
    markStderrBroken();
  }
}
