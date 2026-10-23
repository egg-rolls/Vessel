/**
 * Hub 控制面投影（S5）。
 *
 * `packages/serve` 只认识这些纯形状；Team / Agent 数据的实现由 app 层通过
 * `HubControlLike` 注入，serve 不依赖 `@vessel-agent/agent`。
 *
 * 投影只允许元数据；实现方必须白名单构造，不得透传 TeamService / AgentService
 * 的原始结果（尤其 messages / content / session_id / system_prompt）。
 *
 * @module @vessel-agent/serve/hub-control
 */

/** 目录数组上限；超出截断并置 `truncated: true`。 */
export const HUB_MAX_TEAMS = 500;
export const HUB_MAX_AGENTS = 2000;

/** 指针原因；固定子集，不是新事件枚举。 */
export type HubPointerReason =
  | 'team.message'
  | 'team.roster'
  | 'agent.state'
  | 'permission.request'
  | 'directory.changed';

/** Team 元数据（hub 目录只存这些字段）。 */
export interface HubTeamMeta {
  team_id: string;
  name: string;
  member_count: number;
  agent_count: number;
  /** present && live 的 Agent 数；缺失 = 节点未提供（S3 可选字段）。 */
  online_count?: number;
  /** 该 team 最近一次指针的 ts；不是消息时间线。 */
  last_active?: number;
}

/** Agent 元数据（不含 session / model / prompt / usage）。 */
export interface HubAgentMeta {
  agent_id: string;
  name?: string;
  team_id: string;
  membership: 'present' | 'left';
  presence: 'live' | 'gone';
  epoch?: number;
}

/** provider 返回的投影；revision / observed_at 由 gateway 补。 */
export interface HubNodeSnapshotInput {
  counts: { teams: number; agents: number; live_agents: number };
  teams: HubTeamMeta[];
  agents: HubAgentMeta[];
  /** teams 或 agents 被上限截断时为 true。 */
  truncated: boolean;
}

/** provider 产生的指针；node_id / ts 由 gateway 补。 */
export interface HubPointerInput {
  team_id: string;
  request_id?: string;
  reason: HubPointerReason;
  ts: number;
}

export interface HubControlChange {
  /** true 表示 teams / agents 需要重新 snapshot；gateway 用 250ms debounce 合并。 */
  directoryChanged?: boolean;
  pointers?: HubPointerInput[];
}

/** app 层注入的目录投影端口。 */
export interface HubControlLike {
  /** 只返回白名单投影；实现方不得透传原始 Team / Agent 结果。 */
  snapshot(tenantId: string): Promise<HubNodeSnapshotInput>;
  /** 订阅目录 / 指针变化；返回取消函数。 */
  subscribe(tenantId: string, listener: (change: HubControlChange) => void): () => void;
}

/**
 * team-scoped token 的事件归属映射。
 * 无法判定归属时必须返回 undefined（调用方 fail-closed 丢弃事件）。
 */
export interface HubTeamScopeLike {
  teamForSession(sessionId: string): string | undefined;
}
