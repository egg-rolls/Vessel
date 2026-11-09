/**
 * Hub 服务客户端与会话（非 React、依赖可注入）。
 *
 * 边界（CONTRACT-0.49 §8 / D9）：
 * - 不 import node 客户端目录，不复用 node WS 客户端的握手 / token 语义。
 * - token 只在内存与 `Authorization` 头 / WS auth 帧里；不进 URL / query / 日志。
 * - `/health` 免鉴权；`/v1/hub/directory` 仅非回环带 Bearer（回环可匿名）；
 *   `/v1/hub/events` 首帧认证 `{v:1,kind:'auth',protocol:'vessel.hub/2',token?}`；
 *   旧 `vessel.hub/1` peer 由现有 `incompatible` 错误面显式失败。
 * - 数据层负责：connect（health + directory）、WS auth、错误分类、
 *   401/403/4401 清 token 并停重连、5xx/网络 1s..30s 退避。
 *
 * `HubSession` 可直接单测：注入 `{ fetch, WebSocket, setTimeout, clearTimeout, storage }`。
 */

import { isLoopbackHostname } from '../url';
import { defaultHubStorage, type HubStorage } from './hub-storage';
import {
  HUB_PROTOCOL,
  type HubDirectory,
  type HubHealth,
  type HubNodeCounts,
  type HubNodeRecord,
  type HubNodeStatus,
  type HubPointerFrame,
  type HubServerEvent,
} from './hub-types';

const REQUEST_TIMEOUT_MS = 10_000;
/** 本地 Hub 默认端口（与 `hub.listen.port` 缺省一致）。 */
export const DEFAULT_HUB_PORT = 8643;
export const HUB_RECONNECT_MIN_MS = 1_000;
export const HUB_RECONNECT_MAX_MS = 30_000;
export const HUB_POINTER_TTL_MS = 4_000;
const EVENTS_PATH = '/v1/hub/events';
const DIRECTORY_PATH = '/v1/hub/directory';
const HEALTH_PATH = '/health';

export type TimerHandle = unknown;

/** 注入的最小 WS 面；默认实现包装浏览器 `WebSocket`。 */
export interface HubWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: 'error', listener: () => void): void;
}

/** 数据层依赖；注入 fake 时全部替换，便于确定性断言。 */
export interface HubSessionDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** 打开 WS（名字保留契约里的 `WebSocket`；实现为工厂）。 */
  WebSocket: (url: string) => HubWebSocket;
  setTimeout: (handler: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
  storage: HubStorage;
}

/** 默认浏览器实现；只在调用时解析全局对象，模块顶层不捕获。 */
export function browserHubSessionDeps(overrides: Partial<HubSessionDeps> = {}): HubSessionDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    WebSocket: (url) => new globalThis.WebSocket(url) as unknown as HubWebSocket,
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    storage: defaultHubStorage(),
    ...overrides,
  };
}

export type HubErrorKind =
  | 'invalid_url'
  | 'unauthorized'
  | 'forbidden'
  | 'network'
  | 'http'
  | 'incompatible';

export class HubClientError extends Error {
  constructor(
    readonly kind: HubErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HubClientError';
  }
}

/**
 * Hub URL 归一化为 origin：只接受 http(s)，允许省略尾 `/`；
 * 拒绝 credentials / path / query / hash（token 绝不能借 URL 传递）。
 */
