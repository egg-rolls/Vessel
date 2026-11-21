/**
 * engine-client pending 关联表（P2 接缝契约 §1.3；设计契约 §3/§5）。
 *
 * callback 方向的工具调用在 invoke 派发前于 host 侧登记在途记录；engine 的
 * `tool.callback` 只带关联 id —— host 按 (run_id, tool_call_id) 查记录并执行
 * **原 handler(args, 原 ctx 引用)**（零序列化；events/messages/signal/vault/队列
 * 全在 host 内存）。关联-only fail-closed：形状不过 / 查无记录 / state≠pending
 * 一律拒绝，**绝不执行** —— engine 不能注入任意调用。
 *
 * 记录本身不带 resolve/reject：本次 invoke 的收口语义由转发 handler 的 invoke
 * promise 承担（forward.ts）；表只管状态与生命周期。迟到 callback 命中
 * state≠pending（或记录已删）一律拒，幂等收口。
 *
 * @module @vessel-agent/engine-client
 */

import type { ToolContext, ToolHandler } from '@vessel-agent/core';
import { ENGINE_ERROR, type ToolInvokeResult } from './protocol.js';

/** 在途记录状态：pending→executing→settled（幂等收口）。 */
export type PendingState = 'pending' | 'executing' | 'settled';

/** 在途 callback 调用记录（ctx = 原引用，零序列化；设计契约 §5）。 */
export interface PendingRecord {
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  args: unknown;
  ctx: ToolContext;
  originalHandler: ToolHandler;
  state: PendingState;
}

/** 关联键：JSON.stringify([run_id, tool_call_id])（无分隔符歧义）。 */
export function pendingKey(runId: string, toolCallId: string): string {
  return JSON.stringify([runId, toolCallId]);
}

/** record 形状守卫（callback params / 信封 args / invoke 结果 / 通知 params 共用）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface PendingTable {
  /** invoke 派发前登记（仅 exec=callback）。 */
  register(record: Omit<PendingRecord, 'state'>): void;
  /** 置 settled 并删记录（转发 handler finally / abort 监听；幂等）。 */
  settle(runId: string, toolCallId: string): void;
  /** 池 S9：只读状态查询（callback 续上 oracle）；记录已删（settled/disposed）→ undefined。 */
  state(runId: string, toolCallId: string): PendingState | undefined;
  /** child.ts onToolCallback hook 落点：关联-only fail-closed 执行原 handler。 */
  handleCallback(params: unknown): Promise<ToolInvokeResult>;
  /** dispose：全部 pending 置 settled（迟到 callback 一律拒）。 */
  dispose(): void;
}

export function createPendingTable(): PendingTable {
  const records = new Map<string, PendingRecord>();
  return {
    register(record) {
      records.set(pendingKey(record.run_id, record.tool_call_id), { ...record, state: 'pending' });
    },
    settle(runId, toolCallId) {
      const key = pendingKey(runId, toolCallId);
      const record = records.get(key);
      if (record === undefined) return;
      record.state = 'settled';
      records.delete(key);
    },
    state(runId, toolCallId) {
      return records.get(pendingKey(runId, toolCallId))?.state;
    },
    async handleCallback(params) {
      if (
        !isRecord(params) ||
        typeof params.run_id !== 'string' ||
        typeof params.tool_call_id !== 'string'
      ) {
        throw new Error(ENGINE_ERROR.callbackRejected);
      }
      const record = records.get(pendingKey(params.run_id, params.tool_call_id));
      if (record === undefined || record.state !== 'pending') {
        throw new Error(ENGINE_ERROR.callbackRejected);
      }
      record.state = 'executing';
      try {
        const content = await record.originalHandler(record.args, record.ctx);
        record.state = 'settled';
        // 不带 bounded：原 handler 在 host ctx 上原生登记 gate receipt，管道直接认领。
        return { content };
      } catch (error) {
        record.state = 'settled';
        throw error; // 原样抛（child.ts 折 -32000 回包）
      }
    },
    dispose() {
      for (const record of records.values()) record.state = 'settled';
      records.clear();
    },
  };
}
