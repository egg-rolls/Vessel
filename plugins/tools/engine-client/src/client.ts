/**
 * engine-client host 侧客户端（P2 接缝契约 §1 冻结签名；设计契约 §0.3/§2/§3/§4）。
 *
 * PluginHost 接入层「协议转译 / 同步上报」的实现载体（能力插件，与 mcp-client 同形）：
 * - wireTool / unwireTool：就地换 handler + 喂账本（def 身份不变，core 零改动）；
 * - pushRegistry：host→engine `engine.registry.sync` 增量；
 * - handleToolCallback：child.ts onToolCallback hook 落点（关联-only fail-closed）；
 * - handleEngineNotification：impl.swapped 指纹对拍 / health 自报（**校验权在 host，
 *   不信 engine 自报**；批次 2 additive：health.mcp 快照逐条机械校验后透传）；
 * - mcpControl：批次 2 `engine.mcp.control` 请求端口（装配层 host shell 用）。
 *
 * getTransport 晚绑定：supervisor 未 start ⇒ undefined ⇒ 转发 fail-closed（unavailable）。
 *
 * @module @vessel-agent/engine-client
 */

import type { BasicToolsConfig, PathBoundary } from '@vessel-agent/basic-tools';
import type { Logger, ToolDefinition } from '@vessel-agent/core';
import type { McpServerStatus } from '@vessel-agent/mcp-client';
import { createPendingTable, isRecord, type PendingState } from './pending.js';
import {
  ENGINE_ERROR,
  ENGINE_WIRE,
  type EngineHealthParams,
  type EngineTransport,
  type ExecClass,
  type ImplRejectParams,
  type McpControlParams,
  type McpControlResult,
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
  /** 推账本增量（upsert = 全账本；remove = 上次推过但已不在账本的名字 − retain）。 */
  pushRegistry(): Promise<void>;
  /**
   * issue-0：设置注册表 retain 集（活体成员面仍广告的工具名）。所有 pushRegistry 路径
   * （cli 热应用 / bootstrap 重连 / mcp）自动 honoring：retain 内的名字不被 remove，
   * 待轮边界成员面刷新、retain 收缩后的 push 才冲刷移除。缺省空集 = 现态（零回归）。
   */
  setRegistryRetain(names: Iterable<string>): void;
  /** child.ts onToolCallback hook 落点：关联-only fail-closed 执行原 handler。 */
  handleToolCallback(params: unknown): Promise<unknown>;
  /** child.ts onEngineNotification hook 落点（impl.swapped / health）。 */
  handleEngineNotification(method: string, params: unknown): void;
  /** S9 host 侧读面：callback 续上 oracle（S8 pendingState 注入参数接线用）。 */
  pendingState(runId: string, toolCallId: string): PendingState | undefined;
  /** 最近一次 engine 健康自报（supervisor 补 restarts 后对外）。 */
  lastHealth(): EngineHealthParams | undefined;
  /** engine.mcp.control 请求端口（装配层 host shell 用）；transport 缺省 → throw unavailable。 */
  mcpControl(params: McpControlParams, timeoutMs?: number): Promise<McpControlResult>;
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
    setRegistryRetain(names) {
      ledger.setRetain(names);
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
        // 批次 2 additive：mcp 可选数组逐条机械形状校验，不过整条忽略；
        // 缺省 = 无 MCP server（批次 1 行为零变化）。
        const rawMcp = params.mcp;
        let mcp: McpServerStatus[] | undefined;
        if (Array.isArray(rawMcp)) {
          mcp = [];
          for (const item of rawMcp) {
            const status = parseMcpServerStatus(item);
            if (status !== undefined) mcp.push(status);
          }
        }
        health = { status: params.status, loaded, ...(mcp !== undefined ? { mcp } : {}) };
        logger?.info('engine health', { status: params.status, loaded: loaded.length });
        return;
      }
      // 其余 method 忽略。
    },
    pendingState(runId, toolCallId) {
      return pending.state(runId, toolCallId);
    },
    lastHealth() {
      return health;
    },
    async mcpControl(params, timeoutMs) {
      const transport = getTransport();
      if (transport === undefined || !transport.active) {
        throw new Error(ENGINE_ERROR.unavailable);
      }
      const result = await transport.request(ENGINE_WIRE.mcpControl, params, timeoutMs);
      // 回包形状机械校验（判别联合）；不过 = engine 协议违规，折稳定 unavailable。
      // ok:false 原样返回（host shell 折 McpPluginError 语义）。
      if (!isMcpControlResult(result)) {
        throw new Error(ENGINE_ERROR.unavailable);
      }
      return result;
    },
    dispose() {
      pending.dispose();
    },
  };
}

