/**
 * 可取消的截止时间（deadline）—— 替代 `AbortSignal.timeout()`。
 *
 * ## 为什么不用 `AbortSignal.timeout()`
 *
 * bun 1.3.9 上 `AbortSignal.timeout(ms)` 的定时器**可能不触发**：当它只被一次挂起的
 * `await` 等待、且进程里没有其它活跃定时器时，事件循环空转、abort 事件永远不来，
 * 于是「看上去有超时」的代码实际上会**无限挂起**（进程不报错、也不动）。实测：单个
 * 探针挂死 60s；旁边再挂一个 `setTimeout` 才触发。
 *
 * 这里的定时器是**普通 ref 定时器**，只要调用方在 `finally`/`dispose()` 里清掉，
 * 超时一定成立。用法：
 *
 * ```ts
 * // 常见形状：整个 await 链都在预算内
 * const body = await withDeadline(3_000, async (signal) => {
 *   const res = await fetch(url, { signal });
 *   return await res.json();
 * });
 *
 * // 需要和调用方的 signal 合并、或要把 signal 交给别处时
 * const deadline = startDeadline(3_000);
 * try {
 *   const signal = caller === undefined ? deadline.signal : AbortSignal.any([caller, deadline.signal]);
 *   await fetch(url, { signal });
 * } finally {
 *   deadline.dispose(); // 不清就是悬挂定时器，会把进程多留 ms 毫秒
 * }
 * ```
 *
 * ## 怎么判断自己踩了 `AbortSignal.timeout` 的坑
 *
 * 三条同时成立就中：① 用了 `AbortSignal.timeout`；② 这个 signal 只喂给一次挂起的
 * `await`（通常是 `fetch`），没有别的 `Promise.race` / 显式定时器兜底；③ 触发路径上
 * 进程没有其它活跃定时器（CLI 一次性命令、启动探针、安装脚本最容易满足）。
 * 长跑的服务通常有别的定时器「陪着」，所以这个 bug **时灵时不灵**，别指望复现率。
 *
 * @module @vessel-agent/core
 */

/** `AbortSignal.timeout()` 抛出的错误形状（保持调用方的 `name === 'TimeoutError'` 判定不变）。 */
function timeoutReason(ms: number): DOMException {
  return new DOMException(`The operation timed out after ${ms}ms.`, 'TimeoutError');
}

/** 一个可取消的截止时间：`signal` 到期 abort，`dispose()` 清掉定时器。 */
export interface Deadline {
  /** 到期后 abort（reason 是 `TimeoutError` DOMException）。 */
  signal: AbortSignal;
  /** 清掉定时器。**必须**在 `finally` 里调用，否则定时器会一直挂着。 */
  dispose: () => void;
}

/**
 * 开一个截止时间。`ms <= 0` 或不有限 ⇒ 不设超时（返回永不 abort 的 signal）。
 *
 * 为什么不接受「不设超时」以外的降级：把非法值静默变成无超时，会让一个拼写错误
 * 变成永久挂起。
 */
export function startDeadline(ms: number): Deadline {
  if (!Number.isFinite(ms) || ms <= 0) {
    return { signal: new AbortController().signal, dispose: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(timeoutReason(ms));
  }, ms);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * 在截止时间内跑完 `run(deadline.signal)`；返回它的结果，超时则由底层（fetch 等）
 * abort 后以 `TimeoutError` 拒绝。定时器在 `finally` 里清掉。
 *
 * 注意：它**不**替调用方把超时归一成业务错误——那层语义留给各自模块（例如 provider
 * 的 `ProviderTimeoutError`）。
 */
export async function withDeadline<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = startDeadline(ms);
  try {
    return await run(deadline.signal);
  } finally {
    deadline.dispose();
  }
}
