/**
 * 工具公开信息（`tools.list` 的单一条目）。
 *
 * 只有这一种条目形状：节点与成员看到的是同一份清单，所以既没有 `source`（来源），
 * 也没有「谁拿不到 + 为什么」之类第二层字段 —— 那种区分已按用户裁定删掉。
 */
export interface ToolInfo {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  has_permission_check: boolean;
}

/**
 * `tools.list` 响应：无论传不传 `agent_id` 都只有 `tools`。
 *
 * `agent_id`（可选，deprecated）只决定「按哪具成员身体去读」，不改变资源形状；
 * 成员用的就是节点那一份工具面。
 */
export interface ToolListResponse {
  tools?: ToolInfo[];
}

/**
 * 工具确认策略（CONTRACT-hot-apply §6/§7）。
 * 三档完全由 `permission.autoApprove` / `neverAutoApprove` 两个数组表达。
 */
export type ToolPolicy = 'auto' | 'ask' | 'never';

/** `permissions.setToolPolicy` 结果（canonical RPC 冻结形状）。 */
export interface ToolPolicyResult {
  ok: boolean;
  tool: string;
  policy: ToolPolicy;
  auto_approve: string[];
  never_auto_approve: string[];
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

export interface EvalRunResponse {
  report: EvalReport;
}

/** `config.get.config.plugins[]` 条目（additive 视图）。 */
export interface ConfigPluginEntry {
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface ConfigResponse {
  schema_version: number;
  config: Record<string, unknown>;
  /** E10 additive：部分 gateway 直接暴露 plugins 数组；也兼容 config.plugins。 */
  plugins?: ConfigPluginEntry[];
  paths: { user: string; project: string };
  tenant_overlay_keys?: string[];
  /**
   * 0.25 additive：进程版本。旧 gateway 不返回该字段，UI 必须按可选处理
   * （Hub / Gateway 状态页显示 `—`），不得用协议版本冒充。
   */
  version?: string;
}

/** config.sources（0.5） */
export interface ConfigSourcesResponse {
  sources: Record<string, string>;
  tenant_overlay_keys?: string[];
}

/**
 * `gateway.reload` 结果（CONTRACT-hot-apply §1）。
 * `requires_restart` 不得伪装成已生效。
 */
export interface GatewayReloadResult {
  reloaded: string[];
  requires_restart: string[];
}
