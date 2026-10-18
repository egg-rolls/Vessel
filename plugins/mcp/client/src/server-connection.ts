/**
 * 单个 MCP server 的连接与状态机。
 *
 * 负责 initialize 握手、tools/list 分页、tools/call、事件发布与被动断开处理。
 * 工具注册由 plugin.ts 统一处理（需要检查 PluginHost 冲突）。
 */

import type { EventStream } from '@vessel/core';
import { formatError, isRecord, JsonRpcError, McpTransportError } from './json-rpc.js';
import { createTransport } from './transport.js';
import type {
  McpServerConfig,
  McpServerState,
  McpToolDef,
  McpToolResult,
  McpTransport,
} from './types.js';

/** tools/list 最大分页数 */
const MAX_TOOL_PAGES = 50;

/** initialize 协商的协议版本（请求值） */
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** 已知可接受的协议版本；其它版本仅告警 */
const KNOWN_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

/** 服务器未实现 tools 能力时的 JSON-RPC 错误码 */
const METHOD_NOT_FOUND = -32601;

export class McpServerConnection {
  readonly config: McpServerConfig;
  state: McpServerState = 'failed';
  error?: string;
  protocolVersion?: string;
  serverInfo?: { name: string; version?: string };

  private readonly events?: EventStream;
  private readonly tenantId?: string;
  private transport?: McpTransport;
  private toolList: McpToolDef[] = [];
  private closed = false;

  constructor(config: McpServerConfig, events?: EventStream, tenantId?: string) {
    this.config = config;
    this.events = events;
    if (tenantId !== undefined) this.tenantId = tenantId;
  }

  get tools(): McpToolDef[] {
    return this.toolList;
  }

  get connectTimeoutMs(): number {
    return this.config.connectTimeoutMs ?? 10000;
  }

  get toolTimeoutMs(): number {
    return this.config.toolTimeoutMs ?? 60000;
  }

  /** 建连 + 握手 + 拉工具列表；失败只记录状态，不抛出 */
  async connect(): Promise<void> {
    if (this.config.enabled === false) {
      this.state = 'disabled';
      this.error = undefined;
      return;
    }

    const transport = createTransport(this.config);
    this.transport = transport;
    transport.onClose((reason) => this.handlePassiveClose(reason));

    try {
      await transport.start();
      await this.handshake(transport);
      this.toolList = await this.listAllTools(transport);
      this.state = 'connected';
      this.error = undefined;
      this.publish('mcp.server.connected', {
        server: this.config.name,
        transport: this.config.transport,
        ...(this.protocolVersion !== undefined ? { protocolVersion: this.protocolVersion } : {}),
        ...(this.serverInfo !== undefined ? { serverInfo: this.serverInfo } : {}),
        toolCount: this.toolList.length,
      });
    } catch (error) {
      this.state = 'failed';
      this.error = formatError(error);
      this.publish('mcp.server.failed', {
        server: this.config.name,
        transport: this.config.transport,
        error: this.error,
      });
      await transport.close().catch(() => {});
    }
  }

  /** 调用工具；返回给模型的文本，失败抛出稳定错误 */
  async callTool(
    rawName: string,
    exposedName: string,
    args: unknown,
    signal: AbortSignal | undefined,
    runId: string,
  ): Promise<string> {
    const transport = this.transport;
    if (this.closed || this.state !== 'connected' || !transport) {
      const message = `MCP server "${this.config.name}" is not connected`;
      this.publishToolFailed(rawName, exposedName, message, runId, undefined);
      throw new Error(message);
    }

    const startedAt = Date.now();
    try {
      const result = await transport.request(
        'tools/call',
        { name: rawName, arguments: args },
        { timeoutMs: this.toolTimeoutMs, ...(signal !== undefined ? { signal } : {}) },
      );
      const text = renderToolResult(result);
      if (isRecord(result) && result.isError === true) {
        this.publishToolFailed(rawName, exposedName, undefined, runId, {
          duration: Date.now() - startedAt,
          isError: true,
        });
        return text;
      }
      this.publish(
        'mcp.tool.called',
        {
          server: this.config.name,
          tool: rawName,
          exposedTool: exposedName,
          duration_ms: Date.now() - startedAt,
        },
        runId,
      );
      return text;
    } catch (error) {
      const duration = Date.now() - startedAt;
      const message = this.toolErrorMessage(error);
      this.publishToolFailed(rawName, exposedName, message, runId, { duration });
      if (error instanceof McpTransportError && error.kind === 'timeout') {
        throw new Error(
          `MCP tool "${this.config.name}/${rawName}" timed out after ${this.toolTimeoutMs}ms`,
        );
      }
      if (error instanceof McpTransportError && error.kind === 'aborted') {
        throw new Error(`MCP tool "${this.config.name}/${rawName}" aborted`);
      }
      throw new Error(`MCP tool "${this.config.name}/${rawName}" failed: ${message}`);
    }
  }

