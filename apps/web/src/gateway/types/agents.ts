import type { Usage } from './runs';

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

/**
 * 0.27 live Body（`MemberStatus.bodies?` / `agents.list` 的 `bodies?`）。
 *
 * `body_id ≡ session_id`；`primary` 存在时为该 agent 的缺省投递目标。
 * 字段全部可选：旧 gateway 不返回 `bodies`，读侧降级为「只有 `session_id` 一个 body」。
 */
export interface ExecutionUnitStatus {
  body_id?: string;
  session_id?: string;
  state?: string;
  epoch?: number;
  created_at?: number;
  last_active_at?: number;
  primary?: boolean;
  retired_at?: number;
}

/**
 * Agent 角色 v3（CONTRACT-role-model §1；0.28 收窄）。
 *
 * `member` = 团队成员（含 `main`）；`temporary` = 临时雇佣者。
 * 旧 gateway 只返回 owner，UI 用 `roleOf()` 推断（owner 缺失 = member）。
 * 0.27 的 `single` 已删除：旧 gateway 仍可能送来该值，读侧统一按 `member` 处理
 * （`roleOf` 是唯一归一点，不要在各组件里各写一遍）。
 */
export type AgentRole = 'member' | 'temporary';

/**
 * 0.25 Agent CRUD（canonical `agents.create|update|close`）。
 *
 * 字段全部 optional：不同 gateway 版本可能只返回部分字段，UI 必须容错。
 * `agents.update` 的 model / system_prompt 从下一个 Body 生效，名称立即生效。
 */
export interface AgentSummary {
  agent_id?: string;
  id?: string;
  name?: string;
  team_id?: string;
  visibility?: 'private' | 'team' | 'tenant';
  membership?: 'present' | 'left';
  presence?: 'live' | 'gone';
  state?: string;
  model?: string;
  system_prompt?: string;
  session_id?: string;
  /** v3 additive：角色；旧 gateway 缺失时按 owner 推断。 */
  role?: AgentRole;
  /** 0.27 additive：owner 存在 = contractor，缺失 = peer。 */
  owner?: string;
  /** 0.27 additive：live body 列表；`session_id` 仍是 primary body。 */
  bodies?: ExecutionUnitStatus[];
  /**
   * 父 agent id（canonical `agents.list` 一直返回；0.51 起 Web 才用它）。
   *
   * 用途只有一个：历史脏数据（`parent_session_id` 里装的是 agent id）的甄别 ——
   * 用 roster 上溯到父 agent 的当前 primary body，见
   * `domains/pending/attribution.ts`。
   */
  parent_id?: string;
}

export interface AgentCreateInput {
  name?: string;
  model?: string;
  system_prompt?: string;
  /** 缺省 = unbound（不加入 Team）。 */
  team_id?: string;
  visibility?: 'private' | 'team' | 'tenant';
  /** 0.27 additive：创建判别；缺省保持现有语义。 */
  kind?: 'peer' | 'contractor';
}

export interface AgentUpdateInput {
  agent_id: string;
  name?: string;
  model?: string;
  system_prompt?: string;
  /** v3：转换角色；member 必须带 Team。 */
  role?: AgentRole;
  /** v3：转换 / 绑定 Team；member 必需，temporary 可选。 */
  team_id?: string;
}

/** canonical `agents.create|update|close` 是批量形状；Web 每次只发一条。 */
export interface AgentBatchSuccess {
  ok: true;
  agent: AgentSummary;
}

export interface AgentBatchFailure {
  ok: false;
  code?: string;
  error?: string;
}

export type AgentBatchEntry = AgentBatchSuccess | AgentBatchFailure;

export interface AgentBatchResponse {
  results?: AgentBatchEntry[];
}

/** `agents.inbox` 一条只读条目（0.52 待处理条带；0.53 加归属）。 */
export interface AgentInboxEntry {
  message_id: string;
  from: string;
  summary: string;
  status: 'unread' | 'held';
  ts: number;
  /**
   * 归属会话（0.53 additive）：这条消息是哪个会话的下一条输入。
   * 缺省 = 归属未知（老条目 / wake·quiet 投递）⇒ 条带一律不显示，宁可隐藏也不串台。
   */
  session_id?: string;
  /** 仅当请求带 `message_ids` 且命中时存在（peek 正文，不改状态）。 */
  text?: string;
}

export interface AgentInboxResponse {
  /** 这批条目所属的 agent（0.53 additive）：取消走 `agents.recall` 时要用它。 */
  agent_id?: string;
  unread: number;
  pending: number;
  entries: AgentInboxEntry[];
}

/** `agents.recall` 的单条跳过原因（与 `AgentInboxDiscardResult` 同形口径）。 */
export interface AgentRecallSkip {
  message_id: string;
  reason: 'not_found' | 'consumed' | 'active';
}

/** `agents.recall` 结果：`deleted` 是真正从待处理集合里拿掉的条目。 */
export interface AgentRecallResponse {
  deleted: string[];
  skipped?: AgentRecallSkip[];
}

/** `agents.claim` 的单条跳过原因（0.51；没有 `active` —— 正在跑的那条开跑即 consumed）。 */
export interface AgentClaimSkip {
  message_id: string;
  reason: 'not_found' | 'consumed';
}

/**
 * `agents.claim` 结果（0.51）：`claimed` = 真的被拿走（→ consumed）的条目。
 *
 * 与 `AgentRecallResponse` 同形，条带对两个动作写同一套「本地减法 + 如实报失败」；
 * 差别是**不可逆**：拿走的条目不再投递、不再出现在 `agents.inbox`。
 */
export interface AgentClaimResponse {
  claimed: string[];
  skipped?: AgentClaimSkip[];
}

/** `agents.send` 的单条结果（置顶复用 message_id + interrupt）。 */
export interface AgentSendEntry {
  ok: boolean;
  code?: string;
  error?: string;
  message_id?: string;
  queued?: boolean;
  state?: string;
}

export interface AgentSendResponse {
  results?: AgentSendEntry[];
}
