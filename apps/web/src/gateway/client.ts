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

import { t } from '../i18n';
import { unwrapAgentResult } from './agent-result';
import type { ListedInteraction, ListedInteractionPage } from './interaction-hydration';
import { permissionRespondParams } from './interactions';
import type {
  AgentBatchResponse,
  AgentCreateInput,
  AgentSummary,
  AgentsTreeResponse,
  AgentUpdateInput,
  AskUserAnswer,
  CapabilityManifest,
  ConfigResponse,
  ConfigSourcesResponse,
  DeleteSessionResult,
  DurableRunSummary,
  DurableRunsResponse,
  EvalReport,
  EvalReportResponse,
  EvalRunResponse,
  EventsResponse,
  FeishuResponse,
  FeishuStatus,
  GapFrame,
  GatewayErrorBody,
  GatewayReloadResult,
  HealthResponse,
  HelloInfo,
  McpServerStatus,
  McpServersResponse,
  Message,
  MetricsResponse,
  MetricsSnapshot,
  PermissionScope,
  RenameSessionResult,
  ResumeRunResponse,
  RpcResponseEnvelope,
  RunEvent,
  RunResponse,
  RunStartResult,
  RunStatus,
  RunsResponse,
  ServerFrame,
  SessionDetail,
  SessionInfo,
  SessionSearchHit,
  TeamCreateInput,
  TeamDetail,
  TeamPostResult,
  TeamSummary,
  TeamUpdateInput,
  TenantInfo,
  TenantResponse,
  ToolInfo,
  ToolPolicy,
  ToolPolicyResult,
} from './types';
import { toWebSocketBase } from './url';

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

  // ── 语义方法 ──────────────────────────────────

  /**
   * 提交 run：优先 0.5 canonical RPC `runs.start`（带 tenant + quota），
   * 旧 gateway 不支持时回退 WS legacy `run.submit`。
   */
  /**
   * 0.27：`runs.start` 解析 session → agent/body 后回填 `agent_id` / `session_id`。
   *
   * 0.28（CONTRACT §3 / §3.1）：`agentId` 表达「这一次投给哪个 agent」。
   * 新会话必须先 `agents.create` 再带 `agentId` 调这里 —— 只传 `session_id`
   * 会让未绑定的 session 落到 `main` 上长出第二具 body。
   * `agentId` 缺省时保持 0.27 行为（`/resume` 等按 session 的路径不受影响）。
   */
  async submitRun(input: string, sessionId?: string, agentId?: string): Promise<RunStartResult> {
    const params = {
      input,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(agentId ? { agent_id: agentId } : {}),
    };
    try {
      return await this.rpc<RunStartResult>('runs.start', params);
    } catch (error) {
      // 带 `agentId` 时**不能**回退：legacy `run.submit` 没有 agent 维度，丢掉了
      // `agent_id` 就会落到 `main` 上长出第二具 body（契约 §3 明禁，且是静默的）。
      // 宁可在只支持 legacy 的旧 gateway 上显式失败，让用户看到真实原因。
      if (agentId) throw error;
      if (!canFallbackToLegacyRuns(error)) throw error;
      return this.request<RunStartResult>('run.submit', {
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

  /**
   * 会话列表：canonical RPC 优先（HTTP + token，断线重连时仍可读），
   * 旧 gateway 回退 WS legacy `sessions.list`。
   */
  async listSessions(): Promise<SessionInfo[]> {
    try {
      const body = await this.rpc<{ sessions?: SessionInfo[] }>('sessions.list');
      return body.sessions ?? [];
    } catch (error) {
      if (!canFallbackToRest(error)) throw error;
      const body = await this.request<{ sessions?: SessionInfo[] }>('sessions.list');
      return body.sessions ?? [];
    }
  }

  /**
   * 会话内容搜索（canonical `sessions.search`）。
   * 旧 gateway 没有该方法时返回 null，由调用方回退到本地 title/preview/id 过滤。
   */
  async searchSessions(query: string, limit?: number): Promise<SessionSearchHit[] | null> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    try {
      const body = await this.rpc<{ sessions?: SessionSearchHit[] }>('sessions.search', {
        query: trimmed,
        ...(limit !== undefined ? { limit } : {}),
      });
      return body.sessions ?? [];
    } catch {
      return null;
    }
  }

  /** 删除会话及其持久历史、关联 runs 与事件；返回级联计数。 */
  deleteSession(sessionId: string): Promise<DeleteSessionResult> {
    return this.rpc<DeleteSessionResult>('sessions.delete', { session_id: sessionId });
  }

  /** 重命名会话；后端会更新 updated_at，列表按倒序会自然跳到顶部。 */
  renameSession(sessionId: string, title: string): Promise<RenameSessionResult> {
    return this.rpc<RenameSessionResult>('sessions.rename', {
      session_id: sessionId,
      title,
    });
  }

  /** 当前 gateway 进程内的 live runs（内存，无分页）。 */
  /** 0.27：`runs.list` 支持 agent / session 维度过滤（agent_id 为 additive 参数）。 */
  async listRuns(
    params: { session_id?: string; agent_id?: string; status?: string; tenant_id?: string } = {},
  ): Promise<RunStatus[]> {
    const body = await this.rpc<RunsResponse>('runs.list', params);
    return body.runs ?? [];
  }

  /**
   * 0.18：读取 pending / answered / orphaned 交互（旧 gateway 无此方法时由调用方处理）。
   * 只是分页版本的兼容包装：返回数组，不改变 hydration 的调用契约。
   */
  async listInteractions(
    params: {
      session_id?: string;
      run_id?: string;
      status?: 'pending' | 'answered' | 'orphaned';
      limit?: number;
      tenant_id?: string;
    } = {},
  ): Promise<ListedInteraction[]> {
    const page = await this.listInteractionsPage(params);
    return page.interactions;
  }

  /**
   * DECISION-038 §2.2：`interactions.list` 分页（order / cursor / total additive）。
   * 旧 gateway 忽略未知参数；返回形状缺失时按空页处理。
   */
  async listInteractionsPage(
    params: {
      session_id?: string;
      run_id?: string;
      team_id?: string;
      status?: 'pending' | 'answered' | 'orphaned';
      limit?: number;
      order?: 'oldest' | 'newest';
      cursor?: string;
      tenant_id?: string;
    } = {},
  ): Promise<ListedInteractionPage> {
    const body = await this.rpc<{
      interactions?: ListedInteraction[];
      total?: number;
      next_cursor?: string;
    }>('interactions.list', params);
    const interactions = body.interactions ?? [];
    return {
      interactions,
      total: typeof body.total === 'number' ? body.total : interactions.length,
      ...(typeof body.next_cursor === 'string' && body.next_cursor.length > 0
        ? { next_cursor: body.next_cursor }
        : {}),
    };
  }

  /** canonical runs.get；失败时回退 legacy WS run.get（旧 gateway）。 */
  async getRunCanonical(runId: string): Promise<RunStatus> {
    try {
      const body = await this.rpc<RunResponse>('runs.get', { run_id: runId });
      return body.run;
    } catch (error) {
      if (!canFallbackToLegacyRuns(error)) throw error;
      return this.request<RunStatus>('run.get', { run_id: runId });
    }
  }

  /**
   * 恢复可恢复运行：canonical `runs.resume` 优先；旧 gateway 回退 durable REST。
   * `conflict`（含 legacy_code=run_already_running）视为已在恢复，由调用方处理。
   */
  async resumeRun(runId: string): Promise<ResumeRunResponse> {
    try {
      return await this.rpc<ResumeRunResponse>('runs.resume', { run_id: runId });
    } catch (error) {
      if (!canFallbackToLegacyRuns(error)) throw error;
      return this.resumeDurableRun(runId);
    }
  }

  /** 读取事件记录（trace）；limit ≤500，升序返回。 */
  async readEvents(params: {
    run_id?: string;
    since_seq?: number;
    since_ts?: number;
    types?: string[];
    type_prefix?: string;
    limit?: number;
  }): Promise<RunEvent[]> {
    const body = await this.rpc<EventsResponse>('events.list', params);
    return body.events ?? [];
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

  /** 工具目录：canonical RPC 优先，旧 gateway 回退 WS legacy `tools.list`。 */
  async listTools(): Promise<ToolInfo[]> {
    try {
      const body = await this.rpc<{ tools?: ToolInfo[] }>('tools.list');
      return body.tools ?? [];
    } catch (error) {
      if (!canFallbackToRest(error)) throw error;
      const body = await this.request<{ tools?: ToolInfo[] }>('tools.list');
      return body.tools ?? [];
    }
  }

  async respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    scope: PermissionScope = 'once',
  ): Promise<void> {
    await this.request('permission.respond', {
      request_id: requestId,
      ...permissionRespondParams(decision, scope),
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

  async getConfig(tenantId?: string): Promise<ConfigResponse> {
    return this.rpc<ConfigResponse>(
      'config.get',
      tenantId !== undefined ? { tenant_id: tenantId } : {},
    );
  }

  async getConfigSources(tenantId?: string): Promise<ConfigSourcesResponse> {
    return this.rpc<ConfigSourcesResponse>(
      'config.sources',
      tenantId !== undefined ? { tenant_id: tenantId } : {},
    );
  }

  /** 0.15：只写服务端白名单键；未注入 writer 时返回 not_found。 */
  setConfigValue(
    key: string,
    value: string | boolean,
  ): Promise<{ ok: boolean; key: string; value: string | boolean }> {
    return this.rpc('config.set', { key, value });
  }

  /**
   * 写入单个工具的确认策略（canonical `permissions.setToolPolicy`）。
   * 旧 gateway 没有该方法，调用方须先用 `capabilities.list` 判定是否可用。
   */
  setToolPolicy(tool: string, policy: ToolPolicy): Promise<ToolPolicyResult> {
    return this.rpc<ToolPolicyResult>('permissions.setToolPolicy', { tool, policy });
  }

  /**
   * 热应用（canonical `gateway.reload`）。
   * 只接受 serve 声明的 scope；写策略后调 `['permission']` 让存活 runtime 换规则。
   */
  reload(scopes: string[]): Promise<GatewayReloadResult> {
    return this.rpc<GatewayReloadResult>('gateway.reload', { scopes });
  }

  listAgentsTree(
    params: { session_id?: string; state?: string } = {},
  ): Promise<AgentsTreeResponse> {
    return this.rpc<AgentsTreeResponse>('agents.tree', params);
  }

  async listTenants(): Promise<TenantInfo[]> {
    const body = await this.rpc<{ tenants?: TenantInfo[] }>('tenants.list');
    return body.tenants ?? [];
  }

  async createTenant(
    tenantId: string,
    options: { name?: string; quota?: Record<string, number> } = {},
  ): Promise<TenantInfo> {
    const body = await this.rpc<TenantResponse>('tenants.create', {
      tenant_id: tenantId,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.quota !== undefined ? { quota: options.quota } : {}),
    });
    return body.tenant;
  }

  async updateTenant(
    tenantId: string,
    options: {
      name?: string;
      status?: 'active' | 'disabled';
      quota?: Record<string, number>;
    } = {},
  ): Promise<TenantInfo> {
    const body = await this.rpc<TenantResponse>('tenants.update', {
      tenant_id: tenantId,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.quota !== undefined ? { quota: options.quota } : {}),
    });
    return body.tenant;
  }

  async getHealth(): Promise<HealthResponse> {
    return this.rpc<HealthResponse>('health.get');
  }

  async getTenantId(): Promise<string | undefined> {
    const body = await this.rpc<{ tenant_id?: string }>('health.get');
    return body.tenant_id;
  }

  /** metrics：优先 canonical `metrics.get`（可带 source），旧 gateway 回退 REST。 */
  async getMetricsSnapshot(source: 'live' | 'trace' = 'live'): Promise<{
    metrics: MetricsSnapshot;
    source: 'live' | 'trace';
  }> {
    try {
      const body = await this.rpc<{ metrics: MetricsSnapshot; source: 'live' | 'trace' }>(
        'metrics.get',
        { source },
      );
      return body;
    } catch (error) {
      if (source === 'live' && canFallbackToRest(error)) {
        const body = await this.httpJson<MetricsResponse>('/v1/metrics');
        return { metrics: body.metrics, source: 'live' };
      }
      throw error;
    }
  }

  resetMetrics(): Promise<{ ok: boolean }> {
    return this.rpc<{ ok: boolean }>('metrics.reset', {});
  }

  reconnectMcp(name: string): Promise<{ ok: boolean; tenant_id: string }> {
    return this.rpc<{ ok: boolean; tenant_id: string }>('mcp.reconnect', { name });
  }

  runEval(suite: string): Promise<EvalReport> {
    return this.rpc<EvalRunResponse>('evals.run', { suite }).then((body) => body.report);
  }

  // ── Team（0.19 S6，node-local；canonical `teams.*`）──
  // 只走 HTTP rpc()；`teams.*` 不依赖 WS 在线。

  async listTeams(): Promise<TeamSummary[]> {
    const body = await this.rpc<{ teams?: TeamSummary[] }>('teams.list');
    return body.teams ?? [];
  }

  getTeam(teamId: string, opts?: { limit?: number; members_limit?: number }): Promise<TeamDetail> {
    return this.rpc<TeamDetail>('teams.get', {
      team_id: teamId,
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts?.members_limit !== undefined ? { members_limit: opts.members_limit } : {}),
    });
  }

  postTeam(input: {
    team_id: string;
    content: string;
    mentions?: string[];
  }): Promise<TeamPostResult> {
    return this.rpc<TeamPostResult>('teams.post', input);
  }

  /** DECISION-040：结果形状为 TeamSummary。 */
  createTeam(input: TeamCreateInput): Promise<TeamSummary> {
    return this.rpc<TeamSummary>('teams.create', input);
  }

  updateTeam(input: TeamUpdateInput): Promise<TeamSummary> {
    return this.rpc<TeamSummary>('teams.update', input);
  }

  archiveTeam(teamId: string): Promise<TeamSummary> {
    return this.rpc<TeamSummary>('teams.archive', { team_id: teamId });
  }

  /** 0.27：冻结 / 解冻 Team 的成员创建闸门。 */
  setSpawnFrozen(teamId: string, frozen: boolean): Promise<TeamSummary> {
    return this.rpc<TeamSummary>('teams.spawnFrozen', { team_id: teamId, frozen });
  }

  /** canonical `agents.list`；管理面 token 会额外返回成员记录。 */
  async listAgents(): Promise<AgentSummary[]> {
    const body = await this.rpc<{ agents?: AgentSummary[] }>('agents.list', {});
    return Array.isArray(body?.agents) ? body.agents : [];
  }

  // ── Agent CRUD（0.25；canonical `agents.create|update|close`）──
  // update 的 model / system_prompt 从下一个 Body 生效，name 立即生效。

  async createAgent(input: AgentCreateInput): Promise<AgentSummary> {
    return unwrapAgentResult(
      await this.rpc<AgentBatchResponse>('agents.create', { agents: [input] }),
    );
  }

  async updateAgent(input: AgentUpdateInput): Promise<AgentSummary> {
    return unwrapAgentResult(
      await this.rpc<AgentBatchResponse>('agents.update', { agents: [input] }),
    );
  }

  async closeAgent(agentId: string): Promise<AgentSummary> {
    return unwrapAgentResult(
      await this.rpc<AgentBatchResponse>('agents.close', { agents: [{ agent_id: agentId }] }),
    );
  }

  // ── 0.3 REST（durable / MCP）──────────────────

  private async httpJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.token;
    if (!token) {
      throw new GatewayHttpError('unauthorized', t('gateway.client.tokenRequiredHttp'));
    }
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
    params: { status?: string; session_id?: string; agent_id?: string; limit?: number } = {},
  ): Promise<DurableRunSummary[]> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.session_id) query.set('session_id', params.session_id);
    if (params.agent_id) query.set('agent_id', params.agent_id);
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

  /** MCP server 连接状态快照：canonical `mcp.list` 优先，旧 gateway 回退 REST。 */
  async listMcpServers(): Promise<McpServerStatus[]> {
    try {
      const body = await this.rpc<McpServersResponse>('mcp.list', {});
      return body.servers ?? [];
    } catch (error) {
      if (!canFallbackToRest(error)) throw error;
      const body = await this.httpJson<McpServersResponse>('/v1/mcp/servers');
      return body.servers ?? [];
    }
  }

  // ── 0.4 REST（metrics / feishu / evals）──

  async getMetrics(source: 'live' | 'trace' = 'live'): Promise<MetricsSnapshot> {
    return (await this.getMetricsSnapshot(source)).metrics;
  }

  async getFeishuStatus(): Promise<FeishuStatus> {
    try {
      const body = await this.rpc<FeishuResponse>('feishu.status', {});
      return body.channel;
    } catch (error) {
      if (!canFallbackToRest(error)) throw error;
      const body = await this.httpJson<FeishuResponse>('/v1/channels/feishu');
      return body.channel;
    }
  }

  async getLatestEval(suite: string): Promise<EvalReport> {
    try {
      const body = await this.rpc<EvalReportResponse>('evals.latest', { suite });
      return body.report;
    } catch (error) {
      if (!canFallbackToRest(error)) throw error;
      const query = new URLSearchParams({ suite });
      const body = await this.httpJson<EvalReportResponse>(`/v1/evals/latest?${query.toString()}`);
      return body.report;
    }
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

/** 旧 gateway 没有 canonical RPC 时回退到既有 REST 读接口。 */
function canFallbackToRest(error: unknown): boolean {
  if (!(error instanceof GatewayHttpError)) return false;
  if (error.status === 404 || error.status === 405) return true;
  return error.code === 'method_not_allowed' || error.code === 'not_found';
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
