/**
 * MCP Streamable HTTP 传输。
 *
 * 冻结最小范围（Addendum A §7）：POST JSON-RPC；Accept 同时声明 JSON 与 SSE；
 * 响应支持纯 JSON 与 SSE 帧解析；不做 GET 长连接、session 恢复、OAuth。
 */

import type {
  JsonRpcNotificationMessage,
  JsonRpcRequestMessage,
  JsonRpcResponseMessage,
} from './json-rpc.js';
import {
  formatError,
  isRecord,
  isResponse,
  isServerRequest,
  JsonRpcError,
  McpTransportError,
  parseJsonRpcLine,
} from './json-rpc.js';
import { warnMcp } from './logging.js';
import type { McpServerConfig, McpTransport, RequestOptions } from './types.js';

/** DELETE 终止会话的预算 */
const CLOSE_TIMEOUT_MS = 3000;

interface SseMatch {
  matched: boolean;
  result?: unknown;
}

export class HttpTransport implements McpTransport {
  readonly kind = 'http' as const;

  private readonly config: McpServerConfig;
  private readonly url: string;
  private sessionId?: string;
  private protocolVersion?: string;
  private nextId = 1;
  private closed = false;
  private closeHandler?: (reason: string) => void;
  private closePromise?: Promise<void>;
  private readonly active = new Set<AbortController>();

