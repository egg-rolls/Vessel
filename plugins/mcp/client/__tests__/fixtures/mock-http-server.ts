/**
 * 本地 mock MCP Streamable HTTP server（测试 fixture）。
 *
 * 绑定 127.0.0.1 的临时端口，不访问外网。
 * 选项：
 * - mode: 'json' | 'sse'        响应形态
 * - requireSession              校验 Mcp-Session-Id
 * - expireAfterRequests         超过该 POST 次数后返回 404（模拟会话失效）
 * - slowMs                      slow 工具延迟
 */

import { callMockTool, isMockToolName, MOCK_TOOLS, SLOW_TOOL } from './mock-tools.js';

export interface MockHttpServerOptions {
  mode?: 'json' | 'sse';
  requireSession?: boolean;
  expireAfterRequests?: number;
  slowMs?: number;
}

export interface MockHttpRequestRecord {
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockHttpServer {
  url: string;
  requests: MockHttpRequestRecord[];
  close(): void;
}

interface IncomingMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorResponse(id: number | string, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function startMockHttpServer(options: MockHttpServerOptions = {}): MockHttpServer {
  const mode = options.mode ?? 'json';
  const slowMs = options.slowMs ?? 500;
  const requests: MockHttpRequestRecord[] = [];
  let sessionCounter = 0;
  let sessionId: string | undefined;
  let posts = 0;

  async function handleMessage(message: IncomingMessage): Promise<unknown> {
    const method = message.method;
    if (method === undefined) return undefined;

    if (method === 'initialize') {
      sessionId = `sess-${++sessionCounter}`;
      const requested = message.params?.protocolVersion;
      return {
        jsonrpc: '2.0',
        id: message.id ?? 0,
        result: {
          protocolVersion: typeof requested === 'string' ? requested : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-http', version: '0.0.0' },
        },
      };
    }

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return undefined;
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: message.id ?? 0,
        result: { tools: MOCK_TOOLS },
      };
    }

    if (method === 'tools/call') {
      const id = message.id;
      if (id === undefined) return undefined;
      const name = message.params?.name;
      if (typeof name !== 'string') {
        return errorResponse(id, -32602, 'tools/call requires a tool name');
      }
      if (!isMockToolName(name)) {
        return errorResponse(id, -32602, `unknown tool: ${name}`);
      }
      if (name === SLOW_TOOL) {
        await sleep(slowMs);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'slow-done' }] },
        };
      }
      const result = callMockTool(name, message.params?.arguments);
      return result === undefined ? undefined : { jsonrpc: '2.0', id, result };
    }

    if (message.id !== undefined) {
      return errorResponse(message.id, -32601, `unknown method: ${method}`);
    }
    return undefined;
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/mcp') return new Response('not found', { status: 404 });
      if (request.method === 'DELETE') {
        sessionId = undefined;
        return new Response(null, { status: 204 });
      }
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405 });
      }

      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      const text = await request.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return new Response(JSON.stringify(errorResponse(0, -32700, 'parse error')), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      requests.push({ method: request.method, headers, body });
      posts += 1;

      const messages = (Array.isArray(body) ? body : [body]) as IncomingMessage[];
      const isInitialize = messages.some((message) => message?.method === 'initialize');

      if (!isInitialize && sessionId !== undefined) {
        if (options.requireSession === true && headers['mcp-session-id'] !== sessionId) {
          return new Response('session not found', { status: 404 });
        }
        if (options.expireAfterRequests !== undefined && posts > options.expireAfterRequests) {
          return new Response('session expired', { status: 404 });
        }
      }

      const responses: unknown[] = [];
      for (const message of messages) {
        const response = await handleMessage(message);
        if (response !== undefined) responses.push(response);
      }

      const sessionHeaders: Record<string, string> = sessionId
        ? { 'mcp-session-id': sessionId }
        : {};

      if (responses.length === 0) {
        return new Response(null, { status: 202, headers: sessionHeaders });
      }

      if (mode === 'sse') {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(': mock stream\n\n'));
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'notifications/message',
                  params: { level: 'info', data: 'ignored' },
                })}\n\n`,
              ),
            );
            for (const response of responses) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(response)}\n\n`));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { ...sessionHeaders, 'content-type': 'text/event-stream' },
        });
      }

      const payload = responses.length === 1 ? responses[0] : responses;
      return new Response(JSON.stringify(payload), {
        headers: { ...sessionHeaders, 'content-type': 'application/json' },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    requests,
    close() {
      void server.stop(true);
    },
  };
}
