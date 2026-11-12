/** 工具来源（0.51 additive）：`plugin` = 节点插件面；`member` = 成员运行期注入（`inbox`）。 */
export type ToolSource = 'plugin' | 'member';

/** 工具公开信息（/v1/tools） */
export interface ToolInfo {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  has_permission_check: boolean;
  /** 只在按成员查询时出现：旧 gateway 不带 ⇒ 未知来源（按节点口径展示）。 */
  source?: ToolSource;
}

/**
 * 成员工具面的来源档位（`tools.list{agent_id}`）。
 *
 * `live` = 该成员活身体宿主里实取；`derived` = 当前没有活身体，服务端按「一具新身体
 * 会拿到什么」推导。两者都是真实注册路径，区别只在有没有身体可读。
 */
export type ToolSurface = 'live' | 'derived';

/**
 * 节点有、这个成员拿不到的工具的**原因**（服务端算好，界面只负责显示）。
 *
 * - `parent_answered`：需要父级转发人类应答（`ask`），这具身体没有 bridge；
 * - `readonly_mode`：该成员是 deny（只读）档，只留 `read` / `media` / `subscribe`；
 * - `unknown`：规则放行了，但这具活身体上确实没有（多半是新工具还没热刷新过来）。
 */
export type ToolUnavailableReason = 'parent_answered' | 'readonly_mode' | 'unknown';

/** 被挡在成员工具面外的一条工具（只有名字与原因，没有 schema / 描述）。 */
export interface ToolUnavailable {
  name: string;
  reason: ToolUnavailableReason;
}

/** `tools.list` 响应：不带 `agent_id` 时只有 `tools`（旧形状）。 */
export interface ToolListResponse {
  tools?: ToolInfo[];
  /** 只在按成员查询时出现 */
  surface?: ToolSurface;
  /** 只在按成员查询时出现 */
  agent_id?: string;
  /**
   * 只在按成员查询时出现：节点有、这个成员拿不到的工具 + 原因。
   *
   * 旧 gateway 没有这个字段（也不会有 `surface`）⇒ 按「不知道」处理，不推出「没有工具被挡」。
   */
  unavailable?: ToolUnavailable[];
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
