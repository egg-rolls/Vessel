/**
 * Node 连接 / 传输层：WS 生命周期、帧处理、请求应答与监听器。
 *
 * 0.49 G1：这是 node 客户端（`/v1/rpc`、`/v1/events`）；平台客户端在
 * 平台客户端目录，两者互不 import。
 */

import { t } from '../../i18n';

/**
 * 当前 origin，**不直接引用 **（0.52）。
 *
 * 原因：这个文件被零依赖探针（）间接 import，
 * 而根 tsconfig 没有 DOM lib ⇒ 任何  都会在根 typecheck 里报
 * “Property 'x' does not exist on type 'Window'”。这里用  的结构化读取，
 * 浏览器与 Node 两侧都能编过（Node 侧只是拿不到 origin，回落到默认值）。
 */
function currentOrigin(): string {
  const location = (globalThis as { location?: { origin?: string } }).location;
  return typeof location?.origin === 'string' && location.origin !== ''
    ? location.origin
    : 'http://127.0.0.1';
}

import type {
  GatewayErrorBody,
  HelloInfo,
  HelloTimelineSegment,
  RunEvent,
  ServerFrame,
  TimelineEpochEndFrame,
} from '../types';
import { toWebSocketBase } from '../url';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

/** REST / WS 错误（携带 gateway 稳定 code；HTTP 还带 details） */
export class GatewayHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}

export interface EventMeta {
  seq: number;
  jobId?: string;
}

/**
 * hello 帧的**平铺**时间线段 → 内部归一化对象（`HelloTimelineSegment`）。
 *
 * 线上形状由 `packages/serve/src/gateway/frames.ts#helloFrame` 决定：时间线 epoch 会把六个
 * 字段（+ `published_head` / `reset`）**平铺**在 hello 帧上，**没有**嵌套的 `timeline` 对象。
 * 0.54 B1 起线的两端就一直是这个形状；客户端早先按嵌套对象读，于是
 * `readTimelineHelloSegment(source, undefined)` 永远返回 `undefined` —— 四条校验与
 * epoch 记账在真机上从未生效（一律退化成老 epoch 行为）。这个映射就是那处修复。
 *
 * 判据（不猜，0.55 只认形状）：时间线的键缺一个 / 不是非负整数 ⇒ 不给（半截实现按老 epoch
 * 处理，宁可不校验也不假校验）。0.54 的 `timeline_source` 显式标记已删除 —— 它当初的用途
 * 正是这个判据，而现在形状本身就是完整的判据（服务端同步停发该键）。
 */
function readHelloTimelineSegment(frame: {
  start_seq?: number;
  end_seq?: number;
  count?: number;
  timeline_head?: number;
  wal_head?: number;
  published_head?: number;
  holes?: { from_seq: number; to_seq: number }[];
  tainted?: boolean;
  reset?: boolean;
}): HelloTimelineSegment | undefined {
  const isSeq = (value: number | undefined): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0;
  const {
    start_seq: start,
    end_seq: end,
    count,
    timeline_head: timelineHead,
    wal_head: walHead,
  } = frame;
  if (!isSeq(start) || !isSeq(end) || !isSeq(count)) return undefined;
  if (!isSeq(timelineHead) || !isSeq(walHead)) return undefined;
  return {
    start_seq: start,
    end_seq: end,
    count,
    timeline_head: timelineHead,
    wal_head: walHead,
    // `(published_head, wal_head]` 允许永不被推送；缺省 = 全部已发布（与 core 同口径）。
    ...(isSeq(frame.published_head)
      ? { published_head: Math.min(frame.published_head, walHead) }
      : {}),
    holes: Array.isArray(frame.holes) ? frame.holes : [],
    tainted: frame.tainted === true,
    ...(frame.reset === true ? { reset: true as const } : {}),
  };
}

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 30_000;

/** 0.58：客户端构造选项。 */
export interface ProtocolClientOptions {
  /**
   * `true` = 数据面走**平台代理**（`<platform>/nodes/<node_id>`）。
   *
   * 两处不同（其余逐字不变）：
   * - HTTP 不带 `Authorization` 也可以（鉴权靠平台会话 cookie / 平台 token）；
   * - `/health` 预探要带 cookie（`credentials: 'same-origin'`），否则恒 401。
   *
   * 为什么不能让「空 token」在所有模式下都合法：直连 node 时空 token 曾经是
   * 「node 回环匿名」的合法语义，放宽会掩盖真正的凭据缺失。
   */
  proxy?: boolean;
}

export abstract class ProtocolClient {
  private readonly baseUrl: string;
  /** 0.58：代理数据面（见 {@link ProtocolClientOptions.proxy}）。 */
  protected readonly proxyMode: boolean;
  protected token: string | null = null;
  private ws: WebSocket | null = null;
  protected state: ConnectionState = 'idle';
  protected helloInfo: HelloInfo | null = null;
  private lastCloseCode: number | null = null;

