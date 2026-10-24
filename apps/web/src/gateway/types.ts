/**
 * 前端协议类型（vessel.gateway/1 的最小契约）。
 *
 * 与 packages/serve/src/protocol.ts 对齐，但不 import 服务端源码——
 * 前端独立构建，避免把 Bun/Node 类型带进来。
 */

/** Run 事件（type 为开放字符串协议） */
export interface RunEvent {
  type: string;
  run_id: string;
  data: Record<string, unknown>;
  ts: number;
  /**
   * trace 落盘时分配的 per-run 序号（`events.list` 会返回）。
   * 实时 WS 事件通常没有该字段；分页时只能依赖 trace 事件。
   */
  seq?: number;
  /** 0.6：事件来源节点（events.list 会返回；实时流可能缺省）。 */
  node_id?: string;
}

/** LLM 流式 chunk（对应 core 的 StreamChunk） */
export interface StreamChunk {
  /** `reasoning_delta` 仅在 `ui.showReasoning: true` 时由 core 发出（0.11.1，additive）。 */
  type: 'text_delta' | 'reasoning_delta' | 'tool_call_delta' | 'finish';
  delta?: string;
  tool_call_index?: number;
  tool_call_id?: string;
  tool_call_name?: string;
  arguments_delta?: string;
  finish_reason?: string;
  usage?: Usage;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
}

/** LLM 工具 Schema（对应 `llm.request.data.tools`） */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** 会话摘要（/v1/sessions 返回的 SessionInfo） */
export interface SessionInfo {
  session_id: string;
  title: string;
  preview: string;
  status: string;
  started_at: number;
  updated_at: number;
  message_count: number;
  branch?: string;
}

/** 会话消息角色（与 core `Message` 对齐） */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 工具调用（assistant 消息里的 tool_calls） */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 单条会话消息（sessions.get 返回的 session.messages） */
export interface Message {
  role: MessageRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** 0.6.1：逐条消息时间戳（core 可能缺省；缺失时 Web 降级为不分组/不显示时间）。 */
  timestamp?: number;
}

/** sessions.search 的单条结果（E5 冻结形状）。 */
export interface SessionSearchHit {
  session_id: string;
  title: string;
  preview: string;
  snippet: string;
  updated_at: number;
  message_count: number;
}

/** 会话详情（sessions.get 返回 `{ session: RunState }`） */
export interface SessionDetail {
  session_id: string;
  messages: Message[];
  title?: string;
  preview?: string;
  started_at?: number;
  updated_at?: number;
  status?: string;
}

/** 工具公开信息（/v1/tools） */
export interface ToolInfo {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  has_permission_check: boolean;
}

/** ask_user 单个问题 */
export interface AskUserQuestion {
  header: string;
  question: string;
  options?: string[];
  multi_select?: boolean;
}

/** ask_user 单个回答 */
export interface AskUserAnswer {
  header: string;
  question: string;
  answer: string;
}

/** ask_user 请求（ask.user.requested） */
export interface AskUserRequest {
  requestId: string;
  questions: AskUserQuestion[];
  runId: string;
  /** 事件时间（缺失回退收到时间）；只用于与权限请求混排，不表示过期。 */
  requestedAt: number;
  /** 0.15 additive：由 run.started 反查的归属会话；旧流缺失时不参与跨 session 归类。 */
  sessionId?: string;
  /** 成员 bridge 的父 chat（事件 `parent_session_id`）；旧事件缺失，缺失时回退 `sessionId`。 */
  parentSessionId?: string;
  /** 0.17 additive：发起请求的子 agent（delegate_id / agent_id）；旧流缺失。 */
  agentId?: string;
}

/** 权限应答范围（DECISION-024 §2.1）。 */
export type PermissionScope = 'once' | 'session' | 'always';

/**
 * 待答权限请求（tool.permission.request，0.13 增加关联字段）。
 *
 * Addendum A / 0.18：权限等待默认不超时，因此没有过期字段；卡片只保留事件时间用于排序。
 */
export interface PermissionRequest {
  requestId: string;
  tool: string;
  input: unknown;
  runId: string;
  /** run 归属会话；旧 gateway 缺失时不参与跨 session 归类。 */
  sessionId?: string;
  /** 成员 bridge 的父 chat（事件 `parent_session_id`）；旧事件缺失，缺失时回退 `sessionId`。 */
  parentSessionId?: string;
  toolCallId?: string;
  source?: string;
  /** 0.17 additive：发起请求的子 agent（delegate_id / agent_id）；旧流缺失。 */
  agentId?: string;
  /** 事件时间（同一 run 多请求排序）。 */
  requestedAt: number;
}

