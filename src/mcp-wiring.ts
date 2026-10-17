/**
 * MCP 工厂式插件接线（0.3 A1）。
 *
 * ext 的 `@vessel/mcp-client` 默认导出是工厂函数，不能经 `PluginLoader.load()`
 * 当作普通 Plugin 加载。本模块：
 * - 按 `mcp_servers` 构造 `createMcpPlugin({ servers, events })`；
 * - 把插件控制面适配成 TUI `/mcp` 与 gateway `/v1/mcp/servers` 需要的结构接口；
 * - 动态 import，asm 分支不静态依赖 ext 的实现（并行开发隔离）。
 */

import type { McpServerConfig, VesselConfig } from '../packages/config/src/index';
import type { EventStream, Plugin, PluginHost } from '../packages/core/src/index';
import type { PluginLoader } from './plugin-loader';

/** MCP server 状态快照（Addendum B §9.1 / tui McpServerSummary / web McpServerStatus） */
export interface McpServerSummary {
  name: string;
  status: 'connected' | 'failed' | 'disabled';
  tools: string[];
  error?: string;
  transport?: 'stdio' | 'http';
  protocolVersion?: string;
  serverInfo?: { name: string; version?: string };
}

/** TUI / gateway 共用的只读控制面 */
export interface McpControl {
  list(): Promise<McpServerSummary[]>;
  reconnect(name: string): Promise<McpServerSummary>;
  /** 完整工具名 → 来源 server + 原始工具名；非 MCP 返回 null（同步） */
  toolSource(toolName: string): { server: string; tool: string } | null;
}

/** ext 的 McpClientPlugin（结构镜像，不静态 import） */
export interface McpPluginLike extends Plugin {
  close(): Promise<void>;
  listServers?(): McpServerSummary[];
  getServer?(name: string): McpServerSummary | undefined;
  reconnect?(name: string): Promise<unknown>;
}

/** ext 模块的结构形状 */
export interface McpModuleLike {
  createMcpPlugin(options: {
    servers: Array<{ name: string } & McpServerConfig>;
    events: EventStream;
  }): McpPluginLike;
}

/** 配置了 mcp_servers 但插件不可用 */
export class McpPluginUnavailableError extends Error {
  readonly code = 'mcp_plugin_unavailable';

  constructor(detail?: string) {
    super(
      detail
        ? `mcp_plugin_unavailable: ${detail}`
        : 'mcp_plugin_unavailable: configure plugins/mcp/client or remove mcp_servers',
    );
    this.name = 'McpPluginUnavailableError';
  }
}

/** 生成带 code 的稳定错误（TUI/gateway 直接读 code） */
function mcpError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export interface CreateMcpOptions {
  config: VesselConfig;
  events: EventStream;
  /** 默认模块加载器（bootstrap 传 PluginLoader） */
  loader?: Pick<PluginLoader, 'loadModule'>;
  /** 测试注入口；优先于 loader */
  loadModule?: () => Promise<unknown | null>;
}

export interface McpWiringResult {
  plugin: McpPluginLike;
  control: McpControl;
}

/** 按配置顺序（排序后）生成 server 列表；`enabled:false` 也传，由插件标记 disabled */
export function resolveMcpServers(config: VesselConfig): Array<{ name: string } & McpServerConfig> {
  const servers = config.mcpServers;
  if (!servers) return [];
  return Object.keys(servers)
    .sort()
    .map((name) => ({ name, ...(servers[name] as McpServerConfig) }));
}

/**
 * 构造 MCP 插件；未配置 `mcp_servers` 时返回 null（不 import、不建连）。
 * @throws McpPluginUnavailableError 配置了 servers 但模块缺失/无工厂
 */
export async function createMcpFromConfig(
  options: CreateMcpOptions,
): Promise<McpWiringResult | null> {
  const servers = resolveMcpServers(options.config);
  if (servers.length === 0) return null;

  const load = options.loadModule ?? (async () => options.loader?.loadModule('mcp-client'));
  const mod = (await load()) as McpModuleLike | null | undefined;

  if (!mod || typeof mod.createMcpPlugin !== 'function') {
    throw new McpPluginUnavailableError(
      'plugin "mcp-client" not found or does not export createMcpPlugin()',
    );
  }

  const plugin = mod.createMcpPlugin({ servers, events: options.events });
  return { plugin, control: createMcpControl(plugin, servers) };
}

/** 把插件控制面适配成 TUI / gateway 的结构接口 */
export function createMcpControl(
  plugin: McpPluginLike,
  servers: Array<{ name: string } & McpServerConfig>,
): McpControl {
  const byName = new Map(servers.map((server) => [server.name, server]));

  const snapshot = (): McpServerSummary[] => {
    if (typeof plugin.listServers === 'function') return plugin.listServers();
    // 理论上不会发生（Addendum B 冻结了 listServers）；保守回退不猜状态。
    return servers.map((server) => ({
      name: server.name,
      status: server.enabled === false ? ('disabled' as const) : ('failed' as const),
      tools: [],
      error:
        server.enabled === false ? undefined : 'mcp client plugin does not expose listServers()',
    }));
  };

  return {
    async list() {
      return snapshot();
    },

    async reconnect(name: string) {
      const server = byName.get(name);
      if (!server) {
        throw mcpError('mcp_server_not_found', `MCP server "${name}" is not configured`);
      }
      if (server.enabled === false) {
        throw mcpError('mcp_server_disabled', `MCP server "${name}" is disabled`);
      }
      if (typeof plugin.reconnect !== 'function') {
        throw mcpError('mcp_reconnect_unavailable', `MCP server "${name}" cannot be reconnected`);
      }

      await plugin.reconnect(name);
      const current =
        typeof plugin.getServer === 'function'
          ? plugin.getServer(name)
          : snapshot().find((s) => s.name === name);
      return (
        current ?? {
          name,
          status: 'failed' as const,
          tools: [],
          error: 'server status unavailable after reconnect',
        }
      );
    },

    toolSource(toolName: string) {
      for (const server of servers) {
        const prefix = `mcp__${server.name.replace(/[^A-Za-z0-9_]/g, '_')}__`;
        if (toolName.startsWith(prefix)) {
          return { server: server.name, tool: toolName.slice(prefix.length) };
        }
      }
      // toolPrefix=false：只能从状态快照反查（同名工具冲突由 ext 跳过并告警）
      for (const summary of snapshot()) {
        if (summary.tools.includes(toolName) && byName.get(summary.name)?.toolPrefix === false) {
          return { server: summary.name, tool: toolName };
        }
      }
      return null;
    },
  };
}

/** 安装 MCP 插件到最终 PluginHost；未配置时不做任何事 */
export async function installMcp(
  options: CreateMcpOptions,
  pluginHost: PluginHost,
): Promise<McpWiringResult | null> {
  const wiring = await createMcpFromConfig(options);
  if (wiring) await wiring.plugin.install(pluginHost);
  return wiring;
}
