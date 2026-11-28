/**
 * tools-engine MCP 连接管理（P2 seams 批次 2 契约 §2.1）。
 *
 * engine child 持 MCP server 连接（第三方 server 进程是 child 的孙进程，崩溃不拖垮 child）；
 * 注册权威在 host——configure/reconnect 回包带工具集，host 走既有增删注册流程，
 * 本模块不注册工具，只维护 exposed→{server,original} 路由映射（naming 不可逆，映射自建）。
 *
 * entries 口径复用 plugin.ts buildEntries（validateConfig 单实现 / 重名只留第一个标 failed /
 * enabled:false 不建连）；configure = 全量 diff（新增建连 / 移除关连接 / config 变化重建 /
 * 不变保留），并行 connect（Promise.allSettled，与 install 同口径），部分失败不整请求失败。
 *
 * 事件全 host 发布：events 是 noop shim，只拦截 'mcp.server.disconnected'
 * （McpServerConnection.handlePassiveClose 被动断开）→ notifyHealth()；mcp.* 诊断不跨进程。
 * configure/reconnect 主动结果以回包为准，不重复发 notification。
 *
 * 密钥纪律：config 内存 only 不落盘；日志只记 name/status，错误文本经 sanitizeLogText
 * 去掉 URL 内嵌凭据（logging.ts 单实现）。
 *
 * @module tools-engine/mcp
 */

import type { EventStream, Logger } from '@vessel-agent/core';
import {
  canonicalJSON,
  ENGINE_ERROR,
  type McpConfigureServerResult,
} from '@vessel-agent/engine-client';
// 共享模块单实现（mcp-client index 共享导出；根 package.json 已声明 workspace 依赖）。
import {
  exposedToolName,
  McpPluginError,
  type McpPromptDef,
  type McpResourceDef,
  type McpServerConfig,
  McpServerConnection,
  type McpServerState,
  type McpServerStatus,
  type McpToolDef,
  sanitizeLogText,
  validateConfig,
} from '@vessel-agent/mcp-client';

export interface McpConnectionManagerOptions {
  /** 被动状态变化 → engine 发 health notification（带 mcp）。 */
  notifyHealth(): void;
  logger?: Logger;
}

/** 与 plugin.ts ServerEntry 同口径（worker 不注册工具，无 registered 账本）。 */
interface ServerEntry {
  config: McpServerConfig;
  connection?: McpServerConnection;
  /** 配置错误（缺 command/url、重名等）；有值时该 entry 不建连。 */
  configError?: string;
}

/** exposed 名 → server + 原始名；kind 区分真实工具与 resources/prompts 辅助工具。 */
interface ToolMapping {
  server: string;
  original: string;
  kind: 'tool' | 'listResources' | 'readResource' | 'listPrompts';
}

export class McpConnectionManager {
  private entries: ServerEntry[] = [];
  private readonly toolIndex = new Map<string, ToolMapping>();
  private readonly events: EventStream;
  private disposePromise?: Promise<void>;

  constructor(private readonly options: McpConnectionManagerOptions) {
    // noop shim：事件全 host 发布；只拦截被动断开（handlePassiveClose 唯一发布点）。
    this.events = {
      subscribe: () => () => {},
      publish: (event) => {
        if (event.type === 'mcp.server.disconnected') {
          this.options.notifyHealth();
        }
      },
      clear: () => {},
      getHistory: () => [],
      waitFor: () => Promise.reject(new Error('mcp events are not available in the engine worker')),
    };
  }