export function normalizeHubBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    return isLoopbackHostname(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * 0.50：页面由本地平台提供且没有已存 URL 时，隐式连接同机默认 Hub。
 * 只在回环 http 页面生效（https 页面会被 mixed content 拒绝）；非回环返回 null。
 */
export function implicitHubUrl(): string | null {
  const location = globalThis.location;
  if (location === undefined) return null;
  if (location.protocol === 'https:') return null;
  if (!isLoopbackHostname(location.hostname)) return null;
  return `http://${location.hostname}:${DEFAULT_HUB_PORT}`;
}

/** HTTPS 页面拒绝 http Hub（mixed content），归入 invalid_url。 */
function isMixedContent(baseUrl: string): boolean {
  const protocol = typeof globalThis.location === 'undefined' ? '' : globalThis.location.protocol;
  return protocol === 'https:' && baseUrl.startsWith('http:');
}

function toWebSocketBase(baseUrl: string): string {
  return baseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const NODE_STATUSES: ReadonlySet<string> = new Set([
  'connecting',
  'healthy',
  'unreachable',
  'incompatible',
  'unauthorized',
  'identity_mismatch',
]);

function parseCounts(value: unknown): HubNodeCounts {
  if (!isRecord(value)) return { teams: 0, agents: 0, live_agents: 0 };
  return {
    teams: number(value.teams) ?? 0,
    agents: number(value.agents) ?? 0,
    live_agents: number(value.live_agents) ?? 0,
  };
}

function parseNode(value: unknown): HubNodeRecord | null {
  if (!isRecord(value)) return null;
  const nodeId = text(value.node_id);
  const status = text(value.status);
  if (!nodeId || !status || !NODE_STATUSES.has(status)) return null;

  const dataPlane =
    value.data_plane === 'direct' || value.data_plane === 'unreachable'
      ? value.data_plane
      : undefined;
  const direction =
    value.direction === 'hub' || value.direction === 'node' ? value.direction : undefined;

  return {
    node_id: nodeId,
    status: status as HubNodeStatus,
    truncated: value.truncated === true,
    counts: parseCounts(value.counts),
    ...(text(value.name) !== undefined ? { name: text(value.name) } : {}),
    ...(text(value.alias) !== undefined ? { alias: text(value.alias) } : {}),
    ...(text(value.url) !== undefined ? { url: text(value.url) } : {}),
    ...(text(value.public_url) !== undefined ? { public_url: text(value.public_url) } : {}),
    ...(dataPlane !== undefined ? { data_plane: dataPlane } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(number(value.last_seen) !== undefined ? { last_seen: number(value.last_seen) } : {}),
    ...(text(value.last_error) !== undefined ? { last_error: text(value.last_error) } : {}),
  };
}

/** HTTP 目录（`updated_at`）与 WS 目录帧（`observed_at`）共用。 */
export function parseHubDirectory(value: unknown): HubDirectory | null {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return null;
  const hubId = text(value.hub_id);
  if (hubId === undefined) return null;
  const updatedAt = number(value.updated_at) ?? number(value.observed_at) ?? Date.now();
  const nodes = value.nodes.map(parseNode).filter((node): node is HubNodeRecord => node !== null);
  return { v: 1, hub_id: hubId, updated_at: updatedAt, nodes };
}

function parsePointer(value: Record<string, unknown>): HubPointerFrame | null {
  const nodeId = text(value.node_id);
  const hubId = text(value.hub_id);
  const teamId = text(value.team_id);
  const reason = text(value.reason);
  if (!nodeId || !hubId || !teamId || !reason) return null;
  const requestId = text(value.request_id);
  return {
    v: 1,
    kind: 'pointer',
    protocol: HUB_PROTOCOL,
    dialer: text(value.dialer) ?? 'hub',
    node_id: nodeId,
    hub_id: hubId,
    team_id: teamId,
    reason,
    ts: number(value.ts) ?? Date.now(),
    ...(requestId !== undefined ? { request_id: requestId } : {}),
  };
}

/** 解析 WS 文本帧；未知 / 畸形帧一律忽略（不打断连接）。 */
export function parseHubServerEvent(raw: string): HubServerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1) return null;
  // 旧 v1 peer 显式失败，而不是静默忽略整个目录。
  if (typeof value.protocol === 'string' && value.protocol !== HUB_PROTOCOL) {
    return { kind: 'incompatible' };
  }
  switch (value.kind) {
    case 'hello': {
      const hubId = text(value.hub_id);
      return hubId === undefined
        ? null
        : { kind: 'hello', hubId, revision: number(value.revision) };
    }
    case 'directory': {
      const directory = parseHubDirectory(value);
      return directory === null ? null : { kind: 'directory', directory };
    }
    case 'pointer': {
      const pointer = parsePointer(value);
      return pointer === null ? null : { kind: 'pointer', pointer };
    }
    case 'ping':
      return { kind: 'ping' };
    default:
      return null;
  }
}

export interface HubEventsHandlers {
  onOpen?(): void;
  onHello?(info: { hubId: string; revision?: number }): void;
  onDirectory?(directory: HubDirectory): void;
  onPointer?(pointer: HubPointerFrame): void;
  /** 4401：token 无效 / 过期；调用方清 token 并停止重连。 */
  onUnauthorized?(): void;
  /** 4400：协议不兼容；不重连。 */
  onIncompatible?(): void;
  /** 网络 / 5xx 类断线；已按 1s..30s 退避安排重连。 */
  onDisconnected?(info: { attempt: number; retryInMs: number }): void;
}

export interface HubEventsConnection {
  close(): void;
}

/** WS `/v1/hub/events`：open 后发 auth 帧；异常断线按 1s..30s 退避重连。 */
export function openHubEvents(
  baseUrl: string,
  token: string,
  deps: HubSessionDeps,
  handlers: HubEventsHandlers,
): HubEventsConnection {
  let socket: HubWebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: TimerHandle | undefined;

  function scheduleReconnect(): void {
    attempt += 1;
    const retryInMs = Math.min(HUB_RECONNECT_MAX_MS, HUB_RECONNECT_MIN_MS * 2 ** (attempt - 1));
    handlers.onDisconnected?.({ attempt, retryInMs });
    timer = deps.setTimeout(connect, retryInMs);
  }

  function connect(): void {
    if (closed) return;
    let next: HubWebSocket;
    try {
      next = deps.WebSocket(`${toWebSocketBase(baseUrl)}${EVENTS_PATH}`);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = next;

    next.addEventListener('open', () => {
      attempt = 0;
      handlers.onOpen?.();
      const authFrame = {
        v: 1,
        kind: 'auth',
        protocol: HUB_PROTOCOL,
        dialer: 'hub',
        ...(token !== '' ? { token } : {}),
      };
      next.send(JSON.stringify(authFrame));
    });

    next.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const parsed = parseHubServerEvent(event.data);
      if (parsed === null) return;
      switch (parsed.kind) {
        case 'hello':
          handlers.onHello?.({ hubId: parsed.hubId, revision: parsed.revision });
          break;
        case 'directory':
          handlers.onDirectory?.(parsed.directory);
          break;
        case 'pointer':
          handlers.onPointer?.(parsed.pointer);
          break;
        case 'ping':
          if (next.readyState === 1) {
            next.send(
              JSON.stringify({ v: 1, kind: 'pong', protocol: HUB_PROTOCOL, dialer: 'hub' }),
            );
          }
          break;
        case 'incompatible':
          handlers.onIncompatible?.();
          try {
            next.close(4400, 'incompatible');
          } catch {
            // 已关闭 / 不可关闭：错误面已由 onIncompatible 表达。
          }
          break;
      }
    });

    // `error` 之后浏览器总会再发 `close`（通常 code 1006）；重连只在 close 里安排。
    next.addEventListener('error', () => {});

    next.addEventListener('close', (event) => {
      if (socket === next) socket = null;
      if (closed) return;
      if (event.code === 4401) {
        handlers.onUnauthorized?.();
        return;
      }
      if (event.code === 4400) {
        handlers.onIncompatible?.();
        return;
      }
      scheduleReconnect();
    });
  }

  connect();

  return {
    close() {
      closed = true;
      if (timer !== undefined) {
        deps.clearTimeout(timer);
        timer = undefined;
      }
      const current = socket;
      socket = null;
      current?.close(1000, 'client closed');
    },
  };
}

