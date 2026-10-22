/**
 * `--connect --run` 的终态等待（0.17 P0 / 0.18 加固）。
 *
 * `runs.start` 只返回排队信封，不是最终输出；本模块等待对应 run 的终态：
 * - 订阅必须先于 `start()`，极快 run 的 `run.started` / 终态不会漏；
 * - WS 客户端会剥掉 frame 的 `job_id`，因此用
 *   `run.started.data.session_id + input` 匹配本次请求，并用
 *   `runs.get(job_id)` 的 `core_run_id` 做权威确认（注意返回形状是 `{run:{...}}`）；
 * - 终态事件可能丢失（重连 / gap）：定时 `runs.get` 轮询兜底；
 * - 显式超时（缺省 10 分钟），避免永久挂起。
 *
 * `--connect --resume-run`（0.18 P0-2）复用同一套终态集合，但按 `run_id` 直接等待：
 * `runs.resume` 只回复 `{run_id, status:'queued'}`，终态只能靠事件或 checkpoint 收口。
 *
 * @module vessel/connect-run-wait
 */

import type { EventStream, RunEvent } from '../packages/core/src/index';

const TERMINAL_RUN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

/** connect run 等待超时 */
export class ConnectRunTimeoutError extends Error {
  readonly code = 'run_timeout' as const;

  constructor(timeoutMs: number, hint?: string) {
    super(`Run did not finish within ${timeoutMs}ms${hint === undefined ? '' : ` — ${hint}`}`);
    this.name = 'ConnectRunTimeoutError';
  }
}

/** `runs.start` 的结果 */
export type ConnectRunStart = { kind: 'legacy'; text: string } | { kind: 'job'; jobId: string };

export interface WaitForConnectedRunOptions {
  events: EventStream;
  prompt: string;
  sessionId: string;
  /** 调用 canonical `runs.start`；内部负责把结果归一成 ConnectRunStart */
  start: () => Promise<ConnectRunStart>;
  /** 调用 canonical `runs.get({run_id})`；返回原始结果（可能是 `{run}`） */
  getRun: (jobId: string) => Promise<unknown>;
  timeoutMs: number;
  /** runs.get 轮询间隔；缺省 1000ms */
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `runs.get` 可能返回 `{run:{...}}` 或裸 run；统一取内层 */
function unwrapRun(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecordValue(raw)) return undefined;
  return isRecordValue(raw.run) ? raw.run : raw;
}

function terminalResultOf(event: RunEvent): string {
  const data = isRecordValue(event.data) ? event.data : {};
  if (event.type === 'run.completed') {
    return typeof data.output === 'string' ? data.output : '';
  }
  const message =
    typeof data.error === 'string' && data.error.length > 0
      ? data.error
      : event.type === 'run.cancelled'
        ? 'Run cancelled'
        : 'Run failed';
  throw Object.assign(new Error(message), {
    code: typeof data.error_code === 'string' ? data.error_code : 'run_failed',
    run_id: event.run_id,
  });
}

function errorFromRun(record: Record<string, unknown>): Error {
  const message =
    typeof record.error === 'string' && record.error.length > 0
      ? record.error
      : record.status === 'cancelled'
        ? 'Run cancelled'
        : 'Run failed';
  return Object.assign(new Error(message), {
    code: typeof record.error_code === 'string' ? record.error_code : 'run_failed',
  });
}

/**
 * 等待一次 connect run 结束并返回完整 output（失败抛错）。
 */
