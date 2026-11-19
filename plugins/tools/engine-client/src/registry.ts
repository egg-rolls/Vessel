/**
 * engine-client 注册喂账本（P2 接缝契约 §1.1；设计契约 §2）。
 *
 * wireTool 就地换 def.handler（def 对象身份不变 ⇒ install scope / applyTools 回滚 /
 * P0 快照全不受影响）；**不** unregister/register。账本 entry 带 schema_fingerprint
 * （engine 派发前机械校验与 host impl.swapped 对拍共用同一指纹算法）。
 * 热应用重注册的新 def 对象 → 重新 wireTool（新指纹覆盖，rejected 清零）。
 *
 * pushRegistry 喂增量：upsert = 全部未 rejected 条目；remove = lastPushed − 当前账本；
 * 成功后更新 lastPushed，失败原样抛（装配层记日志）。
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
  /** 喂账本增量；transport 缺省 → unavailable；失败原样抛。 */
  push(): Promise<void>;
}

export function createToolLedger(deps: ToolLedgerDeps): ToolLedger {
  const { getTransport, pending, logger } = deps;
  const wrapped = new WeakSet<ToolDefinition>();
  const records = new Map<string, LedgerRecord>();
  let lastPushed = new Set<string>();

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
      const remove = [...lastPushed].filter((name) => !current.has(name));
      const params: RegistrySyncParams = { upsert, remove };
      await transport.request(ENGINE_WIRE.registrySync, params);
      lastPushed = current;
    },
  };
}
