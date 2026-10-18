/**
 * MCP client 插件工厂。
 *
 * 只注册 ToolDefinition；单 server 失败不阻塞启动；控制面按 Addendum B §9.1。
 */

import type { EventStream, PluginHost, ToolDefinition } from '@vessel/core';
import { formatError } from './json-rpc.js';
import { exposedToolName } from './naming.js';
import { McpServerConnection } from './server-connection.js';
import {
  type McpClientPlugin,
  McpPluginError,
  type McpPluginOptions,
  type McpServerConfig,
  type McpServerState,
  type McpServerStatus,
} from './types.js';

interface ServerEntry {
  config: McpServerConfig;
  connection?: McpServerConnection;
  /** 配置错误（缺 command/url、重名等）；有值时该 entry 不建连 */
  configError?: string;
  /** 已成功注册的暴露工具名 */
  registered: string[];
}

/** 配置预检；返回错误文本或 undefined */
function validateConfig(config: McpServerConfig): string | undefined {
  if (typeof config.name !== 'string' || config.name === '') {
    return 'server name is required';
  }
  if (config.transport !== 'stdio' && config.transport !== 'http') {
    return `unsupported transport "${String(config.transport)}"`;
  }
  if (config.transport === 'stdio') {
    if (typeof config.command !== 'string' || config.command === '') {
      return 'stdio transport requires "command"';
    }
    return undefined;
  }
  if (typeof config.url !== 'string' || config.url === '') {
    return 'http transport requires "url"';
  }
  try {
    const parsed = new URL(config.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'http url must use http or https';
    }
  } catch {
    return `invalid url "${config.url}"`;
  }
  return undefined;
}