  /** 全量 diff：新增建连 / 移除关连接 / config 变化（稳定 JSON 对比）重建 / 不变保留。 */
  async configure(servers: McpServerConfig[]): Promise<McpConfigureServerResult[]> {
    const oldByName = new Map<string, ServerEntry>();
    for (const entry of this.entries) {
      if (!oldByName.has(entry.config.name)) oldByName.set(entry.config.name, entry);
    }

    const next: ServerEntry[] = [];
    const seen = new Set<string>();
    const carried = new Set<McpServerConnection>();
    const connecting: ServerEntry[] = [];
    for (const config of servers) {
      const entry: ServerEntry = { config };
      const error = validateConfig(config);
      if (error !== undefined) {
        entry.configError = error;
      } else if (seen.has(config.name)) {
        entry.configError = `duplicate server name "${config.name}"`;
      } else {
        seen.add(config.name);
        const old = oldByName.get(config.name);
        if (old !== undefined && canonicalJSON(old.config) === canonicalJSON(config)) {
          entry.connection = old.connection;
          if (old.connection !== undefined) carried.add(old.connection);
        } else if (config.enabled !== false) {
          entry.connection = new McpServerConnection(config, this.events);
          connecting.push(entry);
        }
      }
      next.push(entry);
    }

    const closing: Promise<void>[] = [];
    for (const old of this.entries) {
      if (old.connection !== undefined && !carried.has(old.connection)) {
        closing.push(old.connection.close().catch(() => {})); // benign: 旧连接关闭尽力而为，失败不阻断替换。
      }
    }
    this.entries = next;
    await Promise.allSettled([
      ...closing,
      ...connecting.map((entry) => entry.connection?.connect() ?? Promise.resolve()),
    ]);
    this.rebuildToolIndex();

    for (const entry of next) {
      const error = entry.configError ?? entry.connection?.error;
      if (error !== undefined) {
        this.options.logger?.warn('tools-engine: mcp server configure failed', {
          server: entry.config.name,
          status: this.statusOf(entry).status,
          error: sanitizeLogText(error),
        });
      }
    }
    return next.map((entry) => {
      const error = entry.configError ?? entry.connection?.error;
      return {
        name: entry.config.name,
        status: this.statusOf(entry),
        tools: [...(entry.connection?.tools ?? [])],
        ...(error !== undefined ? { error } : {}),
      };
    });
  }

  /** 关旧连接 → 新建 → connect；state≠connected 也返回 status，不 throw（host 同口径）。 */
  async reconnect(server: string): Promise<{ status: McpServerStatus; tools: McpToolDef[] }> {
    const entry = this.entries.find((candidate) => candidate.config.name === server);
    if (entry === undefined) {
      throw new McpPluginError('mcp_server_not_found', `MCP server "${server}" is not configured`);
    }
    if (entry.config.enabled === false) {
      throw new McpPluginError('mcp_server_disabled', `MCP server "${server}" is disabled`);
    }
    if (entry.configError !== undefined) throw new Error(entry.configError);

    const previous = entry.connection;
    if (previous !== undefined) await previous.close().catch(() => {}); // benign: 旧连接关闭尽力而为。
    const connection = new McpServerConnection(entry.config, this.events);
    entry.connection = connection;
    await connection.connect();
    this.rebuildToolIndex();
    if (connection.state !== 'connected') {
      this.options.logger?.warn('tools-engine: mcp server reconnect failed', {
        server,
        status: connection.state,
        error: sanitizeLogText(connection.error ?? 'unknown'),
      });
    }
    return { status: this.statusOf(entry), tools: [...connection.tools] };
  }

  listTools(server: string): McpToolDef[] {
    return this.connected(server).tools;
  }

  listResources(server: string): McpResourceDef[] {
    return this.connected(server).resources;
  }

  readResource(server: string, uri: string): Promise<string> {
    return this.connected(server).readResource(uri);
  }

  listPrompts(server: string): McpPromptDef[] {
    return this.connected(server).prompts;
  }

  /**
   * mcp invoke 路由：exposed 名 → 自建映射找 server+original。
   * 未映射 → notRegistered 稳定文本；连接断开 → not connected 稳定文本（host handler 同口径）；
   * 辅助工具（list_resources/read_resource/list_prompts）语义与 host 注册 handler 逐字一致。
   */
  async callTool(
    exposedName: string,
    args: unknown,
    signal: AbortSignal,
    runId: string,
  ): Promise<string> {
    const mapping = this.toolIndex.get(exposedName);
    if (mapping === undefined) throw new Error(ENGINE_ERROR.notRegistered(exposedName));
    const entry = this.entries.find((candidate) => candidate.config.name === mapping.server);
    const connection = entry?.connection;
    if (connection === undefined || connection.state !== 'connected') {
      throw new Error(`MCP server "${mapping.server}" is not connected`);
    }
    switch (mapping.kind) {
      case 'tool':
        return connection.callTool(mapping.original, exposedName, args, signal, runId);
      case 'listResources':
        return JSON.stringify(connection.resources);
      case 'listPrompts':
        return JSON.stringify(connection.prompts);
      case 'readResource': {
        if (typeof args !== 'object' || args === null) {
          return 'Error: read_resource requires { uri: string }';
        }
        const uri = (args as Record<string, unknown>).uri;
        if (typeof uri !== 'string' || uri === '') {
          return 'Error: read_resource requires a non-empty uri';
        }
        return connection.readResource(uri, signal);
      }
    }
  }

