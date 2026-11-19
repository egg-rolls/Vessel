/**
 * tools-engine P2 批次 2：MCP host shell（engine 模式的装配层接线）。
 *
 * 连接/传输/pending 在 engine worker（McpConnectionManager）；host 壳只管：
 * - 注册权威（configure/reconnect 回包工具集 → 既有注册语义增删，engine 不驱动注册 C1）；
 * - wireTool 就地换转发 handler（exec=worker，def 身份不变；换连接不换定义——工具集不变
 *   时 def 原样保留，worker 侧映射已更新）；
 * - 控制面代理（listServers/getServer = engine health.mcp 缓存 + host 已注册名；
 *   reconnect 经 engine.mcp.control）——createMcpControl 单实现不变，cli applier/toggle 零改动。
 *
 * library 模式（无 engineClient）走 mcp-wiring.installMcp，一字不改。
 * 密钥纪律：config 经 stdio 出进程 = PII 同信任边界（修正案 r2 已批）；host 日志不记 config 值。
 *
 * @module vessel/mcp-engine-wiring
 */

import type { EngineClient } from '@vessel-agent/engine-client';
import type {
  McpRegistrationPorts,
  McpServerConfig,
  McpServerStatus,
  McpToolDef,
} from '@vessel-agent/mcp-client';
import type { EventStream, Logger, PluginHost } from '../packages/core/src/index';
import {
  type CreateMcpOptions,
  createMcpControl,
  type McpControl,
  type McpModuleLike,
  type McpPluginLike,
  McpPluginUnavailableError,
  type McpServerSummary,
  mcpError,
  resolveMcpServers,
} from './mcp-wiring';

/** loaded mcp-client 模块的批次 2 共享面（结构镜像，不静态 import 实现）。 */
export interface McpEngineModuleLike {
  registerMcpTools(
    host: PluginHost,
    server: McpServerConfig,
    tools: McpToolDef[],
    ports: McpRegistrationPorts,
    registered: string[],
  ): void;
  registerMcpResourceTools(
    host: PluginHost,
    server: McpServerConfig,
    ports: McpRegistrationPorts,
    registered: string[],
  ): void;
  exposedToolName(server: string, tool: string, toolPrefix: boolean): string;
  DEFAULT_MCP_CONNECT_TIMEOUT_MS: number;
}

/** host shell 状态（逐 server）：注册名 host 权威；status/tools 来自 engine 回包/health。 */
interface ServerState {
  config: McpServerConfig;
  registered: string[];
  status?: McpServerStatus;
  tools: McpToolDef[];
}

export interface McpEngineShell extends McpPluginLike {
  /** 全量对账（初始 / 热应用 / engine 重启 onReady）：喂 configure + 注册增删 + 喂账本。 */
  configure(servers: McpServerConfig[]): Promise<void>;
  /** 用最近一次 servers 重喂（engine 重启对账）。 */
  reconcile(): Promise<void>;
}

export interface McpEngineShellOptions {
  client: EngineClient;
  host: PluginHost;
  servers: McpServerConfig[];
  module: McpEngineModuleLike;
  events?: EventStream;
  tenantId?: string;
  logger?: Logger;
}

/** host 请求预算：max(connectTimeoutMs ?? 缺省) + 10s 宽限（worker 建连 timer 在先）。 */
const CONFIGURE_GRACE_MS = 10_000;

