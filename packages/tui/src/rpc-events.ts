/**
 * run 完成追踪（0.5 / Q2：事件驱动）
 * @module @vessel-agent/tui
 *
 * RPC 的 runs.resume 只返回 id，不返回 Promise：
 * - 终态由 `run.completed|failed|cancelled` 事件判定（A-3 §10.3）；
 * - `runs.get` 轮询作为兜底。
 *
 * 事件 payload 的最小字段：`run_id`（或 `data.run_id`）与事件类型；
 * 缺字段时忽略该条事件。
 */

import type { RpcClientLike, RpcEventNotificationLike } from './repl-context.js';

export type RunCompletionStatus = 'completed' | 'failed' | 'cancelled';

export interface RunCompletionOutcome {
  status: RunCompletionStatus;
  error?: unknown;
}

/** 等待句柄：done 恰好 settle 一次；stop() 取消等待并返回 cancelled */
export interface CompletionWaiter<T> {
  done: Promise<T>;
  stop: () => void;
}

/** 轮询选项 */
export interface PollOptions {
  signal?: AbortSignal;
  /** 默认 1000ms */
  intervalMs?: number;
}

const RUN_TERMINAL_EVENTS: Readonly<Record<string, RunCompletionStatus>> = {
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ParsedEvent {
  type: string;
  runId?: string;
  data: Record<string, unknown>;
}

function parseEvent(notification: RpcEventNotificationLike): ParsedEvent | null {
  if (notification.method !== 'events.event') return null;
  const event = notification.params;
  if (!isRecord(event) || typeof event.type !== 'string') return null;

  const data = isRecord(event.data) ? event.data : {};
  const runId =
    typeof event.run_id === 'string'
      ? event.run_id
      : typeof data.run_id === 'string'
        ? data.run_id
        : undefined;
  return { type: event.type, runId, data };
}

function readError(data: Record<string, unknown>): unknown {
  return data.error ?? data.message;
}

/**
 * 等待单个 run 的终态。run_id 不匹配的事件会被忽略。
 * signal abort 或 stop() 时返回 `{ status: 'cancelled' }`。
 */
export function waitForRunCompletion(
  rpc: RpcClientLike,
  runId: string,
  signal?: AbortSignal,
): CompletionWaiter<RunCompletionOutcome> {
  let settled = false;
  let unsubscribe: () => void = () => undefined;
  let resolveDone: (outcome: RunCompletionOutcome) => void = () => undefined;

  const finish = (outcome: RunCompletionOutcome): void => {
    if (settled) return;
    settled = true;
    unsubscribe();
    signal?.removeEventListener('abort', onAbort);
    resolveDone(outcome);
  };

  const onAbort = (): void => finish({ status: 'cancelled' });

  const done = new Promise<RunCompletionOutcome>((resolve) => {
    resolveDone = resolve;
  });

  if (signal?.aborted) {
    finish({ status: 'cancelled' });
    return { done, stop: () => finish({ status: 'cancelled' }) };
  }

  unsubscribe = rpc.subscribe((notification) => {
    const event = parseEvent(notification);
    if (!event || event.runId !== runId) return;
    const status = RUN_TERMINAL_EVENTS[event.type];
    if (!status) return;

    const error = readError(event.data);
    finish(error === undefined ? { status } : { status, error });
  });

  signal?.addEventListener('abort', onAbort, { once: true });
  return { done, stop: () => finish({ status: 'cancelled' }) };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `runs.get` 轮询兜底（事件丢失 / 订阅晚于完成时使用）。
 * interrupted 不是 run 的终态，这里按 failed 返回并带错误说明。
 */
export async function pollRunCompletion(
  rpc: RpcClientLike,
  runId: string,
  options: PollOptions = {},
): Promise<RunCompletionOutcome> {
  const intervalMs = options.intervalMs ?? 1000;
  const signal = options.signal;

  for (;;) {
    if (signal?.aborted) return { status: 'cancelled' };

    const result = await rpc.request<unknown>('runs.get', { run_id: runId });
    // A-5 §12.2：live 与 durable 统一返回 { run: ... }
    const run = isRecord(result) && isRecord(result.run) ? result.run : result;
    const status = isRecord(run) ? run.status : undefined;

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      const error = isRecord(run) ? readError(run) : undefined;
      return error === undefined ? { status } : { status, error };
    }
    if (status === 'interrupted') {
      return { status: 'failed', error: 'run interrupted' };
    }

    await sleep(intervalMs, signal);
  }
}