export async function waitForConnectedRun(options: WaitForConnectedRunOptions): Promise<string> {
  const { events, prompt, sessionId, start, getRun, timeoutMs, signal } = options;
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1000);

  const terminalByRun = new Map<string, RunEvent>();
  const candidates = new Set<string>();
  let coreRunId: string | undefined;
  /**
   * `runs.get` 是否可用。可用时只信 job → core_run_id 的权威映射，
   * 不再用 session+input 猜测（同 prompt 并发 run 会误收别人的终态）。
   */
  let authoritative = false;
  /** 明确探测到 runs.get 不可用后才允许事件猜测兜底 */
  let getRunUnavailable = false;

  const matchStarted = (event: RunEvent): boolean => {
    if (event.type !== 'run.started') return false;
    const data = isRecordValue(event.data) ? event.data : {};
    const eventSession = typeof data.session_id === 'string' ? data.session_id : undefined;
    if (eventSession !== undefined && eventSession !== sessionId) return false;
    const eventInput = typeof data.input === 'string' ? data.input : undefined;
    return eventInput === undefined || eventInput === prompt;
  };

  // 先订阅再 start：所有启动/终态事件都进入缓冲。
  const bufferedUnsub = events.subscribe((event) => {
    if (matchStarted(event)) candidates.add(event.run_id);
    if (TERMINAL_RUN_EVENT_TYPES.has(event.type) && !terminalByRun.has(event.run_id)) {
      terminalByRun.set(event.run_id, event);
    }
  });

  try {
    const started = await start();
    if (started.kind === 'legacy') return started.text;
    const jobId = started.jobId;

    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        try {
          runUnsub();
        } catch {
          // ignore
        }
        if (pollTimer !== undefined) clearInterval(pollTimer);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const settleFromEvent = (event: RunEvent): void => {
        settle(() => {
          try {
            resolve(terminalResultOf(event));
          } catch (error) {
            reject(error);
          }
        });
      };
      const settleFromRun = (record: Record<string, unknown>): void => {
        if (record.status === 'completed') {
          settle(() => resolve(typeof record.output === 'string' ? record.output : ''));
        } else if (record.status === 'failed' || record.status === 'cancelled') {
          settle(() => reject(errorFromRun(record)));
        }
      };
      /** 用 runs.get 确认 core_run_id / 终态（形状 `{run:{...}}`） */
      const refreshRun = async (): Promise<void> => {
        if (settled) return;
        let raw: unknown;
        try {
          raw = await getRun(jobId);
        } catch {
          // 旧 gateway / 权限不足：允许退回 session+input 事件匹配。
          if (!authoritative) getRunUnavailable = true;
          trySettleFromEvents();
          return;
        }
        const record = unwrapRun(raw);
        if (record === undefined || settled) return;
        authoritative = true;
        getRunUnavailable = false;
        if (typeof record.core_run_id === 'string') {
          coreRunId = record.core_run_id;
          candidates.add(coreRunId);
        }
        settleFromRun(record);
        if (settled) return;
        const terminal = coreRunId !== undefined ? terminalByRun.get(coreRunId) : undefined;
        if (terminal) settleFromEvent(terminal);
      };
      const trySettleFromEvents = (): void => {
        if (settled) return;
        const direct = coreRunId !== undefined ? terminalByRun.get(coreRunId) : undefined;
        if (direct) {
          settleFromEvent(direct);
          return;
        }
        // 只有明确探测到 runs.get 不可用时，才退回 session+input 猜测。
        if (!getRunUnavailable) return;
        for (const runId of candidates) {
          const terminal = terminalByRun.get(runId);
          if (terminal) {
            coreRunId = runId;
            settleFromEvent(terminal);
            return;
          }
        }
      };
      const onAbort = (): void => {
        settle(() => reject(signal?.reason ?? new Error('Run cancelled')));
      };

      const runUnsub = events.subscribe((event) => {
        if (matchStarted(event)) {
          candidates.add(event.run_id);
          void refreshRun();
        }
        if (!TERMINAL_RUN_EVENT_TYPES.has(event.type)) return;
        terminalByRun.set(event.run_id, event);
        if (coreRunId !== undefined && event.run_id === coreRunId) {
          settleFromEvent(event);
          return;
        }
        if (getRunUnavailable && candidates.has(event.run_id)) {
          // 旧 gateway（runs.get 不可用）：退回 session+input 匹配。
          settleFromEvent(event);
          return;
        }
        // 权威模式下先缓冲；runs.get 会给出本 job 的 core_run_id 或终态。
        void refreshRun();
      });

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      timeoutTimer = setTimeout(
        () => settle(() => reject(new ConnectRunTimeoutError(timeoutMs))),
        timeoutMs,
      );
      pollTimer = setInterval(() => void refreshRun(), pollIntervalMs);

      // 先扫 run 前缓冲，再向服务端确认一次（可能已 running/终态）。
      trySettleFromEvents();
      void refreshRun();
    });
  } finally {
    bufferedUnsub();
  }
}

/** `runs.resume` 的回复：旧 gateway 同步返回文本；新 gateway 只回排队的 run_id */
export type ConnectResumeStart =
  | { kind: 'legacy'; text: string }
  | { kind: 'queued'; runId: string; sessionId?: string };

export interface WaitForConnectedResumeOptions {
  events: EventStream;
  runId: string;
  /** 先订阅再调用；只允许调用一次，不重试（超时 / abort / runs.get 失败都不重发） */
  resume: () => Promise<ConnectResumeStart>;
  /** 调用 canonical `runs.get({run_id})`；返回原始结果（可能是 `{run}` 或裸 run） */
  getRun: (runId: string) => Promise<unknown>;
  timeoutMs: number;
  /** runs.get 轮询间隔；缺省 1000ms，最小 50ms */
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** connect 引导时解析出的会话 id（sessionId 来源中优先级最低） */
  sessionId?: string;
}

