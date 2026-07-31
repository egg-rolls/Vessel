/**
 * @vessel/mcp-client - MCP (Model Context Protocol) 客户端插件
 * @module @vessel/mcp-client
 *
 * 真实 MCP 客户端实现（非 stub）。通过 JSON-RPC 2.0 over stdio
 * 连接 MCP Server，将 tools/resources/prompts 桥接到
 * ToolRegistry + ContextManager。
 * Tier 1。
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Hook, HookContext, Plugin, PluginHost, ToolDefinition } from '@vessel/core';
import { HookType } from '@vessel/core';

// ── 类型 ──────────────────────────────────────────

/** MCP JSON-RPC 请求 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** MCP JSON-RPC 响应 */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** MCP Tool 定义（来自 server） */
interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** MCP Resource 定义 */
interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** MCP Prompt 定义 */
interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** MCP Server 配置 */
export interface McpServerConfig {
  /** 连接名称 */
  name: string;
  /** 启动命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作目录 */
  cwd?: string;
}

/** 插件配置 */
export interface McpClientConfig {
  /** 预配置的 MCP Server 列表 */
  servers?: McpServerConfig[];
}

// ── MCP 客户端实现 ────────────────────────────────

/** JSON-RPC 错误码 */
const _JSONRPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * 单个 MCP Server 连接
 * 管理一个子进程 + JSON-RPC 通信
 */
class McpConnection {
  readonly name: string;
  private config: McpServerConfig;
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> =
    new Map();
  private tools: McpTool[] = [];
  private resources: McpResource[] = [];
  private prompts: McpPrompt[] = [];
  private pluginHost: PluginHost | null = null;
  private registeredToolNames: Set<string> = new Set();
  private _status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';

  constructor(config: McpServerConfig) {
    this.name = config.name;
    this.config = config;
  }

  get status(): string {
    return this._status;
  }