export function createMcpEngineShell(options: McpEngineShellOptions): McpEngineShell {
  const { client, host, module: mod, events, tenantId, logger } = options;
  const state = new Map<string, ServerState>();
  let lastServers: McpServerConfig[] = options.servers;
  for (const config of options.servers) {
    if (!state.has(config.name)) state.set(config.name, { config, registered: [], tools: [] });
  }

  function publish(type: string, data: Record<string, unknown>): void {
    events?.publish({
      type,
      run_id: 'mcp',
      data,
      ts: Date.now(),
      ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
    });
  }

  /** 注册端口 = 占位（wireTool 立即覆盖 handler，永不执行；engine disabled 时转发先折 unavailable）。 */
  function placeholderPorts(server: string, status: McpServerStatus): McpRegistrationPorts {
    const notConnected = async (): Promise<string> => {
      throw new Error(`MCP server "${server}" is not connected`);
    };
    return {
      callTool: notConnected,
      readResource: notConnected,
      resources: () => [],
      prompts: () => [],
      supportsResources: status.resources !== undefined,
      supportsPrompts: status.prompts !== undefined,
      warn: (message, fields) => {
        logger?.warn('mcp.registration', { server, message, ...fields });
        publish('mcp.warning', { server, warning: message, ...fields });
      },
    };
  }

  function exposedToolsOf(
    st: ServerState,
    status: McpServerStatus,
    tools: McpToolDef[],
  ): Set<string> {
    const toolPrefix = st.config.toolPrefix !== false;
    const names = new Set<string>();
    if (status.status === 'connected') {
      for (const tool of tools)
        names.add(mod.exposedToolName(st.config.name, tool.name, toolPrefix));
      if (status.resources !== undefined) {
        names.add(mod.exposedToolName(st.config.name, 'list_resources', toolPrefix));
        names.add(mod.exposedToolName(st.config.name, 'read_resource', toolPrefix));
      }
      if (status.prompts !== undefined) {
        names.add(mod.exposedToolName(st.config.name, 'list_prompts', toolPrefix));
      }
    }
    return names;
  }

  /**
   * 逐 server 注册对账（换连接不换定义）：工具集不变 → def 原样保留（worker 映射已更新）；
   * 新增 → 注册 + wire；移除 → unregister + unwire。failed 保留旧注册（调用折 not connected，
   * 与今日 reconnect 失败口径一致）；disabled 清空（toggle.disable 口径）。
   */
  function reconcileServer(name: string, status: McpServerStatus, tools: McpToolDef[]): void {
    const st = state.get(name);
    if (st === undefined) return;
    st.status = status;
    st.tools = tools;
    if (status.status === 'connected') {
      const ports = placeholderPorts(name, status);
      // 注册函数对「已在 host 的同名工具」跳过：st.registered 含旧名 ⇒ 旧 def 静默保留，
      // 真新增注册，与其它 server 碰撞告警（单实现语义）。
      mod.registerMcpTools(host, st.config, tools, ports, st.registered);
      mod.registerMcpResourceTools(host, st.config, ports, st.registered);
      const target = exposedToolsOf(st, status, tools);
      for (const old of [...st.registered]) {
        if (!target.has(old)) {
          host.unregisterTool?.(old);
          client.unwireTool(old);
          st.registered.splice(st.registered.indexOf(old), 1);
        }
      }
      for (const registered of st.registered) {
        const def = host.getTool(registered);
        if (def !== undefined) {
          client.wireTool(def, { execClass: 'worker', source: `mcp:${name}` });
        }
      }
      return;
    }
    if (status.status === 'disabled') {
      for (const old of st.registered) {
        host.unregisterTool?.(old);
        client.unwireTool(old);
      }
      st.registered = [];
    }
    // failed：保留旧注册（从未注册则空）——调用经 worker 折 not connected 稳定文本。
  }

  async function pushRegistrySafe(): Promise<void> {
    try {
      await client.pushRegistry();
    } catch (error) {
      logger?.warn('tools-engine registry push failed (mcp)', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function listServers(): McpServerSummary[] {
    const health = client.lastHealth()?.mcp;
    return [...state.values()].map((st) => {
      const reported = health?.find((item) => item.name === st.config.name) ?? st.status;
      const status =
        st.config.enabled === false ? ('disabled' as const) : (reported?.status ?? 'failed');
      return {
        name: st.config.name,
        status,
        tools: [...st.registered],
        ...(reported?.error !== undefined ? { error: reported.error } : {}),
        ...(reported?.transport !== undefined ? { transport: reported.transport } : {}),
        ...(reported?.protocolVersion !== undefined
          ? { protocolVersion: reported.protocolVersion }
          : {}),
        ...(reported?.serverInfo !== undefined ? { serverInfo: reported.serverInfo } : {}),
      };
    });
  }

  const shell: McpEngineShell = {
    name: 'mcp-client',
    version: '0.3.0',
    description: 'MCP host shell (tools-engine P2 batch 2): registration authority + control proxy',
    // 注册经 configure（engine 回包工具集）；install 空壳（bundle 生命周期形状需要）。
    install: async () => {},
    // 连接在 worker：engine 退出路径关连接（杀 server 孙进程）；host 壳无连接可关。
    close: async () => {},

    listServers,

    getServer(name: string): McpServerSummary | undefined {
      return listServers().find((server) => server.name === name);
    },

    async reconnect(name: string): Promise<void> {
      const st = state.get(name);
      if (st === undefined) {
        throw mcpError('mcp_server_not_found', `MCP server "${name}" is not configured`);
      }
      if (st.config.enabled === false) {
        throw mcpError('mcp_server_disabled', `MCP server "${name}" is disabled`);
      }
      const result = await client.mcpControl({ action: 'reconnect', server: name });
      if (!result.ok) throw mcpError(result.code, result.message);
      if (result.action !== 'reconnect') {
        throw mcpError('mcp_reconnect_unavailable', 'unexpected engine control result');
      }
      reconcileServer(name, result.status, result.tools);
      await pushRegistrySafe();
    },

    async configure(servers: McpServerConfig[]): Promise<void> {
      lastServers = servers;
      const timeoutMs =
        servers.reduce(
          (max, server) =>
            Math.max(max, server.connectTimeoutMs ?? mod.DEFAULT_MCP_CONNECT_TIMEOUT_MS),
          0,
        ) + CONFIGURE_GRACE_MS;
      const result = await client.mcpControl({ action: 'configure', servers }, timeoutMs);
      if (!result.ok) throw mcpError(result.code, result.message);
      if (result.action !== 'configure') {
        throw mcpError('mcp_reconnect_unavailable', 'unexpected engine control result');
      }
      // 移除的 server：unregister + unwire（C3 卸载对称）。
      const nextNames = new Set(servers.map((server) => server.name));
      for (const [name, st] of [...state.entries()]) {
        if (!nextNames.has(name)) {
          for (const old of st.registered) {
            host.unregisterTool?.(old);
            client.unwireTool(old);
          }
          state.delete(name);
        }
      }
      for (const item of result.results) {
        const config = servers.find((server) => server.name === item.name);
        if (config === undefined) continue;
        const existing = state.get(item.name);
        state.set(item.name, {
          config,
          registered: existing?.registered ?? [],
          status: item.status,
          tools: item.tools,
        });
        reconcileServer(item.name, item.status, item.tools);
        if (item.status.status === 'failed') {
          publish('mcp.server.failed', {
            server: item.name,
            transport: item.status.transport,
            error: item.error ?? item.status.error ?? 'connect failed',
          });
        }
      }
      await pushRegistrySafe();
    },

    async reconcile(): Promise<void> {
      await shell.configure(lastServers);
    },
  };

  return shell;
}

/**
 * engine 模式 MCP 接线：加载模块（共享注册语义单实现）→ 建壳 → 初始 configure（启动期同步，
 * tools[] 快照时点与今日 install 一致）→ control = createMcpControl（单实现不变）。
 * configure 失败不崩启动（engine disabled → 工具 fail-closed；状态 failed 可由 applier 重连）。
 */
export async function createMcpEngineFromConfig(
  options: CreateMcpOptions & { client: EngineClient; host: PluginHost; logger?: Logger },
): Promise<{ plugin: McpEngineShell; control: McpControl } | null> {
  const servers = resolveMcpServers(options.config);
  if (servers.length === 0) return null;

  const load = options.loadModule ?? (async () => options.loader?.loadModule('mcp-client'));
  const mod = (await load()) as (McpModuleLike & McpEngineModuleLike) | null | undefined;
  if (
    !mod ||
    typeof mod.registerMcpTools !== 'function' ||
    typeof mod.registerMcpResourceTools !== 'function' ||
    typeof mod.exposedToolName !== 'function' ||
    typeof mod.DEFAULT_MCP_CONNECT_TIMEOUT_MS !== 'number'
  ) {
    throw new McpPluginUnavailableError(
      'plugin "mcp-client" not found or lacks batch-2 shared exports (registration/naming)',
    );
  }

  const shell = createMcpEngineShell({
    client: options.client,
    host: options.host,
    servers,
    module: mod,
    ...(options.events !== undefined ? { events: options.events } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  try {
    await shell.configure(servers);
  } catch (error) {
    options.logger?.error('mcp engine configure failed at startup; tools are fail-closed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return { plugin: shell, control: createMcpControl(shell, servers) };
}