export interface HubClientOptions {
  baseUrl: string;
  token?: string;
  deps?: Partial<HubSessionDeps>;
}

export class HubClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly deps: HubSessionDeps;

  constructor(options: HubClientOptions) {
    const normalized = normalizeHubBaseUrl(options.baseUrl);
    if (normalized === null) {
      throw new HubClientError('invalid_url', 'invalid hub url');
    }
    this.baseUrl = normalized;
    this.token = options.token?.trim() ?? '';
    this.deps = browserHubSessionDeps(options.deps);
  }

  private async request(path: string, authorized: boolean): Promise<unknown> {
    const controller = new AbortController();
    const timer = this.deps.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const sendToken = authorized && this.token !== '' && !isLoopbackBaseUrl(this.baseUrl);
    let response: Response;
    try {
      response = await this.deps.fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: sendToken ? { Authorization: `Bearer ${this.token}` } : {},
        signal: controller.signal,
      });
    } catch (error) {
      throw new HubClientError(
        'network',
        error instanceof Error && error.name === 'AbortError'
          ? 'hub request timeout'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      this.deps.clearTimeout(timer);
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const kind =
        response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'http';
      throw new HubClientError(kind, `HTTP ${response.status}`, response.status);
    }
    return body;
  }

  /** URL / CORS 预检；`/health` 免鉴权。 */
  async health(): Promise<HubHealth> {
    const body = await this.request(HEALTH_PATH, false);
    if (!isRecord(body) || body.ok !== true) {
      throw new HubClientError('http', 'invalid hub health response');
    }
    return {
      ok: true,
      hub_id: text(body.hub_id) ?? '',
      nodes: number(body.nodes) ?? 0,
      now: number(body.now) ?? Date.now(),
    };
  }

  async directory(): Promise<HubDirectory> {
    const directory = parseHubDirectory(await this.request(DIRECTORY_PATH, true));
    if (directory === null) {
      throw new HubClientError('http', 'invalid hub directory response');
    }
    return directory;
  }

  events(handlers: HubEventsHandlers): HubEventsConnection {
    return openHubEvents(this.baseUrl, this.token, this.deps, handlers);
  }
}

