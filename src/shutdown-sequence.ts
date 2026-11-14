/**
 * serve 关闭顺序（0.10 R2-18 合入 web 后）。
 *
 * `gateway.stop()` 现在自己完成 `interrupt('shutdown')` + 最多 5s 等待 active run。
 * 因此顺序必须是：await stop → 关 transport → closeAll（含 hub.close）→ shutdown，
 * 且后两步传 `{drain:false}`，避免 bundle 再等 5s（总耗时上限仍是一次 gateway drain）。
 *
 * 抽成纯函数便于守卫顺序与耗时；CLI 只负责提供真实依赖。
 *
 * 0.52 S1a 在第 0 步插入 beginDrain()：它必须在 gateway.stop() **之前**跑 ——
 * 负责 fence 准入 + 只给有在跑 run 的会话写 resume 标记 + interrupt(shutdown)
 * + 最多 2s settle + flush。反过来的话 run 已经被 gateway 打断，执行面快照为空，
 * 一条标记都写不出来（进程重启后活就白跑了）。
 *
 * @module vessel/shutdown-sequence
 */

type DrainOptions = { drain?: boolean } | undefined;

export interface ShutdownSequenceOptions {
  /**
   * 0.52 S1a：退出序列第一段（幂等，失败不阻断退出）。
   * 必须早于 gateway.stop()，见模块注释。
   */
  beginDrain?: () => Promise<void>;
  /** null/undefined = 未启动 gateway（headless / REPL），此时 bundle 自己 drain */
  gateway?: { stop(): Promise<void> } | null;
  closeTransport?: () => Promise<void>;
  /** gateway 关闭后、tenant 关闭前 */
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
  // 0.52 S1a：先 fence + 写标记 + 打断 + settle + flush（幂等，重复调用不会重做）。
  if (options.beginDrain) await options.beginDrain();

  if (options.gateway) await options.gateway.stop();
  const drainOptions = serveDrainOptions(options.gateway);

  if (options.closeTransport) await options.closeTransport();
  if (options.beforeClose) await options.beforeClose();

  await options.closeTenants(drainOptions);
  await options.shutdown(drainOptions);
}
