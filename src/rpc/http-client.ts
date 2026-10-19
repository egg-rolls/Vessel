/**
 * HttpRpcClient（0.5 E16 / 0.6 F5）
 *
 * - POST `{baseUrl}/v1/rpc`，Bearer token；
 * - 非回环必须 HTTPS + token（DECISION-014 §2.1）；
 * - 可选 CA 文件（PEM）透传给 Bun fetch / WebSocket；
 * - WS 首帧 `{kind:'auth',token,since}`（token 不进 URL）；
 * - 解析 gateway `{kind:'hello'|'event'|'gap'|'ping'}`；
 * - `ping` → `pong`；指数退避重连；`hello.latest_seq` 回退时重置 since。
 *
 * token 永不打印、永不进 URL。
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
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: WebSocketMessageEvent) => void): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  send(data: string): void;
  close(): void;
  readonly readyState?: number;
}

/** WebSocket 工厂（第二参数用于 wss 的自签/私有 CA） */
export type WebSocketFactory = (url: string, tls?: { ca: string }) => WebSocketLike;

/** 连接建立后由 gateway `hello` 提供的信息 */
export interface RpcHelloInfo {
  nodeId?: string;
  tenantId?: string;
  latestSeq?: number;
}

/** HttpRpcClient 选项 */
export interface HttpRpcClientOptions {
  /** 如 http://127.0.0.1:8642 或 https://gateway.example.com */
  baseUrl: string;
  /** gateway token；空串表示不发送 Authorization（仅回环匿名允许） */
  token: string;
  fetch?: typeof fetch;
  /** 默认 true；false 时 subscribe 为 no-op */
  subscribe?: boolean;
  /** 测试注入 */
  webSocket?: WebSocketFactory;
  /** CA 证书 PEM 内容（自签/私有 CA）；由调用方异步读文件后传入 */
  ca?: string;
  /** 单次 RPC 超时（默认 10000ms） */
  requestTimeoutMs?: number;
  /** WS 重连参数 */
  reconnect?: {
    /** 默认 1000ms */
    initialMs?: number;
    /** 默认 30000ms */
    maxMs?: number;
    /** 默认 10000ms；超时未收到 hello 视为连接失败 */
    helloTimeoutMs?: number;
  };
  /** `hello` 回调（展示/诊断；不包含 token） */
  onHello?: (info: RpcHelloInfo) => void;
}

/** 带 close 的客户端 */
export type HttpRpcClient = RpcClient & { close(): Promise<void> };

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只接受 http(s) 回环 gateway */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

/**
 * 归一化 `--connect`：接受 ws:// / wss://（转 http/https），
 * 以及误传的 `/ws`、`/v1/events` 路径。其余校验交给 assertConnectUrl。
 */
export function normalizeConnectUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.pathname === '/ws' || url.pathname === '/v1/events') url.pathname = '/';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return baseUrl;
  }
}

/**
 * 校验 `--connect` URL。非回环必须 HTTPS 且 token 非空；不回退明文。
 * 错误信息不包含 token。
 */
