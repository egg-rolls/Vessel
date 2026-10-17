/**
 * MCP client 插件的公开类型与内部传输契约。
 *
 * 冻结面：DECISION-008 §4.2；控制面：Addendum B §9.1。
 * 本插件只经 PluginHost.registerTool 接入，不新增 core 接口。
 */

import type { EventStream, Plugin } from '@vessel/core';

/** 传输类型 */
export type McpTransportKind = 'stdio' | 'http';

/** 单个 MCP server 配置（字段名按 DECISION-008 §4.2 冻结） */
export interface McpServerConfig {
  name: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  connectTimeoutMs?: number;
  toolTimeoutMs?: number;
  toolPrefix?: boolean;
  autoApproveTools?: string[];
}

/** 插件配置 */
export interface McpPluginOptions {
  servers: McpServerConfig[];
  events?: EventStream;
}

/** 冻结的插件形状 */
export type McpPlugin = Plugin & { close(): Promise<void> };

/** 对外可见的 server 状态 */
export type McpServerState = 'connected' | 'failed' | 'disabled';

/** server 状态快照（供 TUI / gateway 消费） */
export interface McpServerStatus {
  name: string;
  status: McpServerState;
  transport: McpTransportKind;
  /** 已按 toolPrefix 规则生成的完整工具名 */
  tools: string[];
  error?: string;
  protocolVersion?: string;
  serverInfo?: { name: string; version?: string };
}

/** 控制面（Addendum B §9.1） */
export interface McpPluginControls {
  listServers(): McpServerStatus[];
  getServer(name: string): McpServerStatus | undefined;
  reconnect(name: string): Promise<void>;
}

/** 工厂返回类型 */
export type McpClientPlugin = Plugin & McpPluginControls & { close(): Promise<void> };

/** 稳定错误码（Addendum B §9.1） */
export type McpPluginErrorCode = 'mcp_server_not_found' | 'mcp_server_disabled';

/** 控制面稳定错误 */
export class McpPluginError extends Error {
  readonly code: McpPluginErrorCode;

  constructor(code: McpPluginErrorCode, message: string) {
    super(message);
    this.name = 'McpPluginError';
    this.code = code;
  }
}

/** server 返回的工具描述 */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** tools/call 结果（只取需要的字段） */
export interface McpToolResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** 单次请求选项 */
export interface RequestOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 传输层统一接口 */
export interface McpTransport {
  readonly kind: McpTransportKind;
  /** stdio: spawn 子进程；http: 校验 URL */
  start(): Promise<void>;
  request(method: string, params: unknown, opts: RequestOptions): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
  /** 连接被动断开（进程退出 / 会话失效 / 传输错误） */
  onClose(handler: (reason: string) => void): void;
}
