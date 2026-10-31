/**
 * Gateway 连接 / 传输层：WS 生命周期、帧处理、请求应答与监听器。
 *
 * 从 `client.ts` 拆出（S1）；行为与原单文件一致。
 */

import { t } from '../../i18n';
import type { GapFrame, GatewayErrorBody, HelloInfo, RunEvent, ServerFrame } from '../types';
import { toWebSocketBase } from '../url';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

/** REST 错误（携带 gateway 稳定 code） */
export class GatewayHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}

export interface EventMeta {
  seq: number;
  jobId?: string;
}

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 30_000;

export abstract class ProtocolClient {
  private readonly baseUrl: string;
  protected token: string | null = null;
  private ws: WebSocket | null = null;
  protected state: ConnectionState = 'idle';
  protected helloInfo: HelloInfo | null = null;
  private lastCloseCode: number | null = null;

  private readonly eventListeners = new Set<(event: RunEvent, meta: EventMeta) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly helloListeners = new Set<(info: HelloInfo) => void>();
  private readonly gapListeners = new Set<(gap: GapFrame) => void>();
  private readonly closeListeners = new Set<(code: number) => void>();

  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number }
  >();

  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
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

  onGap(cb: (gap: GapFrame) => void): () => void {
    this.gapListeners.add(cb);
    return () => this.gapListeners.delete(cb);
  }

  onClose(cb: (code: number) => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  protected httpBase(): string {
    return this.baseUrl || window.location.origin;
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
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.httpBase()}/health`, {
        method: 'GET',
        credentials: 'omit',
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
      window.clearTimeout(timer);
    }
  }

  /**
   * 建立 WS 并完成首帧鉴权；resolve 时机是收到 hello。
   * tenantId 仅对 admin principal 生效（非 admin 传其它 tenant 会被 4403 关闭）。
   */
  connect(token: string, since = 0, tenantId?: string): Promise<void> {
    const tk = token.trim();
    if (!tk) return Promise.reject(new Error(t('gateway.client.tokenRequired')));
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
            ...(tenantId !== undefined && tenantId !== '' ? { tenant_id: tenantId } : {}),
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
  restart(token: string, since = 0, tenantId?: string): Promise<void> {
    this.close();
    return this.connect(token, since, tenantId);
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
        this.helloInfo = {
          protocol: frame.protocol,
          node: frame.node,
          from_seq: frame.from_seq,
          latest_seq: frame.latest_seq,
          // 0.5 hello 携带 token 解析出的 tenant；丢掉会让 tenant 徽章/切换失准。
          ...(frame.tenant_id !== undefined ? { tenant_id: frame.tenant_id } : {}),
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
      case 'gap': {
        for (const cb of [...this.gapListeners]) cb(frame);
        return;
      }
      case 'res': {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        window.clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
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
      window.clearTimeout(pending.timer);
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
      const timer = window.setTimeout(() => {
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
