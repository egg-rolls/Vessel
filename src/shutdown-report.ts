/**
 * 关闭失败的可观测性（0.10 R2-16）。
 *
 * 关闭链路（bundle / bootstrap）的每一步异常都要：
 * - 发 `shutdown.failed` 事件（开放字符串，data 带 step / error / tenant_id）；
 * - 写 logger.error；
 * - 不中断后续清理（调用方继续下一段）。
 *
 * @module vessel/shutdown-report
 */

import type { EventStream, Logger } from '../packages/core/src/index';

export interface ShutdownFailureInput {
  events?: EventStream;
  logger: Logger;
  /** 清理步骤名，如 `trace.flush` / `tenantLock.release` */
  step: string;
  error: unknown;
  tenantId?: string;
  now?: () => number;
}

/** 记录一次关闭失败，返回可读错误文本（调用方可继续清理）。 */
export function reportShutdownFailure(input: ShutdownFailureInput): string {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const data: Record<string, unknown> = { step: input.step, error: message };
  if (input.tenantId !== undefined) data.tenant_id = input.tenantId;

  try {
    input.events?.publish({
      type: 'shutdown.failed',
      run_id: 'shutdown',
      data,
      ts: (input.now ?? Date.now)(),
    });
  } catch {
    // 事件流已关闭 / 订阅者异常：日志仍然可用
  }

  try {
    input.logger.error('shutdown.failed', data);
  } catch {
    // 日志 sink 故障不得阻断清理
  }

  return message;
}
