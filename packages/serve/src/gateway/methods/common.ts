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
 * 可选字符串参数：`undefined` = 调用方没传（走旧行为）。
 *
 * 与 `stringParam` 同一口径拒绝空串：additive 参数不该用一个「有键但没值」的形状
 * 悄悄变成另一种语义（例如把 `agent_id: ''` 当成「不传」去答节点口径）。
 */
export function optionalStringParam(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('invalid_params', `${key} must be a non-empty string`);
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
