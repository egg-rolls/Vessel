import type { AgentRole, ExecutionUnitStatus } from './agents';
import type { MessageRef } from './sessions';

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
  /** 显式模型 pin（只读 additive，model-registry A+B）；缺省 = 跟随节点默认。 */
  model?: string;
  /** S3 R1：已退役 Body，≤20；缺失时回退到事件累积。 */
  body_history?: TeamBodyHistoryEntry[];
  /** 0.27 additive：live body 列表；缺失时只有 `session_id` 一个 body。 */
  bodies?: ExecutionUnitStatus[];
  /** v3 additive：角色；旧 gateway 缺失时按 owner 推断。 */
  role?: AgentRole;
  /** v3 additive：member = self，temporary = 雇佣者；缺失时按旧语义推断。 */
  owner?: string;
  /**
   * 0.57 additive：该成员**最后一次活动**（epoch ms，服务端真值）。
   *
   * 来源是 registry 的 `AgentRecord.lastSeen`（`packages/agent/src/registry.ts`），
   * Team 卡排序拿它当「最近活动」的主键；旧 gateway 不返回时回落到 body 的
   * `last_active_at` / `created_at`（见 `state/team-order.ts#memberLastSeen`）。
   */
  last_seen?: number;
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
  /**
   * 0.38：`retract` 为 append-only tombstone，目标是 `retracted_message_id`。
   * 0.39：新写 `create`；旧日志的 `fork` 只读渲染。
   * 0.51：删掉 `rotate` —— 对应的 `agent.rotated` 从未发出过，这个值一行都没被写过。
   */
  system_event?: 'join' | 'leave' | 'archive' | 'create' | 'fork' | 'retract';
  /** 0.38 additive：tombstone 指向被撤回的消息；仅 `system_event: 'retract'` 时出现。 */
  retracted_message_id?: string;
  /** 0.21 additive：federation 入站日志的回信地址；本地日志缺失。 */
  federation?: TeamMessageFederation;
  /**
   * 0.52 additive：本条日志携带的附件引用（只有路径与元信息）。
   * 旧 gateway / 旧日志缺失 → 不渲染 chip，其它字段照常。
   */
  refs?: MessageRef[];
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
  /** 0.39：新写 `created`；旧日志的 `forked` 只读渲染。 */
  resolution?: 'live' | 'resumed' | 'rotating' | 'created' | 'forked';
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
  /** 0.52 additive：已写进日志的引用（无引用 / 旧 gateway 缺失）。 */
  refs?: MessageRef[];
}

/** `teams.retract` 结果（0.38 append-only tombstone）。 */
export interface TeamRetractResult {
  team_id: string;
  /** tombstone 自己的 message_id。 */
  message_id: string;
  /** 被撤回的目标 message_id。 */
  retracted_message_id: string;
}

/**
 * `teams.recall_delivery` 结果：编辑一条 team 消息时，逐成员级联消费 inbox 副本。
 * `deleted` / `skipped` 与 `agents.recall` 同形（inbox 消息 id）；skipped 的
 * not_found / consumed / active 都不是错误（副本早已不在「将执行」集合里）。
 */
export interface TeamRecallDeliveryResult {
  team_id: string;
  message_id: string;
  deliveries: {
    agent_id: string;
    deleted: string[];
    skipped: { message_id: string; reason: 'not_found' | 'consumed' | 'active' }[];
  }[];
}

/** teams.get 结果。 */
export interface TeamDetail {
  team: TeamSummary;
  members: TeamMember[];
  /** 本次返回的连续日志窗口（升序）；`before` 有值时是上一页。 */
  messages: TeamMessage[];
  /**
   * 本次窗口之前是否还有日志。S1 additive；旧 gateway 缺失视为 false。
   * 只有 `before` 响应可以更新翻页状态，尾页轮询不覆盖。
   */
  messages_has_more?: boolean;
}