/** 运行状态（/v1/runs/:id、run.get；durable checkpoint 是其中的超集） */
export interface RunStatus {
  run_id: string;
  /** gateway 引擎 id → core run id；trace 事件使用 core run id。 */
  core_run_id?: string;
  session_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  output?: string;
  error?: string;
  usage?: Usage;
  started_at?: number;
  completed_at?: number;
  queue_position?: number;
  /** 0.14 / 0.15 E6：run.failed 结构化 envelope（additive）。 */
  error_code?: string;
  category?: string;
  phase?: string;
  retryable?: boolean;
  http_status?: number;
  details?: Record<string, unknown>;
  /** durable checkpoint 字段（runs.get 对 durable run 返回）。 */
  agent_id?: string;
  iteration?: number;
  updated_at?: number;
  preview?: string;
  messages?: Message[];
}

/** agents.tree 节点（0.15 E5）。 */
export interface AgentCard {
  id: string;
  role?: string;
  parent_id?: string;
  depth: number;
  state: string;
  current_tool?: string;
  session_id?: string;
  usage?: Usage;
  task?: string;
  node_id?: string;
  queue_position?: number;
  wait_reason?: string;
  context_used?: number;
  context_max?: number;
  children_count: number;
  children_ids: string[];
  last_seen?: number;
  artifact_refs?: string[];
}

export interface AgentsTreeResponse {
  nodes: AgentCard[];
  as_of: number;
}

// ── Team（0.19 S6，node-local） ─────────────────────
// 契约来自个人侧 PLAN-0.19-s3-team 与 S6 R1；字段只增不改。

/** 已退役 Body；S3 `TeamMember.body_history?`。 */
export interface TeamBodyHistoryEntry {
  session_id: string;
  epoch: number;
  started_at: number;
  retired_at: number;
}

/** teams.list 元素 / teams.get.team。 */
export interface TeamSummary {
  team_id: string;
  name: string;
  tenant_id: string;
  /** 旧 gateway / 缺失 workspace 的 Team 不返回该字段；UI 显示 —。 */
  workspace?: string;
  /** 0.21 additive：展示字段；缺失时 UI 显示 —。 */
  description?: string;
  /** 0.21 additive：默认接头人（地址保留字 human / principal）；缺失时 UI 显示 —。 */
  default_principal?: string;
  member_count: number;
  /** S3 R1：present && live；缺失时显示 —。 */
  online_count?: number;
  handoff_path?: string;
  policy?: Record<string, unknown>;
  created_at: number;
  /** 0.24 additive：归档时间；缺失 = active（DECISION-040）。 */
  archived_at?: number;
}

/** `teams.create` 参数（DECISION-040 §2.1）。 */
export interface TeamCreateInput {
  workspace: string;
  name?: string;
  description?: string;
  default_principal?: string;
  handoff_path?: string;
  policy?: Record<string, unknown>;
}

/** `teams.update` 参数（DECISION-040 §2.2）；null = 清空该字段。 */
export interface TeamUpdateInput {
  team_id: string;
  name?: string;
  description?: string | null;
  default_principal?: string | null;
  handoff_path?: string | null;
  policy?: Record<string, unknown>;
}

/** teams.get.members 元素。 */
export interface TeamMember {
  agent_id: string;
  name?: string;
  session_id?: string;
  membership: 'present' | 'left';
  presence: 'live' | 'gone';
  visibility: 'private' | 'team' | 'tenant';
  state?: string;
  epoch?: number;
  /** S3 R1：已退役 Body，≤20；缺失时回退到事件累积。 */
  body_history?: TeamBodyHistoryEntry[];
}

/** Team 日志条目；kind:'reply' 由 S3 R1 新增。 */
export interface TeamMessage {
  message_id: string;
  team_id: string;
  from: string;
  to: string[];
  mentions: string[];
  content: string;
  ts: number;
  kind: 'post' | 'mention' | 'system' | 'reply';
  system_event?: 'join' | 'leave' | 'rotate' | 'archive' | 'fork';
  /** 0.21 additive：federation 入站日志的回信地址；本地日志缺失。 */
  federation?: TeamMessageFederation;
}