/** McpServerStatus 机械形状校验（校验权在 host）：name/status/transport/tools 必备，
 *  不过整条忽略；可选字段仅在类型相符时保留（重建，不信 engine 自报的多余字段）。 */
function parseMcpServerStatus(value: unknown): McpServerStatus | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.name !== 'string') return undefined;
  if (value.status !== 'connected' && value.status !== 'failed' && value.status !== 'disabled') {
    return undefined;
  }
  if (value.transport !== 'stdio' && value.transport !== 'http') return undefined;
  if (!Array.isArray(value.tools)) return undefined;
  const tools: string[] = [];
  for (const item of value.tools) {
    if (typeof item !== 'string') return undefined;
    tools.push(item);
  }
  const status: McpServerStatus = {
    name: value.name,
    status: value.status,
    transport: value.transport,
    tools,
  };
  if (typeof value.error === 'string') status.error = value.error;
  if (typeof value.protocolVersion === 'string') status.protocolVersion = value.protocolVersion;
  if (isRecord(value.serverInfo) && typeof value.serverInfo.name === 'string') {
    status.serverInfo = {
      name: value.serverInfo.name,
      ...(typeof value.serverInfo.version === 'string'
        ? { version: value.serverInfo.version }
        : {}),
    };
  }
  if (typeof value.resources === 'number') status.resources = value.resources;
  if (typeof value.prompts === 'number') status.prompts = value.prompts;
  return status;
}

/** McpControlResult 判别联合机械校验：ok:false 只查 code/message；ok:true 按 action 查回包。 */
function isMcpControlResult(value: unknown): value is McpControlResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) {
    return typeof value.code === 'string' && typeof value.message === 'string';
  }
  if (value.ok !== true) return false;
  switch (value.action) {
    case 'configure':
      return Array.isArray(value.results) && value.results.every(isMcpConfigureServerResult);
    case 'reconnect':
      return parseMcpServerStatus(value.status) !== undefined && isMcpToolDefArray(value.tools);
    case 'listTools':
      return isMcpToolDefArray(value.tools);
    case 'listResources':
      return Array.isArray(value.resources) && value.resources.every(isMcpResourceDef);
    case 'readResource':
      return typeof value.content === 'string';
    case 'listPrompts':
      return Array.isArray(value.prompts) && value.prompts.every(isMcpPromptDef);
    default:
      return false;
  }
}

/** configure 逐 server 结果：{name, status, tools, error?}。 */
function isMcpConfigureServerResult(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== 'string') return false;
  if (parseMcpServerStatus(value.status) === undefined) return false;
  if (!isMcpToolDefArray(value.tools)) return false;
  return value.error === undefined || typeof value.error === 'string';
}

function isMcpToolDefArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isMcpToolDef);
}

/** McpToolDef：{name, description?, inputSchema?}。 */
function isMcpToolDef(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== 'string') return false;
  if (value.description !== undefined && typeof value.description !== 'string') return false;
  return value.inputSchema === undefined || isRecord(value.inputSchema);
}

/** McpResourceDef：{uri, name?, description?, mimeType?}。 */
function isMcpResourceDef(value: unknown): boolean {
  if (!isRecord(value) || typeof value.uri !== 'string') return false;
  if (value.name !== undefined && typeof value.name !== 'string') return false;
  if (value.description !== undefined && typeof value.description !== 'string') return false;
  return value.mimeType === undefined || typeof value.mimeType === 'string';
}

/** McpPromptDef：{name, description?, arguments?: [{name, description?, required?}]}。 */
function isMcpPromptDef(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== 'string') return false;
  if (value.description !== undefined && typeof value.description !== 'string') return false;
  if (value.arguments === undefined) return true;
  if (!Array.isArray(value.arguments)) return false;
  return value.arguments.every((argument) => {
    if (!isRecord(argument) || typeof argument.name !== 'string') return false;
    if (argument.description !== undefined && typeof argument.description !== 'string') {
      return false;
    }
    return argument.required === undefined || typeof argument.required === 'boolean';
  });
}
