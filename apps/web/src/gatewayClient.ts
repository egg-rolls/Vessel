/**
 * Browser gateway client —— 连接 Vessel gateway（vessel.gateway/1）。
 *
 * 协议（见 packages/serve/src/gateway.ts）：
 *   - WS    `/v1/events?since=<seq>`，首帧 `{kind:'auth', token}`；服务端回 `hello`
 *   - 帧    `event` / `gap` / `res` / `ping`（见 packages/serve/src/protocol.ts）
 *   - REST  `/v1/sessions` / `/v1/tools`（Bearer 头，仅在 WS 不可用时兜底）
 *
 * 浏览器默认同源（gateway 托管 dist，或 Vite proxy）；也可在运行时指定远端 gateway
 * （见 gatewayUrl.ts）。跨 Origin 时 gateway 必须配置 `serve.allowed_origins`。
 */

import { toWebSocketBase } from './gatewayUrl';
import type {
  AskUserAnswer,
  CapabilityManifest,
  ConfigSourcesResponse,
  DurableRunSummary,
  DurableRunsResponse,
  EvalReport,
  EvalReportResponse,
  FeishuResponse,
  FeishuStatus,
  GapFrame,
  GatewayErrorBody,
  HelloInfo,
  McpServerStatus,
  McpServersResponse,
  Message,
  MetricsResponse,
  MetricsSnapshot,
  RpcResponseEnvelope,
  RunEvent,
  RunStatus,
  ServerFrame,
  SessionDetail,
  SessionInfo,
  TenantInfo,
  ToolInfo,
  WorkflowCancelResponse,
  WorkflowResponse,
  WorkflowRunAccepted,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowsResponse,
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
        throw new GatewayHttpError('network', '连接 gateway 超时');
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

  /**
   * 提交 run：优先 0.5 canonical RPC `runs.start`（带 tenant + quota），
   * 旧 gateway 不支持时回退 WS legacy `run.submit`。
   */
  async submitRun(
    input: string,
    sessionId?: string,
  ): Promise<{ run_id: string; status: RunStatus['status']; queue_position?: number }> {
    try {
      return await this.rpc<{
        run_id: string;
        status: RunStatus['status'];
        queue_position?: number;
      }>('runs.start', {
        input,
        ...(sessionId ? { session_id: sessionId } : {}),
      });
    } catch (error) {
      if (!canFallbackToLegacyRuns(error)) throw error;
      return this.request('run.submit', {
        input,
        ...(sessionId ? { session_id: sessionId } : {}),
      });
    }
  }

  async cancelRun(runId: string): Promise<{ cancelled: boolean }> {
    try {
      return await this.rpc<{ cancelled: boolean }>('runs.cancel', { run_id: runId });
    } catch (error) {
      if (!canFallbackToLegacyRuns(error)) throw error;
      return this.request('run.cancel', { run_id: runId });
    }
  }

  getRun(runId: string): Promise<RunStatus> {
    return this.request('run.get', { run_id: runId });
  }

  /**
   * 查询 run 状态：canonical `runs.get` 优先，旧 gateway 回退 WS legacy `run.get`。
   * 排队卡片用它轮询 queue_position；不新增服务端方法。
   */
  async getRunStatus(runId: string): Promise<RunStatus> {
    try {
      const body = await this.rpc<{ run: RunStatus }>('runs.get', { run_id: runId });
      return body.run;
    } catch (error) {
      if (!canFallbackToLegacyRuns(error)) throw error;
      return this.request<RunStatus>('run.get', { run_id: runId });
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const body = await this.request<{ sessions?: SessionInfo[] }>('sessions.list');
    return body.sessions ?? [];
  }

  /**
   * 读取单个会话的完整状态（含 messages）。
   * WS `sessions.get` 优先；方法不可用/超时再回退 0.5 HTTP RPC。
   * not_found 是业务结果，不触发回退。
   */
  async getSession(sessionId: string): Promise<SessionDetail> {
    if (this.state === 'open' && this.helloInfo) {
      try {
        const body = await this.request<{ session?: SessionDetail }>('sessions.get', {
          session_id: sessionId,
        });
        const session = body.session;
        if (!session) throw new GatewayHttpError('not_found', 'Session not found');
        return { ...session, messages: normalizeMessages(session.messages) };
      } catch (error) {
        if (isNotFoundError(error)) throw error;
        // WS 不可用：继续走 HTTP RPC
      }
    }
    const body = await this.rpc<{ session?: SessionDetail }>('sessions.get', {
      session_id: sessionId,
    });
    const session = body.session;
    if (!session) throw new GatewayHttpError('not_found', 'Session not found');
    return { ...session, messages: normalizeMessages(session.messages) };
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

  // ── 0.5 RPC（POST /v1/rpc）────────────────────

  /** 统一 RPC 入口；失败抛 GatewayHttpError（携带冻结 code） */
  async rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    const response = await this.httpJson<RpcResponseEnvelope<T>>('/v1/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        id: crypto.randomUUID(),
        method,
        ...(params !== undefined ? { params } : {}),
      }),
    });
    if (!response.ok) {
      throw new GatewayHttpError(
        response.error?.code ?? 'internal',
        response.error?.message ?? `RPC failed: ${method}`,
      );
    }
    return response.result as T;
  }

  getCapabilities(): Promise<CapabilityManifest> {
    return this.rpc<CapabilityManifest>('capabilities.list');
  }

  async getConfigSources(tenantId?: string): Promise<ConfigSourcesResponse> {
    return this.rpc<ConfigSourcesResponse>(
      'config.sources',
      tenantId !== undefined ? { tenant_id: tenantId } : {},
    );
  }

  async listTenants(): Promise<TenantInfo[]> {
    const body = await this.rpc<{ tenants?: TenantInfo[] }>('tenants.list');
    return body.tenants ?? [];
  }

  async getTenantId(): Promise<string | undefined> {
    const body = await this.rpc<{ tenant_id?: string }>('health.get');
    return body.tenant_id;
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

  // ── 0.4 REST（workflow / metrics / feishu / evals）──

  async listWorkflows(
    params: { status?: string; limit?: number } = {},
  ): Promise<WorkflowRunSummary[]> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const suffix = query.toString();
    const body = await this.httpJson<WorkflowsResponse>(
      `/v1/workflows${suffix ? `?${suffix}` : ''}`,
    );
    return body.workflows ?? [];
  }

  async getWorkflow(id: string): Promise<WorkflowRunDetail> {
    const body = await this.httpJson<WorkflowResponse>(`/v1/workflows/${encodeURIComponent(id)}`);
    return body.workflow;
  }

  startWorkflow(name: string, inputs?: Record<string, string>): Promise<WorkflowRunAccepted> {
    const payload: { name: string; inputs?: Record<string, string> } = { name };
    if (inputs && Object.keys(inputs).length > 0) payload.inputs = inputs;
    return this.httpJson<WorkflowRunAccepted>('/v1/workflows/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  resumeWorkflow(id: string): Promise<WorkflowRunAccepted> {
    return this.httpJson<WorkflowRunAccepted>(`/v1/workflows/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    });
  }

  cancelWorkflow(id: string): Promise<WorkflowCancelResponse> {
    return this.httpJson<WorkflowCancelResponse>(`/v1/workflows/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    });
  }

  async getMetrics(): Promise<MetricsSnapshot> {
    const body = await this.httpJson<MetricsResponse>('/v1/metrics');
    return body.metrics;
  }

  async getFeishuStatus(): Promise<FeishuStatus> {
    const body = await this.httpJson<FeishuResponse>('/v1/channels/feishu');
    return body.channel;
  }

  async getLatestEval(suite: string): Promise<EvalReport> {
    const query = new URLSearchParams({ suite });
    const body = await this.httpJson<EvalReportResponse>(`/v1/evals/latest?${query.toString()}`);
    return body.report;
  }
}

