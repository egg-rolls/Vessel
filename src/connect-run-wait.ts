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

  constructor(timeoutMs: number) {
    super(`Run did not finish within ${timeoutMs}ms`);
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