export function createMcpPlugin(options: McpPluginOptions): McpClientPlugin {
  const tenantId = normalizeTenantId(options.tenantId);
  const events = options.events;
  const entries: ServerEntry[] = buildEntries(options.servers ?? [], events, tenantId);
  let host: PluginHost | undefined;
  let installed = false;
  let closePromise: Promise<void> | undefined;

  function publish(type: string, data: Record<string, unknown>): void {
    events?.publish({
      type,
      run_id: 'mcp',
      data,
      ts: Date.now(),
      ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
    });
  }

  function registerTools(pluginHost: PluginHost, entry: ServerEntry): void {
    const connection = entry.connection;
    if (!connection) return;

    const autoApprove = new Set(entry.config.autoApproveTools ?? []);
    const toolPrefix = entry.config.toolPrefix !== false;
    for (const tool of connection.tools) {
      const exposed = exposedToolName(entry.config.name, tool.name, toolPrefix);
      if (pluginHost.getTool(exposed) !== undefined) {
        // 同一插件的重复重连不算冲突；与既有工具（含其它 server）碰撞才告警
        if (!entry.registered.includes(exposed)) {
          console.warn(
            `Skipping MCP tool "${exposed}" from server "${entry.config.name}": ` +
              'a tool with this name is already registered; the existing tool is kept',
          );
        }
        continue;
      }

      const toolDefinition: ToolDefinition = {
        name: exposed,
        description: tool.description ?? `MCP tool "${entry.config.name}/${tool.name}"`,
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        handler: async (args, ctx) => {
          const current = entry.connection;
          if (!current) {
            throw new Error(`MCP server "${entry.config.name}" is not connected`);
          }
          return current.callTool(tool.name, exposed, args, ctx.signal, ctx.run_id);
        },
        // Addendum A §5：原始工具名、大小写敏感、精确匹配
        checkPermission: async () => (autoApprove.has(tool.name) ? 'allow' : 'ask'),
      };

      pluginHost.registerTool(toolDefinition);
      entry.registered.push(exposed);
    }
  }

  async function install(pluginHost: PluginHost): Promise<void> {
    if (installed) return;
    installed = true;
    host = pluginHost;

    for (const entry of entries) {
      if (entry.configError !== undefined) {
        publish('mcp.server.failed', {
          server: entry.config.name,
          transport: entry.config.transport,
          error: entry.configError,
        });
      }
    }

    const active = entries.filter(
      (entry) =>
        entry.configError === undefined &&
        entry.config.enabled !== false &&
        entry.connection !== undefined,
    );
    await Promise.allSettled(active.map((entry) => entry.connection?.connect()));

    for (const entry of entries) {
      if (entry.connection?.state !== 'connected') continue;
      try {
        registerTools(pluginHost, entry);
      } catch (error) {
        publish('mcp.server.failed', {
          server: entry.config.name,
          transport: entry.config.transport,
          error: `tool registration failed: ${formatError(error)}`,
        });
      }
    }
  }

  function statusOf(entry: ServerEntry): McpServerStatus {
    const connection = entry.connection;
    let status: McpServerState;
    if (entry.config.enabled === false) {
      status = 'disabled';
    } else if (entry.configError !== undefined) {
      status = 'failed';
    } else {
      status = connection?.state ?? 'failed';
    }

    const error = entry.configError !== undefined ? entry.configError : connection?.error;
    return {
      name: entry.config.name,
      status,
      transport: entry.config.transport,
      tools: [...entry.registered],
      ...(error !== undefined ? { error } : {}),
      ...(connection?.protocolVersion !== undefined
        ? { protocolVersion: connection.protocolVersion }
        : {}),
      ...(connection?.serverInfo !== undefined ? { serverInfo: connection.serverInfo } : {}),
    };
  }

  function listServers(): McpServerStatus[] {
    return entries.map(statusOf);
  }

  function getServer(name: string): McpServerStatus | undefined {
    const entry = entries.find((candidate) => candidate.config.name === name);
    return entry ? statusOf(entry) : undefined;
  }

  async function reconnect(name: string): Promise<void> {
    const entry = entries.find((candidate) => candidate.config.name === name);
    if (!entry) {
      throw new McpPluginError('mcp_server_not_found', `MCP server "${name}" is not configured`);
    }
    if (entry.config.enabled === false) {
      throw new McpPluginError('mcp_server_disabled', `MCP server "${name}" is disabled`);
    }
    if (entry.configError !== undefined) {
      throw new Error(entry.configError);
    }
    if (!host) {
      throw new Error('MCP plugin is not installed');
    }

    const previous = entry.connection;
    if (previous) await previous.close().catch(() => {});

    const connection = new McpServerConnection(entry.config, events, tenantId);
    entry.connection = connection;
    await connection.connect();
    if (connection.state === 'connected') {
      registerTools(host, entry);
    }
  }

  function close(): Promise<void> {
    closePromise ??= (async () => {
      await Promise.allSettled(
        entries.map((entry) => entry.connection?.close() ?? Promise.resolve()),
      );
    })();
    return closePromise;
  }

  return {
    name: 'mcp-client',
    version: '0.3.0',
    description: 'MCP client: register tools from stdio / Streamable HTTP servers',
    install,
    listServers,
    getServer,
    reconnect,
    close,
  };
}

const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function normalizeTenantId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!TENANT_ID_RE.test(value)) throw new Error(`invalid tenant id "${value}"`);
  return value;
}

/** 预检配置并创建连接对象；重名只保留第一个，后续标记失败 */
function buildEntries(
  servers: McpServerConfig[],
  events?: EventStream,
  tenantId?: string,
): ServerEntry[] {
  const entries: ServerEntry[] = [];
  const seen = new Set<string>();

  for (const config of servers) {
    const entry: ServerEntry = { config, registered: [] };
    const error = validateConfig(config);
    if (error !== undefined) {
      entry.configError = error;
    } else if (seen.has(config.name)) {
      entry.configError = `duplicate server name "${config.name}"`;
    } else {
      seen.add(config.name);
      if (config.enabled !== false) {
        entry.connection = new McpServerConnection(config, events, tenantId);
      }
    }
    entries.push(entry);
  }

  return entries;
}
