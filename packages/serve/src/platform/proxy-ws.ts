/**
 * 0.58：平台 → node 的事件 WS 代理（**双端状态机**）。
 *
 * 最容易做错的一处（设计 §4）：把 WS 代理写成「两个 socket 互相 onmessage 转发」就收工。
 * 那样没有心跳、没有背压、close 语义不对称，表现为「随机掉线 + 内存上涨」且没有任何
 * counter 能定位。所以这里三个判据都必须成立：
 *
 * 1. **平台自己打心跳**（`ws.ping()` 到浏览器、应用帧往返到 node），并记 `heartbeat_misses`；
 *    绝不用浏览器心跳当上游存活证据（标签页休眠会伪造「上游已死」）。
 * 2. **双向水位 + 硬阈值关闭**：超过高水位转入**有界**待发队列（低水位放行），
 *    队列超过硬阈值（或全局预算）立刻 1013 `backpressure_overflow`。
 * 3. **每次关闭恰好一条** `gateway.ws.closed`（含 `who`、时长、帧/字节数、背压与心跳计数）。
 *
 * 凭据方向：浏览器带来的首帧 `auth` **不转发**；平台用自己的 node token 向上游发一帧
 * `auth`。所以 node token 永远不出网关，浏览器 token 也永远不会被 node 看到。
 *
 * @module @vessel-agent/serve/platform/proxy-ws
 */

import { randomBytes } from 'node:crypto';
import type { PlatformProxyLimits } from './proxy-config.js';

/** 浏览器侧（Bun `ServerWebSocket`）的最小形状。 */
export interface ProxyWsClient {
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  /**
   * DR15-2 迭代2：Bun 1.3.9 ServerWebSocket.terminate()（立即 us_socket_close，
   * 无 close 帧握手）。server-initiated 关闭一律优先用它——graceful close()
   * 在对端不 echo（冻结浏览器）时留 CLOSING 残留，stop(true) 的 native 收尾
   * 会被 CLOSING socket 卡死（ISSUE-DR15-2）。client 侧 WebSocket 无此方法时
   * 退回 close()（upstream 不计 pendingWebSockets，graceful 无害）。
   */
  terminate?(): void;
  getBufferedAmount(): number;
  ping(data?: string): void;
}

