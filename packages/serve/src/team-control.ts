/**
 * canonical `teams.*` RPC 的结构化控制面端口（0.19 S3）。
 *
 * `packages/serve` 不依赖 `@vessel-agent/agent`（分包方向不可倒置）：
 * app 侧把 TeamService 直接注入本结构接口，不做二次映射。
 * 字段名与 `packages/agent` 的 Team 输出结构保持一致。
 *
 * @module @vessel-agent/serve
 */

/** 团队元数据（teams.list / teams.get 的 `team`）。 */
export interface TeamSummaryLike {
  team_id: string;
  name: string;
  tenant_id: string;
  /** team-scoped control token 不含此字段（白名单脱敏）。 */
  workspace?: string;
  handoff_path?: string;
  /** team-scoped control token 不含此字段（白名单脱敏）。 */
  policy?: Record<string, unknown>;
  member_count: number;
  /** present && presence === 'live'；从 roster 派生，不持久化 */
  online_count: number;
  created_at: number;
}

/** 已退役 Body（0.19 S6 additive）。 */
export interface AgentBodyHistoryEntryLike {
  session_id: string;
  epoch: number;
  started_at: number;
  retired_at: number;
}

/** roster 条目（由 Agent 记录派生，不单独持久化）。 */
export interface TeamMemberLike {
  agent_id: string;
  name?: string;
  session_id: string;
  team_id?: string;
  membership: 'present' | 'left';
  presence: 'live' | 'gone';
  visibility: 'private' | 'team' | 'tenant';
  state: string;
  epoch: number;
  /** 已退役 Body 历史（可选；旧数据缺失不报错） */
  body_history?: AgentBodyHistoryEntryLike[];
}

/** 只追加团队日志的一条记录。 */
export interface TeamMessageLike {
  message_id: string;
  team_id: string;
  from: string;
  to: string[];
  mentions: string[];
  content: string;
  ts: number;
  kind: 'post' | 'mention' | 'system' | 'reply';
  system_event?: 'join' | 'leave' | 'rotate' | 'archive' | 'budget_override' | 'fork';
  /** 0.19 S4 会话分组；旧日志缺省 */
  conversation_id?: string;
}

/** teams.get 的完整视图。 */
export interface TeamDetailLike {
  team: TeamSummaryLike;
  members: TeamMemberLike[];
  messages: TeamMessageLike[];
}

/** 单条 mention 投递结果。 */
export interface TeamDeliveryLike {
  agent_id: string;
  status: 'queued' | 'rejected' | 'error';
  message_id?: string;
  resolution?: 'live' | 'resumed' | 'rotating' | 'forked';
  code?: string;
  reason?: string;
}

/** teams.post 结果。 */
export interface TeamPostResultLike {
  message_id: string;
  team_id: string;
  kind: 'post' | 'mention' | 'system';
  mentions: string[];
  delivered: TeamDeliveryLike[];
  ts: number;
  /** 0.19 S4 会话分组 */
  conversation_id?: string;
}

/** 预算维度（0.19 S4）。 */
export type BudgetDimensionLike = 'hops' | 'turns' | 'tokens' | 'wall_clock' | 'cycle';

/** conversation 预算视图；不含正文。 */
export interface ConversationBudgetStatusLike {
  conversation_id: string;
  team_id?: string;
  created_at: number;
  last_activity: number;
  hops: number;
  turns: number;
  total_tokens: number;
  wall_clock_ms: number;
  edges: Array<{
    from: string;
    to: string;
    count: number;
    last_ts: number;
    blocked_until?: number;
  }>;
  overrides: Record<string, { max: number; by: 'human'; via: 'cli' | 'api'; at: number }>;
  blocked?: { dimension: BudgetDimensionLike; reason: string; at: number };
}

/** teams.budget 结果（status / override）。 */
export interface TeamBudgetResultLike {
  team_id: string;
  action: 'status' | 'override';
  conversation_id?: string;
  conversations?: ConversationBudgetStatusLike[];
  /** 单会话 status 时的视图（additive；与 conversations[0] 同形） */
  status?: ConversationBudgetStatusLike;
  previous_max?: number | null;
  max?: number | null;
}

/** teams.members 结果。 */
export interface TeamMembersResultLike {
  team_id: string;
  action: 'add' | 'remove';
  agent_id: string;
  membership: 'present' | 'left';
}

/**
 * 注入的 Team 控制面；`tenantId` 决定 canonical RPC 的 tenant 作用域。
 * 未注入 / tenant 不匹配时 `teams.*` 返回 `not_found`。
 */
export interface TeamControlLike {
  readonly tenantId: string;
  list(options?: { viewer?: string }): Promise<TeamSummaryLike[]>;
  get(
    teamId: string,
    options?: { viewer?: string; limit?: number },
  ): Promise<TeamDetailLike | undefined>;
  post(input: {
    team_id: string;
    content: string;
    mentions?: string[];
    from?: string;
    conversation_id?: string;
  }): Promise<TeamPostResultLike>;
  members(input: {
    team_id: string;
    action: 'add' | 'remove';
    member: string;
    from?: string;
  }): Promise<TeamMembersResultLike | undefined>;
  /** 0.19 S4：预算状态 / 人工 override；可选，未注入时 teams.budget 返回 not_found。 */
  budget?(input: {
    team_id: string;
    action: 'status' | 'override';
    conversation_id?: string;
    dimension?: BudgetDimensionLike;
    max?: number | null;
  }): Promise<TeamBudgetResultLike | undefined>;
}
