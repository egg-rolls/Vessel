/**
 * serve 关闭顺序（0.10 R2-18 合入 web 后）。
 *
 * 顺序必须是：await beginDrain → gateway.stop() → 关 transport → closeAll
 * （含 hub.close）→ shutdown，且后两步传 `{drain:false}`，避免 bundle 再做
 * 限时等待。gateway.stop() 自 0.27 起只退订 / 关连接，不碰 run 生命周期。
 *
 * beginDrain() 是 drain-to-quiesce（用户裁定：缺省完全优雅）：fence 准入 →
 * **不限时**等所有活跃 run 自然跑完（不 interrupt、不写 resume 标记）→ flush。
 * 它必须在 gateway.stop() **之前**跑：先关闸，退出期间不再起新 run。
 *
 * @module vessel/shutdown-sequence
 */

import { runShutdownStep, type ShutdownStepEmit } from '@vessel-agent/serve';

type DrainOptions = { drain?: boolean } | undefined;

export interface ShutdownSequenceOptions {
  /**
   * node 退出序列（幂等，失败不阻断退出）：drain-to-quiesce。
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
  /**
   * DR15-1：步骤级进度日志发射口（可选；缺省不打，兼容既有调用方）。
   * 注入后每步打 node.shutdown.step start/done —— 挂起时最后一条 start 即挂点。
   */
  onStep?: ShutdownStepEmit;
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
  // DR15-1：有 onStep 时每步打进度日志；没有则原样直跑（零行为变化）。
  const emit = options.onStep;
  const step = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    emit ? runShutdownStep(emit, name, fn) : fn();

  // drain-to-quiesce：先 fence + 不限时等活跃 run 自然跑完 + flush（幂等，重复调用不会重做）。
  const beginDrain = options.beginDrain;
  if (beginDrain) await step('serve.beginDrain', beginDrain);

  const gateway = options.gateway;
  if (gateway) await step('serve.gateway.stop', () => gateway.stop());
  const drainOptions = serveDrainOptions(options.gateway);

  const closeTransport = options.closeTransport;
  if (closeTransport) await step('serve.closeTransport', closeTransport);
  const beforeClose = options.beforeClose;
  if (beforeClose) await step('serve.beforeClose', beforeClose);

  await step('serve.closeTenants', () => options.closeTenants(drainOptions));
  await step('serve.shutdown', () => options.shutdown(drainOptions));
}
