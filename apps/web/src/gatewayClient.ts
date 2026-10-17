/**
 * Browser gateway client —— 连接 Vessel gateway（vessel.gateway/1）。
 *
 * 协议（见 packages/serve/src/gateway.ts）：
 *   - WS    `/v1/events?since=<seq>`，首帧 `{kind:'auth', token}`；服务端回 `hello`
 *   - 帧    `event` / `gap` / `res` / `ping`（见 packages/serve/src/protocol.ts）
 *   - REST  `/v1/sessions` / `/v1/tools`（Bearer 头，仅在 WS 不可用时兜底）
 *
 * 浏览器默认同源（gateway 托管 dist，或 Vite proxy）；VITE_GATEWAY_URL 可覆盖。
 */

import type {
  AskUserAnswer,
  DurableRunSummary,
  DurableRunsResponse,
  GapFrame,
  GatewayErrorBody,
  HelloInfo,
  McpServerStatus,
  McpServersResponse,
  RunEvent,
  RunStatus,
  ServerFrame,
  SessionInfo,
  ToolInfo,
} from './types';

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

export class GatewayClient {
  private readonly baseUrl: string;
  private token: string | null = null;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'idle';
  private helloInfo: HelloInfo | null = null;
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

  private httpBase(): string {
    return this.baseUrl || window.location.origin;
  }

  private wsUrl(since: number): string {
    const http = this.httpBase();
    const ws = http.replace(/^http/, 'ws');
    return `${ws}/v1/events?since=${since}`;
  }

  /** 建立 WS 并完成首帧鉴权；resolve 时机是收到 hello */
  connect(token: string, since = 0): Promise<void> {
    const tk = token.trim();
    if (!tk) return Promise.reject(new Error('token 不能为空'));
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
        ws.send(JSON.stringify({ v: 1, kind: 'auth', token: tk, since }));
      });

      ws.addEventListener('message', (event) => {
        this.handleFrame(String(event.data));
      });

      ws.addEventListener('error', () => {
        // close 事件会带 code；这里只保证 connect 不会永远挂起。
        if (this.state === 'connecting') this.failConnect('WebSocket 连接失败');
      });

      ws.addEventListener('close', (event) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.lastCloseCode = event.code;
        this.rejectPending(new Error(`连接已关闭（${event.code}）`));
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
      return Promise.reject(new Error('gateway 尚未连接'));
    }
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时：${method}`));
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
    this.rejectPending(new Error('连接已关闭'));
    if (ws) {
      ws.close();
    }
    if (this.state !== 'idle') this.setState('closed');
  }

  // ── 语义方法 ──────────────────────────────────

  submitRun(
    input: string,
    sessionId?: string,
  ): Promise<{ run_id: string; status: RunStatus['status']; queue_position?: number }> {
    return this.request('run.submit', {
      input,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  }

  cancelRun(runId: string): Promise<{ cancelled: boolean }> {
    return this.request('run.cancel', { run_id: runId });
  }

  getRun(runId: string): Promise<RunStatus> {
    return this.request('run.get', { run_id: runId });
  }

  async listSessions(): Promise<SessionInfo[]> {
    const body = await this.request<{ sessions?: SessionInfo[] }>('sessions.list');
    return body.sessions ?? [];
  }

  async listTools(): Promise<ToolInfo[]> {
    const body = await this.request<{ tools?: ToolInfo[] }>('tools.list');
    return body.tools ?? [];
  }

  async respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember = false,
  ): Promise<void> {
    await this.request('permission.respond', {
      request_id: requestId,
      decision,
      ...(remember ? { remember: true } : {}),
    });
  }

  /** 回答 ask_user；answers=[] 表示取消 */
  async respondAsk(requestId: string, answers: AskUserAnswer[]): Promise<void> {
    await this.request('ask.respond', { request_id: requestId, answers });
  }

  // ── 0.3 REST（durable / MCP）──────────────────

  private async httpJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.token;
    if (!token) throw new GatewayHttpError('unauthorized', '缺少 gateway token');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);

    let res: Response;
    try {
      res = await fetch(`${this.httpBase()}${path}`, { ...init, headers });
    } catch (error) {
      throw new GatewayHttpError('network', error instanceof Error ? error.message : String(error));
    }
    if (!res.ok) {
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
    }
    return (await res.json()) as T;
  }

  /** interrupted/其它状态的 durable run 摘要 */
  async listDurableRuns(
    params: { status?: string; session_id?: string; limit?: number } = {},
  ): Promise<DurableRunSummary[]> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.session_id) query.set('session_id', params.session_id);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const suffix = query.toString();
    const body = await this.httpJson<DurableRunsResponse>(
      `/v1/durable/runs${suffix ? `?${suffix}` : ''}`,
    );
    return body.runs ?? [];
  }

  /** 恢复一个 durable run；gateway 受理后返回 queued */
  resumeDurableRun(runId: string): Promise<{ run_id: string; status: 'queued' }> {
    return this.httpJson(`/v1/durable/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST',
    });
  }

  /** MCP server 连接状态快照 */
  async listMcpServers(): Promise<McpServerStatus[]> {
    const body = await this.httpJson<McpServersResponse>('/v1/mcp/servers');
    return body.servers ?? [];
  }
}

/** WS close code → 用户可读信息 */
function closeMessage(code: number): string {
  switch (code) {
    case 4400:
      return '协议版本不兼容（需要 vessel.gateway/1）';
    case 4401:
      return '鉴权失败（token 错误或已失效）';
    case 1001:
      return 'gateway 已停止';
    case 1006:
      return '无法连接 gateway（未启动或地址错误）';
    default:
      return `连接已关闭（${code}）`;
  }
}
