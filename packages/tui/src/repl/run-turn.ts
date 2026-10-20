/**
 * 单轮 run 的执行壳（可单测）
 *
 * 把「调用 runtime.run + 区分完成/取消/失败」从 Ink 组件里抽出来：
 * - signal 由调用方传入，Ink 层只需要在 Esc/Ctrl+C 时 abort；
 * - abort 后的错误优先判为 cancelled，不再走错误分类（避免把取消显示成网络错误）。
 */

import type { DurableRunHandle, WorkflowRunHandle } from '../repl-context.js';

export type TurnOutcome =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown };

export interface ExecuteTurnOptions {
  /** 真正执行一轮的入口（通常包一层 ctx.runtime.run） */
  run: (signal: AbortSignal) => Promise<unknown>;
  /** 本轮的 AbortController */
  abort: AbortController;
}

/** 执行一轮并归一化结果；不抛错，由调用方决定如何展示 */
export async function executeTurn({ run, abort }: ExecuteTurnOptions): Promise<TurnOutcome> {
  try {
    await run(abort.signal);
    return { status: 'completed' };
  } catch (error) {
    if (abort.signal.aborted) return { status: 'cancelled' };
    return { status: 'failed', error };
  }
}

/**
 * 等待 /runs resume 启动的 run 结束，并归一化结果。
 * Esc / Ctrl+C 会 abort -> handle.cancel()（幂等）；done 意外 reject 也按失败处理。
 */
export async function executeResume(
  handle: DurableRunHandle,
  abort: AbortController,
): Promise<TurnOutcome> {
  const onAbort = () => handle.cancel();
  if (abort.signal.aborted) {
    handle.cancel();
  } else {
    abort.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const outcome = await handle.done;
    if (abort.signal.aborted || outcome.status === 'cancelled') return { status: 'cancelled' };
    if (outcome.status === 'failed') return { status: 'failed', error: outcome.error };
    return { status: 'completed' };
  } catch (error) {
    if (abort.signal.aborted) return { status: 'cancelled' };
    return { status: 'failed', error };
  } finally {
    abort.signal.removeEventListener('abort', onAbort);
  }
}

export type WorkflowTurnOutcome =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'interrupted' }
  | { status: 'failed'; error: unknown };

/**
 * 等待 /workflows run|resume 启动的 workflow 结束，并归一化结果。
 * Esc / Ctrl+C 会 abort -> cancel(id)（幂等）；done 意外 reject 也按失败处理。
 */
export async function executeWorkflow(
  handle: WorkflowRunHandle,
  abort: AbortController,
): Promise<WorkflowTurnOutcome> {
  let cancelRequested = false;
  const onAbort = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    void handle.cancel().catch(() => undefined);
  };

  if (abort.signal.aborted) {
    onAbort();
  } else {
    abort.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const outcome = await handle.done;
    if (abort.signal.aborted || outcome.status === 'cancelled') return { status: 'cancelled' };
    if (outcome.status === 'interrupted') return { status: 'interrupted' };
    if (outcome.status === 'failed') {
      return { status: 'failed', error: outcome.error ?? new Error('workflow failed') };
    }
    if (outcome.status === 'completed') return { status: 'completed' };
    return {
      status: 'failed',
      error: new Error(`unexpected workflow status: ${outcome.status}`),
    };
  } catch (error) {
    if (abort.signal.aborted) return { status: 'cancelled' };
    return { status: 'failed', error };
  } finally {
    abort.signal.removeEventListener('abort', onAbort);
  }
}
