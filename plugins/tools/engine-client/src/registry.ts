/**
 * engine-client 注册喂账本（P2 接缝契约 §1.1；设计契约 §2）。
 *
 * wireTool 就地换 def.handler（def 对象身份不变 ⇒ install scope / applyTools 回滚 /
 * P0 快照全不受影响）；**不** unregister/register。账本 entry 带 schema_fingerprint
 * （engine 派发前机械校验与 host impl.swapped 对拍共用同一指纹算法）。
 * 热应用重注册的新 def 对象 → 重新 wireTool（新指纹覆盖，rejected 清零）。
 *
 * pushRegistry 喂增量：upsert = 全部未 rejected 条目；remove = lastPushed − 当前账本 − retain；
 * 成功后更新 lastPushed，失败原样抛（装配层记日志）。
 *
 * retain（issue-0 热应用同步）：活体成员的工具面延迟到轮边界才刷新（ADR-054），窗口期内
 * 引擎注册表必须仍能执行这些「已从宿主移除、但活体成员面仍在广告」的工具，否则模型被广告
 * 执行不了的工具（engine_tool_not_registered）。装配层把 retain 设为 running 成员当前广告的
 * 工具名并集；push 不 remove retain 内的名字，并把它们保留在 lastPushed，待轮边界 retain 收缩
 * 后的下一次 push 才冲刷移除。缺省 retain 为空 = 现态行为（零回归）。
 *
 * @module @vessel-agent/engine-client
 */

import type { Logger, ToolDefinition, ToolHandler } from '@vessel-agent/core';
import type { ToolRoute } from './client.js';
import { createForwardHandler } from './forward.js';
import type { PendingTable } from './pending.js';
import {
  computeSchemaFingerprint,
  ENGINE_ERROR,
  ENGINE_WIRE,
  type EngineTransport,
  type RegistryEntry,
  type RegistrySyncParams,
} from './protocol.js';

/** 账本记录：原 handler + 路由 + 喂账 entry + rejected 标记。 */
export interface LedgerRecord {
  def: ToolDefinition;
  originalHandler: ToolHandler;
  route: ToolRoute;
  entry: RegistryEntry;
  rejected: boolean;
}

export interface ToolLedgerDeps {
  getTransport(): EngineTransport | undefined;
  pending: PendingTable;
  logger?: Logger;
}

export interface ToolLedger {
  /** 就地换 handler + 账本 upsert；幂等（WeakSet 防同一对象二次包裹）。 */
  wire(def: ToolDefinition, route: ToolRoute): void;
  /** 恢复原 handler + 账本 remove（C3 卸载对称）。 */
  unwire(name: string): void;
  get(name: string): LedgerRecord | undefined;
  /** impl.swapped 指纹不一致 / 未知 name → 标 rejected（转发拒、push 不再 upsert）。 */
  markRejected(name: string): void;
  /**
   * issue-0：设置 push 的 retain 集（活体成员面仍广告的工具名）。push 不 remove 这些名字，
   * 并把它们保留在 lastPushed，待 retain 收缩后的下一次 push 才冲刷。缺省空集 = 现态。
   */
  setRetain(names: Iterable<string>): void;
  /** 喂账本增量；transport 缺省 → unavailable；失败原样抛。 */
  push(): Promise<void>;
}

export function createToolLedger(deps: ToolLedgerDeps): ToolLedger {
  const { getTransport, pending, logger } = deps;
  const wrapped = new WeakSet<ToolDefinition>();
  const records = new Map<string, LedgerRecord>();
  let lastPushed = new Set<string>();
  let retain = new Set<string>();

  return {
    wire(def, route) {
      if (wrapped.has(def)) return;
      const originalHandler = def.handler;
      const record: LedgerRecord = {
        def,
        originalHandler,
        route,
        entry: {
          name: def.name,
          inputSchema: def.inputSchema,
          schema_fingerprint: computeSchemaFingerprint(def.name, def.description, def.inputSchema),
          exec_class: route.execClass,
          source: route.source,
        },
        rejected: false,
      };
      records.set(def.name, record);
      wrapped.add(def);
      def.handler = createForwardHandler({
        def,
        route,
        originalHandler,
        getTransport,
        isRejected: (name) => records.get(name)?.rejected === true,
        pending,
        logger,
      });
    },
    unwire(name) {
      const record = records.get(name);
      if (record === undefined) return;
      record.def.handler = record.originalHandler;
      records.delete(name);
      // 同一 def 对象日后可重新 wire（WeakSet 只保留当前已包裹的对象）。
      wrapped.delete(record.def);
    },
    get(name) {
      return records.get(name);
    },
    markRejected(name) {
      const record = records.get(name);
      if (record !== undefined) record.rejected = true;
    },
    setRetain(names) {
      retain = new Set(names);
    },
    async push() {
      const transport = getTransport();
      if (transport === undefined || !transport.active) {
        throw new Error(ENGINE_ERROR.unavailable);
      }
      const upsert: RegistryEntry[] = [];
      for (const record of records.values()) {
        if (!record.rejected) upsert.push(record.entry);
      }
      const current = new Set(records.keys());
      // issue-0：retain 内的名字不 remove（活体成员面仍在广告，引擎须保持可执行）。
      const remove = [...lastPushed].filter((name) => !current.has(name) && !retain.has(name));
      const params: RegistrySyncParams = { upsert, remove };
      await transport.request(ENGINE_WIRE.registrySync, params);
      // retain 内、本次仍在引擎的名字保留在 lastPushed，待 retain 收缩后的 push 冲刷移除。
      lastPushed = new Set([...current, ...[...lastPushed].filter((name) => retain.has(name))]);
    },
  };
}