  private readonly eventListeners = new Set<(event: RunEvent, meta: EventMeta) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly helloListeners = new Set<(info: HelloInfo) => void>();
  /** 0.55：时间线 epoch 的显式结束标记（`timeline-epoch-end`）。 */
  private readonly epochEndListeners = new Set<(end: TimelineEpochEndFrame) => void>();
  private readonly closeListeners = new Set<(code: number) => void>();

  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      /** DOM 侧是 number，Node 侧是 Timeout ⇒ 用 ReturnType 两种 lib 都能编 */
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  constructor(baseUrl = '', options: ProtocolClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.proxyMode = options.proxy === true;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get protocol(): HelloInfo | null {
    return this.helloInfo;
  }

  get closedWithCode(): number | null {
    return this.lastCloseCode;
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    for (const cb of [...this.stateListeners]) cb(next);
  }

  onState(cb: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    cb(this.state);
    return () => this.stateListeners.delete(cb);
  }

  onEvent(cb: (event: RunEvent, meta: EventMeta) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  onHello(cb: (info: HelloInfo) => void): () => void {
    this.helloListeners.add(cb);
    return () => this.helloListeners.delete(cb);
  }

  /**
   * 时间线 epoch 的显式结束标记（0.55，能力位 `timeline.epoch-end`）。
   *
   * 只在服务端把本趟声明区间**整趟发完**时到来；提前停不发（那时客户端从订阅 `res`
   * 那条显式事实收尾，见 `SubscriptionController#run`）。老服务端（0.54）永远不触发它，
   * 所以订阅层不能把它当唯一出口。
   */
  onEpochEnd(cb: (end: TimelineEpochEndFrame) => void): () => void {
    this.epochEndListeners.add(cb);
    return () => this.epochEndListeners.delete(cb);
  }

  onClose(cb: (code: number) => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  protected httpBase(): string {
    return this.baseUrl || currentOrigin();
  }

  private wsUrl(since: number): string {
    return `${toWebSocketBase(this.httpBase())}/v1/events?since=${since}`;
  }

  /**
   * 连接前预探 `/health`：把 Origin 403 / TLS / 网络错误与 WS 鉴权失败区分开。
   * `/health` 公开（远程模式也不要求 token），但同样经过 Host/Origin 校验；
   * 跨 Origin 且未列入 allowlist 时浏览器会以 CORS 失败形式报 network。
   */
  async probeHealth(timeoutMs = 5_000): Promise<void> {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.httpBase()}/health`, {
        method: 'GET',
        // 0.58：代理数据面靠平台会话 cookie 鉴权，`omit` 会把 cookie 丢掉 ⇒ 恒 401。
        credentials: this.proxyMode ? 'same-origin' : 'omit',
        signal: controller.signal,
      });
      if (res.ok) return;
      let code = 'internal';
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as GatewayErrorBody;
        if (body?.error?.code) {
          code = body.error.code;
          message = body.error.message || message;
        }
      } catch {
        // 非 JSON 错误体：保留 HTTP 状态
      }
      throw new GatewayHttpError(code, message, res.status);
    } catch (error) {
      if (error instanceof GatewayHttpError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GatewayHttpError('network', t('gateway.client.timeout'));
      }
      throw new GatewayHttpError('network', error instanceof Error ? error.message : String(error));
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  /** 建立 WS 并完成首帧鉴权；resolve 时机是收到 hello。 */
  connect(token: string, since = 0): Promise<void> {
    // 0.49：空 token 合法——平台 `credentials` 返回 `mode:'none'` 时，node 走
    // 回环匿名语义；是否接受由 node 服务端鉴权决定（WS 4401 会如实回报）。
    const tk = token.trim();
    if (this.state === 'open') return Promise.resolve();
    if (this.state === 'connecting' && this.connectResolve) {
      return new Promise<void>((resolve, reject) => {
        const previousResolve = this.connectResolve;
        const previousReject = this.connectReject;
        this.connectResolve = () => {
          previousResolve?.();
          resolve();
        };
        this.connectReject = (error) => {
          previousReject?.(error);
          reject(error);
        };
      });
    }

    this.close();
    this.token = tk;

    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.setState('connecting');
      this.lastCloseCode = null;

      let ws: WebSocket;
      try {
        ws = new WebSocket(this.wsUrl(since));
      } catch (error) {
        this.failConnect(error instanceof Error ? error.message : String(error));
        return;
      }
      this.ws = ws;

      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            v: 1,
            kind: 'auth',
            token: tk,
            since,
          }),
        );
      });

      ws.addEventListener('message', (event) => {
        // 已切到新连接（如 seq 回退重放）时，旧 socket 的在途帧必须丢弃。
        if (this.ws !== ws) return;
        this.handleFrame(String(event.data));
      });

      ws.addEventListener('error', () => {
        // close 事件会带 code；这里只保证 connect 不会永远挂起。
        if (this.state === 'connecting') this.failConnect(t('gateway.client.wsFailed'));
      });

      ws.addEventListener('close', (event) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.lastCloseCode = event.code;
        this.rejectPending(new Error(t('gateway.client.closedWithCode', { code: event.code })));
        const message = closeMessage(event.code);
        if (this.state === 'connecting') {
          this.failConnect(message);
        } else {
          this.setState(event.code === 1000 ? 'closed' : 'error');
        }
        for (const cb of [...this.closeListeners]) cb(event.code);
      });
    });
  }

  /**
   * 丢弃当前连接并以指定 since 重新建连。
   * 与 `connect` 不同：即使 state 已是 open 也会强制重建（seq 回退重放）。
   */
  restart(token: string, since = 0): Promise<void> {
    this.close();
    return this.connect(token, since);
  }

  private failConnect(message: string): void {
    const reject = this.connectReject;
    this.connectResolve = null;
    this.connectReject = null;
    this.setState('error');
    reject?.(new Error(message));
  }

  private handleFrame(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }

    switch (frame.kind) {
      case 'hello': {
        // 时间线段在**线上是平铺的**（`start_seq` / `end_seq` / `count` / …），
        // 归一化成一个对象往下传。这里是唯一一处 wire → 内部形状的映射：下游
        // （四条校验 / `beginTimelineEpoch`）只认一个对象。
        //
        // 形状不全 ⇒ 不给 `timeline`（fail-closed 当成老 epoch）：六个键缺一个，说明对端是
        // 半截实现，按「不做四条校验」处理。0.55 起**没有**别的判据（`timeline_source` 已删）。
        const segment = readHelloTimelineSegment(frame);
        // `connectResolve` 非空 = 这条 hello 是 `connect()` 正在等的那条（连接级）。
        // 必须在下面 `resolve` 之前取快照，否则重连 / 订阅交错时判不出来。
        const connectionLevel = this.connectResolve !== null;
        this.helloInfo = {
          protocol: frame.protocol,
          node: frame.node,
          from_seq: frame.from_seq,
          latest_seq: frame.latest_seq,
          ...(connectionLevel ? { connectionLevel: true as const } : {}),
          ...(segment !== undefined ? { timeline: segment } : {}),
        };
        this.setState('open');
        const resolve = this.connectResolve;
        this.connectResolve = null;
        this.connectReject = null;
        resolve?.();
        for (const cb of [...this.helloListeners]) cb(this.helloInfo);
        return;
      }
      case 'event': {
        for (const cb of [...this.eventListeners]) {
          cb(frame.event, {
            seq: frame.seq,
            ...(frame.job_id ? { jobId: frame.job_id } : {}),
          });
        }
        return;
      }
      case 'timeline-epoch-end': {
        // 0.55：结趟的**显式**事实（`{end_seq, count, has_more}`）。形状不全就当没收到
        // （老客户端行为等价于空行；这里也守住「不猜」）：三个字段缺一个都不结趟。
        if (
          typeof frame.end_seq !== 'number' ||
          !Number.isFinite(frame.end_seq) ||
          typeof frame.count !== 'number' ||
          !Number.isFinite(frame.count) ||
          typeof frame.has_more !== 'boolean'
        ) {
          return;
        }
        for (const cb of [...this.epochEndListeners]) cb(frame);
        return;
      }
      case 'res': {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        globalThis.clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(frame.result);
        else
          pending.reject(
            new GatewayHttpError(
              frame.error.code,
              `${frame.error.code}: ${frame.error.message}`,
              undefined,
              frame.error.details,
            ),
          );
        return;
      }
      case 'ping': {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ v: 1, kind: 'pong' }));
        }
        return;
      }
      default:
        return;
    }
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      globalThis.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** WS 请求/响应；超时拒绝 */
  request<T>(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.helloInfo) {
      return Promise.reject(new Error(t('gateway.client.notConnected')));
    }
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(t('gateway.client.requestTimeout', { method })));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      ws.send(JSON.stringify({ v: 1, kind: 'req', id, method, params }));
    });
  }

  /**
   * 自报时间线缺口（0.54 B1 的唯一接收路径）：同一条 WS 连接上发一帧
   * `{kind:'timeline_gap', …}`，**不新开 RPC 方法** —— 这条报告要能在 RPC 通道本身出问题
   * （订阅刚被拒 / 服务端正忙）时仍然送达，语义上是「传输层事实」。
   *
   * best-effort：连不上就丢（服务端侧同样只记录、不改事实源）。
   */
  reportTimelineGap(frame: {
    session_id?: string;
    expected?: number;
    received?: number;
    start_seq?: number;
    end_seq?: number;
    after_timeline_seq?: number;
    check?: 1 | 2 | 3 | 4;
  }): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ v: 1, kind: 'timeline_gap', ...frame }));
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.token = null;
    this.helloInfo = null;
    this.rejectPending(new Error(t('gateway.client.closed')));
    if (ws) {
      ws.close();
    }
    if (this.state !== 'idle') this.setState('closed');
  }
}

/** WS close code → 用户可读信息 */
function closeMessage(code: number): string {
  switch (code) {
    case 4400:
      return t('gateway.connection.protocolMismatch');
    case 4401:
      return t('gateway.connection.authFailed');
    case 4403:
      return t('gateway.connection.forbiddenTenant');
    case 1001:
      return t('gateway.client.stopped');
    case 1006:
      return t('gateway.client.unreachable');
    default:
      return t('gateway.client.closedWithCode', { code });
  }
}