export type HubSessionStatus =
  | 'unconfigured'
  | 'loading'
  | 'connected'
  | 'empty'
  | 'unauthorized'
  | 'incompatible'
  | 'network';

export interface HubSessionSnapshot {
  status: HubSessionStatus;
  url: string;
  hasToken: boolean;
  directory: HubDirectory | null;
  /** 仅瞬时提示：节点有更新；`null` = 无提示。 */
  pointer: HubPointerFrame | null;
  /** WS 当前是否在线；已加载目录时断线只降级提示，不清空目录。 */
  live: boolean;
  reconnecting: boolean;
  connecting: boolean;
  connectError: HubErrorKind | null;
}

export interface HubConnectInput {
  url: string;
  token: string;
}

export interface HubConnectResult {
  ok: boolean;
  error?: HubErrorKind;
}

export interface HubSessionOptions {
  deps?: Partial<HubSessionDeps>;
}

/**
 * Hub 数据会话：所有鉴权 / 失效 / 重连语义都在这里；React 只订阅快照。
 * 生命周期：`connect()` 启动（health → directory → WS）；`retry()` 重连；
 * `disconnect()` 清 URL + token；`close()` 仅停止（页面卸载）。
 */
export class HubSession {
  private readonly deps: HubSessionDeps;
  private state: HubSessionSnapshot;
  private readonly listeners = new Set<() => void>();
  private events: HubEventsConnection | null = null;
  private pointerTimer: TimerHandle | undefined;
  private epoch = 0;
  private stopped = false;

  constructor(options: HubSessionOptions = {}) {
    this.deps = browserHubSessionDeps(options.deps);
    const stored = this.deps.storage.read();
    const implicitUrl = stored.url === '' ? implicitHubUrl() : null;
    this.state = {
      status: stored.url !== '' || implicitUrl !== null ? 'loading' : 'unconfigured',
      url: stored.url !== '' ? stored.url : (implicitUrl ?? ''),
      hasToken: stored.token !== '',
      directory: null,
      pointer: null,
      live: false,
      reconnecting: false,
      connecting: false,
      connectError: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): HubSessionSnapshot => this.state;

  private patch(partial: Partial<HubSessionSnapshot>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of [...this.listeners]) listener();
  }

  private clearPointerTimer(): void {
    if (this.pointerTimer === undefined) return;
    this.deps.clearTimeout(this.pointerTimer);
    this.pointerTimer = undefined;
  }

  private stopEvents(): void {
    this.events?.close();
    this.events = null;
  }

  /** 401 / 403 / 4401：清 token、停重连、回 connect form。 */
  private handleUnauthorized(epoch: number): void {
    if (epoch !== this.epoch) return;
    this.stopped = true;
    this.epoch += 1;
    this.stopEvents();
    this.clearPointerTimer();
    this.deps.storage.clearToken();
    this.patch({
      status: 'unauthorized',
      hasToken: false,
      directory: null,
      pointer: null,
      live: false,
      reconnecting: false,
      connecting: false,
      connectError: null,
    });
  }

  private async loadDirectory(baseUrl: string, token: string, epoch: number): Promise<void> {
    try {
      const directory = await new HubClient({ baseUrl, token, deps: this.deps }).directory();
      if (epoch !== this.epoch || this.stopped) return;
      // 协议不兼容已判定：目录成功也不得把 incompatible 覆盖成 connected。
      if (this.state.status === 'incompatible') return;
      this.patch({
        directory,
        status: directory.nodes.length === 0 ? 'empty' : 'connected',
      });
    } catch (error) {
      if (epoch !== this.epoch || this.stopped) return;
      const kind = error instanceof HubClientError ? error.kind : 'http';
      if (kind === 'unauthorized' || kind === 'forbidden') {
        this.handleUnauthorized(epoch);
        return;
      }
      // 网络 / 5xx：保留 token；WS 仍按退避重连。
      if (this.state.directory === null) this.patch({ status: 'network' });
    }
  }

