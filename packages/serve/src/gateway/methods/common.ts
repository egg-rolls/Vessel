/**
 * 方法表拆分后的共享小工具（纯函数 / 常量）。
 *
 * @module @vessel-agent/serve
 */

import { RpcError } from '../../rpc.js';

export function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('invalid_params', `${key} is required`);
  }
  return value;
}

/**
 * CREATE-0.39 r10：`run_in_progress: <runId|spawn>` 的 wire 归一。
 *
 * 返回 `undefined` 表示 message 不含该 reason；`runId` 只保留真实值
 * （内部 `spawn` 哨兵与空值丢弃，绝不进 wire message）。
 */
export function runInProgressReason(message: string): { runId?: string } | undefined {
  const marker = 'run_in_progress';
  const index = message.indexOf(marker);
  if (index === -1) return undefined;
  const rest = message.slice(index + marker.length);
  const match = /^\s*:\s*([^\s,;]+)/.exec(rest);
  const raw = match?.[1];
  const runId = raw !== undefined && raw.length > 0 && raw !== 'spawn' ? raw : undefined;
  return runId !== undefined ? { runId } : {};
}
