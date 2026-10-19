/**
 * RemoteTransport —— 跨节点 Transport 实现（0.6 F5 / DECISION-014 B1/B2/B4）
 *
 * - `kind:'remote'`，不依赖共享文件系统。
 * - `send`：`node:agent` 目标 → `POST /v1/team/messages`（Bearer + 可选 CA）。
 * - `request`：ext 的跨节点控制协议（team.spawn / team.inbox / team.status）。
 * - `peers`：静态 nodes + 心跳状态（见 node-registry）。
 * - B4：按节点订阅 `ws(s)://.../v1/events`，按 `(node_id, wire seq)` 去重后
 *   带 `node_id` 回调；断线指数退避重连，`since` 续放，seq 回退重置。
 *
 * 错误统一为 RemoteTransportError（稳定 code）；token 永不打印。
 *
 * @module vessel/remote-transport
 */

import type {
  AgentMessage,
  PeerInfo,
  RunEvent,
  Transport,
  TransportRequest,
  Unsubscribe,
} from '../packages/core/src/index';
import { fromWireMessage, toWireMessage } from '../packages/serve/src/index';
import { NodeRegistry, type NodeRegistryOptions, type ResolvedNode } from './node-registry';
import type { WebSocketFactory, WebSocketLike } from './rpc/index';

/** 远端传输错误码（覆盖 loopback 的稳定码 + team 控制面码） */
export type RemoteTransportErrorCode =
  | 'transport_closed'
  | 'peer_not_found'
  | 'peer_unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'unsupported_protocol'
  | 'invalid_request'
  | 'agent_not_found'
  | 'no_spawn'
  | 'inbox_overflow'
  | 'peer_error';

/** 稳定错误（message 不含 token） */
export class RemoteTransportError extends Error {
  constructor(
    readonly code: RemoteTransportErrorCode,
    message: string,
    readonly nodeId?: string,
  ) {
    super(message);
    this.name = 'RemoteTransportError';
  }
}

export interface RemoteTransportOptions {
  /** 本节点 id（唯一来源：host.node_id） */
  nodeId: string;
  registry: NodeRegistry;
  fetch?: typeof fetch;
  /** 单次 HTTP 超时（默认 10000ms） */
  requestTimeoutMs?: number;
  /**
   * B4 事件扇出回调；提供时才会订阅远端 `/v1/events`。
   * 事件已带 `node_id`（远端 origin）。
   */
  onEvent?: (event: RunEvent) => void;
  /** 测试注入 */
  webSocket?: WebSocketFactory;
  eventReconnect?: {
    /** 默认 1000ms */
    initialMs?: number;
    /** 默认 30000ms */
    maxMs?: number;
    /** 默认 10000ms */
    helloTimeoutMs?: number;
  };
}

export interface CreateRemoteTransportOptions extends Omit<RemoteTransportOptions, 'registry'> {
  nodes: Parameters<typeof NodeRegistry.create>[0];
  registryOptions?: NodeRegistryOptions;
}

type FetchInit = RequestInit & { tls?: { ca: string } };

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const MAX_SEEN = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `node:agent`（本机可省略 node）解析；`*` 返回 undefined（仅本机广播） */
function parseAddress(address: string): { nodeId?: string; agentId: string } | undefined {
  if (address === '*') return undefined;
  const index = address.indexOf(':');
  if (index < 0) return { agentId: address };
  const nodeId = address.slice(0, index);
  const agentId = address.slice(index + 1);
  if (nodeId === '' || agentId === '') return undefined;
  return { nodeId, agentId };
}

function textOf(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  const converter = (data as { toString?: unknown } | null | undefined)?.toString;
  return typeof converter === 'function' ? String(data) : undefined;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = isRecord(body.error) ? body.error : body;
  return typeof error.message === 'string' ? error.message : undefined;
}

