/**
 * 插件 WebSocket 反代（CONTRACT-0.48 §4）。
 *
 * 宿主充当 WS 客户端连接插件的 loopback endpoint，只桥接应用帧：
 * - text / binary 原样转发，不做 JSON-RPC 转换、不改写 payload；
 * - 客户端子协议 / 扩展不转发；控制帧 hop-local（不端到端转发 ping/pong）；
 * - 双向单帧上限（`maxFrameBytes`）与 4 MiB 高水位背压；
 * - idle 以应用帧为准；close code / reason 双向映射与幂等关闭；
 * - 连接结束后写 `plugin.http.disconnect` 审计并归还路由连接槽。
 *
 * R6：Bun 1.3.9 实测允许 `await` 后 `srv.upgrade()`，因此 resolve 在 upgrade 前完成
 * （404/503 语义完整），不走「先升级再 resolve」降级。
 * R7：Bun 客户端 `WebSocket.bufferedAmount` 可用，client→plugin 方向执行对称硬背压。
 *
 * @module @vessel-agent/serve/plugin-host
 */

import type {
  PluginHttpAuditEvent,
  PluginHttpRoute,
  PluginHttpTarget,
  PluginWebSocketAccounting,
  PluginWebSocketHandle,
} from './http.js';

/** plugin→client / client→plugin 的高水位（CONTRACT-0.48 §4.4）。 */
export const PLUGIN_WS_HIGH_WATER_BYTES = 4 * 1024 * 1024;
/** close reason 的 UTF-8 上限（RFC 6455 / CONTRACT-0.48 §4.5）。 */
export const PLUGIN_WS_MAX_CLOSE_REASON_BYTES = 123;

/** 客户端侧 ServerWebSocket 的最小形状（Bun 结构兼容）。 */
export interface PluginWsClient {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

/** 宿主→插件 WS 客户端的最小形状（Bun `WebSocket` 结构兼容）。 */
export interface PluginWsUpstream {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason?: string }) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

export interface PluginWsConnectionOptions {
  route: PluginHttpRoute;
  target: PluginHttpTarget;
  /** 客户端请求的 pathname + query，原样转给插件。 */
  path: string;
  /** 原始请求头；由本模块按 §4.3 清洗后转发。 */
  headers: Headers;
  /** 连接结束（恰好一次）归还 gateway 的路由连接槽。 */
  releaseSlot: () => void;
  accounting?: PluginWebSocketAccounting;
  /** 可注入的 WS 客户端工厂（探针 / 测试用）；缺省用全局 WebSocket。 */
  connect?: (url: string, headers: Record<string, string>) => PluginWsUpstream;
}

/** 需要剥离的客户端 upgrade 头（CONTRACT-0.48 §4.3）。 */
const DROP_UPGRADE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  // 子协议 / 扩展不协商；握手 key/version 由 Bun 客户端重新生成。
  'sec-websocket-protocol',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-version',
]);

function upstreamHeaders(original: Headers, target: PluginHttpTarget): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of original) {
    const lower = name.toLowerCase();
    if (DROP_UPGRADE_HEADERS.has(lower)) continue;
    if (lower.startsWith('x-vessel-') || lower.startsWith('x-forwarded-')) continue;
    headers[lower] = value;
  }
  // Host 由 WS 客户端按回环 URL 设置；插件看到的不是客户端 Host。
  headers['x-vessel-plugin-token'] = target.token;
  return headers;
}