  constructor(config: McpServerConfig) {
    this.config = config;
    this.url = config.url ?? '';
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new McpTransportError('closed', this.serverLabel('transport is closed'));
    }
    let parsed: URL;
    try {
      parsed = new URL(this.url);
    } catch {
      throw new McpTransportError('protocol', this.serverLabel(`invalid url "${this.url}"`));
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new McpTransportError(
        'protocol',
        this.serverLabel(`url must use http or https: "${this.url}"`),
      );
    }
  }

  request(method: string, params: unknown, opts: RequestOptions): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcRequestMessage = { jsonrpc: '2.0', id, method, params };
    return this.post(message, method, opts, id);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const message: JsonRpcNotificationMessage = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    await this.post(message, method, { timeoutMs: this.connectTimeoutMs }, undefined);
  }

  close(): Promise<void> {
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  private get connectTimeoutMs(): number {
    return this.config.connectTimeoutMs ?? 10000;
  }

  private async doClose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();

    if (!this.sessionId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLOSE_TIMEOUT_MS);
    try {
      await fetch(this.url, {
        method: 'DELETE',
        headers: this.headers(),
        signal: controller.signal,
      });
    } catch {
      // 尽力而为
    } finally {
      clearTimeout(timer);
    }
  }

  private async post(
    message: JsonRpcRequestMessage | JsonRpcNotificationMessage,
    method: string,
    opts: RequestOptions,
    id: number | undefined,
  ): Promise<unknown> {
    if (this.closed) {
      throw new McpTransportError('closed', this.serverLabel('transport is closed'));
    }
    if (opts.signal?.aborted) {
      throw new McpTransportError('aborted', `MCP request "${method}" aborted`);
    }

    const controller = new AbortController();
    this.active.add(controller);
    let abortReason: 'timeout' | 'aborted' | undefined;
    const onAbort = () => {
      abortReason = 'aborted';
      controller.abort();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        abortReason = 'timeout';
        controller.abort();
      }, opts.timeoutMs);
    }

    try {
      let response: Response;
      try {
        response = await fetch(this.url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(message),
          signal: controller.signal,
        });
      } catch (error) {
        if (this.closed) {
          throw new McpTransportError('closed', this.serverLabel('connection closed'));
        }
        if (abortReason === 'aborted') {
          throw new McpTransportError('aborted', `MCP request "${method}" aborted`);
        }
        if (abortReason === 'timeout') {
          throw new McpTransportError(
            'timeout',
            `MCP request "${method}" timed out after ${opts.timeoutMs}ms`,
          );
        }
        const reason = this.serverLabel(`HTTP request failed: ${formatError(error)}`);
        this.failClosed(reason);
        throw new McpTransportError('io', reason);
      }

      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;

      if (!response.ok) this.raiseHttpError(response, method);

      if (id === undefined) {
        try {
          await response.body?.cancel();
        } catch {
          // 已关闭
        }
        return undefined;
      }

      if (response.status === 202 || response.status === 204) {
        throw new McpTransportError(
          'protocol',
          this.serverLabel(`returned no response for "${method}" (HTTP ${response.status})`),
        );
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (contentType.includes('text/event-stream')) {
        return await this.readSse(response, id, method);
      }
      if (contentType.includes('application/json')) {
        let body: unknown;
        try {
          body = (await response.json()) as unknown;
        } catch (error) {
          throw new McpTransportError(
            'protocol',
            this.serverLabel(`returned invalid JSON: ${formatError(error)}`),
          );
        }
        const result = this.pickResponse(body, id, method);
        this.captureInitialize(method, result);
        return result;
      }
      throw new McpTransportError(
        'protocol',
        this.serverLabel(`returned unsupported content-type "${contentType}"`),
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      this.active.delete(controller);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.config.headers ?? {})) {
      headers[key.toLowerCase()] = value;
    }
    headers['content-type'] = 'application/json';
    headers.accept = 'application/json, text/event-stream';
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    return headers;
  }

  private raiseHttpError(response: Response, method: string): never {
    const status = response.status;
    if (status === 404 && this.sessionId !== undefined) {
      const reason = this.serverLabel('session expired (HTTP 404)');
      this.failClosed(reason);
      throw new McpTransportError('closed', reason);
    }
    if (status === 401 || status === 403) {
      throw new McpTransportError('io', this.serverLabel(`authentication failed (HTTP ${status})`));
    }
    const suffix = response.statusText ? ` ${response.statusText}` : '';
    throw new McpTransportError(
      'io',
      this.serverLabel(`returned HTTP ${status}${suffix} for "${method}"`),
    );
  }

  private failClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.(reason);
  }

  private pickResponse(body: unknown, id: number, method: string): unknown {
    const messages = Array.isArray(body) ? body : [body];
    for (const message of messages) {
      if (!isResponse(message)) continue;
      if (message.id !== id) continue;
      return this.unwrap(message, method);
    }
    throw new McpTransportError(
      'protocol',
      this.serverLabel(`returned no JSON-RPC response for "${method}"`),
    );
  }

  private unwrap(message: JsonRpcResponseMessage, method: string): unknown {
    if (message.error) throw new JsonRpcError(method, message.error);
    return message.result;
  }

  private captureInitialize(method: string, result: unknown): void {
    if (method !== 'initialize' || !isRecord(result)) return;
    if (typeof result.protocolVersion === 'string') {
      this.protocolVersion = result.protocolVersion;
    }
  }

  private async readSse(response: Response, id: number, method: string): Promise<unknown> {
    const body = response.body;
    if (!body) {
      throw new McpTransportError('protocol', this.serverLabel('returned an empty SSE body'));
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines: string[] = [];

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let lineEnd = buffer.indexOf('\n');
        while (lineEnd >= 0) {
          let line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);

          if (line === '') {
            if (dataLines.length > 0) {
              const match = this.consumeSsePayload(dataLines.join('\n'), id, method);
              dataLines = [];
              if (match.matched) {
                try {
                  await reader.cancel();
                } catch {
                  // 已关闭
                }
                return match.result;
              }
            }
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          lineEnd = buffer.indexOf('\n');
        }
      }

      // 流结束时处理最后一个未以空行收尾的事件
      if (dataLines.length > 0) {
        const match = this.consumeSsePayload(dataLines.join('\n'), id, method);
        if (match.matched) return match.result;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // 已释放
      }
    }

    throw new McpTransportError(
      'protocol',
      this.serverLabel(`closed the SSE stream without a response to "${method}"`),
    );
  }

  private consumeSsePayload(payload: string, id: number, method: string): SseMatch {
    const parsed = parseJsonRpcLine(payload);
    if (parsed === undefined) return { matched: false };
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      if (isResponse(message) && message.id === id) {
        const result = this.unwrap(message, method);
        this.captureInitialize(method, result);
        return { matched: true, result };
      }
      if (isServerRequest(message)) {
        warnMcp(this.config.name, 'MCP server sent an unsupported request', {
          method: message.method,
        });
      }
    }
    return { matched: false };
  }

  private serverLabel(suffix: string): string {
    return `MCP server "${this.config.name}" ${suffix}`;
  }
}