/** 兼容 WS 错误（`code: message`）与 HTTP GatewayHttpError 两种形状 */
function isNotFoundError(error: unknown): boolean {
  if (error instanceof GatewayHttpError) return error.code === 'not_found';
  return error instanceof Error && error.message.startsWith('not_found:');
}

/** 旧 gateway 没有 /v1/rpc 或 runs.* 时回退到 WS legacy 方法；业务错误不回退。 */
function canFallbackToLegacyRuns(error: unknown): boolean {
  if (!(error instanceof GatewayHttpError)) return false;
  if (error.status === 404 || error.status === 405) return true;
  return error.code === 'method_not_allowed';
}

/** 服务端返回的 messages 可能是旧数据/空值；统一成前端可渲染的形状 */
function normalizeMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is Message =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as Message).role === 'string' &&
      typeof (item as Message).content === 'string',
  );
}

/** WS close code → 用户可读信息 */
function closeMessage(code: number): string {
  switch (code) {
    case 4400:
      return '协议版本不兼容（需要 vessel.gateway/1）';
    case 4401:
      return '鉴权失败（token 错误或已失效）';
    case 4403:
      return '无权访问该 tenant';
    case 1001:
      return 'gateway 已停止';
    case 1006:
      return '无法连接 gateway（未启动或地址错误）';
    default:
      return `连接已关闭（${code}）`;
  }
}