function toWsUrl(targetUrl: string, path: string): string {
  const origin = targetUrl.startsWith('http://')
    ? `ws://${targetUrl.slice('http://'.length)}`
    : targetUrl;
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

function defaultConnect(url: string, headers: Record<string, string>): PluginWsUpstream {
  const Ctor = WebSocket as unknown as new (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => PluginWsUpstream;
  return new Ctor(url, { headers });
}

/** 不可发送的 close code 映射（CONTRACT-0.48 §4.5）。 */
export function mapPluginWsCloseCode(code: number): number {
  if (code === 1005) return 1000;
  if (code === 1006 || code === 1015) return 1011;
  if (code === 1000 || code === 1001 || code === 1002 || code === 1003 || code === 1007)
    return code;
  if (code >= 1008 && code <= 1014) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1011;
}

/** reason 截断到不超过 `maxBytes` 个 UTF-8 字节（不切断 code point）。 */
export function truncatePluginWsReason(reason: string, maxBytes: number): string {
  if (Buffer.byteLength(reason, 'utf8') <= maxBytes) return reason;
  let output = '';
  let used = 0;
  for (const char of reason) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (used + bytes > maxBytes) break;
    output += char;
    used += bytes;
  }
  return output;
}

function payloadBytes(data: unknown): number | null {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (data instanceof Uint8Array) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return null;
}

function toPayload(data: unknown): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return String(data);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * 单条插件 WS 连接：`begin()` 由 gateway 的 `open` 调用，之后 message/close
 * 由 gateway handler 转发。所有关闭路径共用 `finish()`，保证幂等与恰好一次清理。
 */
export class PluginWsConnection {
  private readonly options: PluginWsConnectionOptions;
  private client?: PluginWsClient;
  private upstream?: PluginWsUpstream;
  private closed = false;
  private upstreamOpen = false;
  private unregister?: () => void;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private pending: Array<string | Uint8Array> = [];
  private pendingBytes = 0;
  private framesIn = 0;
  private bytesIn = 0;
  private framesOut = 0;
  private bytesOut = 0;

  constructor(options: PluginWsConnectionOptions) {
    this.options = options;
  }

  /** 客户端已升级：连接插件并开始桥接。 */
  begin(client: PluginWsClient): void {
    this.client = client;
    if (this.closed) {
      // 升级后、open 前 manager 已要求下线（例如 deactivate）——直接关闭客户端。
      try {
        client.close(1011, 'plugin_unavailable');
      } catch {
        // 已关闭
      }
      return;
    }
    const { route, accounting } = this.options;
    this.unregister = accounting?.register(route.pluginId, {
      close: (code, reason) => this.closeByHost(code, reason),
    } satisfies PluginWebSocketHandle);
    this.armIdle();
    this.armHandshake();

    let upstream: PluginWsUpstream;
    try {
      const headers = upstreamHeaders(this.options.headers, this.options.target);
      const url = toWsUrl(this.options.target.url, this.options.path);
      upstream =
        this.options.connect !== undefined
          ? this.options.connect(url, headers)
          : defaultConnect(url, headers);
    } catch {
      this.fail(1011, 'upstream_error');
      return;
    }
    this.upstream = upstream;
    upstream.addEventListener('open', () => {
      if (this.closed) return;
      this.upstreamOpen = true;
      this.clearHandshake();
      this.flushPending();
      this.armIdle();
    });
    upstream.addEventListener('message', (event) => this.fromPlugin(event.data));
    upstream.addEventListener('close', (event) => {
      this.fromUpstreamClose(event.code ?? 1006, event.reason ?? '');
    });
    upstream.addEventListener('error', () => this.fail(1011, 'upstream_error'));
  }

  /** 客户端 → 插件的一帧（text / binary 原样）。 */
  message(data: unknown): void {
    if (this.closed) return;
    const size = payloadBytes(data);
    if (size === null) return;
    const maxFrameBytes = this.options.route.limits.maxFrameBytes;
    if (maxFrameBytes !== null && size > maxFrameBytes) {
      this.fail(1009, 'frame_too_large');
      return;
    }
    this.framesIn += 1;
    this.bytesIn += size;
    this.options.accounting?.frame(this.options.route.pluginId, 'in', size);
    this.armIdle();
    const payload = toPayload(data);
    if (!this.upstreamOpen || this.upstream === undefined) {
      this.pending.push(payload);
      this.pendingBytes += size;
      // 握手期间最多缓存一个高水位；超过视为上游不可用。
      if (this.pendingBytes > PLUGIN_WS_HIGH_WATER_BYTES) this.fail(1011, 'upstream_error');
      return;
    }
    this.sendUpstream(payload);
  }

  /** 客户端主动关闭（Bun close handler）。 */
  clientClose(code: number, reason?: string): void {
    if (this.closed) return;
    this.finish(code, reason ?? '', 'client_closed', false, true);
  }

  /** 没有任何数据（保留给 gateway 的 pong 路由；本代理不注入应用层 ping）。 */
  pong(): void {}

  /** manager / gateway 主动关闭（deactivate / shutdown）。 */
  closeByHost(code: number, reason: string): void {
    if (this.closed) return;
    this.finish(code, reason, reason.length > 0 ? reason : 'host', true, true);
  }

  private fromPlugin(data: unknown): void {
    if (this.closed) return;
    const size = payloadBytes(data);
    if (size === null) return;
    const maxFrameBytes = this.options.route.limits.maxFrameBytes;
    if (maxFrameBytes !== null && size > maxFrameBytes) {
      this.fail(1009, 'frame_too_large');
      return;
    }
    this.framesOut += 1;
    this.bytesOut += size;
    this.options.accounting?.frame(this.options.route.pluginId, 'out', size);
    this.armIdle();
    const client = this.client;
    if (client === undefined) return;
    try {
      client.send(toPayload(data));
    } catch {
      this.finish(1011, '', 'client_closed', false, true);
      return;
    }
    if (client.getBufferedAmount() > PLUGIN_WS_HIGH_WATER_BYTES) {
      this.fail(1013, 'slow_consumer');
    }
  }

  private fromUpstreamClose(code: number, reason: string): void {
    if (this.closed) return;
    const reasonClass = code === 1000 || code === 1001 ? 'upstream_closed' : 'upstream_error';
    this.finish(code, reason, reasonClass, true, false);
  }

  private sendUpstream(payload: string | Uint8Array): void {
    const upstream = this.upstream;
    if (upstream === undefined) {
      this.fail(1011, 'upstream_error');
      return;
    }
    try {
      upstream.send(payload);
    } catch {
      this.fail(1011, 'upstream_error');
      return;
    }
    // R7：Bun 客户端 bufferedAmount 可用 → 对称硬背压。
    if (upstream.bufferedAmount > PLUGIN_WS_HIGH_WATER_BYTES) {
      this.fail(1013, 'slow_consumer');
    }
  }

  private flushPending(): void {
    if (this.upstream === undefined || this.closed) return;
    const pending = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const payload of pending) {
      if (this.closed) return;
      this.sendUpstream(payload);
    }
  }

  private fail(code: number, reasonClass: string): void {
    if (this.closed) return;
    this.finish(code, reasonClass, reasonClass, true, true);
  }

  private armIdle(): void {
    this.clearIdle();
    const idleTimeoutMs = this.options.route.limits.idleTimeoutMs;
    if (idleTimeoutMs === null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.fail(1001, 'idle_timeout');
    }, idleTimeoutMs);
    unrefTimer(this.idleTimer);
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private armHandshake(): void {
    const timeoutMs = this.options.route.limits.timeoutMs;
    if (timeoutMs === null) return;
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = undefined;
      this.fail(1011, 'upstream_timeout');
    }, timeoutMs);
    unrefTimer(this.handshakeTimer);
  }

  private clearHandshake(): void {
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  /** 统一收口：清理 timer / 槽 / 计数器，写 disconnect 审计；幂等。 */
  private finish(
    code: number,
    reason: string,
    reasonClass: string,
    closeClient: boolean,
    closeUpstream: boolean,
  ): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    this.clearHandshake();
    this.pending = [];
    this.pendingBytes = 0;

    const mapped = mapPluginWsCloseCode(code);
    const safeReason = truncatePluginWsReason(reason, PLUGIN_WS_MAX_CLOSE_REASON_BYTES);
    if (closeClient && this.client !== undefined) {
      try {
        this.client.close(mapped, safeReason);
      } catch {
        // 客户端已关闭
      }
    }
    if (closeUpstream && this.upstream !== undefined) {
      try {
        this.upstream.close(mapped, safeReason);
      } catch {
        // 上游已关闭
      }
    }

    const unregister = this.unregister;
    this.unregister = undefined;
    try {
      unregister?.();
    } catch {
      // 幂等注销
    }
    try {
      this.options.releaseSlot();
    } catch {
      // 槽位已归还
    }

    const { route, accounting } = this.options;
    accounting?.closed(route.pluginId, mapped);
    const event: PluginHttpAuditEvent = {
      event: 'plugin.http.disconnect',
      data: {
        plugin: route.pluginId,
        route: route.id,
        code: mapped,
        reasonClass,
        bytesIn: this.bytesIn,
        bytesOut: this.bytesOut,
        framesIn: this.framesIn,
        framesOut: this.framesOut,
      },
    };
    accounting?.audit(event);
  }
}
