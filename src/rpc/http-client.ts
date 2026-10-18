/**
 * HttpRpcClient（0.5 E16 / PLAN §6.2、§6.4）
 *
 * - POST `{baseUrl}/v1/rpc`，Bearer token；
 * - §6.2 HTTP 状态 → RpcErrorCode 映射；
 * - WS 订阅只处理事件帧，断线不自动重连；
 * - token 永不打印。
 *
 * @module vessel/rpc
 */

import { isLoopbackHostname } from '../../packages/config/src/index';
import {
  type RpcClient,
  RpcClientError,
  type RpcEventNotification,
  type RpcRequest,
  unwrapRpcResponse,
} from './types';

/** 最小 WebSocket 形状（便于测试注入） */
export interface WebSocketMessageEvent {
  data: unknown;
}

export interface WebSocketLike {
  addEventListener(type: 'message', listener: (event: WebSocketMessageEvent) => void): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  close(): void;
}

/** HttpRpcClient 选项 */
export interface HttpRpcClientOptions {
  /** 如 http://127.0.0.1:8642 */
  baseUrl: string;
  /** gateway token；空串表示不发送 Authorization */
  token: string;
  fetch?: typeof fetch;
  /** 默认 true；false 时 subscribe 为 no-op */
  subscribe?: boolean;
  /** 测试注入 */
  webSocket?: (url: string) => WebSocketLike;
}

/** 带 close 的客户端 */
export type HttpRpcClient = RpcClient & { close(): Promise<void> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只接受本机回环 gateway（F5 跨机器远程不是 0.5 目标） */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function statusToCode(status: number): RpcClientError['code'] {
  switch (status) {
    case 400:
    case 413:
      return 'invalid_params';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    default:
      return 'internal';
  }
}

/** 从错误响应体提取 message / details（不包含 token） */
function extractErrorBody(body: unknown): { message?: string; details?: unknown } {
  if (!isRecord(body)) return {};
  if (isRecord(body.error)) {
    return {
      ...(typeof body.error.message === 'string' ? { message: body.error.message } : {}),
      ...(body.error.details !== undefined ? { details: body.error.details } : {}),
    };
  }
  return typeof body.message === 'string' ? { message: body.message } : {};
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toWsUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = `${pathname}/ws`;
  if (token !== '') url.searchParams.set('token', token);
  return url.toString();
}

function parseNotification(data: unknown): RpcEventNotification | undefined {
  const text =
    typeof data === 'string'
      ? data
      : typeof (data as { toString?: unknown })?.toString === 'function'
        ? String(data)
        : undefined;
  if (text === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (isRecord(parsed) && parsed.method === 'events.event') {
    return { method: 'events.event', params: parsed.params };
  }
  // gateway 也可能直接推 RunEvent
  if (isRecord(parsed) && typeof parsed.type === 'string' && typeof parsed.run_id === 'string') {
    return { method: 'events.event', params: parsed };
  }
  return undefined;
}

/** 创建 HTTP RPC 客户端；baseUrl 必须是本机回环 */
export function createHttpRpcClient(options: HttpRpcClientOptions): HttpRpcClient {
  if (!isLoopbackBaseUrl(options.baseUrl)) {
    throw new RpcClientError(
      'invalid_params',
      '--connect only supports a loopback gateway URL (for example http://127.0.0.1:8642)',
    );
  }

  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const rpcUrl = `${baseUrl}/v1/rpc`;
  const subscribeEnabled = options.subscribe !== false;
  const wsFactory =
    options.webSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);

  const handlers = new Set<(notification: RpcEventNotification) => void>();
  let socket: WebSocketLike | undefined;

  function connect(): void {
    if (socket || !subscribeEnabled) return;
    const current = wsFactory(toWsUrl(baseUrl, options.token));
    socket = current;
    current.addEventListener('message', (event) => {
      const notification = parseNotification(event.data);
      if (!notification) return;
      for (const handler of handlers) {
        try {
          handler(notification);
        } catch {
          // 订阅者异常不影响其它订阅者
        }
      }
    });
    current.addEventListener('close', () => {
      if (socket === current) socket = undefined;
    });
    current.addEventListener('error', () => {
      // 0.5 不自动重连
    });
  }

  return {
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      const request: RpcRequest = {
        v: 1,
        id: crypto.randomUUID(),
        method,
        ...(params !== undefined ? { params } : {}),
      };

      let response: Response;
      try {
        response = await fetchImpl(rpcUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(options.token !== '' ? { Authorization: `Bearer ${options.token}` } : {}),
          },
          body: JSON.stringify(request),
        });
      } catch (error) {
        throw new RpcClientError(
          'internal',
          error instanceof Error ? error.message : String(error),
        );
      }

      const body = await readJson(response);

      if (response.status !== 200) {
        const extracted = extractErrorBody(body);
        const code = statusToCode(response.status);
        throw new RpcClientError(
          code,
          extracted.message ?? `RPC request failed with HTTP ${response.status}`,
          {
            ...(response.status === 413
              ? { details: { status: 413 } }
              : extracted.details !== undefined
                ? { details: extracted.details }
                : {}),
            httpStatus: response.status,
          },
        );
      }

      try {
        return unwrapRpcResponse<T>(body, request.id);
      } catch (error) {
        if (error instanceof RpcClientError) {
          throw new RpcClientError(error.code, error.message, {
            ...(error.details !== undefined ? { details: error.details } : {}),
            httpStatus: response.status,
          });
        }
        throw error;
      }
    },

    subscribe(handler: (notification: RpcEventNotification) => void): () => void {
      if (!subscribeEnabled) return () => {};
      handlers.add(handler);
      connect();
      return () => {
        handlers.delete(handler);
      };
    },

    async close(): Promise<void> {
      handlers.clear();
      if (socket) {
        const current = socket;
        socket = undefined;
        try {
          current.close();
        } catch {
          // best-effort
        }
      }
    },
  };
}