export interface ConnectedResumeOutcome {
  sessionId: string;
  output: string;
  /** 区分“真空输出”（event）与“只能从 checkpoint 收口”（checkpoint） */
  outputSource: 'event' | 'checkpoint' | 'none';
}

/** 恢复 run 超时时必须提醒用户：远端可能仍在跑，重复 resume 只会 conflict */
const RESUME_TIMEOUT_HINT = 'the remote run may still be running; do not resume it again';

function sessionIdOf(event: RunEvent): string | undefined {
  const data = isRecordValue(event.data) ? event.data : {};
  return typeof data.session_id === 'string' ? data.session_id : undefined;
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function resumeCancelledError(reason: unknown): Error {
  const message =
    reason instanceof Error && reason.message.length > 0 ? reason.message : 'Resume cancelled';
  return codedError('resume_cancelled', message);
}

/** 终态事件 → 稳定错误码（resume 语义：cancelled 映射为 resume_cancelled） */
function resumeRejectionOf(event: RunEvent): Error {
  const data = isRecordValue(event.data) ? event.data : {};
  const message =
    typeof data.error === 'string' && data.error.length > 0 ? data.error : 'Run failed';
  if (event.type === 'run.cancelled') {
    return codedError('resume_cancelled', message === 'Run failed' ? 'Run cancelled' : message);
  }
  return codedError(typeof data.error_code === 'string' ? data.error_code : 'run_failed', message);
}

/** checkpoint 的失败码：顶层（gateway 已摊平）优先，其次 error_envelope */
function checkpointErrorCode(record: Record<string, unknown>): string | undefined {
  if (typeof record.error_code === 'string' && record.error_code.length > 0) {
    return record.error_code;
  }
  const envelope = isRecordValue(record.error_envelope) ? record.error_envelope : undefined;
  if (envelope !== undefined && typeof envelope.error_code === 'string') {
    return envelope.error_code;
  }
  return undefined;
}

function checkpointFailureError(record: Record<string, unknown>): Error {
  const message =
    typeof record.error === 'string' && record.error.length > 0 ? record.error : 'Run failed';
  return codedError(checkpointErrorCode(record) ?? 'resume_failed', message);
}

/**
 * 等待一次 connect `runs.resume` 的终态并返回完整 output。
 *
 * `resume()` 只调用一次：超时 / abort / `runs.get` 失败都不重试，也不调用 `runs.cancel`
 * （恢复的 run 不在 `RunEngine.runs`，cancel 只会 not_found；远端可能仍在运行）。
 */
export async function waitForConnectedResumeTerminal(
  options: WaitForConnectedResumeOptions,
): Promise<ConnectedResumeOutcome> {
  const { events, runId, resume, getRun, timeoutMs, signal } = options;
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1000);
  /** checkpoint completed / 后置 interrupted 的 grace：一个 poll，封顶 1000ms */
  const graceMs = Math.min(pollIntervalMs, 1000);

  // sessionId 优先级：事件 data.session_id > checkpoint.session_id > resume 回复 > 初始值
  let eventSessionId: string | undefined;
  let checkpointSessionId: string | undefined;
  let replySessionId: string | undefined;
  let sawResumed = false;
  /** core resume 先发 run.resumed、再写 running checkpoint；只有见过 running 才算真正开跑 */
  let sawRunning = false;

  const resolveSessionId = (): string =>
    eventSessionId ?? checkpointSessionId ?? replySessionId ?? options.sessionId ?? '';

  // 先订阅再 resume：极快 run 的 run.resumed / 终态不会漏（resume 返回前先缓冲）。
  let onTerminal: ((event: RunEvent) => void) | undefined;
  const bufferedTerminals: RunEvent[] = [];
  const unsubscribe = events.subscribe((event) => {
    if (event.run_id !== runId) return;
    if (event.type === 'run.resumed') {
      const sessionId = sessionIdOf(event);
      if (sessionId !== undefined) eventSessionId = sessionId;
      sawResumed = true;
      return;
    }
    if (!TERMINAL_RUN_EVENT_TYPES.has(event.type)) return;
    const sessionId = sessionIdOf(event);
    if (sessionId !== undefined) eventSessionId = sessionId;
    if (onTerminal !== undefined) onTerminal(event);
    else bufferedTerminals.push(event);
  });

  try {
    if (signal?.aborted) throw resumeCancelledError(signal.reason);

    const started = await resume();
    if (started.kind === 'legacy') {
      return { sessionId: resolveSessionId(), output: started.text, outputSource: 'event' };
    }
    if (started.runId !== runId) {
      throw codedError('resume_failed', `Resume returned run_id ${started.runId} for ${runId}`);
    }
    if (started.sessionId !== undefined) replySessionId = started.sessionId;

    return await new Promise<ConnectedResumeOutcome>((resolve, reject) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let graceKind: 'completed' | 'interrupted' | undefined;
      /** getRun 抛错后只靠事件 + 超时，不再轮询 */
      let getRunUnavailable = false;

      const cleanup = (): void => {
        try {
          unsubscribe();
        } catch {
          // ignore
        }
        if (pollTimer !== undefined) clearInterval(pollTimer);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const resolveOutcome = (output: string, outputSource: 'event' | 'checkpoint'): void => {
        settle(() => resolve({ sessionId: resolveSessionId(), output, outputSource }));
      };
      const clearGrace = (): void => {
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        graceTimer = undefined;
        graceKind = undefined;
      };
      const armGrace = (kind: 'completed' | 'interrupted'): void => {
        if (graceKind !== undefined) return;
        graceKind = kind;
        graceTimer = setTimeout(() => {
          graceTimer = undefined;
          if (settled) return;
          if (kind === 'completed') {
            // checkpoint 没有 output 字段：终态事件丢失时只能返回空串。
            resolveOutcome('', 'checkpoint');
          } else {
            settle(() =>
              reject(codedError('run_interrupted', `Run ${runId} was interrupted during resume`)),
            );
          }
        }, graceMs);
      };
      const handleTerminal = (event: RunEvent): void => {
        if (settled) return;
        if (event.type === 'run.completed') {
          const data = isRecordValue(event.data) ? event.data : {};
          resolveOutcome(typeof data.output === 'string' ? data.output : '', 'event');
          return;
        }
        settle(() => reject(resumeRejectionOf(event)));
      };

      const refreshRun = async (): Promise<void> => {
        if (settled || getRunUnavailable) return;
        let raw: unknown;
        try {
          raw = await getRun(runId);
        } catch {
          // 旧 gateway / 权限不足：轮询不可用，只靠事件 + 超时（不因此提前退出）。
          getRunUnavailable = true;
          if (pollTimer !== undefined) {
            clearInterval(pollTimer);
            pollTimer = undefined;
          }
          return;
        }
        if (settled) return;
        const record = unwrapRun(raw);
        if (record === undefined) return;
        if (typeof record.session_id === 'string' && record.session_id.length > 0) {
          checkpointSessionId = record.session_id;
        }
        const status = typeof record.status === 'string' ? record.status : undefined;
        if (status === 'completed') {
          // 终态事件可能紧随 checkpoint 到达：给一个 poll 的 grace，再按 checkpoint 收口。
          if (graceKind === 'interrupted') clearGrace();
          armGrace('completed');
          return;
        }
        if (status === 'failed') {
          settle(() => reject(checkpointFailureError(record)));
          return;
        }
        if (status === 'cancelled') {
          const message =
            typeof record.error === 'string' && record.error.length > 0
              ? record.error
              : 'Run cancelled';
          settle(() => reject(codedError('resume_cancelled', message)));
          return;
        }
        if (status === 'interrupted') {
          // resume 前的 interrupted，以及 run.resumed 之后、running checkpoint 之前
          // （core 先发事件再写 checkpoint）都不是终态；只有真正跑过又回到 interrupted 才收口。
          if (sawResumed && sawRunning) armGrace('interrupted');
          return;
        }
        // running / queued / 未知状态：继续等；若之前因 interrupted 挂了 grace，run 又活了就撤销。
        if (status === 'running') sawRunning = true;
        if (graceKind === 'interrupted') clearGrace();
      };

      const onAbort = (): void => {
        // 不调用 runs.cancel：恢复的 run 不在 RunEngine.runs，远端不会被停。
        settle(() => reject(resumeCancelledError(signal?.reason)));
      };

      onTerminal = handleTerminal;
      for (const event of bufferedTerminals.splice(0)) handleTerminal(event);
      if (settled) return;

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      timeoutTimer = setTimeout(
        () => settle(() => reject(new ConnectRunTimeoutError(timeoutMs, RESUME_TIMEOUT_HINT))),
        timeoutMs,
      );
      pollTimer = setInterval(() => void refreshRun(), pollIntervalMs);

      // 先扫 resume 前缓冲（上面已处理），再向服务端确认一次（可能已 running / 终态）。
      void refreshRun();
    });
  } finally {
    unsubscribe();
  }
}
