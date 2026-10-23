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
  workspace: string;
  handoff_path?: string;
  policy: Record<string, unknown>;
  member_count: number;
  created_at: number;
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
  kind: 'post' | 'mention' | 'system';
  system_event?: 'join' | 'leave' | 'rotate' | 'archive';
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
  resolution?: 'live' | 'resumed' | 'rotating';
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
  }): Promise<TeamPostResultLike>;
  members(input: {
    team_id: string;
    action: 'add' | 'remove';
    member: string;
    from?: string;
  }): Promise<TeamMembersResultLike | undefined>;
}
