/**
 * Agent 能力层契约（AgentService / registry / runtime port / snapshot）。
 *
 * 成员状态、可见性与 DTO 字段名是 0.17 的对外形状（snake_case），
 * 不要为内部方便改名；内部记录在 registry 里用 camelCase。
 *
 * @module @vessel-agent/agent
 */

import type { TeamPolicy } from '@vessel-agent/config';
import type { EventStream, Logger, RunEvent, Usage } from '@vessel-agent/core';

/** 成员状态（终态：completed / failed / cancelled / closed） */
export type MemberState =
  | 'created'
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'closed'
  | 'stale';

/** 成员可见性；private 仅 owner 可见 */
export type MemberVisibility = 'private' | 'team' | 'tenant';

/** 进程内存在性：live 表示 engine 在当前进程可用，gone 表示需要 resume（不持久化） */
export type MemberPresence = 'live' | 'gone';

/** 成员归属：present 在册，left 已关闭（持久化） */
export type MemberMembership = 'present' | 'left';

/** Body 轮换相位（不持久化；S2 rotate 使用） */
export type MemberRotation = 'stable' | 'rotating';

/** Body 指针：body_id ≡ session_id，epoch 由 current_body 派生 */
export interface AgentBodyPointer {
  session_id: string;
  epoch: number;
  started_at: number;
}

/** body_history 上限；超出时丢弃最旧条目 */
export const MAX_BODY_HISTORY = 20;

/** 已退役 Body 的历史条目；只追加，有界（最多 20 条） */
export interface AgentBodyHistoryEntry extends AgentBodyPointer {
  retired_at: number;
}

/** 成员对外状态（E1 冻结形状；新字段 additive） */
export interface MemberStatus {
  id: string;
  session_id: string;
  name?: string;
  parent_id?: string;
  /**
   * 归属 / private 可见性 principal；缺省表示 peer（无 owner）。
   * root owner 的 `owner === id`。
   */
  owner?: string;
  visibility: MemberVisibility;
  state: MemberState;
  current_tool?: string;
  last_seen?: number;
  usage?: Usage;
  /** 进程内 presence（DTO 派生，不落盘） */
  presence?: MemberPresence;
  /** 归属（DTO 派生，持久化在 PersistedAgentRecord） */
  membership?: MemberMembership;
  /** 当前 Body 的 epoch（由 current_body 派生） */
  epoch?: number;
  /** 所属 Team（0.19 S3；unbound 时缺省） */
  team_id?: string;
  /** 已退役 Body 历史（0.19 S6 additive；≤20，当前 Body 不在其中） */
  body_history?: AgentBodyHistoryEntry[];
}

/**
 * 快照持久化记录（v2）。
 *
 * 与 MemberStatus 分离：不把 model / system_prompt 等配置泄漏进对外 DTO。
 * presence / rotation 不持久化（进程内可重建）。
 */
export interface PersistedAgentRecord {
  id: string;
  /** 第一具 Body 的 session（兼容旧数据） */
  session_id: string;
  name?: string;
  parent_id?: string;
  /** 归属 principal；缺省 = peer（旧数据总有该字段） */
  owner?: string;
  visibility: MemberVisibility;
  /** 最后已知 engine 状态（重启后按 membership 重置） */
  state: MemberState;
  membership: MemberMembership;
  /** 所属 Team（0.19 S3；unbound 时缺省） */
  team_id?: string;
  model?: string;
  system_prompt?: string;
  current_body?: AgentBodyPointer;
  /** 已退役 Body 的历史（只追加，最多 20 条；当前 Body 不在其中） */
  body_history?: AgentBodyHistoryEntry[];
  forked_from?: string;
  current_tool?: string;
  last_seen?: number;
  usage?: Usage;
}

/** 成员间消息；队列只在内存，不落 snapshot */
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  ts: number;
  /** 会话分组（0.19 S4）；系统提示也继承当前会话 */
  conversation_id?: string;
  /** 系统提示类别；rotate 成功时移除 limit_warning，避免旧 Body 的预警发给新 Body */
  kind?: 'limit_warning';
}

/** 传给执行内核的成员身份（不携带 registry 状态） */
export interface MemberRuntimeMember {
  id: string;
  session_id: string;
  name?: string;
  parent_id?: string;
  /** 归属 principal；peer 缺省 */
  owner?: string;
  visibility: MemberVisibility;
  /** 所属 Team（0.19 S4：权限策略 / bridge 归属） */
  team_id?: string;
  model?: string;
  system_prompt?: string;
}

/** 一轮执行的结果 */
export interface MemberTurnResult {
  /** 本轮最终文本；成员未显式 reply 时由 AgentService 自动投递给父成员 */
  content?: string;
  outcome?: TurnOutcome;
  usage?: Usage;
}

/**
 * 执行内核适配口（A2/A3 提供实现）。
 *
 * runTurn 被 AgentService 调用，不得在内部吞掉取消；
 * 成员若调用 `reply`，本轮自动最终文本会被抑制。
 */
