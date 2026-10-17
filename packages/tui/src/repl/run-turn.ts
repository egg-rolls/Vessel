/**
 * 单轮 run 的执行壳（可单测）
 *
 * 把「调用 runtime.run + 区分完成/取消/失败」从 Ink 组件里抽出来：
 * - signal 由调用方传入，Ink 层只需要在 Esc/Ctrl+C 时 abort；
 * - abort 后的错误优先判为 cancelled，不再走错误分类（避免把取消显示成网络错误）。
 */

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
