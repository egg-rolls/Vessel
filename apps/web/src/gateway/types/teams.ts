import type { AgentRole, BodyStatus } from './agents';

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
  member_count: number;
  /** S3 R1：present && live；缺失时显示 —。 */
  online_count?: number;
  policy?: Record<string, unknown>;
  created_at: number;
  /** 0.24 additive：归档时间；缺失 = active（DECISION-040）。 */
  archived_at?: number;
  /** 0.27 additive：冻结后禁止创建成员；缺失 = 未冻结。 */
  spawn_frozen?: boolean;
}

/** `teams.create` 参数（DECISION-040 §2.1）。 */
export interface TeamCreateInput {
  workspace: string;
  name?: string;
  description?: string;
  policy?: Record<string, unknown>;
}

/** `teams.update` 参数（DECISION-040 §2.2）；null = 清空该字段。 */
export interface TeamUpdateInput {
  team_id: string;
  name?: string;
  description?: string | null;
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
  /** 0.27 additive：live body 列表；缺失时只有 `session_id` 一个 body。 */
  bodies?: BodyStatus[];
  /** v3 additive：角色；旧 gateway 缺失时按 owner 推断。 */
  role?: AgentRole;
  /** v3 additive：member = self，temporary = 雇佣者；缺失时按旧语义推断。 */
  owner?: string;
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