/** 跨节点报文在 Team 日志上的结构化回信地址。 */
export interface TeamMessageFederation {
  /** `<principal>@<node_id>:<team_id>` */
  from_addr: string;
  /** `<principal>@<node_id>:<team_id>` */
  to_addr?: string;
  conversation_id?: string;
  hop?: number;
}

/** teams.post 的逐条投递结果。 */
export interface TeamDelivery {
  agent_id: string;
  status: 'queued' | 'rejected' | 'error';
  message_id?: string;
  resolution?: 'live' | 'resumed' | 'rotating' | 'forked';
  code?: string;
  reason?: string;
}

/** teams.post 结果（不包裹）。 */
export interface TeamPostResult {
  message_id: string;
  team_id: string;
  kind: 'post' | 'mention' | 'system';
  mentions: string[];
  delivered: TeamDelivery[];
  ts: number;
}

/** teams.get 结果。 */
export interface TeamDetail {
  team: TeamSummary;
  members: TeamMember[];
  messages: TeamMessage[];
}

/** tasks.list / tasks.get 条目（只读派生）。 */
export interface TaskEntry {
  id: string;
  title: string;
  assignee: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  parent_task?: string;
  artifact_refs: string[];
  since: number;
}

export interface TasksResponse {
  tasks: TaskEntry[];
}

export interface TaskResponse {
  task: TaskEntry;
}

/** health.get 的 runtime.scheduler 条目（0.15 E6）。 */
export interface SchedulerRunSummary {
  run_id: string;
  agent_id?: string;
  session_id?: string;
  status: string;
  queue_position?: number;
  queued_at?: number;
  started_at?: number;
  wait_reason?: string;
}

export interface RuntimeHealth {
  active_run_id?: string;
  scheduler: {
    as_of: number;
    queued: SchedulerRunSummary[];
    running: SchedulerRunSummary[];
    stats: {
      queued: number;
      running: number;
      completed: number;
      failed: number;
      cancelled: number;
    };
  };
}

/** durable run 摘要（GET /v1/durable/runs） */
export interface DurableRunSummary {
  run_id: string;
  session_id: string;
  agent_id?: string;
  status: 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  iteration?: number;
  updated_at: number;
  preview?: string;
}

export interface DurableRunsResponse {
  runs: DurableRunSummary[];
}

/** MCP server 状态（GET /v1/mcp/servers） */
export type McpServerState = 'connected' | 'failed' | 'disabled';

export interface McpServerStatus {
  name: string;
  status: McpServerState;
  tools: string[];
  error?: string;
}

export interface McpServersResponse {
  servers: McpServerStatus[];
}