function assertConnectUrl(baseUrl: string, token: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new RpcClientError('invalid_params', '--connect requires an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RpcClientError('invalid_params', '--connect must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new RpcClientError('invalid_params', '--connect URL must not contain userinfo');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new RpcClientError('invalid_params', '--connect URL must not contain a path');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new RpcClientError(
      'invalid_params',
      '--connect URL must not contain query or hash (pass the token via --connect-token or env)',
    );
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (!loopback && url.protocol !== 'https:') {
    throw new RpcClientError(
      'invalid_params',
      'non-loopback --connect gateways require https (plaintext fallback is not supported)',
    );
  }
  if (!loopback && token === '') {
    throw new RpcClientError(
      'invalid_params',
      'non-loopback --connect requires a token (--connect-token, VESSEL_CONNECT_TOKEN, or config)',
    );
  }
  return url;
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
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = `${pathname}/ws`;
  return url.toString();
}

function textOf(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  const converter = (data as { toString?: unknown } | null | undefined)?.toString;
  return typeof converter === 'function' ? String(data) : undefined;
}

type GatewayFrame =
  | { kind: 'notification'; notification: RpcEventNotification }
  | { kind: 'hello'; nodeId?: string; tenantId?: string; latestSeq?: number }
  | { kind: 'event'; seq?: number; event: unknown }
  | { kind: 'gap'; toSeq?: number }
  | { kind: 'ping' };

/**
 * 解析一帧。兼容 0.5 的 `{method:'events.event'}` 与裸 RunEvent；
 * 0.6 gateway 帧形状见 DECISION-014 Edge #2。
 */
export function parseGatewayFrame(data: unknown): GatewayFrame | undefined {
  const text = textOf(data);
  if (text === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  if (parsed.method === 'events.event') {
    return {
      kind: 'notification',
      notification: { method: 'events.event', params: parsed.params },
    };
  }

  switch (parsed.kind) {
    case 'hello':
      return {
        kind: 'hello',
        ...(typeof parsed.node_id === 'string' ? { nodeId: parsed.node_id } : {}),
        ...(typeof parsed.tenant_id === 'string' ? { tenantId: parsed.tenant_id } : {}),
        ...(typeof parsed.latest_seq === 'number' ? { latestSeq: parsed.latest_seq } : {}),
      };
    case 'event':
      if (!isRecord(parsed.event)) return undefined;
      return {
        kind: 'event',
        ...(typeof parsed.seq === 'number' ? { seq: parsed.seq } : {}),
        event: parsed.event,
      };
    case 'gap':
      return {
        kind: 'gap',
        ...(typeof parsed.to_seq === 'number' ? { toSeq: parsed.to_seq } : {}),
      };
    case 'ping':
      return { kind: 'ping' };
    default:
      break;
  }

  // gateway 也可能直接推 RunEvent（0.5 兼容）
  if (typeof parsed.type === 'string' && typeof parsed.run_id === 'string') {
    return { kind: 'notification', notification: { method: 'events.event', params: parsed } };
  }
  return undefined;
}

/** 创建 HTTP RPC 客户端；非回环必须 HTTPS + token */
export function createHttpRpcClient(options: HttpRpcClientOptions): HttpRpcClient {
  const normalized = normalizeConnectUrl(options.baseUrl);
  assertConnectUrl(normalized, options.token);

  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = normalized.replace(/\/+$/, '');
  const rpcUrl = `${baseUrl}/v1/rpc`;
  const wsUrl = toWsUrl(baseUrl);
  const subscribeEnabled = options.subscribe !== false;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const initialMs = options.reconnect?.initialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
  const maxMs = options.reconnect?.maxMs ?? DEFAULT_RECONNECT_MAX_MS;
  const helloTimeoutMs = options.reconnect?.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const wsFactory: WebSocketFactory =
    options.webSocket ??
    ((url, tls) => new WebSocket(url, (tls ? { tls } : {}) as never) as unknown as WebSocketLike);

  const handlers = new Set<(notification: RpcEventNotification) => void>();
  let socket: WebSocketLike | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let lastSeq = 0;
  let disposed = false;

  function clearReconnectTimer(): void {
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  function clearHelloTimer(): void {
    if (helloTimer !== undefined) clearTimeout(helloTimer);
    helloTimer = undefined;
  }

  function emit(notification: RpcEventNotification): void {
    for (const handler of handlers) {
      try {
        handler(notification);
      } catch {
        // 订阅者异常不影响其它订阅者
      }
    }
  }

  function scheduleReconnect(immediate = false): void {
    if (disposed || !subscribeEnabled || handlers.size === 0) return;
    if (reconnectTimer !== undefined) return;
    const capped = Math.min(maxMs, initialMs * 2 ** Math.min(attempt, 16));
    const delay = immediate ? 0 : Math.round(capped * (0.8 + Math.random() * 0.4));
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    (reconnectTimer as { unref?: () => void }).unref?.();
  }

  function sendPong(current: WebSocketLike): void {
    try {
      current.send(JSON.stringify({ v: 1, kind: 'pong' }));
    } catch {
      // 连接已断开；close 事件会触发重连
    }
  }

  function dropSocket(current: WebSocketLike, immediate = false): void {
    if (socket !== current) return;
    socket = undefined;
    clearHelloTimer();
    try {
      current.close();
    } catch {
      // best-effort
    }
    scheduleReconnect(immediate);
  }

  function handleFrame(current: WebSocketLike, frame: GatewayFrame): void {
    if (socket !== current) return;
    switch (frame.kind) {
      case 'hello': {
        clearHelloTimer();
        attempt = 0;
        options.onHello?.({
          ...(frame.nodeId !== undefined ? { nodeId: frame.nodeId } : {}),
          ...(frame.tenantId !== undefined ? { tenantId: frame.tenantId } : {}),
          ...(frame.latestSeq !== undefined ? { latestSeq: frame.latestSeq } : {}),
        });
        // gateway 重启 / 缓冲区清空：seq 回退，重置从 0 重放。
        if (frame.latestSeq !== undefined && frame.latestSeq < lastSeq) {
          lastSeq = 0;
          dropSocket(current, true);
        }
        return;
      }
      case 'event':
        if (frame.seq !== undefined) lastSeq = Math.max(lastSeq, frame.seq);
        emit({ method: 'events.event', params: frame.event });
        return;
      case 'gap':
        if (frame.toSeq !== undefined) lastSeq = Math.max(lastSeq, frame.toSeq);
        // 历史缺失：以 to_seq 为新 since 重连，由 gateway 续放。
        dropSocket(current, true);
        return;
      case 'ping':
        sendPong(current);
        return;
      case 'notification':
        emit(frame.notification);
        return;
      default:
        return;
    }
  }

  function connect(): void {
    if (disposed || !subscribeEnabled || handlers.size === 0 || socket) return;

    let current: WebSocketLike;
    try {
      current = wsFactory(wsUrl, options.ca !== undefined ? { ca: options.ca } : undefined);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;

    current.addEventListener('open', () => {
      if (socket !== current) return;
      // 退避计数只在 hello 后重置；open 不代表对端可用。
      try {
        current.send(
          JSON.stringify({
            v: 1,
            kind: 'auth',
            token: options.token,
            ...(lastSeq > 0 ? { since: lastSeq } : {}),
          }),
        );
      } catch {
        dropSocket(current);
        return;
      }
      helloTimer = setTimeout(() => {
        helloTimer = undefined;
        if (socket === current) dropSocket(current);
      }, helloTimeoutMs);
      (helloTimer as { unref?: () => void }).unref?.();
    });

    current.addEventListener('message', (event) => {
      const frame = parseGatewayFrame(event.data);
      if (frame) handleFrame(current, frame);
    });

    current.addEventListener('close', () => {
      if (socket === current) {
        socket = undefined;
        clearHelloTimer();
        scheduleReconnect();
      }
    });

    current.addEventListener('error', () => {
      // 某些实现 error 后不一定 close；统一按断开处理。
      if (socket === current) dropSocket(current);
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

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

      let response: Response;
      try {
        const init: RequestInit & { tls?: { ca: string } } = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(options.token !== '' ? { Authorization: `Bearer ${options.token}` } : {}),
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        };
        if (options.ca !== undefined) init.tls = { ca: options.ca };
        response = await fetchImpl(rpcUrl, init as RequestInit);
      } catch (error) {
        if (controller.signal.aborted) {
          throw new RpcClientError('internal', `RPC request timed out after ${requestTimeoutMs}ms`);
        }
        throw new RpcClientError(
          'internal',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        clearTimeout(timer);
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
        if (handlers.size === 0 && !disposed) {
          clearReconnectTimer();
          const current = socket;
          socket = undefined;
          clearHelloTimer();
          if (current) {
            try {
              current.close();
            } catch {
              // best-effort
            }
          }
        }
      };
    },

    async close(): Promise<void> {
      disposed = true;
      handlers.clear();
      clearReconnectTimer();
      clearHelloTimer();
      const current = socket;
      socket = undefined;
      if (current) {
        try {
          current.close();
        } catch {
          // best-effort
        }
      }
    },
  };
}