  /** health.mcp 快照（entries 顺序；tools = 该 server 连接的 exposedToolName 全集）。 */
  status(): McpServerStatus[] {
    return this.entries.map((entry) => this.statusOf(entry));
  }

  /** 关全部连接（杀 server 孙进程）；幂等。 */
  async dispose(): Promise<void> {
    this.disposePromise ??= Promise.allSettled(
      this.entries.map((entry) => entry.connection?.close() ?? Promise.resolve()),
    ).then(() => {});
    return this.disposePromise;
  }

  /** 校验 server 并返回已连接实例（plugin.ts connected 同口径）。 */
  private connected(name: string): McpServerConnection {
    const entry = this.entries.find((candidate) => candidate.config.name === name);
    if (entry === undefined) {
      throw new McpPluginError('mcp_server_not_found', `MCP server "${name}" is not configured`);
    }
    if (entry.config.enabled === false) {
      throw new McpPluginError('mcp_server_disabled', `MCP server "${name}" is disabled`);
    }
    const connection = entry.connection;
    if (connection === undefined || connection.state !== 'connected') {
      throw new McpPluginError('mcp_server_not_connected', `MCP server "${name}" is not connected`);
    }
    return connection;
  }

  /** 与 plugin.ts statusOf 同口径；tools 字段 = exposedToolName 全集（契约 §2.1）。 */
  private statusOf(entry: ServerEntry): McpServerStatus {
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
      tools: this.exposedToolsOf(entry),
      ...(error !== undefined ? { error } : {}),
      ...(connection?.protocolVersion !== undefined
        ? { protocolVersion: connection.protocolVersion }
        : {}),
      ...(connection?.serverInfo !== undefined ? { serverInfo: connection.serverInfo } : {}),
      ...(connection?.supportsResources === true ? { resources: connection.resources.length } : {}),
      ...(connection?.supportsPrompts === true ? { prompts: connection.prompts.length } : {}),
    };
  }

  private exposedToolsOf(entry: ServerEntry): string[] {
    const connection = entry.connection;
    if (connection === undefined) return [];
    const toolPrefix = entry.config.toolPrefix !== false;
    return connection.tools.map((tool) =>
      exposedToolName(entry.config.name, tool.name, toolPrefix),
    );
  }

  /**
   * configure/reconnect 后按各连接 tools + naming 重建；碰撞跳过先注册者优先
   * （entries 顺序 = configure servers 顺序，与 host 注册口径一致）。
   * 辅助工具随能力广告追加（host registerResourceTools 同序）；真实工具同名时真实工具优先。
   * 断开连接的最近工具集保留映射：callTool 按调用时 state 折 not connected（host handler 同口径）。
   */
  private rebuildToolIndex(): void {
    this.toolIndex.clear();
    for (const entry of this.entries) {
      const connection = entry.connection;
      if (connection === undefined) continue;
      const toolPrefix = entry.config.toolPrefix !== false;
      const add = (toolName: string, kind: ToolMapping['kind']): void => {
        const exposed = exposedToolName(entry.config.name, toolName, toolPrefix);
        if (this.toolIndex.has(exposed)) return;
        this.toolIndex.set(exposed, { server: entry.config.name, original: toolName, kind });
      };
      for (const tool of connection.tools) add(tool.name, 'tool');
      if (connection.supportsResources) {
        add('list_resources', 'listResources');
        add('read_resource', 'readResource');
      }
      if (connection.supportsPrompts) {
        add('list_prompts', 'listPrompts');
      }
    }
  }
}
