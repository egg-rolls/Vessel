/**
 * engine-client host 侧客户端（P2 接缝契约 §1 冻结签名；设计契约 §0.3/§2/§3/§4）。
 *
 * PluginHost 接入层「协议转译 / 同步上报」的实现载体（能力插件，与 mcp-client 同形）：
 * - wireTool / unwireTool：就地换 handler + 喂账本（def 身份不变，core 零改动）；
 * - pushRegistry：host→engine `engine.registry.sync` 增量；
 * - handleToolCallback：child.ts onToolCallback hook 落点（关联-only fail-closed）；
 * - handleEngineNotification：impl.swapped 指纹对拍 / health 自报（**校验权在 host，
 *   不信 engine 自报**）。
 *
 * getTransport 晚绑定：supervisor 未 start ⇒ undefined ⇒ 转发 fail-closed（unavailable）。
 *
 * @module @vessel-agent/engine-client
 */

import type { BasicToolsConfig, PathBoundary } from '@vessel-agent/basic-tools';
import type { Logger, ToolDefinition } from '@vessel-agent/core';
import { createPendingTable, isRecord } from './pending.js';
import {
  ENGINE_WIRE,
  type EngineHealthParams,
  type EngineTransport,
  type ExecClass,
  type ImplRejectParams,
} from './protocol.js';
import { createToolLedger } from './registry.js';

export interface EngineClientOptions {
  /** 晚绑定：supervisor 未 start 时 undefined ⇒ 转发 fail-closed（ENGINE_ERROR.unavailable）。 */
  getTransport(): EngineTransport | undefined;
  logger?: Logger;
}

export interface ToolRoute {
  /** 逐调用 exec 谓词（bash：args.async===true → 'callback'）；缺省 = execClass。 */
  exec?(args: unknown): ExecClass;
  /** 注册表默认执行类。 */
  execClass: ExecClass;
  /** 来源标记（'basic-tools' / 入口注册名 / 'mcp:<server>'）。 */
  source: string;
  /** 安装期 boundary（worker 路径类工具必带；= buildPathBoundary(安装 config)，host 权威）。 */
  boundary?: PathBoundary;
  /** 安装期 config（host 侧 resolveCallCwd 算信封 cwd 用；worker 路径类工具必带）。 */
  config?: BasicToolsConfig;
}

export interface EngineClient {
  /** 就地换 handler（def 对象身份不变；checkPermission/其余字段原样）+ 账本 upsert。幂等。 */
  wireTool(def: ToolDefinition, route: ToolRoute): void;
  /** 恢复原 handler + 账本 remove（C3 卸载对称）。 */
  unwireTool(name: string): void;
  /** 推账本增量（upsert = 全账本；remove = 上次推过但已不在账本的名字）。 */
  pushRegistry(): Promise<void>;
  /** child.ts onToolCallback hook 落点：关联-only fail-closed 执行原 handler。 */
  handleToolCallback(params: unknown): Promise<unknown>;
  /** child.ts onEngineNotification hook 落点（impl.swapped / health）。 */
  handleEngineNotification(method: string, params: unknown): void;
  /** 最近一次 engine 健康自报（supervisor 补 restarts 后对外）。 */
  lastHealth(): EngineHealthParams | undefined;
  dispose(): void;
}

export function createEngineClient(options: EngineClientOptions): EngineClient {
  const { getTransport, logger } = options;
  const pending = createPendingTable();
  const ledger = createToolLedger({ getTransport, pending, logger });
  let health: EngineHealthParams | undefined;

  return {
    wireTool(def, route) {
      ledger.wire(def, route);
    },
    unwireTool(name) {
      ledger.unwire(name);
    },
    pushRegistry() {
      return ledger.push();
    },
    handleToolCallback(params) {
      return pending.handleCallback(params);
    },
    handleEngineNotification(method, params) {
      if (method === ENGINE_WIRE.implSwapped) {
        if (
          !isRecord(params) ||
          typeof params.name !== 'string' ||
          typeof params.schema_fingerprint !== 'string'
        ) {
          return;
        }
        const name = params.name;
        const record = ledger.get(name);
        if (record !== undefined && record.entry.schema_fingerprint === params.schema_fingerprint) {
          // 指纹一致：透明热替换生效。
          logger?.info('engine impl swapped: fingerprint matches', { name });
          return;
        }
        // 不一致 / 未知 name：不接受透明替换，按工具增删走既有变更流程。
        const reject: ImplRejectParams = { name };
        getTransport()?.notify(ENGINE_WIRE.implReject, reject);
        ledger.markRejected(name);
        logger?.warn('engine impl swapped: rejected', { name });
        return;
      }
      if (method === ENGINE_WIRE.health) {
        if (!isRecord(params)) return;
        if (params.status !== 'ok' && params.status !== 'degraded') return;
        const rawLoaded = params.loaded;
        if (!Array.isArray(rawLoaded)) return;
        const loaded: string[] = [];
        for (const item of rawLoaded) {
          if (typeof item !== 'string') return;
          loaded.push(item);
        }
        health = { status: params.status, loaded };
        logger?.info('engine health', { status: params.status, loaded: loaded.length });
        return;
      }
      // 其余 method 忽略。
    },
    lastHealth() {
      return health;
    },
    dispose() {
      pending.dispose();
    },
  };
}