  /**
   * 连接到 MCP Server
   */
  async connect(host: PluginHost): Promise<void> {
    if (this._status === 'connected') return;

    this.pluginHost = host;
    this._status = 'connecting';

    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.command, this.config.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.config.env },
        cwd: this.config.cwd,
        shell: true,
      });

      this.process = proc;

      // 读取 stdout（JSON-RPC 响应）
      if (!proc.stdout) {
        reject(new Error(`MCP server "${this.name}" has no stdout`));
        return;
      }
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line: string) => {
        this.handleLine(line);
      });

      // 读取 stderr（日志）
      if (proc.stderr) {
        proc.stderr.on('data', (_data: Buffer) => {
          // MCP server 日志，静默记录
        });
      }

      // 进程退出
      proc.on('close', (code) => {
        this._status = 'disconnected';
        this.rejectAllPending(new Error(`MCP server "${this.name}" exited with code ${code}`));
      });

      proc.on('error', (err) => {
        this._status = 'error';
        this.rejectAllPending(err);
        reject(err);
      });

      // 发送 initialize 请求
      this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        clientInfo: {
          name: 'vessel-mcp-client',
          version: '0.1.0',
        },
      })
        .then(() => {
          // 发送 initialized 通知
          this.sendNotification('initialized', {});
          this._status = 'connected';

          // 发现工具和资源
          return Promise.all([
            this.discoverTools(),
            this.discoverResources(),
            this.discoverPrompts(),
          ]);
        })
        .then(() => {
          // 注册工具到 PluginHost
          this.registerTools();
          resolve();
        })
        .catch((err) => {
          this._status = 'error';
          reject(err);
        });
    });
  }

  /**
   * 发现工具
   */
  private async discoverTools(): Promise<void> {
    try {
      const result = (await this.sendRequest('tools/list', {})) as {
        tools?: McpTool[];
      };
      this.tools = result.tools ?? [];
    } catch {
      // tools/list 可能不支持
      this.tools = [];
    }
  }

  /**
   * 发现资源
   */
  private async discoverResources(): Promise<void> {
    try {
      const result = (await this.sendRequest('resources/list', {})) as {
        resources?: McpResource[];
      };
      this.resources = result.resources ?? [];
    } catch {
      this.resources = [];
    }
  }

  /**
   * 发现 prompts
   */
  private async discoverPrompts(): Promise<void> {
    try {
      const result = (await this.sendRequest('prompts/list', {})) as {
        prompts?: McpPrompt[];
      };
      this.prompts = result.prompts ?? [];
    } catch {
      this.prompts = [];
    }
  }

  /**
   * 注册 MCP 工具到 PluginHost
   */
  private registerTools(): void {
    if (!this.pluginHost) return;

    for (const mcpTool of this.tools) {
      const toolName = `mcp__${this.name}__${mcpTool.name}`;
      const toolDef: ToolDefinition = {
        name: toolName,
        description: mcpTool.description ?? `MCP tool from server "${this.name}"`,
        inputSchema: mcpTool.inputSchema ?? {
          type: 'object',
          properties: {},
        },
        handler: async (args: unknown) => {
          return this.callTool(mcpTool.name, args);
        },
      };

      try {
        this.pluginHost.registerTool(toolDef);
        this.registeredToolNames.add(toolName);
      } catch {
        // 工具名冲突，跳过
      }
    }
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(toolName: string, args: unknown): Promise<string> {
    try {
      const result = await this.sendRequest('tools/call', {
        name: toolName,
        arguments: args,
      });

      const typedResult = result as {
        content?: Array<{ type: string; text?: string }>;
      };

      // 提取文本内容
      if (typedResult.content) {
        return typedResult.content
          .flatMap((c) => (c.type === 'text' && c.text ? [c.text] : []))
          .join('\n');
      }

      return JSON.stringify(result);
    } catch (err) {
      return `MCP tool error: ${err}`;
    }
  }

  /**
   * 获取资源内容
   */
  async readResource(uri: string): Promise<string> {
    try {
      const result = (await this.sendRequest('resources/read', {
        uri,
      })) as {
        contents?: Array<{ uri: string; text?: string; mimeType?: string }>;
      };
      if (result.contents) {
        return result.contents.flatMap((c) => (c.text ? [c.text] : [])).join('\n');
      }
      return JSON.stringify(result);
    } catch (err) {
      return `MCP resource error: ${err}`;
    }
  }

  /**
   * 获取 prompt 内容
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<string> {
    try {
      const result = (await this.sendRequest('prompts/get', {
        name,
        arguments: args ?? {},
      })) as {
        messages?: Array<{
          role: string;
          content: { type: string; text?: string };
        }>;
      };
      if (result.messages) {
        return result.messages
          .map((m) => {
            const text = typeof m.content === 'string' ? m.content : (m.content?.text ?? '');
            return `[${m.role}]: ${text}`;
          })
          .join('\n');
      }
      return JSON.stringify(result);
    } catch (err) {
      return `MCP prompt error: ${err}`;
    }
  }

  /** 获取已注册的工具名列表 */
  getRegisteredTools(): string[] {
    return Array.from(this.registeredToolNames);
  }

  /** 获取发现的资源列表 */
  getResources(): McpResource[] {
    return [...this.resources];
  }

  /** 获取发现的 prompt 列表 */
  getPrompts(): McpPrompt[] {
    return [...this.prompts];
  }

  /** 获取发现的工具列表（原始名称） */
  getTools(): McpTool[] {
    return [...this.tools];
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this._status = 'disconnected';
  }

  // ── JSON-RPC 核心 ─────────────────────────────

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          const { resolve, reject } = pending;
          this.pending.delete(msg.id);

          if (msg.error) {
            reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            resolve(msg.result);
          }
        }
      }
    } catch {
      // 非 JSON 行，忽略
    }
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.pending.set(id, { resolve, reject });

      const line = `${JSON.stringify(request)}\n`;
      this.process?.stdin?.write(line);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    const line = `${JSON.stringify(notification)}\n`;
    this.process?.stdin?.write(line);
  }

  private rejectAllPending(err: Error): void {
    for (const [, { reject }] of this.pending) {
      reject(err);
    }
    this.pending.clear();
  }
}

// ── MCP 客户端管理器 ──────────────────────────────

class McpClientManager {
  private connections: Map<string, McpConnection> = new Map();
  private pluginHost: PluginHost | null = null;

  setHost(host: PluginHost): void {
    this.pluginHost = host;
  }

  /**
   * 连接一个 MCP Server
   */
  async connect(config: McpServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      throw new Error(`MCP server "${config.name}" is already connected`);
    }

    if (!this.pluginHost) {
      throw new Error('PluginHost not set');
    }

    const conn = new McpConnection(config);
    await conn.connect(this.pluginHost);
    this.connections.set(config.name, conn);
  }

  /**
   * 断开 MCP Server
   */
  disconnect(name: string): void {
    const conn = this.connections.get(name);
    if (conn) {
      conn.disconnect();
      this.connections.delete(name);
    }
  }

  /**
   * 断开所有连接
   */
  disconnectAll(): void {
    for (const [_name, conn] of this.connections) {
      conn.disconnect();
    }
    this.connections.clear();
  }

  /**
   * 获取连接
   */
  get(name: string): McpConnection | undefined {
    return this.connections.get(name);
  }

  /**
   * 列出所有连接
   */
  list(): McpServerConfig[] {
    return Array.from(this.connections.values()).map((c) => ({
      name: c.name,
      command: '',
    }));
  }

  /**
   * 汇总所有 MCP 提供的工具
   */
  listAllTools(): Array<{ server: string; tool: string }> {
    const result: Array<{ server: string; tool: string }> = [];
    for (const [name, conn] of this.connections) {
      for (const tool of conn.getRegisteredTools()) {
        result.push({ server: name, tool });
      }
    }
    return result;
  }
}