  /** 关闭连接；幂等。关闭后工具调用返回 not connected */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const transport = this.transport;
    this.transport = undefined;
    await transport?.close().catch(() => {});
  }

  private async handshake(transport: McpTransport): Promise<void> {
    const result = await transport.request(
      'initialize',
      {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'vessel-mcp-client', version: '0.3.0' },
      },
      { timeoutMs: this.connectTimeoutMs },
    );

    if (!isRecord(result)) {
      throw new McpTransportError(
        'protocol',
        `MCP server "${this.config.name}" returned an invalid initialize result`,
      );
    }
    if (typeof result.protocolVersion !== 'string' || result.protocolVersion === '') {
      throw new McpTransportError(
        'protocol',
        `MCP server "${this.config.name}" did not return a protocolVersion`,
      );
    }
    this.protocolVersion = result.protocolVersion;
    if (!KNOWN_PROTOCOL_VERSIONS.has(result.protocolVersion)) {
      console.warn(
        `MCP server "${this.config.name}" negotiated unsupported protocol version "${result.protocolVersion}"; continuing`,
      );
    }

    if (isRecord(result.serverInfo)) {
      const name = typeof result.serverInfo.name === 'string' ? result.serverInfo.name : '';
      this.serverInfo = {
        name,
        ...(typeof result.serverInfo.version === 'string'
          ? { version: result.serverInfo.version }
          : {}),
      };
    }

    await transport.notify('notifications/initialized');
  }

  private async listAllTools(transport: McpTransport): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      let result: unknown;
      try {
        result = await transport.request('tools/list', cursor === undefined ? {} : { cursor }, {
          timeoutMs: this.connectTimeoutMs,
        });
      } catch (error) {
        if (error instanceof JsonRpcError && error.code === METHOD_NOT_FOUND) {
          return tools;
        }
        throw error;
      }

      if (!isRecord(result)) {
        throw new McpTransportError(
          'protocol',
          `MCP server "${this.config.name}" returned an invalid tools/list result`,
        );
      }
      const rawTools = result.tools;
      if (rawTools !== undefined && !Array.isArray(rawTools)) {
        throw new McpTransportError(
          'protocol',
          `MCP server "${this.config.name}" returned a non-array tools field`,
        );
      }
      for (const item of rawTools ?? []) {
        if (!isRecord(item)) continue;
        const name = typeof item.name === 'string' ? item.name : '';
        if (name === '') {
          console.warn(`MCP server "${this.config.name}" returned a tool without a name; skipping`);
          continue;
        }
        if (seen.has(name)) continue;
        seen.add(name);
        tools.push({
          name,
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
          ...(isRecord(item.inputSchema) ? { inputSchema: item.inputSchema } : {}),
        });
      }

      const next = result.nextCursor;
      if (typeof next !== 'string' || next === '') break;
      if (next === cursor) {
        console.warn(
          `MCP server "${this.config.name}" returned a repeating tools cursor; stopping`,
        );
        break;
      }
      cursor = next;
      if (page === MAX_TOOL_PAGES - 1) {
        console.warn(
          `MCP server "${this.config.name}" exceeded ${MAX_TOOL_PAGES} tool pages; stopping`,
        );
      }
    }

    return tools;
  }

  private handlePassiveClose(reason: string): void {
    if (this.closed) return;
    if (this.state === 'connected') {
      this.state = 'failed';
      this.error = reason;
      this.publish('mcp.server.disconnected', { server: this.config.name, reason });
    }
  }

  private toolErrorMessage(error: unknown): string {
    if (error instanceof McpTransportError) return error.message;
    if (error instanceof JsonRpcError) return error.message;
    return formatError(error);
  }

  private publishToolFailed(
    rawName: string,
    exposedName: string,
    error: string | undefined,
    runId: string,
    extra?: { duration?: number; isError?: boolean },
  ): void {
    this.publish(
      'mcp.tool.failed',
      {
        server: this.config.name,
        tool: rawName,
        exposedTool: exposedName,
        ...(error !== undefined ? { error } : {}),
        ...(extra?.isError !== undefined ? { isError: extra.isError } : {}),
        ...(extra?.duration !== undefined ? { duration_ms: extra.duration } : {}),
      },
      runId,
    );
  }

  private publish(type: string, data: Record<string, unknown>, runId?: string): void {
    this.events?.publish({
      type,
      run_id: runId ?? `mcp:${this.config.name}`,
      data,
      ts: Date.now(),
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    });
  }
}

/** MCP tools/call 结果 → 模型可读文本 */
function renderToolResult(result: unknown): string {
  if (!isRecord(result)) return '';
  const content = (result as McpToolResult).content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!isRecord(part)) {
        parts.push(JSON.stringify(part));
        continue;
      }
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text);
      } else {
        parts.push(JSON.stringify(part));
      }
    }
    const joined = parts.join('\n');
    if (joined !== '') return joined;
  }
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return '';
}