export interface MemberRuntimePort {
  spawn(member: MemberRuntimeMember): Promise<void>;
  runTurn(member: MemberRuntimeMember, message: AgentMessage): Promise<MemberTurnResult>;
  cancel(member: MemberRuntimeMember): Promise<void> | void;
  dispose(member: MemberRuntimeMember): Promise<void> | void;
}

/** `AgentService.drain` 结果：无在跑轮 / 已中断收口 / 超时 */
export type AgentDrainOutcome = 'idle' | 'interrupted' | 'timeout';

export interface AgentDrainOptions {
  timeoutMs?: number;
  /** 测试注入：等待下一次轮询 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** 权限请求（传输由入口层实现；A1 只定义形状与状态等待） */
export interface PermissionRequestInput {
  requestId?: string;
  tool: string;
  input?: unknown;
}

/** 权限应答；桥梁缺席或异常时按 deny 处理 */
export interface PermissionDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

/** bridge 模式下成员处于/离开权限等待的阶段（执行内核回调 AgentService 用） */
export type MemberPermissionState = 'waiting' | 'running';

// ─── Conversation budget（0.19 S4）──────────────────────────────

export type BudgetDimension = 'hops' | 'turns' | 'tokens' | 'wall_clock' | 'cycle';

export type BudgetBlockReason =
  | 'budget_exceeded'
  | 'cycle_detected'
  | 'budget_unavailable'
  | 'conversation_team_mismatch';

/** 有向边计数（环检测用；最多 32 条，按 last_ts 淘汰） */
export interface ConversationBudgetEdge {
  from: string;
  to: string;
  count: number;
  last_ts: number;
  /** 冷却截止时间；未触发时缺省 */
  blocked_until?: number;
}

/** 一条 conversation 的预算视图；不含正文 */
export interface ConversationBudgetStatus {
  conversation_id: string;
  team_id?: string;
  created_at: number;
  last_activity: number;
  hops: number;
  turns: number;
  total_tokens: number;
  wall_clock_ms: number;
  edges: ConversationBudgetEdge[];
  overrides: Partial<
    Record<BudgetDimension, { max: number; by: 'human'; via: 'cli' | 'api'; at: number }>
  >;
  blocked?: { dimension: BudgetDimension; reason: BudgetBlockReason; at: number };
}

/** 投递 / turn 的预算判定结果 */
export type BudgetCheckResult =
  | { ok: true }
  | {
      ok: false;
      dimension: BudgetDimension;
      reason: BudgetBlockReason;
      current: number;
      max: number | null;
      retry_after_ts?: number;
    };

/** 80% 预警（进程内待发布）；service 经端口取走 */
export interface BudgetWarning {
  conversation_id: string;
  team_id?: string;
  dimension: Exclude<BudgetDimension, 'cycle'>;
  current: number;
  max: number;
  threshold: number;
}

/** receiver-side turn 被挡时持久化的 blocked 状态 */
export interface BudgetTurnBlockedInput {
  conversation_id: string;
  team_id?: string;
  dimension: BudgetDimension;
  reason: BudgetBlockReason;
}

export interface BudgetDeliveryInput {
  conversation_id: string;
  team_id?: string;
  /** true 表示 team_id 是显式 origin 声明；跨 Team 回复不设，沿用已存 origin */
  origin_explicit?: boolean;
  from: string;
  to: string;
  message_id?: string;
}

export interface BudgetTurnInput {
  conversation_id: string;
  team_id?: string;
  agent_id: string;
  session_id: string;
  message_id: string;
}

export interface BudgetTurnStartedInput {
  conversation_id: string;
  team_id?: string;
  agent_id: string;
  message_id: string;
}

export interface BudgetTurnFinishedInput {
  conversation_id: string;
  team_id?: string;
  agent_id: string;
  message_id: string;
  usage?: Usage;
}

export interface BudgetStatusInput {
  team_id: string;
  conversation_id?: string;
}

export interface BudgetOverrideInput {
  team_id: string;
  conversation_id: string;
  dimension: BudgetDimension;
  /** null = 清除人工 override，回到 team policy */
  max: number | null;
  /** 审计来源；缺省 api（canonical 入口），owner / CLI 传 cli */
  via?: 'cli' | 'api';
}

export interface BudgetOverrideResult {
  conversation_id: string;
  dimension: BudgetDimension;
  previous_max: number | null;
  max: number | null;
  status: ConversationBudgetStatus;
}

/** AgentService.budget 的统一返回；按 action 区分 */
export type BudgetOverview =
  | { action: 'status'; team_id: string; conversations: ConversationBudgetStatus[] }
  | ({ action: 'override'; team_id: string } & BudgetOverrideResult);

/** 预算状态存储 / 判定端口；文件实现由 wiring 构造 */
export interface ConversationBudgetPort {
  checkDelivery(input: BudgetDeliveryInput): BudgetCheckResult;
  canStartTurn(input: BudgetTurnInput): BudgetCheckResult;
  noteTurnStarted(input: BudgetTurnStartedInput): void;
  noteTurnFinished(input: BudgetTurnFinishedInput): void;
  status(input: BudgetStatusInput): ConversationBudgetStatus[];
  override(input: BudgetOverrideInput): BudgetOverrideResult;
  /** 清除该会话的接收侧 hold；返回需要重新 pump 的 agent id */
  release(conversationId: string): string[];
  /** 可选：service 发布预警 / 记账 receiver-side hold（实现可按需提供） */
  takeWarnings?(conversationId: string): BudgetWarning[];
  noteHold?(conversationId: string, agentId: string): void;
  clearHold?(conversationId: string, agentId: string): void;
  noteTurnBlocked?(input: BudgetTurnBlockedInput): void;
  flush(): Promise<void>;
}

/** 成员创建参数 */
export interface CreateMemberInput {
  name?: string;
  model?: string;
  systemPrompt?: string;
  visibility?: MemberVisibility;
  parentId?: string;
  /**
   * 归属 principal：string = contractor；null = 显式无 owner（peer）；
   * 缺省 = DEFAULT_OWNER（legacy 行为）。
   */
  owner?: string | null;
  /** 输入判别（不持久化）：peer 无 owner 且必须有 Team；contractor 有 owner */
  kind?: 'peer' | 'contractor';
  /** 按已存在 Team 绑定（成员派生路径）；不存在 → invalid_input */
  teamId?: string;
  /** 调用者 id（审计用，不持久化；仅写入 agent.spawned 事件） */
  spawnedBy?: string;
  /**
   * 0.19 S3：显式 workspace（只有 CLI 能传；模型工具不能伪造）。
   * 首个绑定该 workspace 的 Agent 隐式创建 Team；无 name 时拒绝绑定。
   */
  workspace?: string;
}

/** 批量创建（条目并行，逐条结果） */
export interface CreateBatchInput {
  members: CreateMemberInput[];
}

/** update 可修改的配置字段（事件里只出现这些名字，绝不带 prompt 正文） */
export type AgentUpdateField = 'name' | 'model' | 'system_prompt';

/**
 * 更新成员（0.25）。
 *
 * 选择器 `id` / `to` 接受成员 id、当前 Body session 或唯一当前名字（与其它入口一致）。
 * `name` 是**新名字**，不是选择器；改名立即生效。
 * `model` / `systemPrompt` 只写入记录，由**下一次 spawn 的 Body** 使用；
 * 当前已存在的 Body 不会因 update 而重建。
 */
export interface AgentUpdateInput {
  /** 选择器：成员 id / 当前 Body session / 唯一当前名字 */
  id?: string;
  /** 选择器别名（与 close 的 `to` 一致） */
  to?: string;
  /** 新名字 */
  name?: string;
  model?: string;
  systemPrompt?: string;
}

/** 批量更新（条目并行，逐条结果；与 create / close 同语义） */
export interface AgentUpdateBatchInput {
  updates: AgentUpdateInput[];
}

/** 更新结果：`applies_to: 'next_body'` 只在 model / systemPrompt 实际变化时出现 */
export interface AgentUpdateResult {
  agent: MemberStatus;
  /** 实际变化的字段名（顺序：name → model → system_prompt） */
  changed: AgentUpdateField[];
  applies_to?: 'next_body';
}

/**
 * 注册 root owner（REPL 主 agent）。不调用 runtime.spawn。
 * 重复 attach 幂等；stale 记录恢复为 idle。
 */
export interface AttachOwnerInput {
  id: string;
  /** 缺省与 id 相同 */
  sessionId?: string;
  visibility?: MemberVisibility;
}

/** 发送参数；`to` 可传成员 id 或 session id */
export interface SendInput {
  to: string;
  content: string;
  /** 发送者；缺省 DEFAULT_OWNER，private 成员只有 owner 能寻址 */
  from?: string;
  /** 会话分组；缺省由入口生成（0.19 S4） */
  conversation_id?: string;
}

/** 批量发送 */
export interface SendBatchInput {
  messages: SendInput[];
}

/**
 * dispatch：统一入口。`to` 可为 id / session_id / 唯一 name。
 * 与 strict `send` 的区别：gone 成员会先 resume，rotating 成员先排队。
 */
export interface DispatchInput {
  to: string;
  content: string;
  from?: string;
  /** 会话分组；缺省生成（0.19 S4） */
  conversation_id?: string;
  /**
   * 显式 origin team（TeamService.post 用）；与已存 conversation 的 team 不一致时拒绝。
   * 成员 send / reply / owner dispatch 不传，由发送者或目标推导。
   */
  origin_team_id?: string;
  /**
   * 0.20：本次投递是否允许在 resume 失败后 fork 新 Agent。
   * 缺省看 team policy `allowFork`（默认关闭）；显式值覆盖 policy。
   */
  allow_fork?: boolean;
}

/** dispatch 结果：queued 表示已入队；rejected 是明确的业务拒绝 */
export type DispatchResult =
  | {
      status: 'queued';
      message_id: string;
      resolved_to: string;
      resolution: 'live' | 'resumed' | 'rotating' | 'forked';
      /** 0.19 S4；实现始终返回，类型保持 additive */
      conversation_id?: string;
    }
  | {
      status: 'rejected';
      code:
        | 'agent_left'
        | 'resume_failed'
        | 'fork_failed'
        | 'team_full'
        | 'team_frozen'
        | 'not_visible'
        | 'budget_exceeded'
        | 'budget_unavailable'
        | 'conversation_team_mismatch';
      reason: string;
    };

/**
 * rotate：Agent 换一具新 Body；id / name / owner / 配置不变。
 * startup_prompt 必填，作为新 Body 的第一条消息。
 */
export interface RotateInput {
  /** agent id | 当前 Body 的 session_id | 唯一 name */
  to: string;
  startup_prompt: string;
  /** 调用者当前 Body 的 session；agent 工具路径必填，CLI / owner 路径缺省 */
  from_session_id?: string;
  /** 可见性判定；缺省 DEFAULT_OWNER */
  from?: string;
}

/** rotate 结果：failed 表示旧指针保持不变 */
export type RotateResult =
  | {
      status: 'rotated';
      agent_id: string;
      from_session_id: string;
      to_session_id: string;
      epoch: number;
    }
  | {
      status: 'failed';
      code:
        | 'rotate_failed'
        | 'agent_left'
        | 'not_current_body'
        | 'body_not_live'
        | 'rotating'
        | 'not_visible';
      reason: string;
    };

/**
 * roster add（0.19 S3）：把 Agent 绑定到 Team 并恢复 present。
 * 不 spawn、不新建 session；保留 current_body / body_history。
 * 这是继 `attachOwner` 之后第二条人力 `left → present` 路径。
 */
export interface ReinstateInput {
  /** agent id | 当前 Body session | 唯一 name */
  to: string;
  /** 目标 Team；unbound Agent 在此写入 */
  team_id: string;
  /** 可见性判定；缺省 DEFAULT_OWNER */
  from?: string;
}

/** 关闭参数 */
export interface CloseInput {
  member?: string;
  to?: string;
}

/** 批量关闭（成员 id / session id） */
export interface CloseBatchInput {
  members: string[];
}

/** 列表过滤；viewer 用于 private 可见性判定 */
export interface ListFilter {
  viewer?: string;
  visibility?: MemberVisibility;
  state?: MemberState | readonly MemberState[];
  parentId?: string;
}

/** 发送结果：入队即返回，不等待一轮结束 */
export interface SendResult {
  queued: true;
  message_id: string;
  state: MemberState;
}

/** 成员回复父级的结果 */
export interface ReplyResult {
  queued: true;
  message_id: string;
  to: string;
}

/** 关闭结果；重复 close 幂等 */
export interface CloseResult {
  state: 'closed';
}

/**
 * 批量逐条结果；成功条目放在 status。
 * 0.25：失败条目可选带稳定 `code`（AgentError.code / 其它错误对象的 code），
 * 供 canonical RPC / owner 端点共用的逐条结果使用。
 */
export type BatchItemResult<T> =
  | { ok: true; status: T }
  | { ok: false; error: string; code?: string };

/** 批量结果（与输入顺序一致；单条失败不影响其它条目） */
export interface BatchResult<T> {
  results: BatchItemResult<T>[];
}

/** 快照写入选项 */
export interface AgentSnapshotOptions {
  enabled?: boolean;
  /** 合并写入窗口；缺省 0（下一轮事件循环） */
  throttleMs?: number;
  /** POSIX 权限；缺省 0o600 */
  mode?: number;
}

/** 一轮的结局；缺省 completed */
export type TurnOutcome = 'completed' | 'failed' | 'cancelled';

/** 成员事件（开放字符串；字段 snake_case） */
export interface AgentEvent {
  type: string;
  agent_id: string;
  session_id?: string;
  parent_id?: string;
  /** 成员可见性（/agents Self Card 用；spawned 等身份事件必带） */
  visibility?: MemberVisibility;
  /** 成员名（可选） */
  name?: string;
  /** 所属 Team（0.19 S3；unbound / system 事件可能缺省） */
  team_id?: string;
  /** 调用者 id（仅 `agent.spawned`；不持久化） */
  spawned_by?: string;
  /** 会话分组（0.19 S4；system 事件可能缺省） */
  conversation_id?: string;
  /** 本轮 usage（turn.completed 有则带） */
  usage?: Usage;
  /** 仅在 `agent.reply.posted` 携带本轮最终文本（≤64 KiB，超限截断） */
  content?: string;
  state?: MemberState;
  /** 进程内 presence（agent.stale / agent.resumed 等生命周期事件） */
  presence?: MemberPresence;
  /** 当前 Body epoch（agent.resumed） */
  epoch?: number;
  /** rotate：旧 / 新 Body 的 session */
  from_session_id?: string;
  to_session_id?: string;
  /** 事件所属 Body（旧轮终态 / retired / reply.stale） */
  body_id?: string;
  /** 旧 Body 轮末终态标记 */
  stale?: boolean;
  message_id?: string;
  /** 消息来源（queued 事件） */
  from?: string;
  /** 事件目标（0.20 `agent.forked` / `agent.reply.dropped`；与 from 成对） */
  to?: string;
  tool?: string;
  outcome?: TurnOutcome;
  reason?: string;
  request_id?: string;
  decision?: 'allow' | 'deny';
  ts: number;
}

/** 事件监听器；抛错会被隔离，不影响服务行为 */
export type AgentEventListener = (event: AgentEvent) => void;

/** AgentService 构造参数 */
export interface AgentServiceOptions {
  /** 一个实例只服务一个 tenant */
  tenantId: string;
  /** 缺省不落盘（纯内存） */
  dataDir?: string;
  runtime: MemberRuntimePort;
  now?: () => number;
  /** 注入 id 生成器（session_id === member id） */
  newId?: () => string;
  logger?: Logger;
  snapshot?: AgentSnapshotOptions;
  /** 可选的进程内事件流出口；同时仍可 subscribe */
  events?: EventStream;
  /** 创建成员未显式指定 model 时使用的“有效 model”（落库，供 resume 使用） */
  defaultModel?: string;
  /**
   * 0.19 S3：`create` 未显式传 workspace 时的默认 workspace。
   * 仅由“配置声明命中 agent.cwd”提供；无声明时为 undefined（保持 unbound）。
   */
  defaultWorkspace?: string;
  /** 0.19 S3：Team 绑定端口；缺失时 `create` 永远 unbound */
  teamBinder?: TeamBinder;
  /** 0.19 S4：按 team_id 读取解析后的 policy；缺失 = 无 team policy */
  teamPolicy?: (teamId: string) => TeamPolicy | undefined;
  /** 0.19 S4：conversation 预算端口；缺失 = 不执行预算（测试 / 纯内存） */
  budget?: ConversationBudgetPort;
}

/** 稳定错误码（入口层据此映射 RPC / CLI 错误） */
export type AgentErrorCode =
  | 'invalid_input'
  | 'unknown_member'
  | 'member_closed'
  | 'member_stale'
  | 'member_not_visible'
  | 'no_parent'
  | 'spawn_failed'
  | 'team_full'
  | 'team_frozen'
  | 'invalid_state_transition'
  | 'budget_exceeded'
  | 'budget_unavailable'
  | 'conversation_team_mismatch';

/** AgentService 错误；code 稳定，message 供人读 */
export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

/** Agent 能力层唯一契约 */
export interface AgentService {
  // create 是普通方法名，不会与构造签名冲突
  create(input: CreateMemberInput): Promise<MemberStatus>;
  create(input: CreateBatchInput): Promise<BatchResult<MemberStatus>>;
  /** 注册 root owner；不 spawn，重复调用幂等 */
  attachOwner(input: AttachOwnerInput): Promise<MemberStatus>;
  /**
   * 更新名字 / model / systemPrompt；名字立即生效且保持同 Team（unbound 为 tenant）
   * 内 present 成员唯一。model / systemPrompt 只影响下一次 spawn 的 Body。
   */
  update(input: AgentUpdateInput): Promise<AgentUpdateResult>;
  /** 批量更新：条目并行，按输入顺序返回逐条结果 */
  update(input: AgentUpdateBatchInput): Promise<BatchResult<AgentUpdateResult>>;
  send(input: SendInput): Promise<SendResult>;
  send(input: SendBatchInput): Promise<BatchResult<SendResult>>;
  /**
   * 统一投递入口：live 直接入队；gone 先 single-flight resume；
   * rotating 入队等待；left / resume 失败返回 rejected。
   */
  dispatch(input: DispatchInput): Promise<DispatchResult>;
  /**
   * 换一具新 Body：旧 Body 跑完当前轮后退役，新 Body 以 startup_prompt 开始。
   * 失败保持旧指针，不自动 fork / 重试。
   */
  rotate(input: RotateInput): Promise<RotateResult>;
  /**
   * roster add：绑定 Team 并把 `left` 恢复为 `present`（不 spawn、不新建 session）。
   * 只由人力入口（teams.members add / owner 端点）调用。
   */
  reinstate(input: ReinstateInput): Promise<MemberStatus>;
  close(input: CloseInput): Promise<CloseResult>;
  close(input: CloseBatchInput): Promise<BatchResult<CloseResult>>;
  list(filter?: ListFilter): Promise<MemberStatus[]>;
  /**
   * session 是否属于被 spawn 的成员；external owner 的 session 返回 false。
   * O(1) 直查，不受 visibility 过滤。
   */
  hasMember(sessionId: string): Promise<boolean>;
  /** 成员显式回复父级；本轮自动最终文本随后被抑制 */
  reply(memberId: string, content: string): Promise<ReplyResult>;
  /**
   * 取走成员待处理消息（REPL owner 用）；FIFO，不触发 runTurn，不重复投递。
   * limit 缺省取空队列。
   */
  takeMessages(memberId: string, limit?: number): Promise<AgentMessage[]>;
  /**
   * 当前 Body session -> 成员状态；忽略可见性。
   * 只由 TeamService / agent 工具做调用者身份解析，不向模型暴露。
   */
  identify(sessionId: string): Promise<MemberStatus | undefined>;
  /** 执行内核 bridge 上报的权限等待/恢复；只接受当前运行 Body 的回调 */
  notePermissionState(memberId: string, sessionId: string, state: MemberPermissionState): void;
  /** 成员引擎事件回流（装配用）；当前只处理当前 Body 的 agent.limit.warning */
  noteMemberEvent(memberId: string, sessionId: string, event: RunEvent): void;
  /**
   * 该 session 是否属于某个非 owner 成员的 Body：当前 Body、正在跑的旧 Body、
   * 已退役 Body 或 rotate 目标 Body 都算。owner 的 Body 不算。
   */
  isMemberBody(sessionId: string): boolean;
  /** 当前 turn 的 conversation_id；无在跑轮次或缺省时 undefined（TeamService 用） */
  currentConversation(agentId: string): string | undefined;
  /** conversation 预算状态 / 人工 override（只由人力入口调用） */
  budget(input: BudgetStatusInput | BudgetOverrideInput): Promise<BudgetOverview>;
  /**
   * 关闭前中断并等待成员轮收口（含成员 Body 共享的 eventLog 写入）。
   * 只影响在跑轮：不改 registry 状态 / membership，也不启动队列里的后续消息。
   */
  drain(options?: AgentDrainOptions): Promise<AgentDrainOutcome>;
  /** 立即落盘待写快照；无 snapshot 或写入成功返回 true，写入失败返回 false */
  flushSnapshot(): Promise<boolean>;
  /** 订阅成员事件；返回取消函数 */
  subscribe(listener: AgentEventListener): () => void;
}

// ─── Team（0.19 S3）────────────────────────────────────────────

/** Team 元数据（`<dataDir>/teams/<tenant>/<team_id>/team.json`） */
export interface TeamRecord {
  v: 1;
  /** slug(workspace basename)；创建后不可变 */
  team_id: string;
  name: string;
  tenant_id: string;
  /** 归一化绝对路径；Team 的唯一 workspace 来源 */
  workspace: string;
  /** 自由文本：这个 Team 是什么、找谁、怎么用（0.21 additive） */
  description?: string;
  /** S3 只存不执行 */
  policy: Record<string, unknown>;
  created_at: number;
  /** S10.3 additive：归档时间（epoch ms）；存在即只读，无删除路径 */
  archived_at?: number;
  /** 0.27 additive：冻结期间拒绝该 Team 的所有创建 / fork / reinstate */
  spawn_frozen?: boolean;
}

/**
 * 创建 Team（S10.3）。
 *
 * workspace 已属于某个 Team 时幂等返回既有 Team，绝不覆盖 name / policy；
 * 不 spawn 成员，空 Team 合法。
 */
export interface TeamCreateInput {
  workspace: string;
  name?: string;
  description?: string;
  policy?: Record<string, unknown>;
}

/** 更新补丁：缺省（undefined）保留字段，`null` 清除可选项，policy 整体替换 */
export type TeamUpdatePatch = {
  name?: string;
  description?: string | null;
  policy?: Record<string, unknown>;
};

export interface TeamUpdateInput extends TeamUpdatePatch {
  team_id: string;
}

export interface TeamArchiveInput {
  team_id: string;
}

/** 配置声明（全局配置；tenant overlay 不开放） */
export interface TeamDeclaration {
  name?: string;
  workspace: string;
  description?: string;
  policy?: Record<string, unknown>;
}

export type TeamSystemEvent = 'join' | 'leave' | 'rotate' | 'archive' | 'budget_override' | 'fork';

/** 只追加团队日志的一行 */
export interface TeamLogEntry {
  message_id: string;
  team_id: string;
  /** 'system' | owner id | 成员 agent id | 'human' */
  from: string;
  /** 投递目标 agent id（无 @ 时为空） */
  to: string[];
  /** 结构化 agent id；与正文里的 @ 无关 */
  mentions: string[];
  content: string;
  ts: number;
  kind: 'post' | 'mention' | 'system' | 'reply';
  system_event?: TeamSystemEvent;
  /** 会话分组（0.19 S4；系统消息缺省） */
  conversation_id?: string;
  /** 跨节点来源 / 目标地址（0.21 additive；只在 federation 入站日志出现） */
  federation?: TeamLogFederation;
}

/** 跨节点报文在 Team 日志上的结构化回信地址。 */
export interface TeamLogFederation {
  /** `<principal>@<node_id>:<team_id>` */
  from_addr: string;
  /** `<principal>@<node_id>:<team_id>` */
  to_addr: string;
  conversation_id: string;
  hop: number;
}

/** roster 条目（由 Agent 记录派生，不单独持久化） */
export interface TeamMemberSummary {
  agent_id: string;
  name?: string;
  session_id: string;
  /** 所属 Team（unbound 时缺省） */
  team_id?: string;
  membership: MemberMembership;
  presence: MemberPresence;
  /** 归属 principal；peer 缺省（Web 用于标记 peer / contractor） */
  owner?: string;
  visibility: MemberVisibility;
  state: MemberState;
  epoch: number;
  /** 最后活跃时间（0.21 additive；epoch ms） */
  last_seen?: number;
  /** 已退役 Body 历史（0.19 S6 additive；可选，旧数据缺失不报错） */
  body_history?: AgentBodyHistoryEntry[];
}

export interface TeamSummary {
  team_id: string;
  name: string;
  tenant_id: string;
  workspace: string;
  /** 0.21 additive */
  description?: string;
  policy: Record<string, unknown>;
  member_count: number;
  /** present && presence === 'live' 的成员数；从 roster 派生，不持久化 */
  online_count: number;
  created_at: number;
  /** S10.3 additive：归档时间（epoch ms）；存在即只读 */
  archived_at?: number;
  /** 0.27 additive：Team 冻结状态（只读回显） */
  spawn_frozen?: boolean;
}

export interface TeamDetail {
  team: TeamSummary;
  members: TeamMemberSummary[];
  messages: TeamLogEntry[];
}

export interface TeamDelivery {
  agent_id: string;
  status: 'queued' | 'rejected' | 'error';
  message_id?: string;
  resolution?: 'live' | 'resumed' | 'rotating' | 'forked';
  code?: string;
  reason?: string;
}

export interface TeamPostInput {
  team_id: string;
  content: string;
  /** 结构化 agent id；不从正文解析 */
  mentions?: string[];
  /** 只写进日志的收件人标记（不 dispatch；0.21 federation owner） */
  to?: string[];
  from?: string;
  /** 会话分组；缺省生成，所有 mention 共用（0.19 S4） */
  conversation_id?: string;
  /** 跨节点报文元数据（0.21 additive；日志保留原文，dispatch 前置回信抬头） */
  federation?: TeamLogFederation;
}

export interface TeamPostResult {
  message_id: string;
  team_id: string;
  kind: 'post' | 'mention' | 'system';
  mentions: string[];
  delivered: TeamDelivery[];
  ts: number;
  /** 本条 post 的会话分组（0.19 S4） */
  conversation_id?: string;
}

export interface TeamMembersInput {
  team_id: string;
  action: 'add' | 'remove';
  member: string;
  from?: string;
}

export interface TeamMembersResult {
  team_id: string;
  action: 'add' | 'remove';
  agent_id: string;
  membership: MemberMembership;
}

export interface TeamListOptions {
  viewer?: string;
}

export interface TeamGetOptions {
  viewer?: string;
  /** 最近消息条数；缺省 100，最大 1000 */
  limit?: number;
  /** roster 条数窗口（0.21）；缺省 20，最大 100；live 优先、last_seen 降序 */
  members_limit?: number;
}

export interface TeamRosterOptions {
  viewer?: string;
}

/** 成员 Body 的 A2A send（agent 工具用）；from 由 session 解析，模型不能伪造 */
export interface TeamAgentSendInput {
  from_session_id: string;
  to: string;
  content: string;
  /** 会话分组；缺省继承调用者当前 turn（0.19 S4） */
  conversation_id?: string;
}

export interface TeamAgentSendResult {
  status: 'queued' | 'rejected' | 'error';
  resolved_to?: string;
  message_id?: string;
  resolution?: 'live' | 'resumed' | 'rotating' | 'forked';
  code?: string;
  reason?: string;
  /** 是否写入了同 Team 的 mention 日志 */
  logged: boolean;
  /** 本次 send 的会话分组（0.19 S4） */
  conversation_id?: string;
}

/**
 * 跨节点发送端口（0.21）。由 app 层注入：`packages/agent` 不依赖 federation
 * client / 配置 / HTTP，只负责判断地址形式、填 `from` 与映射结果。
 */
export interface FederationSendPort {
  /** 本机节点 id；`from` 由 agent 层用 `<caller>@<nodeId>:<team>` 构造。 */
  readonly nodeId: string;
  send(input: FederationSendRequest): Promise<FederationSendResult>;
}

export interface FederationSendRequest {
  /** 完整地址 `<principal>@<node_id>:<team_id>`，由运行时填写，模型不能伪造 */
  from: string;
  /** 完整地址；模型原样给出，由 app 层解析 */
  to: string;
  content: string;
  conversation_id?: string;
}

export type FederationSendResult =
  | { status: 'queued'; message_id: string }
  | { status: 'rejected' | 'error'; code: string; reason: string };

/** Team 元数据 + 只追加日志的存储端口（文件实现见 team-store.ts） */
export interface TeamBinder {
  ensureForWorkspace(input: {
    workspace: string;
    name?: string;
    description?: string;
    policy?: Record<string, unknown>;
  }): Promise<TeamRecord>;
  /** 0.20 fork：只读 TeamRecord（workspace）；不存在返回 undefined */
  get(teamId: string): TeamRecord | undefined;
}

export interface TeamStore extends TeamBinder {
  /** 配置声明：只补写缺失的 team.json，不创建 Agent、不覆盖已有字段 */
  seed(declarations: readonly TeamDeclaration[]): Promise<void>;
  /** S10.3：创建 / 幂等复用 workspace 已有的 Team；不 spawn 成员 */
  create(input: TeamCreateInput): Promise<{ record: TeamRecord; deduplicated: boolean }>;
  /** S10.3：更新可变字段；归档 Team 拒绝；先落盘再改内存 */
  update(teamId: string, patch: TeamUpdatePatch): Promise<TeamRecord>;
  /** S10.3：归档（幂等）；先落盘再改内存；roster 检查在 TeamService */
  archive(teamId: string): Promise<TeamRecord>;
  /** 0.27：写 spawn_frozen（true 写入，false 删除字段）；先落盘再改内存 */
  setSpawnFrozen(teamId: string, frozen: boolean): Promise<TeamRecord>;
  get(teamId: string): TeamRecord | undefined;
  /** 解析后的 policy；手改非法预算 warning + 忽略，返回 undefined / 去掉非法子结构 */
  policy(teamId: string): TeamPolicy | undefined;
  list(): TeamRecord[];
  readLog(teamId: string, options?: { limit?: number }): Promise<TeamLogEntry[]>;
  /** 串行追加；失败抛出 */
  appendLog(entry: TeamLogEntry): Promise<void>;
  /** 等待串行写链落盘（关闭 / 测试用） */
  flush(): Promise<void>;
}

/** TeamService 事件（指针用途）：绝不含正文。 */
export interface TeamServiceEvent {
  team_id: string;
  /** 日志写入类别，或 roster / spawn 冻结变更 */
  kind: 'post' | 'mention' | 'reply' | 'system' | 'roster' | 'spawn';
  /** 日志写入成功后的 message_id；roster 事件缺省 */
  message_id?: string;
  /** kind === 'spawn' 时的冻结状态 */
  frozen?: boolean;
}

/** Team 能力层（AgentService 之上的 roster / 日志 / 定向投递） */
export interface AgentTeamService {
  readonly tenantId: string;
  /** S10.3：创建 Team（workspace 已有 Team 时幂等复用，返回同一个 TeamSummary） */
  create(input: TeamCreateInput): Promise<TeamSummary>;
  /** S10.3：更新 Team 元数据；归档 Team 抛 team_archived */
  update(input: TeamUpdateInput): Promise<TeamSummary>;
  /** S10.3：归档空 Team；仍有 present 成员时抛 team_not_empty */
  archive(input: TeamArchiveInput): Promise<TeamSummary>;
  /** 0.27：冻结 / 解冻 Team 的 spawn 闸门；返回最新摘要 */
  setSpawnFrozen(teamId: string, frozen: boolean): Promise<TeamSummary>;
  /** 0.27：同步读取冻结状态；Team 不存在视为未冻结 */
  isSpawnFrozen(teamId: string): boolean;
  list(options?: TeamListOptions): Promise<TeamSummary[]>;
  get(teamId: string, options?: TeamGetOptions): Promise<TeamDetail | undefined>;
  roster(teamId: string, options?: TeamRosterOptions): Promise<TeamMemberSummary[]>;
  post(input: TeamPostInput): Promise<TeamPostResult>;
  /** 未知 Team 返回 undefined；业务失败抛 TeamError */
  members(input: TeamMembersInput): Promise<TeamMembersResult | undefined>;
  /** 成员 Body 的 A2A send */
  send(input: TeamAgentSendInput): Promise<TeamAgentSendResult>;
  /** 成员 Body 的 list：有 Team 只返回同 Team  roster；无 Team 返回自己的可见成员 */
  listForCaller(sessionId: string): Promise<TeamMemberSummary[]>;
  /** body session -> 成员（含 team_id） */
  identify(sessionId: string): Promise<TeamMemberSummary | undefined>;
  /** conversation 预算状态 / 人工 override（0.19 S4；只由人力入口调用） */
  budget?(input: BudgetStatusInput | BudgetOverrideInput): Promise<BudgetOverview>;
  /** 订阅日志写入 / roster 变更事件（只带指针，不含正文）；返回取消函数 */
  subscribe(listener: (event: TeamServiceEvent) => void): () => void;
  dispose(): void;
}

/** Team 层稳定错误码（RPC / CLI 据此映射） */
export type TeamErrorCode =
  | 'team_not_found'
  | 'team_conversation_not_found'
  | 'team_log_write_failed'
  | 'team_binding_requires_name'
  | 'team_already_in_team'
  | 'team_not_member'
  | 'team_private_member'
  | 'team_no_team'
  | 'team_self_mention'
  | 'team_owner_not_rosterable'
  | 'team_not_empty'
  | 'team_archived'
  | 'unknown_member'
  | 'invalid_input'
  | 'not_visible';

export class TeamError extends Error {
  readonly code: TeamErrorCode;

  constructor(code: TeamErrorCode, message: string) {
    super(message);
    this.name = 'TeamError';
    this.code = code;
  }
}

/** 缺省成员 owner / 发送者 */
export const DEFAULT_OWNER = 'main';

/** 单条消息上限（字节） */
export const MAX_MESSAGE_BYTES = 64 * 1024;