  private openEvents(baseUrl: string, token: string, epoch: number): void {
    if (this.stopped || epoch !== this.epoch) return;
    this.events = openHubEvents(baseUrl, token, this.deps, {
      onOpen: () => {
        if (epoch !== this.epoch || this.stopped) return;
        this.patch({ live: true, reconnecting: false });
      },
      onDirectory: (directory) => {
        if (epoch !== this.epoch || this.stopped) return;
        this.patch({
          directory,
          status: directory.nodes.length === 0 ? 'empty' : 'connected',
          live: true,
          reconnecting: false,
        });
      },
      onPointer: (pointer) => {
        if (epoch !== this.epoch || this.stopped) return;
        this.clearPointerTimer();
        this.patch({ pointer });
        this.pointerTimer = this.deps.setTimeout(() => {
          this.pointerTimer = undefined;
          this.patch({ pointer: null });
        }, HUB_POINTER_TTL_MS);
      },
      onUnauthorized: () => {
        this.handleUnauthorized(epoch);
      },
      onIncompatible: () => {
        if (epoch !== this.epoch || this.stopped) return;
        this.patch({ status: 'incompatible', live: false, reconnecting: false });
      },
      onDisconnected: () => {
        if (epoch !== this.epoch || this.stopped) return;
        if (this.state.directory === null) {
          this.patch({ status: 'network', live: false, reconnecting: false });
        } else {
          this.patch({ live: false, reconnecting: true });
        }
      },
    });
  }

  async connect(input?: HubConnectInput): Promise<HubConnectResult> {
    const stored = this.deps.storage.read();
    // 0.50：无已存 URL + 回环页面 → 隐式连接同机默认 Hub（空 token）。
    const implicitUrl = input === undefined && stored.url === '' ? implicitHubUrl() : null;
    const draft = input ?? (implicitUrl !== null ? { url: implicitUrl, token: '' } : stored);
    const baseUrl = normalizeHubBaseUrl(draft.url);
    if (baseUrl === null || isMixedContent(baseUrl)) {
      if (input !== undefined) {
        this.patch({ connectError: 'invalid_url', connecting: false });
      } else {
        this.patch({ status: 'unconfigured', url: '', hasToken: false });
      }
      return { ok: false, error: 'invalid_url' };
    }
    const token = draft.token.trim();

    this.stopped = false;
    this.epoch += 1;
    const epoch = this.epoch;
    this.stopEvents();
    this.clearPointerTimer();
    this.patch({
      status: 'loading',
      url: baseUrl,
      hasToken: token !== '',
      directory: null,
      pointer: null,
      live: false,
      reconnecting: false,
      connecting: true,
      connectError: null,
    });

    try {
      // `/health` 预检 URL 与 CORS；失败不落盘，用户可修正后重试。
      await new HubClient({ baseUrl, token, deps: this.deps }).health();
    } catch (error) {
      if (epoch !== this.epoch || this.stopped) return { ok: false, error: 'network' };
      const kind = error instanceof HubClientError ? error.kind : 'network';
      const connectError: HubErrorKind =
        kind === 'network' || kind === 'forbidden'
          ? 'network'
          : kind === 'invalid_url'
            ? 'invalid_url'
            : kind === 'unauthorized'
              ? 'unauthorized'
              : 'http';
      // 失败回到预填手动表单（隐式自动连接失败 / 用户改地址失败都一样），
      // 不停在 loading；用户可改地址或清除后重试。
      this.patch({ status: 'unconfigured', url: baseUrl, connecting: false, connectError });
      return { ok: false, error: kind };
    }
    if (epoch !== this.epoch || this.stopped) return { ok: false, error: 'network' };

    this.deps.storage.save(baseUrl, token);
    this.patch({ connecting: false, connectError: null });
    this.openEvents(baseUrl, token, epoch);
    void this.loadDirectory(baseUrl, token, epoch);
    return { ok: true };
  }

  async retry(): Promise<HubConnectResult> {
    return this.connect();
  }

  /** 用户主动断开：清 URL + token，停 WS / 重连。 */
  disconnect(): void {
    this.stopped = true;
    this.epoch += 1;
    this.stopEvents();
    this.clearPointerTimer();
    this.deps.storage.clear();
    this.patch({
      status: 'unconfigured',
      url: '',
      hasToken: false,
      directory: null,
      pointer: null,
      live: false,
      reconnecting: false,
      connecting: false,
      connectError: null,
    });
  }

  /** 页面卸载：只停连接与定时器，不动存储。 */
  close(): void {
    this.stopped = true;
    this.epoch += 1;
    this.stopEvents();
    this.clearPointerTimer();
  }
}

/** 便利工厂；注入面与 `new HubSession({ deps })` 相同。 */
export function createHubSession(options: HubSessionOptions = {}): HubSession {
  return new HubSession(options);
}