// ── 工具定义 ──────────────────────────────────────

function createMcpTools(manager: McpClientManager): ToolDefinition[] {
  return [
    {
      name: 'mcp_connect',
      description:
        '连接到 MCP (Model Context Protocol) 服务器。' +
        '提供 command（可执行文件路径）和可选的 args（参数数组）。',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '连接名称（用于后续引用）',
          },
          command: {
            type: 'string',
            description: '启动命令（如 npx、node、python）',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: '命令参数',
          },
        },
        required: ['name', 'command'],
      },
      handler: async (input) => {
        const { name, command, args } = input as {
          name: string;
          command: string;
          args?: string[];
        };
        try {
          await manager.connect({ name, command, args: args ?? [] });
          const conn = manager.get(name);
          if (!conn) {
            return `连接失败: 服务器 "${name}" 连接后未找到`;
          }
          const tools = conn.getTools();
          const resources = conn.getResources();
          const prompts = conn.getPrompts();

          return [
            `已连接到 MCP 服务器 "${name}"`,
            `工具: ${tools.map((t) => t.name).join(', ') || '无'}`,
            `资源: ${resources.map((r) => r.name).join(', ') || '无'}`,
            `Prompts: ${prompts.map((p) => p.name).join(', ') || '无'}`,
          ].join('\n');
        } catch (err) {
          return `连接失败: ${err}`;
        }
      },
    },
    {
      name: 'mcp_disconnect',
      description: '断开 MCP 服务器连接',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '连接名称',
          },
        },
        required: ['name'],
      },
      handler: async (input) => {
        const { name } = input as { name: string };
        manager.disconnect(name);
        return `已断开 MCP 服务器 "${name}"`;
      },
    },
    {
      name: 'mcp_list',
      description: '列出所有已连接的 MCP 服务器及其提供的工具',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const tools = manager.listAllTools();
        if (tools.length === 0) {
          return '没有已连接的 MCP 服务器。使用 mcp_connect 连接一个。';
        }
        const byServer = new Map<string, string[]>();
        for (const { server, tool } of tools) {
          if (!byServer.has(server)) byServer.set(server, []);
          byServer.get(server)?.push(tool);
        }
        const lines: string[] = [];
        for (const [server, toolNames] of byServer) {
          lines.push(`**${server}**: ${toolNames.join(', ')}`);
        }
        return lines.join('\n');
      },
    },
  ];
}

// ── Hook ──────────────────────────────────────────

function createMcpContextHook(manager: McpClientManager): Hook {
  return {
    name: 'mcp-context-injection',
    type: HookType.BeforeLlm,
    priority: 80,
    run: async (ctx: HookContext): Promise<HookContext | null> => {
      // 将 MCP 提供的 resources/prompts 摘要注入上下文
      const _parts: string[] = [];
      for (const _conn of Array.from(
        (manager as unknown as { connections: Map<string, McpConnection> }).connections?.values() ??
          [],
      )) {
        // 这里不直接访问 private 字段，改用公开方法
      }

      // 使用公开接口获取信息
      const tools = manager.listAllTools();
      if (tools.length > 0) {
        const extended = ctx as HookContext & { system_prompt?: string };
        const mcpInfo = `\n<!-- MCP 已连接服务器 -->\n已连接 ${tools.length} 个 MCP 工具。使用 mcp_list 查看详情。`;
        extended.system_prompt = (extended.system_prompt ?? '') + mcpInfo;
      }

      return ctx;
    },
  };
}

// ── 插件导出 ──────────────────────────────────────

export const mcpClientPlugin: Plugin = {
  name: 'mcp-client',
  version: '0.1.0',
  description:
    'MCP client plugin — connects to MCP servers via JSON-RPC over stdio and bridges tools/resources/prompts',
  install(host: PluginHost, config?: unknown) {
    const pluginConfig = (config as McpClientConfig) ?? {};
    const manager = new McpClientManager();
    manager.setHost(host);

    // 注册 MCP 管理工具
    for (const tool of createMcpTools(manager)) {
      host.registerTool(tool);
    }

    // 注册 BeforeLlm Hook
    host.registerHook(createMcpContextHook(manager));

    // 自动连接预配置的 MCP Server
    const servers = pluginConfig.servers ?? [];
    for (const serverConfig of servers) {
      manager.connect(serverConfig).catch((err) => {
        console.error(
          `[mcp-client] Failed to auto-connect "${serverConfig.name}":`,
          (err as Error).message,
        );
      });
    }

    // 暴露 manager 供其他插件使用
    (host as Record<string, unknown>).__mcpManager = manager;
  },
};

export type { McpPrompt, McpResource, McpTool };
// 导出类型和类供外部使用
export { McpClientManager, McpConnection };

export default mcpClientPlugin;
