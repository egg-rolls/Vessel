/**
 * 单个 MCP server 的连接与状态机。
 *
 * 负责 initialize 握手、tools/list 分页、tools/call、事件发布与被动断开处理。
 * 工具注册由 plugin.ts 统一处理（需要检查 PluginHost 冲突）。
 */

import type { EventStream } from '@vessel-agent/core';
import { formatError, isRecord, JsonRpcError, McpTransportError } from './json-rpc.js';
import { warnMcp } from './logging.js';
import { createTransport } from './transport.js';
import type {
  McpPromptDef,
  McpResourceDef,
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
  private resourceList: McpResourceDef[] = [];
  private promptList: McpPromptDef[] = [];
  private capabilities: Record<string, unknown> = {};
  private closed = false;

  constructor(config: McpServerConfig, events?: EventStream, tenantId?: string) {
    this.config = config;
    this.events = events;
    if (tenantId !== undefined) this.tenantId = tenantId;
  }

  get tools(): McpToolDef[] {
    return this.toolList;
  }

  get resources(): McpResourceDef[] {
    return this.resourceList;
  }

  get prompts(): McpPromptDef[] {
    return this.promptList;
  }

  /** initialize 协商出的 resources 能力 */
  get supportsResources(): boolean {
    return isRecord(this.capabilities.resources);
  }

  /** initialize 协商出的 prompts 能力 */
  get supportsPrompts(): boolean {
    return isRecord(this.capabilities.prompts);
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
      if (this.supportsResources) {
        this.resourceList = await this.listAllResources(transport).catch((error: unknown) => {
          this.warn('MCP resources/list failed', {
            capability: 'resources',
            error: formatError(error),
          });
          return [];
        });
      }
      if (this.supportsPrompts) {
        this.promptList = await this.listAllPrompts(transport).catch((error: unknown) => {
          this.warn('MCP prompts/list failed', {
            capability: 'prompts',
            error: formatError(error),
          });
          return [];
        });
      }
      this.state = 'connected';
      this.error = undefined;
      this.publish('mcp.server.connected', {
        server: this.config.name,
        transport: this.config.transport,
        ...(this.protocolVersion !== undefined ? { protocolVersion: this.protocolVersion } : {}),
        ...(this.serverInfo !== undefined ? { serverInfo: this.serverInfo } : {}),
        toolCount: this.toolList.length,
        ...(this.supportsResources ? { resourceCount: this.resourceList.length } : {}),
        ...(this.supportsPrompts ? { promptCount: this.promptList.length } : {}),
      });
    } catch (error) {
      this.state = 'failed';
      this.error = formatError(error);
      this.warn('MCP server connection failed', { error: this.error });
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

  /** 读取一个资源；结果渲染为模型可读文本 */
  async readResource(uri: string, signal?: AbortSignal): Promise<string> {
    const transport = this.transport;
    if (this.closed || this.state !== 'connected' || !transport) {
      throw new Error(`MCP server "${this.config.name}" is not connected`);
    }
    if (typeof uri !== 'string' || uri === '') {
      throw new Error('MCP resources/read requires a non-empty uri');
    }

    const startedAt = Date.now();
    try {
      const result = await transport.request(
        'resources/read',
        { uri },
        { timeoutMs: this.toolTimeoutMs, ...(signal !== undefined ? { signal } : {}) },
      );
      const text = renderResourceResult(result);
      this.publish('mcp.resource.read', {
        server: this.config.name,
        uri,
        duration_ms: Date.now() - startedAt,
      });
      return text;
    } catch (error) {
      if (error instanceof McpTransportError && error.kind === 'timeout') {
        throw new Error(`MCP resource "${uri}" timed out after ${this.toolTimeoutMs}ms`);
      }
      if (error instanceof McpTransportError && error.kind === 'aborted') {
        throw new Error(`MCP resource "${uri}" aborted`);
      }
      throw new Error(`MCP resource "${uri}" failed: ${this.toolErrorMessage(error)}`);
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
    if (isRecord(result.capabilities)) this.capabilities = result.capabilities;
    if (!KNOWN_PROTOCOL_VERSIONS.has(result.protocolVersion)) {
      this.warn('MCP server negotiated an unsupported protocol version; continuing', {
        protocolVersion: result.protocolVersion,
      });
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
          this.warn('MCP server returned a tool without a name; skipping', {
            capability: 'tools',
          });
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
        this.warn('MCP server returned a repeating tools cursor; stopping', {
          capability: 'tools',
        });
        break;
      }
      cursor = next;
      if (page === MAX_TOOL_PAGES - 1) {
        this.warn('MCP server exceeded the tool page limit; stopping', {
          capability: 'tools',
          max_pages: MAX_TOOL_PAGES,
        });
      }
    }

    return tools;
  }

  private async listAllResources(transport: McpTransport): Promise<McpResourceDef[]> {
    const items = await this.listPages(transport, 'resources/list', 'resources');
    const seen = new Set<string>();
    const resources: McpResourceDef[] = [];
    for (const item of items) {
      const uri = typeof item.uri === 'string' ? item.uri : '';
      if (uri === '' || seen.has(uri)) continue;
      seen.add(uri);
      resources.push({
        uri,
        ...(typeof item.name === 'string' ? { name: item.name } : {}),
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
      });
    }
    return resources;
  }

  private async listAllPrompts(transport: McpTransport): Promise<McpPromptDef[]> {
    const items = await this.listPages(transport, 'prompts/list', 'prompts');
    const seen = new Set<string>();
    const prompts: McpPromptDef[] = [];
    for (const item of items) {
      const name = typeof item.name === 'string' ? item.name : '';
      if (name === '' || seen.has(name)) continue;
      seen.add(name);
      const args: McpPromptDef['arguments'] = [];
      if (Array.isArray(item.arguments)) {
        for (const arg of item.arguments) {
          if (!isRecord(arg) || typeof arg.name !== 'string' || arg.name === '') continue;
          args.push({
            name: arg.name,
            ...(typeof arg.description === 'string' ? { description: arg.description } : {}),
            ...(typeof arg.required === 'boolean' ? { required: arg.required } : {}),
          });
        }
      }
      prompts.push({
        name,
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        ...(args.length > 0 ? { arguments: args } : {}),
      });
    }
    return prompts;
  }

  /** 通用分页：METHOD_NOT_FOUND 视为空能力 */
  private async listPages(
    transport: McpTransport,
    method: string,
    field: string,
  ): Promise<Array<Record<string, unknown>>> {
    const items: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      let result: unknown;
      try {
        result = await transport.request(method, cursor === undefined ? {} : { cursor }, {
          timeoutMs: this.connectTimeoutMs,
        });
      } catch (error) {
        if (error instanceof JsonRpcError && error.code === METHOD_NOT_FOUND) return items;
        throw error;
      }

      if (!isRecord(result)) {
        throw new McpTransportError(
          'protocol',
          `MCP server "${this.config.name}" returned an invalid ${method} result`,
        );
      }
      const raw = result[field];
      if (raw !== undefined && !Array.isArray(raw)) {
        throw new McpTransportError(
          'protocol',
          `MCP server "${this.config.name}" returned a non-array ${field} field`,
        );
      }
      for (const item of raw ?? []) {
        if (isRecord(item)) items.push(item);
      }

      const next = result.nextCursor;
      if (typeof next !== 'string' || next === '') break;
      if (next === cursor) break;
      cursor = next;
    }

    return items;
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

  /** 结构化告警：stderr 总是写；有事件总线时同时发 mcp.warning */
  private warn(message: string, fields: Record<string, unknown> = {}): void {
    warnMcp(this.config.name, message, fields);
    this.publish('mcp.warning', {
      server: this.config.name,
      transport: this.config.transport,
      warning: message,
      ...fields,
    });
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

/** MCP resources/read 结果 → 模型可读文本 */
function renderResourceResult(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.contents)) return '';
  const parts: string[] = [];
  for (const item of result.contents) {
    if (!isRecord(item)) {
      parts.push(JSON.stringify(item));
      continue;
    }
    if (typeof item.text === 'string') {
      parts.push(item.text);
    } else if (typeof item.blob === 'string') {
      const mime = typeof item.mimeType === 'string' ? item.mimeType : 'application/octet-stream';
      parts.push(`[base64 ${mime}] ${item.blob}`);
    } else {
      parts.push(JSON.stringify(item));
    }
  }
  return parts.join('\n');
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