/** 平台 → node 的 WS 客户端（Bun 全局 `WebSocket` 结构兼容）。 */
export interface ProxyWsUpstream {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

/** close reason 的 UTF-8 上限（RFC 6455：123 字节）。 */
const MAX_CLOSE_REASON_BYTES = 123;
/** 暂停后的排空节拍：只在「已经在暂停」时运行，不是常驻定时器。 */
const DRAIN_TICK_MS = 25;
/** 会话归属嗅探的单帧上限：只为日志带 `session_id`，不解析大帧。 */
const SNIFF_MAX_BYTES = 4 * 1024;

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * close code 映射（RFC 6455 §7.4 + 设计 §2.2）：1005/1006/1015 不能上线，
 * 上游异常断开一律让浏览器看到 `1011`，而不是半死连接。
 */
export function mapProxyWsCloseCode(code: number): number {
  if (code === 1005) return 1000;
  if (code === 1006 || code === 1015) return 1011;
  if (code === 1000 || code === 1001 || code === 1002 || code === 1003 || code === 1007)
    return code;
  if (code >= 1008 && code <= 1014) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1011;
}

/** reason 截断到不超过 `maxBytes` 个 UTF-8 字节（不切断 code point）。 */
export function truncateProxyWsReason(reason: string, maxBytes: number): string {
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

/** `who`：谁关的。没有这一项，掉线永远归因不了（设计 §3.4 硬约束 2）。 */
export type ProxyWsClosedBy = 'downstream' | 'upstream' | 'platform';

export interface ProxyWsBridgeOptions {
  nodeId: string;
  /**
   * node 的显示名（日志里打 `node=<名字>`，没有名字才退回 id 前 8 位）。
   * 只用于可读性，不参与任何判定。
   */
  nodeName?: string;
  /** `ws(s)://<node origin>/<ws path>`；origin 只来自注册表。 */
  wsUrl: string;
  /** node 生效 token（只在平台进程内使用）；undefined = 该 node 走回环匿名。 */
  token: string | undefined;
  /** 升级时已由平台会话 / 回环语义通过；此时不等首帧 token。 */
  preAuthenticated: boolean;
  /** 升级 URL 上的 `?since=`（首帧 auth 里的 `since` 更高优先）。 */
  since?: number;
  /** 首帧 token 校验（**平台** token，不是 node token）。 */
  verifyPlatformToken: (token: string) => boolean;
  /** 平台策略：RPC 帧是否允许；返回拒绝原因（null = 放行）。 */
  frameDenied?: (frame: Record<string, unknown>) => string | null;
  limits: PlatformProxyLimits;
  /** 全局待发字节预算（跨连接）。 */
  reserveBytes: (bytes: number) => boolean;
  releaseBytes: (bytes: number) => void;
  /** 记账出口（`gateway.ws.closed` 等）；由组合层决定打到哪。 */
  log: (fields: Record<string, unknown>) => void;
  /**
   * DR15-2 迭代2：server-initiated downstream 关闭计数 hook（诊断用）。
   * Bun 1.3.9 的 onClose 对 was_closed（JS 先置 flags.closed）不减
   * active_connections ⇒ 每次 server-initiated close 永久泄漏 1 计数；
   * 累计值 ≈ pendingWebSockets 里的泄漏量，供 stop 诊断差值归因。
   */
  onServerClose?: () => void;
  /** 可注入的 WS 客户端工厂（探针用）；缺省用全局 `WebSocket`。 */
  connect?: (url: string, headers: Record<string, string>) => ProxyWsUpstream;
  now?: () => number;
}

/**
 * 单条代理 WS 连接。
 *
 * 生命周期：`begin()`（浏览器已升级）→ 平台鉴权（升级时或首帧）→ 连上游 → 双向中继 →
 * `dispose()`（恰好一次，含记账）。
 */
export class ProxyWsBridge {
  private readonly options: ProxyWsBridgeOptions;
  private readonly connId: string;
  private readonly openedAt: number;
  private client?: ProxyWsClient;
  private upstream?: ProxyWsUpstream;
  private closed = false;
  private authed = false;
  private upstreamOpen = false;
  private since = 0;
  private sessionId: string | undefined;

  /** 上游握手超时（浏览器已连、node 未 open）。 */
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  /** 首帧鉴权超时（preAuthenticated 时不启动）。 */
  private authTimer?: ReturnType<typeof setTimeout>;
  /** 排空节拍（仅暂停时存在）。 */
  private drainTimer?: ReturnType<typeof setInterval>;

  /** 待发队列（两方向各一个，**有界**）。 */
  private readonly toClient: Array<string | Uint8Array> = [];
  private toClientBytes = 0;
  private readonly toUpstream: Array<string | Uint8Array> = [];
  private toUpstreamBytes = 0;
  private pausedDownstream = false;
  private pausedUpstream = false;

  private framesIn = 0;
  private bytesIn = 0;
  private framesOut = 0;
  private bytesOut = 0;
  private backpressurePauses = 0;
  private heartbeatMisses = 0;
  /** 上游存活证据：任何入站帧 / pong 都算。 */
  private lastUpstreamActivity: number;
  /** 浏览器存活证据：平台 ping 之后有没有回 pong（或发出任意帧）。 */
  private downstreamAlive = true;

  constructor(options: ProxyWsBridgeOptions) {
    this.options = options;
    this.connId = randomBytes(4).toString('hex');
    this.openedAt = (options.now ?? Date.now)();
    this.lastUpstreamActivity = this.openedAt;
    this.since = typeof options.since === 'number' && options.since > 0 ? options.since : 0;
  }

  get id(): string {
    return this.connId;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 浏览器连接已升级：开始鉴权 / 连上游。 */
  begin(client: ProxyWsClient): void {
    this.client = client;
    if (this.closed) {
      this.closeQuietly(client, 1011, 'proxy_unavailable');
      return;
    }
    if (this.options.preAuthenticated) {
      this.authed = true;
      this.connectUpstream();
      return;
    }
    // 未在升级时确认身份：等首帧 `auth`（浏览器 WS 带不了 Authorization 头）。
    this.authTimer = setTimeout(() => {
      this.authTimer = undefined;
      this.finish(4401, 'auth timeout', 'platform', true, true);
    }, this.options.limits.wsHandshakeTimeoutMs);
    (this.authTimer as { unref?: () => void }).unref?.();
  }

  /** 浏览器 → 代理的一帧。 */
  message(data: unknown): void {
    if (this.closed) return;
    const size = payloadBytes(data);
    if (size === null) return;
    this.downstreamAlive = true;
    this.framesIn += 1;
    this.bytesIn += size;
    const payload = toPayload(data);

    if (!this.authed) {
      const frame = parseJsonObject(payload);
      if (frame === null || frame.kind !== 'auth') {
        this.finish(4401, 'auth required', 'platform', true, true);
        return;
      }
      if (frame.v !== undefined && frame.v !== 1) {
        this.finish(4400, 'unsupported protocol', 'platform', true, true);
        return;
      }
      const token = typeof frame.token === 'string' ? frame.token : '';
      if (!this.options.verifyPlatformToken(token)) {
        this.finish(4401, 'unauthorized', 'platform', true, true);
        return;
      }
      this.authed = true;
      this.clearAuthTimer();
      if (typeof frame.since === 'number' && frame.since > 0) this.since = frame.since;
      this.connectUpstream();
      return;
    }

    // 已鉴权：平台策略先判帧（`req` 的方法白名单，fail-closed），再决定是否转发。
    const sniffed = this.sniff(payload);
    if (sniffed !== null) {
      // 浏览器带来的 `auth` 首帧**永不转发**：它装的是平台 token（或空串），
      // 到了 node 侧要么无意义、要么等于把平台凭据交给 node。上游鉴权由平台自己发。
      if (sniffed.kind === 'auth') return;
      const denied = this.options.frameDenied?.(sniffed);
      if (denied !== null && denied !== undefined) {
        this.sendResultError(sniffed, denied);
        return;
      }
    }
    this.sendUpstream(payload, size);
  }

  /** 浏览器侧关闭（Bun `close` 回调）。 */
  clientClose(code: number, reason?: string): void {
    this.finish(code, reason ?? '', 'downstream', false, true);
  }

  /** 浏览器侧 pong（协议层）。 */
  pong(): void {
    this.downstreamAlive = true;
  }

  /**
   * 平台侧心跳节拍（由 `PlatformProxy` 统一驱动，一条连接不一个定时器）。
   *
   * - 下游：平台自己发 ping；上一拍之后既没有 pong、也没有任何帧 → `heartbeat_misses` +1，
   *   连续两次没有证据（≈ 2 × 间隔 ≥ 判死阈值）就是判定它死了 → 1001 `heartbeat timeout`。
   * - 上游：超过判死阈值没有任何入站证据 → 1011 `upstream_timeout`（node 有自己的 ping，
   *   正常情况下这条永远不会触发）。
   */
  heartbeat(now = Date.now()): void {
    if (this.closed) return;
    const { wsHeartbeatTimeoutMs } = this.options.limits;

    if (!this.downstreamAlive) {
      this.heartbeatMisses += 1;
      const missesSpanMs = this.heartbeatMisses * this.options.limits.wsHeartbeatIntervalMs;
      if (missesSpanMs >= wsHeartbeatTimeoutMs) {
        this.finish(1001, 'heartbeat timeout', 'platform', true, true);
        return;
      }
    } else {
      this.downstreamAlive = false;
    }
    const client = this.client;
    if (client !== undefined) {
      try {
        client.ping();
      } catch {
        // 已关闭的连接不保证还能发控制帧（下一拍会按判死处理）。
      }
    }

    if (this.upstreamOpen && now - this.lastUpstreamActivity > wsHeartbeatTimeoutMs) {
      this.finish(1011, 'upstream_timeout', 'platform', true, true);
      return;
    }
    this.flushQueues();
  }

  /** 平台停服：双向关闭（`who: 'platform'`）。 */
  shutdown(): void {
    this.finish(1001, 'server stopping', 'platform', true, true);
  }

  /** 上游连接失败 / 不可达。 */
  failUpstream(reason: string): void {
    this.finish(1011, reason, 'platform', true, true);
  }

  private connectUpstream(): void {
    if (this.closed || this.upstream !== undefined) return;
    this.armHandshake();
    let upstream: ProxyWsUpstream;
    try {
      const factory = this.options.connect ?? defaultConnect;
      upstream = factory(this.options.wsUrl, {});
    } catch {
      this.finish(1011, 'upstream_error', 'platform', true, true);
      return;
    }
    this.upstream = upstream;
    upstream.addEventListener('open', () => {
      if (this.closed) return;
      this.upstreamOpen = true;
      this.clearHandshake();
      this.lastUpstreamActivity = (this.options.now ?? Date.now)();
      // 平台自己的鉴权帧（node token 只在平台进程内出现）。
      const token = this.options.token ?? '';
      upstream.send(
        JSON.stringify({
          v: 1,
          kind: 'auth',
          ...(token !== '' ? { token } : {}),
          since: this.since,
        }),
      );
      this.flushQueues();
    });
    upstream.addEventListener('message', (event) => this.fromUpstream(event.data));
    upstream.addEventListener('close', (event) => {
      const code = event.code ?? 1006;
      const reason = event.reason ?? '';
      if (this.closed) return;
      this.finish(code, reason, 'upstream', true, false);
    });
    upstream.addEventListener('error', () => {
      if (this.closed) return;
      this.finish(1011, 'upstream_error', 'platform', true, true);
    });
  }

  private fromUpstream(data: unknown): void {
    if (this.closed) return;
    const size = payloadBytes(data);
    if (size === null) return;
    this.lastUpstreamActivity = (this.options.now ?? Date.now)();
    const sniffed = this.sniff(toPayload(data));
    if (sniffed !== null) {
      // 平台**自己**回 node 的应用层 ping（设计 §2.2：上游存活是平台的责任）。
      //
      // 为什么不能只靠透传：node 每 15s 发一帧 `{kind:'ping'}`，只认客户端的
      // `{kind:'pong'}`；而浏览器标签页休眠 / 被节流时根本不回帧 —— 那样 node 会认为
      // 「客户端死了」并主动断开，用户看到的是「随机掉线」。这里平台代答，浏览器那一端
      // 的存活由平台自己发起的 WS ping（`heartbeat_misses`）单独判定，两件事不混。
      if (sniffed.kind === 'ping') this.pongUpstream();
      const sessionId = readSessionId(sniffed);
      if (sessionId !== undefined) this.sessionId = sessionId;
    }
    // node 的心跳帧（应用层 ping/pong）仍然原样透传：浏览器侧需要它维持既有语义。
    this.framesOut += 1;
    this.bytesOut += size;
    this.sendDownstream(toPayload(data), size);
  }

  /** 代答 node 的应用层 ping（失败即上游已断，交给 close/error 收口）。 */
  private pongUpstream(): void {
    const upstream = this.upstream;
    if (upstream === undefined || !this.upstreamOpen) return;
    try {
      upstream.send(JSON.stringify({ v: 1, kind: 'pong' }));
    } catch {
      // 已断：后续 close 事件会走唯一收口。
    }
  }

  /** 写浏览器侧：高水位 → 进有界队列；硬阈值 → 1013。 */
  private sendDownstream(payload: string | Uint8Array, size: number): void {
    const client = this.client;
    if (client === undefined) return;
    if (this.pausedDownstream) {
      this.queueDownstream(payload, size);
      return;
    }
    try {
      client.send(payload);
    } catch {
      this.finish(1011, 'client_gone', 'platform', false, true);
      return;
    }
    if (client.getBufferedAmount() > this.options.limits.wsHighWaterBytes) {
      this.backpressurePauses += 1;
      this.pausedDownstream = true;
      this.armDrain();
    }
  }

  private queueDownstream(payload: string | Uint8Array, size: number): void {
    if (!this.reserve(size)) {
      this.finish(1013, 'backpressure_overflow', 'platform', true, true);
      return;
    }
    this.toClient.push(payload);
    this.toClientBytes += size;
    if (this.toClientBytes > this.options.limits.wsHardLimitBytes) {
      this.finish(1013, 'backpressure_overflow', 'platform', true, true);
    }
  }

  /** 写上游：node 慢（`bufferedAmount` 高）= 一样的处理，不无界缓存。 */
  private sendUpstream(payload: string | Uint8Array, size: number): void {
    const upstream = this.upstream;
    if (upstream === undefined) {
      // 还没连上游：先排队（握手期间）。队列同样有界。
      this.queueUpstream(payload, size);
      return;
    }
    if (!this.upstreamOpen || this.pausedUpstream) {
      this.queueUpstream(payload, size);
      return;
    }
    try {
      upstream.send(payload);
    } catch {
      this.finish(1011, 'upstream_error', 'platform', true, true);
      return;
    }
    if (upstream.bufferedAmount > this.options.limits.wsHighWaterBytes) {
      this.backpressurePauses += 1;
      this.pausedUpstream = true;
      this.armDrain();
    }
  }

  private queueUpstream(payload: string | Uint8Array, size: number): void {
    if (!this.reserve(size)) {
      this.finish(1013, 'backpressure_overflow', 'platform', true, true);
      return;
    }
    this.toUpstream.push(payload);
    this.toUpstreamBytes += size;
    if (this.toUpstreamBytes > this.options.limits.wsHardLimitBytes) {
      this.finish(1013, 'backpressure_overflow', 'platform', true, true);
    }
  }

  /** 排空节拍：只在暂停时存在，两个方向都低于低水位后自停。 */
  private armDrain(): void {
    if (this.drainTimer !== undefined || this.closed) return;
    this.drainTimer = setInterval(() => this.flushQueues(), DRAIN_TICK_MS);
    unrefTimer(this.drainTimer);
  }

  /**
   * 排空两方向的**有界队列**。
   *
   * 关键一条（0.58 实测踩到）：上游握手期间排队的帧**必须在 `open` 后立刻发出**，
   * 不能只等「暂停恢复」时才发 —— 否则浏览器在握手窗口里发的前几条 `req` 会一直躺在
   * 队列里，直到下一次心跳才可能被带出去（症状：连上了但订阅/请求像没生效）。
   */
  private flushQueues(): void {
    if (this.closed) {
      this.clearDrain();
      return;
    }
    const { wsLowWaterBytes, wsHighWaterBytes } = this.options.limits;
    const client = this.client;
    if (
      this.pausedDownstream &&
      client !== undefined &&
      client.getBufferedAmount() <= wsLowWaterBytes
    ) {
      this.pausedDownstream = false;
    }
    const upstream = this.upstream;
    if (
      this.pausedUpstream &&
      upstream !== undefined &&
      upstream.bufferedAmount <= wsLowWaterBytes
    ) {
      this.pausedUpstream = false;
    }

    if (client !== undefined && !this.pausedDownstream) {
      while (this.toClient.length > 0) {
        const payload = this.toClient.shift();
        if (payload === undefined) break;
        const size = payloadBytes(payload) ?? 0;
        this.toClientBytes -= size;
        this.release(size);
        try {
          client.send(payload);
        } catch {
          this.finish(1011, 'client_gone', 'platform', false, true);
          return;
        }
        if (client.getBufferedAmount() > wsHighWaterBytes) {
          this.pausedDownstream = true;
          break;
        }
      }
    }

    if (upstream !== undefined && this.upstreamOpen && !this.pausedUpstream) {
      while (this.toUpstream.length > 0) {
        const payload = this.toUpstream.shift();
        if (payload === undefined) break;
        const size = payloadBytes(payload) ?? 0;
        this.toUpstreamBytes -= size;
        this.release(size);
        try {
          upstream.send(payload);
        } catch {
          this.finish(1011, 'upstream_error', 'platform', true, true);
          return;
        }
        if (upstream.bufferedAmount > wsHighWaterBytes) {
          this.pausedUpstream = true;
          break;
        }
      }
    }

    if (
      !this.pausedDownstream &&
      !this.pausedUpstream &&
      this.toClient.length === 0 &&
      this.toUpstream.length === 0
    ) {
      this.clearDrain();
    }
  }

  private reserve(bytes: number): boolean {
    return this.options.reserveBytes(bytes);
  }

  private release(bytes: number): void {
    this.options.releaseBytes(bytes);
  }

  /** 只解析小帧（会话归属 / 方法白名单 / 心跳），大帧不动。 */
  private sniff(payload: string | Uint8Array): Record<string, unknown> | null {
    let text: string;
    if (typeof payload === 'string') {
      if (payload.length > SNIFF_MAX_BYTES) return null;
      text = payload;
    } else {
      if (payload.byteLength > SNIFF_MAX_BYTES) return null;
      text = new TextDecoder().decode(payload);
    }
    return parseJsonObject(text);
  }

  /** 回一帧错误（形状与 node 的 `res` 一致），不转发、不断连。 */
  private sendResultError(frame: Record<string, unknown>, message: string): void {
    const id = typeof frame.id === 'string' ? frame.id : '';
    this.sendDownstream(
      JSON.stringify({
        v: 1,
        kind: 'res',
        node_id: this.options.nodeId,
        ts: Date.now(),
        id,
        ok: false,
        error: { code: 'forbidden', message },
      }),
      0,
    );
  }

  private armHandshake(): void {
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = undefined;
      this.finish(1011, 'upstream_timeout', 'platform', true, true);
    }, this.options.limits.wsHandshakeTimeoutMs);
    (this.handshakeTimer as { unref?: () => void }).unref?.();
  }

  private clearHandshake(): void {
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private clearAuthTimer(): void {
    if (this.authTimer !== undefined) {
      clearTimeout(this.authTimer);
      this.authTimer = undefined;
    }
  }

  private clearDrain(): void {
    if (this.drainTimer !== undefined) {
      clearInterval(this.drainTimer);
      this.drainTimer = undefined;
    }
  }

  /** 关闭时释放队列占用的全局预算（恰好一次）。 */
  private releasePending(): void {
    const total = this.toClientBytes + this.toUpstreamBytes;
    this.toClient.length = 0;
    this.toUpstream.length = 0;
    this.toClientBytes = 0;
    this.toUpstreamBytes = 0;
    if (total > 0) this.release(total);
  }

  private closeQuietly<
    T extends { close(code?: number, reason?: string): void; terminate?(): void },
  >(target: T | undefined, code?: number, reason?: string): void {
    if (target === undefined) return;
    try {
      // DR15-2 迭代2：优先 terminate()（立即 us_socket_close，无握手）——
      // graceful close() 在对端不 echo 时留 CLOSING 残留（idleTimeout 兜底被
      // native 卡死饿死），stop(true) 收尾被 CLOSING socket 卡死。terminate
      // 必须在任何 graceful close 之前：close() 先置 flags.closed，之后
      // terminate() 是 no-op（Bun 1.3.9 ServerWebSocket.zig:1095-1110）。
      if (typeof target.terminate === 'function') target.terminate();
      else target.close(code, reason);
    } catch {
      // 已关闭的对端不再重试。
    }
    // 累计 server-initiated downstream close（≈ Bun 计数泄漏量；已闭 socket
    // 上 terminate no-op 会略多计，诊断口径为近似归因，不影响行为）。
    if (this.client !== undefined && (target as unknown) === (this.client as unknown)) {
      this.options.onServerClose?.();
    }
  }

  /**
   * 唯一收口：幂等、清理全部 timer / 预算、双向 close、写**一条** `gateway.ws.closed`。
   *
   * `who` 必填：区分「浏览器走了」「node 崩了」「平台主动关」。
   */
  private finish(
    code: number,
    reason: string,
    who: ProxyWsClosedBy,
    closeClient: boolean,
    closeUpstream: boolean,
  ): void {
    if (this.closed) return;
    this.closed = true;
    this.clearHandshake();
    this.clearAuthTimer();
    this.clearDrain();
    this.releasePending();

    const mapped = mapProxyWsCloseCode(code);
    const safeReason = truncateProxyWsReason(reason, MAX_CLOSE_REASON_BYTES);
    if (closeClient) this.closeQuietly(this.client, mapped, safeReason);
    if (closeUpstream) this.closeQuietly(this.upstream, mapped, safeReason);

    const now = (this.options.now ?? Date.now)();
    this.options.log({
      event: 'gateway.ws.closed',
      via: 'proxy',
      conn_id: this.connId,
      node_id: this.options.nodeId,
      ...(this.options.nodeName !== undefined ? { node_name: this.options.nodeName } : {}),
      who,
      code: mapped,
      reason: safeReason,
      ...(this.sessionId !== undefined ? { session_id: this.sessionId } : {}),
      duration_ms: Math.max(0, now - this.openedAt),
      frames_in: this.framesIn,
      frames_out: this.framesOut,
      bytes_in: this.bytesIn,
      bytes_out: this.bytesOut,
      backpressure_pauses: this.backpressurePauses,
      heartbeat_misses: this.heartbeatMisses,
      upstream_open: this.upstreamOpen,
    });
  }
}

function defaultConnect(url: string, headers: Record<string, string>): ProxyWsUpstream {
  const Ctor = WebSocket as unknown as new (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => ProxyWsUpstream;
  return new Ctor(url, { headers });
}

function parseJsonObject(payload: string | Uint8Array): Record<string, unknown> | null {
  const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
  if (!text.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readSessionId(frame: Record<string, unknown>): string | undefined {
  const params = frame.params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined;
  const sessionId = (params as Record<string, unknown>).session_id;
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined;
}