/** 进程内聚合快照（GET /v1/metrics） */
export interface MetricsSnapshot {
  runs: { started: number; completed: number; failed: number; cancelled: number };
  tool_calls: { total: number; failed: number };
  llm: {
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  duration_ms: { total: number; max: number; avg: number };
  updated_at: number;
}

export interface MetricsResponse {
  metrics: MetricsSnapshot;
}

/** 飞书渠道状态（GET /v1/channels/feishu） */
export interface FeishuStatus {
  connected: boolean;
  appIdMasked: string;
  active_chats: number;
  queued_messages: number;
  last_error?: string;
}

export interface FeishuResponse {
  channel: FeishuStatus;
}

/** eval 报告（GET /v1/evals/latest） */
export interface EvalCaseAssertion {
  type: string;
  ok: boolean;
  detail?: string;
}

export interface EvalUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface EvalCaseResult {
  id: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  duration_ms: number;
  assertions: EvalCaseAssertion[];
  output?: string;
  usage?: EvalUsage;
  error?: string;
}

export interface EvalReport {
  suite: string;
  network: boolean;
  started_at: number;
  finished_at: number;
  duration_ms: number;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  cases: EvalCaseResult[];
}

export interface EvalReportResponse {
  report: EvalReport;
}

/** 统一状态语义（Web 与 TUI 共享词表；颜色只是增强，必须同时有字形 + 文本） */
export type StatusKind =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'pending'
  | 'connected'
  | 'disconnected'
  | 'unreachable'
  | 'disabled'
  | 'unavailable';

/** sessions.delete 结果（级联计数用于确认/反馈） */
export interface DeleteSessionResult {
  sessions_deleted: number;
  runs_deleted: number;
  events_deleted: number;
}

export interface RenameSessionResult {
  session_id: string;
  title: string;
}

export interface RunsResponse {
  runs: RunStatus[];
}

export interface RunResponse {
  run: RunStatus;
}

export interface ResumeRunResponse {
  run_id: string;
  status: 'queued';
}

export interface EventsResponse {
  events: RunEvent[];
}

export interface HealthResponse {
  status: string;
  clients: number;
  latest_seq: number;
  protocol: ProtocolInfo;
  node: NodeInfo;
  started_at: number;
  tenant_id: string;
  /** 0.15 E6：旧 gateway 可能缺省。 */
  runtime?: RuntimeHealth;
}

export interface ConfigResponse {
  schema_version: number;
  config: Record<string, unknown>;
  paths: { user: string; project: string };
  tenant_id: string;
  tenant_overlay_keys?: string[];
  /**
   * 0.25 additive：进程版本。旧 gateway 不返回该字段，UI 必须按可选处理
   * （Hub / Gateway 状态页显示 `—`），不得用协议版本冒充。
   */
  version?: string;
}

export interface EvalRunResponse {
  report: EvalReport;
}

export interface TenantResponse {
  tenant: TenantInfo;
}

/** 网关错误信封 */
export interface GatewayErrorBody {
  error: { code: string; message: string };
}

/** 协议信息 */
export interface ProtocolInfo {
  name: 'vessel.gateway';
  version: number;
  min: number;
  features: string[];
}

/** 节点公开信息 */
export interface NodeInfo {
  node_id: string;
  /** 0.25 additive：可读显示名；旧 gateway 缺失时回退 node_id。 */
  name?: string;
  pid: number;
  started_at: number;
  endpoint: string;
  role: 'standalone' | 'team';
  status: 'idle' | 'busy' | 'draining';
  current_run_id?: string;
  current_session_id?: string;
  capabilities: {
    tools: string[];
    provider?: string;
    model?: string;
    max_concurrency: number;
    protocol: number;
  };
}

/** hello 帧 */
export interface HelloInfo {
  protocol: ProtocolInfo;
  node: NodeInfo;
  from_seq: number;
  latest_seq: number;
  /** 0.5：token 解析出的 tenant（additive） */
  tenant_id?: string;
  /** 0.24 additive：进程 incarnation；仅当前 WS 节点可读。 */
  incarnation?: string;
}

/** RPC 响应信封（0.5） */
export interface RpcResponseEnvelope<T = unknown> {
  v: 1;
  id: string;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string; details?: unknown };
}

/** capability manifest（0.5） */
export interface CapabilityManifest {
  version: string;
  config_schema_version: number;
  methods: Array<{
    name: string;
    params_schema?: unknown;
    result_schema?: unknown;
    permission: 'read' | 'write' | 'admin';
  }>;
  tools: Array<{ name: string; description?: string }>;
  plugins: Array<{ name: string; enabled: boolean }>;
}

/** config.sources（0.5） */
export interface ConfigSourcesResponse {
  sources: Record<string, string>;
  tenant_id?: string;
  tenant_overlay_keys?: string[];
}

/** tenant 元数据（0.5） */
export interface TenantInfo {
  tenant_id: string;
  name?: string;
  status: 'active' | 'disabled';
  created_at: number;
  quota?: Record<string, number>;
  usage?: Record<string, number>;
}

/** gap 帧 */
export interface GapFrame {
  kind: 'gap';
  from_seq: number;
  to_seq: number;
}

/** 服务端帧（前端只消费用到的字段） */
export type ServerFrame =
  | ({ v: 1; kind: 'hello'; node_id: string; ts: number } & HelloInfo)
  | {
      v: 1;
      kind: 'event';
      node_id: string;
      ts: number;
      seq: number;
      job_id?: string;
      event: RunEvent;
    }
  | ({ v: 1; kind: 'gap'; node_id: string; ts: number } & Omit<GapFrame, 'kind'>)
  | { v: 1; kind: 'res'; node_id: string; ts: number; id: string; ok: true; result: unknown }
  | {
      v: 1;
      kind: 'res';
      node_id: string;
      ts: number;
      id: string;
      ok: false;
      error: { code: string; message: string };
    }
  | { v: 1; kind: 'ping'; node_id: string; ts: number };
