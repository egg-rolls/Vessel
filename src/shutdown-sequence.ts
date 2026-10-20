/**
 * serve 关闭顺序（0.10 R2-18 合入 web 后）。
 *
 * `gateway.stop()` 现在自己完成 `interrupt('shutdown')` + 最多 5s 等待 active run。
 * 因此顺序必须是：await stop → 退订共享流 / 关 transport → closeAll → shutdown，
 * 且后两步传 `{drain:false}`，避免 bundle 再等 5s（总耗时上限仍是一次 gateway drain）。
 *
 * 抽成纯函数便于守卫顺序与耗时；CLI 只负责提供真实依赖。
 *
 * @module vessel/shutdown-sequence
 */

type DrainOptions = { drain?: boolean } | undefined;

export interface ShutdownSequenceOptions {
  /** null/undefined = 未启动 gateway（headless / REPL），此时 bundle 自己 drain */
  gateway?: { stop(): Promise<void> } | null;
  unsubShared?: () => void;
  closeTransport?: () => Promise<void>;
  /** gateway 关闭后、tenant 关闭前（如 workflow interrupt） */
  beforeClose?: () => Promise<void>;
  closeTenants: (options?: { drain?: boolean }) => Promise<void>;
  shutdown: (options?: { drain?: boolean }) => Promise<void>;
}

/** 返回传给 closeTenants/shutdown 的 drain 选项，便于调用方复用/测试。 */
export function serveDrainOptions(
  gateway: { stop(): Promise<void> } | null | undefined,
): DrainOptions {
  return gateway ? { drain: false } : undefined;
}

/**
 * 按固定顺序关闭 serve 栈；每步异常由调用方自己的实现隔离（这里不吞）。
 */
export async function shutdownServeStack(options: ShutdownSequenceOptions): Promise<void> {
  if (options.gateway) await options.gateway.stop();
  const drainOptions = serveDrainOptions(options.gateway);

  options.unsubShared?.();

  if (options.closeTransport) await options.closeTransport();
  if (options.beforeClose) await options.beforeClose();

  await options.closeTenants(drainOptions);
  await options.shutdown(drainOptions);
}
