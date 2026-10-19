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
}

/** LLM 流式 chunk（对应 core 的 StreamChunk） */
export interface StreamChunk {
  type: 'text_delta' | 'tool_call_delta' | 'finish';
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
  expiresAt: number;
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
  /** durable checkpoint 字段（runs.get 对 durable run 返回）。 */
  agent_id?: string;
  iteration?: number;
  updated_at?: number;
  preview?: string;
  messages?: Message[];
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

/** workflow 状态（与 DECISION-009 §5.1.3 一致） */
export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

/** workflow run 摘要（GET /v1/workflows） */
export interface WorkflowRunSummary {
  workflow_run_id: string;
  workflow_name: string;
  status: WorkflowRunStatus;
  step_count: number;
  completed_steps: number;
  started_at: number;
  updated_at: number;
  error?: string;
}

export interface WorkflowStepSummary {
  id: string;
  type: 'agent' | 'tool';
  status: WorkflowStepStatus;
  attempts: number;
  started_at?: number;
  finished_at?: number;
  error?: string;
  output_preview?: string;
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  definition_path: string;
  inputs: Record<string, string>;
  steps: WorkflowStepSummary[];
}

export interface WorkflowsResponse {
  workflows: WorkflowRunSummary[];
}

export interface WorkflowResponse {
  workflow: WorkflowRunDetail;
}

export interface WorkflowRunAccepted {
  workflow_run_id: string;
  status: 'queued';
}

export interface WorkflowCancelResponse {
  workflow_run_id: string;
  status: 'cancelled';
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

/** health.get 的 team 探测结果 */
export interface HealthTeamStatus {
  enabled: boolean;
  node_id?: string;
  transport?: string;
}

export interface HealthResponse {
  status: string;
  clients: number;
  latest_seq: number;
  protocol: ProtocolInfo;
  node: NodeInfo;
  started_at: number;
  tenant_id: string;
  team: HealthTeamStatus;
}

export interface ConfigResponse {
  schema_version: number;
  config: Record<string, unknown>;
  paths: { user: string; project: string };
  tenant_id: string;
  tenant_overlay_keys?: string[];
}

export type TeamAgentState = 'idle' | 'running' | 'cancelled' | 'error' | 'closed';

export interface TeamAgentStatus {
  id: string;
  name?: string;
  state: TeamAgentState | string;
  current_run_id?: string;
  tool_names: string[];
  last_error?: string;
}

export interface TeamPeerInfo {
  node_id: string;
  endpoint?: string;
  agents: TeamAgentStatus[];
  protocol: number;
}

export interface TeamPeersResponse {
  protocol: number;
  node_id: string;
  peers: TeamPeerInfo[];
}

export interface TeamAgentsResponse {
  protocol: number;
  agents: TeamAgentStatus[];
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