function errorCode(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  return typeof body.error.code === 'string' ? body.error.code : undefined;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

interface EventState {
  socket?: WebSocketLike;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  helloTimer?: ReturnType<typeof setTimeout>;
  attempt: number;
  lastSeq: number;
}

/** 跨节点 Transport */
export class RemoteTransport implements Transport {
  readonly kind = 'remote' as const;
  readonly nodeId: string;

  private readonly registry: NodeRegistry;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly onEvent?: (event: RunEvent) => void;
  private readonly wsFactory: WebSocketFactory;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly helloTimeoutMs: number;
  private readonly handlers = new Set<(message: AgentMessage) => void | Promise<void>>();
  private readonly seenMessages = new Map<string, true>();
  private readonly seenEvents = new Map<string, true>();
  private readonly eventStates = new Map<string, EventState>();
  private closed = false;

  constructor(options: RemoteTransportOptions) {
    this.nodeId = options.nodeId;
    this.registry = options.registry;
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (options.onEvent) this.onEvent = options.onEvent;
    this.wsFactory =
      options.webSocket ??
      ((url, tls) => new WebSocket(url, (tls ? { tls } : {}) as never) as unknown as WebSocketLike);
    this.reconnectInitialMs = options.eventReconnect?.initialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = options.eventReconnect?.maxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.helloTimeoutMs = options.eventReconnect?.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  }

  /** 创建 registry + transport，并启动心跳与事件订阅 */
  static async create(options: CreateRemoteTransportOptions): Promise<RemoteTransport> {
    const registry = await NodeRegistry.create(options.nodes, options.registryOptions ?? {});
    const transport = new RemoteTransport({
      nodeId: options.nodeId,
      registry,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.webSocket ? { webSocket: options.webSocket } : {}),
      ...(options.eventReconnect ? { eventReconnect: options.eventReconnect } : {}),
    });
    transport.start();
    return transport;
  }

  /** 启动心跳与远端事件订阅（重复调用无副作用） */
  start(): void {
    if (this.closed) return;
    this.registry.start();
    if (!this.onEvent) return;
    for (const id of this.registry.ids()) {
      if (id !== this.nodeId) this.connectEvents(id);
    }
  }

  peers(): Promise<PeerInfo[]> {
    return Promise.resolve(this.registry.peers());
  }

  receive(handler: (message: AgentMessage) => void | Promise<void>): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** gateway 入站入口：去重后投递本地 handler；返回 false 表示重复 */
  async deliver(message: AgentMessage): Promise<boolean> {
    if (this.closed) {
      throw new RemoteTransportError('transport_closed', 'Transport is closed');
    }
    if (this.seenMessages.has(message.id)) return false;
    this.remember(this.seenMessages, message.id);
    await this.deliverLocal(message);
    return true;
  }

  /** 发送消息；本机目标直投，远端 POST */
  async send(message: AgentMessage): Promise<void> {
    if (this.closed) {
      throw new RemoteTransportError('transport_closed', 'Transport is closed');
    }
    let normalized: AgentMessage;
    try {
      normalized = fromWireMessage(toWireMessage(message));
    } catch (error) {
      throw new RemoteTransportError(
        'invalid_request',
        error instanceof Error ? error.message : String(error),
      );
    }

    const target = parseAddress(normalized.to);
    if (target?.nodeId === undefined || target.nodeId === this.nodeId) {
      await this.deliverLocal(normalized);
      return;
    }

    const node = this.registry.get(target.nodeId);
    if (!node) {
      throw new RemoteTransportError(
        'peer_not_found',
        `Unknown remote node: ${target.nodeId}`,
        target.nodeId,
      );
    }

    try {
      await this.fetchJson(node, '/v1/team/messages', {
        method: 'POST',
        body: JSON.stringify({
          protocol: 1,
          node_id: this.nodeId,
          message: toWireMessage(normalized),
        }),
      });
      this.registry.markHealthy(node.id);
    } catch (error) {
      this.registry.markUnreachable(node.id);
      throw error;
    }
  }

  /**
   * ext 的跨节点控制协议。
   * 参数由 ext 以 camelCase 传入，这里映射为 gateway wire（snake_case / path / query）。
   */
  async request<T = unknown>(nodeId: string, request: TransportRequest): Promise<T> {
    if (this.closed) {
      throw new RemoteTransportError('transport_closed', 'Transport is closed');
    }
    const node = this.registry.get(nodeId);
    if (!node) {
      throw new RemoteTransportError('peer_not_found', `Unknown remote node: ${nodeId}`, nodeId);
    }

    const params = isRecord(request.params) ? request.params : {};
    // 幂等 id：header 供日志/代理；spawn 的 body 也必须带（gateway 只读 body）。
    const requestId = request.requestId ?? crypto.randomUUID();
    const headers: Record<string, string> = { 'X-Vessel-Request-Id': requestId };

    let result: unknown;
    try {
      switch (request.method) {
        case 'team.spawn': {
          const body: Record<string, unknown> = { request_id: requestId };
          if (typeof params.name === 'string') body.name = params.name;
          if (typeof params.model === 'string') body.model = params.model;
          const systemPrompt = params.systemPrompt ?? params.system_prompt;
          if (typeof systemPrompt === 'string') body.system_prompt = systemPrompt;
          result = await this.fetchJson(node, '/v1/team/agents', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          });
          break;
        }
        case 'team.inbox': {
          const agentId = stringParam(params, 'agentId') ?? stringParam(params, 'agent_id');
          if (agentId === undefined) {
            throw new RemoteTransportError(
              'invalid_request',
              'team.inbox requires params.agentId',
              nodeId,
            );
          }
          const query = new URLSearchParams({ agent_id: agentId });
          const cursor = stringParam(params, 'cursor');
          if (cursor !== undefined) query.set('cursor', cursor);
          result = await this.fetchJson(node, `/v1/team/inbox?${query.toString()}`, {
            method: 'GET',
            headers,
          });
          break;
        }
        case 'team.status': {
          const agentId = stringParam(params, 'agentId') ?? stringParam(params, 'agent_id');
          if (agentId === undefined) {
            throw new RemoteTransportError(
              'invalid_request',
              'team.status requires params.agentId',
              nodeId,
            );
          }
          result = await this.fetchJson(node, `/v1/team/agents/${encodeURIComponent(agentId)}`, {
            method: 'GET',
            headers,
          });
          break;
        }
        case 'team.status.list':
          result = await this.fetchJson(node, '/v1/team/agents', { method: 'GET', headers });
          break;
        default:
          throw new RemoteTransportError(
            'invalid_request',
            `Unsupported remote method: ${request.method}`,
            nodeId,
          );
      }
      this.registry.markHealthy(node.id);
      return result as T;
    } catch (error) {
      if (
        error instanceof RemoteTransportError &&
        (error.code === 'timeout' || error.code === 'peer_unreachable')
      ) {
        this.registry.markUnreachable(node.id);
      }
      throw error;
    }
  }

  /** 关闭事件订阅、心跳与本地 handler；不关闭远端 gateway */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    this.seenMessages.clear();
    this.seenEvents.clear();
    for (const state of this.eventStates.values()) {
      this.stopEventState(state);
    }
    this.eventStates.clear();
    this.registry.stop();
  }

  // ── 内部：HTTP ─────────────────────────────────

  private async fetchJson(
    node: ResolvedNode,
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<unknown> {
    const controller = new AbortController();
    // 请求超时定时器不能 unref：测试/进程在只有它和 pending fetch 时仍需触发。
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let response: Response;
    try {
      const request: FetchInit = {
        method: init.method,
        headers: {
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(node.token !== '' ? { Authorization: `Bearer ${node.token}` } : {}),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
        ...(init.body !== undefined ? { body: init.body } : {}),
      };
      if (node.ca !== undefined) request.tls = { ca: node.ca };
      response = await this.fetchImpl(`${node.url}${path}`, request as RequestInit);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RemoteTransportError(
          'timeout',
          `Remote request timed out after ${this.requestTimeoutMs}ms`,
          node.id,
        );
      }
      throw new RemoteTransportError(
        'peer_unreachable',
        `Peer unreachable: ${error instanceof Error ? error.message : String(error)}`,
        node.id,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const body = text === '' ? undefined : safeParse(text);

    if (response.ok) return body;

    const code = errorCode(body);
    const message = errorMessage(body) ?? `Remote request failed with HTTP ${response.status}`;
    throw new RemoteTransportError(this.mapHttpError(response.status, code), message, node.id);
  }

  private mapHttpError(status: number, code: string | undefined): RemoteTransportErrorCode {
    if (code === 'agent_not_found') return 'agent_not_found';
    if (code === 'no_spawn') return 'no_spawn';
    if (code === 'inbox_overflow') return 'inbox_overflow';
    if (code === 'invalid_request' || code === 'broadcast_not_supported') {
      return 'invalid_request';
    }
    if (code === 'unsupported_protocol') return 'unsupported_protocol';
    if (code === 'unauthorized' || code === 'forbidden_origin') return 'unauthorized';
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 426) return 'unsupported_protocol';
    if (status === 400 || status === 413) return 'invalid_request';
    if (status === 404) return 'peer_not_found';
    return 'peer_error';
  }

  // ── 内部：本地投递 / 去重 ───────────────────────

  private async deliverLocal(message: AgentMessage): Promise<void> {
    const results = await Promise.allSettled(
      [...this.handlers].map((handler) => Promise.resolve().then(() => handler(message))),
    );
    void results;
  }

  private remember(map: Map<string, true>, key: string): void {
    map.set(key, true);
    while (map.size > MAX_SEEN) {
      const first = map.keys().next();
      if (first.done) break;
      map.delete(first.value);
    }
  }

  // ── 内部：B4 事件订阅 ───────────────────────────

  private connectEvents(nodeId: string): void {
    if (this.closed || !this.onEvent) return;
    const node = this.registry.get(nodeId);
    if (!node) return;

    const state: EventState = this.eventStates.get(nodeId) ?? {
      attempt: 0,
      lastSeq: 0,
    };
    this.eventStates.set(nodeId, state);
    if (state.socket) return;

    const url = `${node.url.replace(/^http/, 'ws')}/v1/events`;
    let current: WebSocketLike;
    try {
      current = this.wsFactory(url, node.ca !== undefined ? { ca: node.ca } : undefined);
    } catch {
      this.scheduleEventReconnect(nodeId, state);
      return;
    }
    state.socket = current;

    current.addEventListener('open', () => {
      if (this.closed || state.socket !== current) return;
      // 退避计数只在收到 hello 后重置；open 不代表对端可用。
      try {
        current.send(
          JSON.stringify({
            v: 1,
            kind: 'auth',
            token: node.token,
            ...(state.lastSeq > 0 ? { since: state.lastSeq } : {}),
          }),
        );
      } catch {
        this.dropEventSocket(nodeId, state, current);
        return;
      }
      state.helloTimer = setTimeout(() => {
        state.helloTimer = undefined;
        if (state.socket === current) this.dropEventSocket(nodeId, state, current);
      }, this.helloTimeoutMs);
      (state.helloTimer as { unref?: () => void }).unref?.();
    });

    current.addEventListener('message', (event) => {
      this.handleEventFrame(nodeId, state, current, event.data);
    });

    current.addEventListener('close', () => {
      if (state.socket === current) {
        state.socket = undefined;
        this.clearHelloTimer(state);
        this.scheduleEventReconnect(nodeId, state);
      }
    });

    current.addEventListener('error', () => {
      if (state.socket === current) this.dropEventSocket(nodeId, state, current);
    });
  }

  private handleEventFrame(
    nodeId: string,
    state: EventState,
    current: WebSocketLike,
    data: unknown,
  ): void {
    if (this.closed || state.socket !== current) return;
    const text = textOf(data);
    if (text === undefined) return;
    const frame = safeParse(text);
    if (!isRecord(frame)) return;

    if (frame.kind === 'hello') {
      this.clearHelloTimer(state);
      state.attempt = 0;
      const latest = typeof frame.latest_seq === 'number' ? frame.latest_seq : undefined;
      if (latest !== undefined && latest < state.lastSeq) {
        // 对端重启/缓冲区清空：旧 seq 的去重键全部作废，否则新 seq=1 会被丢。
        this.seenEvents.clear();
        state.lastSeq = 0;
        this.dropEventSocket(nodeId, state, current, true);
      }
      return;
    }
    if (frame.kind === 'gap') {
      // 历史区间缺失：以 to_seq 为 since 立即重连，由 gateway 续放后续事件。
      const toSeq = typeof frame.to_seq === 'number' ? frame.to_seq : undefined;
      if (toSeq !== undefined) state.lastSeq = Math.max(state.lastSeq, toSeq);
      this.dropEventSocket(nodeId, state, current, true);
      return;
    }
    if (frame.kind === 'ping') {
      try {
        current.send(JSON.stringify({ v: 1, kind: 'pong' }));
      } catch {
        // close 会触发重连
      }
      return;
    }
    if (frame.kind !== 'event' || !isRecord(frame.event)) return;

    const seq = typeof frame.seq === 'number' ? frame.seq : undefined;
    if (seq !== undefined) {
      state.lastSeq = Math.max(state.lastSeq, seq);
      const origin = typeof frame.node_id === 'string' ? frame.node_id : nodeId;
      const key = `${origin}:${seq}`;
      if (this.seenEvents.has(key)) return;
      this.remember(this.seenEvents, key);
    }
    // 无 seq 的帧无法安全去重：直接投递，不做 origin:na 合并。
    const origin = typeof frame.node_id === 'string' ? frame.node_id : nodeId;

    const event = { ...frame.event } as unknown as RunEvent;
    if (event.node_id === undefined) event.node_id = origin;
    try {
      this.onEvent?.(event);
    } catch {
      // 订阅者异常不影响其它节点
    }
  }

  private dropEventSocket(
    nodeId: string,
    state: EventState,
    current: WebSocketLike,
    immediate = false,
  ): void {
    if (state.socket !== current) return;
    state.socket = undefined;
    this.clearHelloTimer(state);
    try {
      current.close();
    } catch {
      // best-effort
    }
    this.scheduleEventReconnect(nodeId, state, immediate);
  }

  private scheduleEventReconnect(nodeId: string, state: EventState, immediate = false): void {
    if (this.closed || !this.onEvent || state.reconnectTimer !== undefined) return;
    const capped = Math.min(
      this.reconnectMaxMs,
      this.reconnectInitialMs * 2 ** Math.min(state.attempt, 16),
    );
    const delay = immediate ? 0 : Math.round(capped * (0.8 + Math.random() * 0.4));
    state.attempt += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      this.connectEvents(nodeId);
    }, delay);
    (state.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private clearHelloTimer(state: EventState): void {
    if (state.helloTimer !== undefined) clearTimeout(state.helloTimer);
    state.helloTimer = undefined;
  }

  private stopEventState(state: EventState): void {
    if (state.reconnectTimer !== undefined) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = undefined;
    this.clearHelloTimer(state);
    const current = state.socket;
    state.socket = undefined;
    if (current) {
      try {
        current.close();
      } catch {
        // best-effort
      }
    }
  }
}
