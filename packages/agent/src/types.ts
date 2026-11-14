/**
 * Agent 能力层契约（AgentService / registry / runtime port / snapshot）。
 *
 * 成员状态、可见性与 DTO 字段名是 0.17 的对外形状（snake_case），
 * 不要为内部方便改名；内部记录在 registry 里用 camelCase。
 *
 * @module @vessel-agent/agent
 */

import type { TeamPolicy } from '@vessel-agent/config';
import type {
  ContextSummarizer,
  EventStream,
  LeaseGrant,
  LeaseServicePort,
  Logger,
  MessageRef,
  RunEvent,
  RunInterruptReason,
  RunOptions,
  RunRecord,
  RunRecordStore,
  RuntimePermissionConfig,
  Scheduler,
  SessionEventLogPort,
  SessionTitleSource,
  ToolDefinition,
  Usage,
} from '@vessel-agent/core';
import type { AgentInboxDelivery, AgentInboxPort } from './inbox.js';

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

/**
 * 成员角色（v3 持久化；0.28 收窄为两值）：
 * - `member`：Team 成员；owner = self，必须有 Team，team 可见。`main` 也是 member；
 * - `temporary`：临时成员；owner = 雇佣者（缺省 `human`），parent 缺省 owner，Team 可选。
 *
 * 0.27 的 `single`（无 Team 的独立 agent）已删除：所有 agent 都属于某个 Team。
 * 存量快照里的 `role:'single'` 在读取时降级为 `member`（见 `snapshot.ts`）。
 */
export type AgentRole = 'member' | 'temporary';

/** 进程内存在性：live 表示 engine 在当前进程可用，gone 表示需要 resume（不持久化） */
export type MemberPresence = 'live' | 'gone';

/** 成员归属：present 在册，left 已关闭（持久化） */
export type MemberMembership = 'present' | 'left';

/** Binding 轮换相位（不持久化；S2 rotate 使用） */
export type MemberRotation = 'stable' | 'rotating';

/** Binding 指针：body_id ≡ session_id，epoch 由 current_body 派生 */
export interface BindingPointer {
  session_id: string;
  epoch: number;
  started_at: number;
}

/** body_history 上限；超出时丢弃最旧条目 */
export const MAX_BINDING_HISTORY = 20;

/** 已退役 Binding 的历史条目；只追加，有界（最多 20 条） */
export interface BindingHistoryEntry extends BindingPointer {
  retired_at: number;
}

/** ExecutionUnit 的对外状态（`body_id ≡ session_id`） */
export interface ExecutionUnitStatus {
  session_id: string;
  epoch: number;
  state: 'idle' | 'running' | 'waiting_permission' | 'closed';
  primary: boolean;
  created_at: number;
  last_active_at: number;
}

/** 持久化的 Binding 记录（v4 唯一真相） */
export interface PersistedBindingRecord {
  body_id: string;
  epoch: number;
  created_at: number;
  last_active_at: number;
  retired_at?: number;
  primary?: boolean;
}

/** 成员对外状态（E1 冻结形状；新字段 additive） */
export interface MemberStatus {
  id: string;
  session_id: string;
  name?: string;
  parent_id?: string;
  /** 成员角色（v3；由持久化记录派生） */
  role: AgentRole;
  /**
   * 归属 / private 可见性 principal（v3 写入总有：member = self，
   * temporary = 雇佣者，缺省 `human`）。DTO 保留可选以兼容旧 wire。
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
  /** 当前 Binding 的 epoch（由 current_body 派生） */
  epoch?: number;
  /** 所属 Team（0.19 S3；unbound 时缺省） */
  team_id?: string;
  /** 已退役 Binding 历史（0.19 S6 additive；≤20，当前 Binding 不在其中） */
  body_history?: BindingHistoryEntry[];
  /** 0.27 additive：live ExecutionUnit 状态；`session_id` 仍表示 primary binding */
  bodies?: ExecutionUnitStatus[];
  /**
   * `create` / `hire` 专用：同名成员已存在，本次没有新建，返回的是它。
   * 只在复用出现时存在；正常创建不带这个字段。
   */
  reused?: boolean;
}

/**
 * 快照持久化记录（v4）。
 *
 * `bodies[]` 是唯一真相；`current_body` / `body_history` 保留为旧数据的兼容视图。
 * 与 MemberStatus 分离：不把 model / system_prompt 等配置泄漏进对外 DTO。
 * presence / rotation 不持久化（进程内可重建）。
 */
export interface PersistedAgentRecord {
  id: string;
  /** 第一具 Binding 的 session（兼容旧数据） */
  session_id: string;
  name?: string;
  parent_id?: string;
  /** 成员角色（v3 写入必填；v1 / v2 读取时按 owner 推断） */
  role: AgentRole;
  /** 归属 principal（v3 写入必填：member = self，temporary = 雇佣者） */
  owner: string;
  visibility: MemberVisibility;
  /** 最后已知 engine 状态（重启后按 membership 重置） */
  state: MemberState;
  membership: MemberMembership;
  /** 所属 Team（0.19 S3；unbound 时缺省） */
  team_id?: string;
  model?: string;
  system_prompt?: string;
  /**
   * 0.51：成员 cwd 快照（create 时显式选中 Team 的基础路径；additive，旧快照忽略未知键）。
   *
   * 落盘而不是每次从 Team 重算：Team.workspace 创建后不可改，快照与重算等价，但它能
   * 在 Team 文件丢失 / 迁移时保住「这具 body 当初在哪跑」这个事实。
   */
  cwd?: string;
  /** 兼容视图：primary binding 指针（v4 以 `bodies[]` 为真相） */
  current_body?: BindingPointer;
  /** 已退役 Binding 的历史（只追加，最多 20 条；当前 Binding 不在其中） */
  body_history?: BindingHistoryEntry[];
  /** 0.27：全部 Binding（含已退役，退役保留 ≤50）；唯一真相 */
  bodies?: PersistedBindingRecord[];
  /** 0.27：primary binding 的 body_id */
  primary_body_id?: string;
  /** 创建来源 agent（持久化键 `source_agent_id`；旧 `forked_from` 不识别） */
  source_agent_id?: string;
  current_tool?: string;
  last_seen?: number;
  usage?: Usage;
}

/**
 * 消息来源类别（仅用于本轮模型上下文的来源标注）。
 *
 * `human` 是外部 principal（root owner / 未登记调用者），`agent` 是已登记的成员，
 * `system` 是 rotate 嘱托 / limit warning 这类系统提示。它**不参与权限判定**：
 * 权限仍由权限 bridge 的 human / policy 主体决定，注入文本不可作为授权依据。
 */
export type AgentMessageSource = 'human' | 'agent' | 'system';

/** 消息渠道（仅用于来源标注）：Team 提及 vs 点对点投递 */
export type AgentMessageChannel = 'team' | 'direct';

/** 成员间消息；队列只在内存，不落 snapshot */
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  ts: number;
  /** 会话分组（0.19 S4）；系统提示也继承当前会话 */
  conversation_id?: string;
  /** 系统提示类别；rotate 成功时移除 limit_warning，避免旧 ExecutionUnit 的预警发给新 ExecutionUnit */
  kind?: 'limit_warning';
  /**
   * 发送者类别（内存内元数据，不落 snapshot）。由 AgentService 入队时按 registry
   * 判定；缺省时执行内核按 `from` 退化推断。只用于告知模型消息从哪来。
   */
  source?: AgentMessageSource;
  /**
   * 投递渠道（内存内元数据，不落 snapshot）。Team `@` 提及为 `team`，owner /
   * 成员点对点投递为 `direct`。缺省 `direct`。
   */
  channel?: AgentMessageChannel;
  /**
   * 发送者的显示名（内存内元数据，不落 snapshot）。由 AgentService 入队时按
   * registry 填；人类 / 系统 / 联邦地址没有本机成员名，缺省。
   *
   * 只用于来源标注的可读性：`from` 仍是 uuid，是唯一身份。执行内核不持有 registry，
   * 所以名字必须随消息带过来，不能到渲染时再查。
   */
  from_name?: string;
  /**
   * 0.52：这条投递的来路（内存内元数据，不落 snapshot、不进 wire）。
   *
   * `ask_answer` = 人类在待批页回答了本成员发的 async `ask`；执行内核据此把
   * core `Message.name` 写成 `ask:answer`，Web 渲染成「待批答复」卡而不是用户气泡。
   */
  origin?: 'ask_answer';
  /**
   * 这条投递在会话里应写成的 `Message.name`（内存内元数据，不落 snapshot）。
   *
   * 只给**运行时合成输入**与**交接嘱托**用，两者都不是「谁说的话」而是同一件事的
   * 两个面：`vessel:notice`（idle 唤醒）是运行时上下文，Web 时间线按环境信息卡渲染、
   * TUI 的人类可读投影跳过它；`rotate:handoff:<epoch>`（rotate 交接）是**发起 rotate
   * 的 agent 写的交接书**（通常是上一具身体；`service.ts` 的
   * `ROTATE_HANDOFF_INPUT_NAME`），Web 渲成交接卡、TUI 渲成可读标题，两边都不再把它
   * 画成「坐在键盘前的人打的字」。
   * A2A 投递不走这里（`agent:<alias>` 由 `source` + `from_name` 推导，见
   * `runtime.ts` 的 `agentInputName`）。
   *
   * **不能用 `source: 'system'` 统一推导**：`startup_prompt` 同样来自 system
   * principal，但只有 rotate 路径那一条是 agent 写的；create / restart / activate 的
   * `startup_prompt` 是调用方（人）写的开场白，必须继续按正文渲染。谁写的这句话
   * 只能由生产者声明，不能从来源推断。
   */
  input_name?: string;
  /**
   * 附件引用（0.52；内存内元数据，不落 snapshot）。
   *
   * 只有路径与种类，正文永不随消息走。执行内核把它写成 core `Message.refs`，
   * 从而落进 `user.message` 事件与 SessionState；**inbox 副本不带它**
   * （inbox 只存正文摘要，rotate 窗口内的消息由正文重投，引用不跟随）。
   */
  refs?: MessageRef[];
}

/** 传给执行内核的成员身份（不携带 registry 状态） */
export interface MemberExecutionMember {
  id: string;
  session_id: string;
  name?: string;
  /**
   * 父 **agent** id —— 执行内核可见的**唯一**归属维度（0.51 裁定）。
   *
   * 这里刻意没有「父会话 id」：会话维度已由本对象自己的 `session_id` 表达，而
   * 「父会话是谁」是读侧从 `parent_id` + roster 上溯出来的展示信息。多带一个字段
   * 就多一处会漂移的事实源（0.19 曾把 agent id 当会话 id 写进事件，导致待批归属
   * 在第一次 rotate 后全错）。
   */
  parent_id?: string;
  /**
   * 成员角色（0.28）。执行内核据此决定上下文策略；core 不知道这个字段，
   * 策略参数由本层翻译成裸参数（见 `packages/agent/src/runtime.ts` 的 spawn）。
   */
  role: AgentRole;
  /** 归属 principal；peer 缺省 */
  owner?: string;
  visibility: MemberVisibility;
  /** 所属 Team（0.19 S4：权限策略 / bridge 归属） */
  team_id?: string;
  model?: string;
  system_prompt?: string;
  /**
   * 0.51：成员 cwd（工具默认工作目录）。由 spawn 解析后随
   * `ExecutionUnitRequest.cwd` 传进 EU，最终成为 `ToolContext.cwd`。
   *
   * 与 `system_prompt` 一样属于「spawn 时的快照」语义：改它要等下一具 body。
   */
  cwd?: string;
  /**
   * Stage 3：ControlPlane 为该 binding 获取的 BindingLease 凭据。
   * agent 层只透传；ExecutionUnit 侧消费（续租 / fencing / dispose 释放）。
   */
  binding_lease?: LeaseGrant;
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
export interface MemberExecutionPort {
  spawn(member: MemberExecutionMember): Promise<void>;
  /**
   * 执行一轮；`runId` 由调度器固定（0.27），缺省时由实现生成。
   * 同一 body 的 run id 必须与调度器事件里的 run_id 一致。
   */
  runTurn(
    member: MemberExecutionMember,
    message: AgentMessage,
    runId?: string,
  ): Promise<MemberTurnResult>;
  /**
   * Q5（additive，可选）：按 session 历史启动新 run。
   * `-r/--resume` 与 AgentService 的 resume 准入路径显式调用；未实现时回退 `runTurn`。
   */
  resumeTurn?(
    member: MemberExecutionMember,
    message: AgentMessage,
    runId?: string,
  ): Promise<MemberTurnResult>;
  /**
   * Stage 4（additive，可选）：用已加载的 RunRecord 恢复成员 EU 上的同一 run。
   * 调用方已经过 RunRecordStore 加载并完成 agent/session 路由；port 只按
   * `record.session_id` 找活的 ExecutionUnit，未实现 / 未 spawn 时调用方报
   * `member_execution_not_found`。
   */
  resumeRun?(record: RunRecord, opts?: RunOptions): Promise<string>;
  cancel(member: MemberExecutionMember, reason?: RunInterruptReason): Promise<void> | void;
  dispose(member: MemberExecutionMember): Promise<void> | void;
  /**
   * Stage 3（additive，可选）：当前 session 有效 SessionLease 的 fencingToken。
   * 用于 sessions.restart / sessions.create 的 conflict payload 与生命周期事件。
   */
  sessionLeaseToken?(sessionId: string): number | undefined;
  /**
   * Stage 3（additive，可选）：sessions.create / restart / activate 预取新 primary 的 SessionLease。
   * `minFence` 保证新 token 高于旧 primary 释放前的 token。
   */
  ensureSessionLease?(sessionId: string, minFence?: number): Promise<LeaseGrant | undefined>;
  /**
   * 身份变更通知（additive，可选）：只向成员上下文追加 `vessel:notice`，
   * 不启动 turn、不入队。live ExecutionUnit 立即追加；未 spawn 的成员暂存到下一次 runTurn。
   *
   * `options.timestamp`（0.52 S1c，additive）：这段环境信息的**产生时刻**。
   * 启动恢复卡在启动时就产生，必须早于它之后被放行的那条输入所在的 run，
   * 所以由调用点把产生时刻带下来；缺省＝注入时刻（既有行为不变）。
   */
  notice?(memberId: string, text: string, options?: { timestamp?: number }): void;
  /**
   * CONTRACT-hot-apply §4（additive，可选）：把规则热应用到所有存活 ExecutionUnit。
   * 返回实际应用的 ExecutionUnit 数量；未实现的 port 由 AgentService 报 0。
   */
  applyPermissionRules?(rules: RuntimePermissionConfig): Promise<number> | number;
  /**
   * CONTRACT-hot-apply §4（additive，可选）：把工具面热刷新到所有存活 ExecutionUnit。
   *
   * 在同一具 body 上换工具宿主，不重建 session / context / provider；有 active run
   * 时延迟到轮边界。`tools` 缺省取父宿主当前工具面。返回实际刷新的 ExecutionUnit 数量；
   * 未实现的 port 由 AgentService 报 0。
   */
  refreshTools?(tools?: readonly ToolDefinition[]): Promise<number> | number;
  /**
   * 0.28 D6（additive，可选）：角色转换后把上下文策略热应用到该成员的活体。
   *
   * `member.role` 是**转换后**的角色；实现的唯一义务是让活体「下一次 run」按它生效
   * （自动压缩开关 + 80%–90% 压力提示尾句），不重建 body、不动历史。返回实际应用的
   * ExecutionUnit 数量（没有活体时为 0，此时策略由下一次 spawn 生效）。未实现的 port 由
   * AgentService 按 0 处理并走兜底轮换。
   */
  applyContextPolicy?(member: MemberExecutionMember): Promise<number> | number;
  /**
   * 0.52（additive，可选）：把「基础信息真值」推进给该成员的活体。
   *
   * Self Card 是构造期只读快照（system 前缀的一部分，热替换会让整段历史缓存失效），所以
   * `agents.update` 改不了模型看到的那张卡。这里只同步真值，由该 body 的下一轮 BeforeLlm
   * hook（`self-card-delta`）与「模型相信的值」diff 出一条 `vessel:notice` 环境信息：
   * 变了才报、同一变更只报一次、字段没变不报。
   *
   * `member` 是**变更后**的身份（name / parent / team / model / system_prompt 全带）。
   * 返回命中的 body 数；未实现的 port 由 `AgentService` 静默跳过（没有活体时本就不需要告知）。
   */
  noteSelfCardIdentity?(member: MemberExecutionMember): number;
  /**
   * 0.31（additive，可选）：body 当前上下文水位（0–1）。
   *
   * 只读诊断值，供 AgentService 生成 rotate 确认文案；不落盘、不新增 RPC。
   * 无活体 / 无 token 预算时返回 undefined。
   */
  contextRatio?(sessionId: string): number | undefined;
  /**
   * Additive (title_source): write the shell title of one session and record where it
   * came from. Used by sessions.create / rotate so a body can name the next session.
   * Returns false when the port has no SessionStore (headless / pure memory) so the
   * caller falls back to automatic naming; a title_source: 'manual' shell is never
   * downgraded to 'generated'.
   */
  setSessionTitle?(
    sessionId: string,
    title: string,
    source: SessionTitleSource,
  ): Promise<boolean> | boolean;
  /**
   * 0.31（additive，可选）：该 body 的交互请求是否真能到达人类。
   *
   * 判据是「bridge 已挂上」而不是「宿主有人类」：permissionMode=allow 的
   * 无 team body 不会 attachBridge，发请求只会永久等待。服务端据此 fail-closed。
   */
  canConfirm?(sessionId: string): boolean;
  /**
   * 0.32（additive，可选）：挂上按 agent_id 的持久化收件箱。
   *
   * 之后 spawn 的每个 ExecutionUnit 注册未读 notice hook 与 `inbox` 工具；传 undefined 关闭。
   * 不新增 RPC / DTO。
   */
  attachInbox?(inbox: AgentInboxPort | undefined): void;
  /**
   * 0.32（additive，可选）：关闭某个旧 ExecutionUnit 的 inbox hook（rotate / retire）。
   * 只是让 hook 不再取消息；已 hold 的队列由 `releaseHeldFor(agentId, bodyId)` 放出。
   */
  disableInbox?(sessionId: string): void;
  /** 0.32（additive，可选）：rotate 回滚时恢复旧 ExecutionUnit 的 inbox hook。 */
  enableInbox?(sessionId: string): void;
  /** 0.32（additive，可选）：丢弃该成员尚未 spawn / 未开跑时暂存的 notice。 */
  clearPendingNotices?(memberId: string): void;
  /**
   * 0.51（可选）：该成员的**真实**工具清单（canonical `tools.list{agent_id}` 的数据源）。
   *
   * 判据必须来自真实注册路径：有活身体就读那具 body 自己的宿主，没有就按 spawn 的同一套
   * 判定推导（推导值）——实现里不许另写一份工具清单。这不是「第二份工具面」：成员用的
   * 就是节点那一份，只是按这具身体读一次。未实现的 port 由 AgentService 按「答不出」处理。
   */
  toolSurface?(member: MemberExecutionMember): MemberToolEntry[];
}

/**
 * 工具条目（`tools.list` 的 `tools[]`，节点与成员同形状）。
 *
 * 没有 `source`：0.51 用户裁定「成员用的就是节点有的那一份，不要区分成员工具面和节点
 * 工具面」，来源标记与「节点有、这具身体拿不到」的解释层一起删掉了。
 */
export interface MemberToolEntry {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  has_permission_check: boolean;
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

/** 有向边计数（环检测用；最多 32 条，按 last_ts 淘汰）。`count` 是最近一个 cooldown 窗口内的次数。 */
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
  /**
   * 检查模式（0.41）：
   * - delivery（缺省）：完整检查并计数 hop / edge / last_activity；
   * - read_only：只查 blocked / cycle / limits，不计数、不落库（message_id urgent）；
   * - wake：inbox 的 wake 投递模式用的口径 —— 只查 cycle（以及显式 origin 的
   *   team 一致性），不 ensure 新 conversation、不计 hop / wall-clock / turns / tokens、
   *   不改 last_activity。
   */
  mode?: 'delivery' | 'read_only' | 'wake';
  /**
   * cycle 边处理（0.41）：
   * - bump（缺省）：检查并计数；
   * - check：只检查；
   * - skip：同一 run 已计过该边时整体跳过。
   */
  edge?: 'bump' | 'check' | 'skip';
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
  /**
   * 显式 id（0.27）：用于 `main` 等固定身份的普通 create。
   * 缺省由 id 生成器分配。
   */
  id?: string;
  /**
   * 显式角色（0.27；0.28 起只剩 member / temporary）。
   * 缺省按 kind / owner 推断（member / temporary）；peer 推导出的 member 不接受覆盖。
   */
  role?: AgentRole;
  name?: string;
  model?: string;
  systemPrompt?: string;
  visibility?: MemberVisibility;
  parentId?: string;
  /**
   * 归属 principal：string = temporary 的雇佣者；null = 显式 peer（role member）；
   * 缺省 = DEFAULT_OWNER（legacy / temporary 行为）。
   */
  owner?: string | null;
  /** 输入判别（不持久化）：peer → role member；contractor → role temporary */
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
  /**
   * CREATE-0.39：来源 session。传了即以该 session 的稳定 transcript 为新
   * session 的种子；不传 = 冷建。源 agent / 源 session 零改动。
   */
  from_session_id?: string;
  /** 仅 `from_session_id` 存在时合法；缺省 copy */
  seed?: CreateSeed;
  /** 仅 `from_session_id` 存在时合法；`sessions.get().messages` 下标 */
  keep_messages?: number;
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
 * 选择器 `id` / `to` 接受成员 id、当前 Binding session 或唯一当前名字（与其它入口一致）。
 * `name` 是**新名字**，不是选择器；改名立即生效。
 * `model` / `systemPrompt` 只写入记录，由**下一次 spawn 的 ExecutionUnit** 使用；
 * 当前已存在的 ExecutionUnit 不会因 update 而重建。
 */
export interface AgentUpdateInput {
  /** 选择器：成员 id / 当前 Binding session / 唯一当前名字 */
  id?: string;
  /** 选择器别名（与 close 的 `to` 一致） */
  to?: string;
  /** 新名字 */
  name?: string;
  model?: string;
  systemPrompt?: string;
  /** 角色转换目标（member 需要 Team；temporary 的 owner 取 `from`）；不触发新 ExecutionUnit */
  role?: AgentRole;
  /** 转换到 member / temporary 时显式指定 Team（缺省沿用已有 Team） */
  teamId?: string;
  /** 转换者 principal（team-scoped 权限由入口层校验）；缺省 DEFAULT_OWNER */
  from?: string;
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
 * 统一准入输入（0.27）：runs.start / agents.send / dispatch / Team @ 全部走这里。
 *
 * `strict` 是 agents.send 语义：不自动恢复 gone 成员；dispatch / runs.start 缺省允许。
 */
export interface AdmitInput {
  content: string;
  /**
   * 附件引用（0.52，additive）：只有路径 + 元信息，**没有正文**。
   *
   * 随本次投递写进 core `Message.refs`，因此出现在 `user.message` 事件与
   * SessionState 里；执行内核不读文件、不注入内容（模型靠工具按需读）。
   * 缺省 = 无引用（`content` 是 string 的输入等价 `refs = []`）。
   */
  refs?: MessageRef[];
  agent_id?: string;
  session_id?: string;
  /** 缺省 `human`（人类入口）；不是 `DEFAULT_OWNER` —— 那是成员归属的缺省值 */
  from?: string;
  channel?: 'direct' | 'team';
  origin_team_id?: string;
  conversation_id?: string;
  /** agents.send 语义：不自动恢复 gone 成员；dispatch/runs.start 缺省允许 */
  strict?: boolean;
  /** 0.41：内部（非 wire、非持久）调用者 session；仅 tool / TeamService 填充，RPC 不填。 */
  origin_session_id?: string;
  /** 0.41：内部（非 wire、非持久）调用者 run；用于同 run cycle 边去重。 */
  origin_run_id?: string;
  /**
   * Q5（仅内部装配使用，不暴露为 RPC）：本次投递按「续接已有 session」执行，
   * 调度到 `MemberExecutionPort.resumeTurn` → core `resumeSession(sessionId, input)`。
   * 缺省 = 普通 `run`。
   */
  resume?: boolean;
  /**
   * 0.52（仅内部装配，不暴露为 RPC）：这条投递的来路，决定它在会话里的身份。
   *
   * `ask_answer` = 人类在待批页回答的 async `ask`：答案必须能投进**提问的成员**
   * （成员自己发的请求 + 人给的答案），因此跳过 `canView` 的可见性闸门（那里判定的是
   * 「谁可以驱动这个成员」，不是「它自己提的问题能不能被回答」）；并让执行内核把它
   * 标成 `ask:answer`（Web 渲染成「待批答复」卡，而不是用户气泡）。
   */
  origin?: 'ask_answer';
  /**
   * 0.53（仅内部装配，不暴露为 RPC）：**复用这条消息的 id**（启动恢复用）。
   *
   * 恢复要做的不是「再发一条」，而是「把磁盘上那条重新交给 body」：同一个 id 让
   * `inbox.append` 幂等（不会多出一条）、`markConsumed` 天然指向同一条。与
   * `interrupt` 复用 `message_id` 同族，区别是这里由条目自己的 id 决定。
   */
  reuse_message_id?: string;
}

/**
 * 启动恢复的结果（只用于日志 / 自检，不上 wire）。
 *
 * `sessions` = 本次真正动手的会话数；`deferred` = 因为超出 `maxSessions` 而顺延到下次
 * 启动的会话数（条目保持 unread，不丢）；`failed` = 逐条投递失败的消息数（同样保持 unread）。
 */
export interface AgentRecoverResult {
  recovered: number;
  sessions: number;
  deferred: number;
  failed: number;
}

/** `agents.recall` 的单条跳过原因（与 inbox 的 discard 口径同族）。 */
export interface AgentRecallSkip {
  message_id: string;
  reason: 'not_found' | 'consumed' | 'active';
}

/** `agents.recall` 入参：把待处理输入从「将执行」集合里拿走。 */
export interface AgentRecallInput {
  agent_id: string;
  message_ids: string[];
}

/**
 * `agents.recall` 结果：`deleted` = 已从待处理集合拿走（human 源真删 / agent 源留档），
 * `skipped` 说明为什么没拿（未知 / 已消费 / 正在跑）。
 */
export interface AgentRecallResult {
  deleted: string[];
  skipped: AgentRecallSkip[];
}

/**
 * `claim`（0.51）的单条跳过原因：`not_found` = 库里没这条（含收件箱损坏）；
 * `consumed` = 早就被拿走了（run 已经开始 / 上次已 claim 过）。
 *
 * 没有 `active` 这个档：一条正在跑的消息在开跑那一刻就已 consumed，落进来的判据与
 * 「已经拿走过」完全一样 —— 多一档只会让调用方多写一个死分支。
 */
export interface AgentClaimSkip {
  message_id: string;
  reason: 'not_found' | 'consumed';
}

/** `claim` 入参：把**已经看到正文**的待处理输入从队列里拿走（不可逆）。 */
export interface AgentClaimInput {
  agent_id: string;
  message_ids: string[];
}

/**
 * `claim` 结果：`claimed` 是真被拿走（→ consumed）的那些 id；`skipped` 说明没拿成的。
 *
 * 与工具层的 `inbox{action:'claim'}` 同一套语义，只是这里不带正文（Web 侧不需要）——
 * 正文只有模型侧需要，走工具层那条路。
 */
export interface AgentClaimResult {
  claimed: string[];
  skipped: AgentClaimSkip[];
}

/** 统一准入结果；`session_id` 是 body id */
export interface AdmitResult {
  run_id: string;
  agent_id: string;
  session_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  queue_position?: number;
}

/** resume 结果与 admit 同形 */
export interface ResumeResult extends AdmitResult {}

/** 发送参数；`to` 可传成员 id 或 session id */
export interface SendInput {
  to: string;
  /** `interrupt + message_id` 时可为空：正文取自 inbox 里的既有消息。 */
  content: string;
  /** 发送者；缺省 DEFAULT_OWNER，private 成员只有 owner 能寻址 */
  from?: string;
  /** 会话分组；缺省由入口生成（0.19 S4） */
  conversation_id?: string;
  /**
   * 0.32-D：取消目标 body 当前 active run（reason `interrupt`），把本次消息
   * （或 `message_id` 指定的 inbox 消息）作为下一条输入，排在现有队列之前。
   */
  interrupt?: boolean;
  /** 指定要优先投递的 inbox 消息 id（无需重复 content；必须与 interrupt 同用）。 */
  message_id?: string;
  /**
   * 0.41 wire 别名： `notify: true` ≡ inbox 的 **wake 投递模式**（只追加 inbox unread
   * 并发一次摘要 wake；不 hold / submit / consume）。内部一律转成投递模式再走链路。
   */
  notify?: boolean;
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
  /** urgent + message_id 时可省 / 为空：正文取自既有 inbox 消息。 */
  content: string;
  /**
   * 附件引用（0.52，additive；内部透传，不扩 wire）：只有路径与种类。
   * 与 `AdmitInput.refs` 同一份形状，最终都写成 core `Message.refs`。
   */
  refs?: MessageRef[];
  from?: string;
  /** 会话分组；缺省生成（0.19 S4） */
  conversation_id?: string;
  /**
   * 显式 origin team（TeamService.post 用）；与已存 conversation 的 team 不一致时拒绝。
   * 成员 send / reply / owner dispatch 不传，由发送者或目标推导。
   */
  origin_team_id?: string;
  /**
   * 本次投递是否允许在 resume 失败后自动创建新 Agent。
   * 缺省看 team policy `allowAutoCreate`（默认关闭）；显式值覆盖 policy。
   */
  allow_auto_create?: boolean;
  /** 0.41：urgent（取消 active 并重投到队首）。 */
  interrupt?: boolean;
  /**
   * 0.41 wire 别名： `notify: true` ≡ inbox 的 **wake 投递模式**（只追加 inbox unread +
   * 摘要唤醒）；与 interrupt 互斥。
   */
  notify?: boolean;
  /** 0.41：与 interrupt 同用时优先投递既有 inbox 消息。 */
  message_id?: string;
  /** 0.41：内部（非 wire、非持久）调用者 session / run；tool / TeamService 填充。 */
  origin_session_id?: string;
  origin_run_id?: string;
  /** 0.41：内部（非 wire、非持久）一次 messages 数组的 wake 边计数 key。 */
  batch_key?: string;
}

/** dispatch 结果：queued 表示已入队；notified 表示 wake 投递成功；rejected 是明确拒绝 */
export type DispatchResult =
  | {
      status: 'queued';
      message_id: string;
      resolved_to: string;
      resolution: 'live' | 'resumed' | 'rotating' | 'created';
      /** 0.19 S4；实现始终返回，类型保持 additive */
      conversation_id?: string;
    }
  | {
      status: 'notified';
      message_id: string;
      resolved_to: string;
      conversation_id: string;
      wake: boolean;
      resolution: 'live' | 'gone';
    }
  | {
      status: 'rejected';
      code:
        | 'agent_left'
        | 'member_stale'
        | 'invalid_input'
        | 'resume_failed'
        | 'auto_create_failed'
        | 'auto_create_not_allowed'
        | 'team_full'
        | 'team_frozen'
        | 'not_visible'
        | 'budget_exceeded'
        | 'budget_unavailable'
        | 'conversation_team_mismatch'
        /**
         * 0.52 S1a：node 正在优雅退出且没有 durable inbox 可排队 ⇒ 明确可重试，
         * 不要落到 resume_failed（那会让调用方以为 agent 有问题）。
         */
        | 'node_draining';
      reason: string;
    };

/** CREATE-0.39：种子方式；缺省 copy，compact 必须显式 */
export type CreateSeed = 'copy' | 'compact';

/** `sessions.create`：无来源 = 空 session；有来源 = 复制 / 压缩前缀 */
export interface SessionCreateInput {
  /** 无来源时必填；有来源时可省（由源推断），两者不一致 → invalid_params */
  agent_id?: string;
  /** 来源 session；必须是该 agent 当前 primary */
  from_session_id?: string;
  seed?: CreateSeed;
  /** `sessions.get().messages` 下标；缺省全量 */
  keep_messages?: number;
  startup_prompt?: string;
  /**
   * Additive: human title for the new session (rotate naming). Written to the new
   * shell as title_source: 'manual'; omitted means the session keeps the derived
   * title until automatic naming fills one in.
   */
  title?: string;
  /** conversation（缺省）/ both（同时做文件回滚；agent 层只透传） */
  mode?: 'conversation' | 'both';
  files?: { ref: string; paths: string[] };
}

/**
 * `sessions.create` 的内部选项（不是 wire 字段）。
 *
 * `allowActiveRun` 只给内置 `agent` 工具的 rotate 动作使用：工具在调用者自身的
 * active run 内执行，必须能换体；RPC 路径不传，仍按契约返回
 * `conflict` + `run_in_progress`。
 */
export interface SessionCreateInternalOptions {
  allowActiveRun?: boolean;
}

export interface SessionCreateResult {
  agent_id: string;
  session_id: string;
  /** Additive: echoed back only when a title was requested (title_source: manual). */
  title?: string;
  /** 无来源时缺省 */
  source_session_id?: string;
  seed?: CreateSeed;
  keep_messages?: number;
  keep_projected?: number;
  copied_messages?: number;
  /** 新 session 恒为 primary */
  primary: true;
  /** 仅 mode=both（文件回滚由入口层执行） */
  files_restored?: number;
  files_skipped?: number;
}

/** `sessions.restart`：同一 session 换 binding（epoch+1） */
export interface SessionRestartInput {
  session_id: string;
  /** 换体后首条输入；给了才起 run */
  startup_prompt?: string;
}

export interface SessionRestartResult {
  agent_id: string;
  session_id: string;
  from_epoch: number;
  epoch: number;
}

/** `sessions.activate`：把 current primary 或 bindingHistory 中的 session 切回 primary */
export interface SessionActivateInput {
  session_id: string;
  startup_prompt?: string;
}

export interface SessionActivateResult {
  agent_id: string;
  session_id: string;
  previous_session_id: string;
  epoch: number;
  /** 目标本来就是当前 primary 时为 true */
  noop: boolean;
}

/**
 * roster add（0.19 S3）：把 Agent 绑定到 Team 并恢复 present。
 * 不 spawn、不新建 session；保留 current_body / body_history。
 * 这是继 `attachOwner` 之后第二条人力 `left → present` 路径。
 */
export interface ReinstateInput {
  /** agent id | 当前 Binding session | 唯一 name */
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

/**
 * 发送结果：入队即返回，不等待一轮结束。
 *
 * 0.41 起是联合：work / urgent 为 queued；wake 投递（wire `notify:true`）为 notified。notified 分支不带
 * run / session；`state` 为让通用 send 消费方保持类型兼容而保留（wire additive）。
 */
export type SendResult =
  | {
      queued: true;
      message_id: string;
      state: MemberState;
      /** 0.27 additive：本次准入的 run / body；预算 block 留在 mailbox 时仍返回 run_id */
      run_id?: string;
      session_id?: string;
    }
  | {
      queued: false;
      notified: true;
      message_id: string;
      wake: boolean;
      resolution: 'live' | 'gone';
    };

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
  /** CREATE-0.39：`agent.spawned` 带来源时的源 agent id（wire snake_case） */
  source_agent_id?: string;
  /** CREATE-0.39：种子方式（有来源创建） */
  seed?: CreateSeed;
  /** CREATE-0.39：请求的保留边界 / 实际复制条数 */
  keep_messages?: number;
  copied_messages?: number;
  keep_projected?: number;
  /** CREATE-0.39：`session.created` 的 new / source 两侧 */
  side?: 'new' | 'source';
  /** CREATE-0.39：文件回滚入口（仅 sessions.create mode=both） */
  mode?: 'conversation' | 'both';
  files_restored?: number;
  files_skipped?: number;
  /** 会话分组（0.19 S4；system 事件可能缺省） */
  conversation_id?: string;
  /** 本轮 usage（run.* 终态由 core 事件携带，AgentEvent 不再填） */
  usage?: Usage;
  /** 已废弃：0.27 删除 `agent.reply.posted`，AgentEvent 不再携带正文 */
  content?: string;
  state?: MemberState;
  /** 进程内 presence（agent.stale / agent.resumed 等生命周期事件） */
  presence?: MemberPresence;
  /** 当前 ExecutionUnit epoch（agent.resumed） */
  epoch?: number;
  /** rotate：旧 / 新 Binding 的 session */
  from_session_id?: string;
  to_session_id?: string;
  /** 事件所属 ExecutionUnit（旧轮终态 / retired / reply.stale） */
  body_id?: string;
  /** 旧 ExecutionUnit 轮末终态标记 */
  stale?: boolean;
  /**
   * B′（0.52）：退役时仍在 in-flight 的那一轮 run id（rotate 交棒轮）。
   *
   * 只在 `reason === 'rotation'` 的 `agent.retired` 上携带：交棒轮是合法收尾，
   * 消费方（TeamService）据此把「自己交棒的那一轮」与「真迟到的旧轮」区分开，
   * 只 fence 后者。
   */
  retired_during_run_id?: string;
  message_id?: string;
  /** 消息来源（queued 事件） */
  from?: string;
  /** 事件目标（`agent.create.failed` / `agent.session.activated` 等；与 from 成对） */
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

/**
 * 成员停下 / 被关闭的四种结局（装配层 peerStops 端口的载荷）。
 */
export type PeerStopKind = 'completed' | 'failed' | 'cancelled' | 'closed';

/**
 * 一条「成员真的停了」的变更。
 *
 * 由 AgentService 产出（它判「真的停了」：终态后没有新消息 / 新 run / rotate 窗口），
 * 由装配层的 peer-notice router 转成一条定向到父 session 的 runtime.notice
 * （scope peer）：合并、延迟窗口、每轮一条都在 router 里。
 *
 * peer 成员（owner=self、无 parent）没有父级，不产生变更。
 */
export interface PeerStopChange {
  /** 注入目标：父成员当前 primary body 的 session id */
  parent_session_id: string;
  agent_id: string;
  /** 展示名（有就用，否则用 id） */
  name?: string;
  kind: PeerStopKind;
  /** 失败原因（一行原文；展示时优先取稳定 code） */
  error?: string;
}

/** 装配层注入的成员停下通知端口；缺省不报（纯内存 / 测试）。 */
export type PeerStopSink = (change: PeerStopChange) => void;

/** AgentService 构造参数 */
export interface AgentServiceOptions {
  /** 一个实例只服务一个 tenant */
  tenantId: string;
  /** 缺省不落盘（纯内存） */
  dataDir?: string;
  runtime: MemberExecutionPort;
  /** 0.27：每 tenant 唯一调度器（必填）；执行只经 scheduler executor */
  scheduler: Scheduler;
  /**
   * 0.34 Stage 3：seeded create（seed=compact）的压缩摘要器（与 tenant 上下文共用）。
   * 缺省用占位摘要；装配层应传入真实 summarizer。
   */
  summarizer?: ContextSummarizer;
  /**
   * 0.34 S2：seeded create（seed=compact）的压缩预算（与 tenant 上下文共用）。
   * 缺省时 `compactMessagesForSeed` 按 1M 兜底。
   */
  contextMaxTokens?: number;
  /**
   * 临时 agent 的空闲回收 TTL（小时）；缺省 2（D5），0 = 关闭。
   *
   * 只回收 `role === 'temporary' && membership === 'present'`；`member`（含 `main`）
   * 永不回收。判据是**持久化**的 `max(lastSeen, body.lastActiveAt)`，不读内存 entry。
   */
  temporaryTtlHours?: number;
  /**
   * 0.32：每个成员持久化收件箱的消息条数上限；缺省 200（store 默认）。
   * 只在有 `dataDir` 时可生效。
   */
  inboxMaxMessages?: number;
  /** 两级租约服务（Stage 3）；缺省无锁（纯内存测试） */
  leaseService?: LeaseServicePort;
  /**
   * 会话事件日志（Stage 3 seeded create）：读取来源 session 的 transcript、
   * 把种子写成新 session 的 `message.injected` 事件。缺省时 seeded create 失败。
   */
  eventLog?: SessionEventLogPort;
  /**
   * 内部 create 失败清理（不是 RPC / wire）：删除新 session 的事件日志 / 元数据。
   * 在「事件已写、primary 切换失败」后 best-effort 调用；缺省时只记录
   * `agent.create_cleanup_skipped`，不残留兼容分支。
   */
  deleteSessionData?: (sessionId: string) => Promise<void>;
  /**
   * Stage 4：成员 run durable 的 RunRecord 存储（内部装配选项，不是公开 RPC）。
   * `resumeRun` 用它按 run_id 加载记录；缺省时成员 resume 不可用。
   */
  runStore?: RunRecordStore;
  now?: () => number;
  /** 注入 id 生成器（session_id === member id） */
  newId?: () => string;
  logger?: Logger;
  snapshot?: AgentSnapshotOptions;
  /** 可选的进程内事件流出口；同时仍可 subscribe */
  events?: EventStream;
  /** 创建成员未显式指定 model 时使用的“有效 model”（落库，供 resume 使用） */
  defaultModel?: string;
  /** 创建成员未显式指定 owner 时的默认 owner；不持久化 */
  ownerId?: string;
  /**
   * 0.19 S3：`create` 未显式传 workspace 时的默认 workspace。
   * 由 bootstrap 传入：配置声明命中、显式 `agent.cwd`，或同 data root 的稳定锚点
   * （`resolveDefaultTeamAnchor`）；headless / 纯内存时为 undefined（保持 unbound）。
   */
  defaultWorkspace?: string;
  /** 0.19 S3：Team 绑定端口；缺失时 `create` 永远 unbound */
  teamBinder?: TeamBinder;
  /**
   * 0.51：系统锚点 workspace（`<dataDir>/default` / `<dataDir>/headless`）。
   *
   * 只用于**排除**：锚点 Team 的 workspace 不是用户为这个成员选的位置，目录还可能不存在，
   * 所以不烧进 `MemberRecord.cwd`（见 `packages/agent/src/member-cwd.ts` 的铁律 1）。
   * 缺省（纯内存 / 测试）= 没有锚点，任何显式选中的 Team 都参与。
   */
  anchorWorkspaces?: readonly string[];
  /** 0.19 S4：按 team_id 读取解析后的 policy；缺失 = 无 team policy */
  teamPolicy?: (teamId: string) => TeamPolicy | undefined;
  /** 0.19 S4：conversation 预算端口；缺失 = 不执行预算（测试 / 纯内存） */
  budget?: ConversationBudgetPort;
  /**
   * 成员停下 / 被关闭的通知端口（内部装配 / 非 wire）。
   *
   * 收口不再自动回传正文（deliverToParent 已删除）：「停了」这个信号改走环境信息，
   * 由本端口交给装配层转成 runtime.notice（scope peer，定向父 session）。
   * 缺省 undefined = 不报（纯内存测试 / 未挂通知总线的入口）。
   */
  peerStops?: PeerStopSink;
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
  | 'conversation_team_mismatch'
  | 'conflict'
  | 'body_limit'
  /**
   * 0.52 S1a：node 正在优雅退出，人类来源的写被 fence 拒绝。
   * 可重试：RPC 侧映射成 gateway_restarting，客户端等 node 回来再发。
   */
  | 'node_draining';

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
  /**
   * 统一准入（0.27）：所有入口（runs.start / send / dispatch / Team @）都走这里。
   * 解析 session → agent/body，检查可见性 / 预算，入 body mailbox 并交给 scheduler。
   */
  admit(input: AdmitInput): Promise<AdmitResult>;
  /** 某 agent 的 live ExecutionUnit 状态（primary 优先） */
  bodies(agentId: string): Promise<ExecutionUnitStatus[]>;
  /**
   * 只读 inbox 快照（`agents.inbox` RPC 的唯一数据源）。
   *
   * 只调 `list()` / `findByIds()`：不 markConsumed、不 hold / unhold、不改持久字段。
   * `messageIds` 非空时才带 `text`（上限由 RPC 层把关）。`sessionId` 非空时只返回归属
   * 该会话的条目（等值比较；缺 `session_id` 的老条目永不命中）；结果带 `agent_id`，
   * 前端据此调 `agents.recall`。
   */
  inboxSnapshot(
    agentId: string,
    options?: {
      includeHeld?: boolean;
      messageIds?: readonly string[];
      sessionId?: string;
    },
  ): {
    agent_id: string;
    unread: number;
    pending: number;
    entries: {
      message_id: string;
      from: string;
      summary: string;
      status: 'unread' | 'held';
      ts: number;
      session_id?: string;
      text?: string;
    }[];
  };
  /**
   * 0.51：该成员的工具清单（canonical `tools.list{agent_id}` 的唯一数据源）。
   *
   * 这不是「另一份工具面」：成员用的就是节点那一份，`agent_id` 只决定按哪具身体读。
   * 未知成员返回 `undefined`（RPC 层翻成 `not_found`，不返回空列表）；已知成员则交给
   * 执行内核的真实注册路径（`MemberExecutionPort.toolSurface`）——活身体实读、
   * 无身体按 spawn 同一套规则推导，判据只在 `packages/agent/src/runtime.ts` 一处。
   */
  toolSurface(agentId: string): MemberToolEntry[] | undefined;
  /**
   * 撤回待处理输入（`agents.recall`，0.53）：把消息从「将执行」集合里拿走。
   *
   * 语义按 source 分两档：**human 源 = 真删**（用户说「这条不发了」，inbox discard，
   * 不留墓碑）；**agent 源 = unhold 留档**（这次不执行，消息回到可读 unread，模型仍能
   * read）。同时取消它对应的 queued run、清 `queuedRuns` 记账、从 body mailbox 出队。
   * 正在执行的那条不能撤回（`skipped: active`），已消费的也不能（`skipped: consumed`）。
   */
  recall(input: AgentRecallInput): Promise<AgentRecallResult>;
  /**
   * 认领待处理输入（`agents.claim`，0.51）：**「这条我已经拿到了，别再投给我」**。
   *
   * 与 `recall` 的区别是「拿走之后留什么」：recall 要么真删（human 源）要么留档
   * （agent 源 unhold），`claim` 一律走**消费**（inbox `consumed` + 解 hold）—— 消息不再
   * 投递、不再出现在 list / read 里，下一次 append 裁剪时清掉。**不可逆**，没有 unclaim。
   *
   * 与 recall 同一条前置收口：先取消该消息对应的 **queued run** 并从 body mailbox 出队，
   * 再消费。少了这一步，`claim` 一条 held（已排进队列）的条目之后它仍会被那次已排程的
   * run 投一遍 —— 这个动作就成了假承诺。
   */
  claim(input: AgentClaimInput): Promise<AgentClaimResult>;
  /**
   * 外部取消一个 **queued** run 后的收口（`runs.cancel` → `RunControlLike.cancel` → 这里）。
   *
   * 不调它就会留下永久僵尸（D-a）：`entry.queuedRuns` 里的 runId 永不清除 ⇒
   * `canDispatchInbox` 恒 false（该 agent 再也不会被投递）、`memberStillBusy` 恒 true
   * （peer 停止通知与 TTL 回收失效）、消息永远停在 `entry.pending` + inbox held。
   * 与 `recall` 共用同一段收口（清记账 / 出队 / 按 source 分档）。
   */
  releaseCancelledRun(runId: string, reason?: string): void;
  /**
   * 启动恢复（0.53）：把**进程死亡时还没变成 run input** 的 human 输入重新投递一次。
   *
   * 判据（一句话）：`status === 'unread'` 且**未被 held** 且 `session_id` 存在且
   * `source === 'human'` 且该 session 还有可重建的 binding。`held` 只存内存 ⇒ 进程死后
   * 全部失效 ⇒ 磁盘上「没被任何 body 接管的输入」恰好就是这一批，不需要额外状态位。
   *
   * 走同一个 `admitInternal`（不新开旁路），并带 `reuse_message_id`（同 id 幂等）。
   * **重启后那条消息最终会不会被执行？会** —— 触发点就是下一次进程启动的这次扫描；
   * 失败（预算 / spawn / 会话退役）保持 unread、留到下次启动再试，绝不 discard（用户没取消）。
   * 上限 `maxSessions`（缺省 8）个会话，其余顺延（避免「崩溃恢复」变成「一开机所有 agent
   * 一起跑」）。每进程只扫一次。
   */
  recoverPendingInputs(options?: { maxSessions?: number }): Promise<AgentRecoverResult>;
  /**
   * 启动恢复卡（0.52 S1c）：把一条环境信息排进**该会话**的下一次请求。
   *
   * 走既有环境信息通道（`MemberRuntime.notice`）：活体已开跑就立刻追加，否则暂存到
   * 该成员下一轮 —— 那一轮会把暂存内容作为**注入消息放在用户输入之前**（`RunOptions.messages`），
   * 所以同一份文本既进模型上下文、也作为 `vessel:notice` 消息落进会话流（web 渲染成
   * EnvCard）。用户裁定：重启恢复不该只让模型知道、用户看不见 ⇒ 不造隐藏输入。
   *
   * 返回 false = 该会话现在收不了卡（不在册 / 已 left / 已 closed / 无 binding），
   * 调用方据此记 skipped 并保留标记，等下次启动再判（幂等）。
   */
  announceEnvironmentCard(sessionId: string, text: string): Promise<boolean>;
  /**
   * 更新名字 / model / systemPrompt；名字立即生效且保持同 Team（unbound 为 tenant）
   * 内 present 成员唯一。model / systemPrompt 只影响下一次 spawn 的 ExecutionUnit。
   */
  update(input: AgentUpdateInput): Promise<AgentUpdateResult>;
  /** 批量更新：条目并行，按输入顺序返回逐条结果 */
  update(input: AgentUpdateBatchInput): Promise<BatchResult<AgentUpdateResult>>;
  send(input: SendInput): Promise<SendResult>;
  send(input: SendBatchInput): Promise<BatchResult<SendResult>>;
  /**
   * 0.41 内部（非 wire）：释放一次 send / messages 批的 wake 边计数 key。
   * tool 在调用边界生成 key，整批结束后调用，避免 `wakeBatchEdges` 无界增长。
   */
  releaseWakeBatch(batchKey: string): void;
  /**
   * 统一投递入口：live 直接入队；gone 先 single-flight resume；
   * rotating 入队等待；left / resume 失败返回 rejected。
   */
  dispatch(input: DispatchInput): Promise<DispatchResult>;
  /**
   * Stage 4（内部装配用，不暴露为 RPC）：按 run_id 恢复成员的一轮 run。
   *
   * 装配层先 `RunRecordStore.load` 并按 `agent_id` 路由到成员；本方法再经
   * scheduler 的 session 串行键提交，保证同 session 排队 / active run 记账不倒退。
   * 缺记录 / 缺成员 / 未 spawn 分别抛 `run_not_found` / `agent_not_found` /
   * `member_execution_not_found`。
   */
  resumeRun(runId: string, opts?: RunOptions): Promise<string>;
  /**
   * `sessions.create`（CREATE-0.39）：同 agent 新 session，成为唯一 primary；
   * 无来源 = 空 session；有来源 = copy / compact 前缀。旧 primary 退役进
   * `bindingHistory`，旧 session 必须 `activateSession` 才能再跑。
   */
  createSession(
    input: SessionCreateInput,
    internal?: SessionCreateInternalOptions,
  ): Promise<SessionCreateResult>;
  /**
   * `sessions.restart`（CREATE-0.39）：同一 session 原地换 binding（epoch+1）；
   * 旧 binding 退役进 `bindingHistory`；失败回滚到旧 binding。
   */
  restartSession(input: SessionRestartInput): Promise<SessionRestartResult>;
  /**
   * `sessions.activate`（CREATE-0.39）：把 `bindingHistory` 中的 session 切回 primary；
   * epoch = 当前 primary epoch + 1；目标已是 primary 时返回 `noop: true`。
   */
  activateSession(input: SessionActivateInput): Promise<SessionActivateResult>;
  /**
   * delete 前置钩子（Stage 3）：有 active run → 抛 `conflict`；否则 dispose 对应 EU、
   * 释放 binding 租约、退役 binding、清 primary 指针。未知 session 幂等返回。
   */
  detachSession(sessionId: string): Promise<void>;
  /**
   * roster add：绑定 Team 并把 `left` 恢复为 `present`（不 spawn、不新建 session）。
   * 只由人力入口（teams.members add / owner 端点）调用。
   */
  reinstate(input: ReinstateInput): Promise<MemberStatus>;
  close(input: CloseInput): Promise<CloseResult>;
  close(input: CloseBatchInput): Promise<BatchResult<CloseResult>>;
  list(filter?: ListFilter): Promise<MemberStatus[]>;
  /** 成员显式回复父级；本轮自动最终文本随后被抑制 */
  reply(memberId: string, content: string): Promise<ReplyResult>;
  /**
   * 当前 Binding session -> 成员状态；忽略可见性。
   * 只由 TeamService / agent 工具做调用者身份解析，不向模型暴露。
   */
  identify(sessionId: string): Promise<MemberStatus | undefined>;
  /** 执行内核 bridge 上报的权限等待/恢复；只接受当前运行 ExecutionUnit 的回调 */
  notePermissionState(memberId: string, sessionId: string, state: MemberPermissionState): void;
  /** 成员引擎事件回流（装配用）；当前只处理 live ExecutionUnit 的 agent.limit.warning */
  noteMemberEvent(memberId: string, sessionId: string, event: RunEvent): void;
  /**
   * 0.31：body 当前上下文水位（0–1）；无活体 / 无预算时 undefined。
   * 模型 rotate 的确认文案用它，不新增 RPC。
   */
  contextRatio(sessionId: string): number | undefined;
  /**
   * 0.31：该 body 的权限请求能否被人类应答（bridge 可用）。
   * 无 bridge 时必须 fail-closed，不能发一个没人接的请求。
   */
  canConfirm(sessionId: string): boolean;
  /**
   * 0.31：工具侧可见事件出口（如 rotate 确认结果）。与 `agent.*` 同一条父流；
   * session 解析不到成员时静默丢弃。
   */
  noteAgentEvent(type: string, sessionId: string, extra?: Record<string, unknown>): void;
  /** 当前 turn 的 conversation_id；无在跑轮次或缺省时 undefined（TeamService 用） */
  currentConversation(agentId: string): string | undefined;
  /**
   * 0.28：临时 agent 空闲回收（装配层定时器 / 测试注入时钟直接调）。
   * 返回本次回收的 agent 数；TTL=0 时 no-op。
   */
  sweepIdleTemporaries(now?: number): Promise<number>;
  /** sweep 节奏（毫秒）；TTL=0 时 undefined，表示不需要定时器 */
  sweepIntervalMs(): number | undefined;
  /** conversation 预算状态 / 人工 override（只由人力入口调用） */
  budget(input: BudgetStatusInput | BudgetOverrideInput): Promise<BudgetOverview>;
  /**
   * 关闭前中断并等待成员轮收口（含成员 ExecutionUnit 共享的 eventLog 写入）。
   * 只影响在跑轮：不改 registry 状态 / membership，也不启动队列里的后续消息。
   */
  drain(options?: AgentDrainOptions): Promise<AgentDrainOutcome>;
  /**
   * 0.52 S1a：node 优雅退出的**准入 fence**（退出序列第一段）。
   *
   * 打开后人类来源的写立刻被拒（node_draining，RPC 侧是可重试的 gateway_restarting），
   * agent 来源的投递只落 durable inbox 并返回 queued，队列不再起新轮。
   * 幂等：返回 true 表示**本次**真正打开了 fence。
   */
  beginDrain(): boolean;
  /** 0.52 S1a：fence 是否已打开（退出序列 / runs.start 闸门用）。 */
  isDraining(): boolean;
  /**
   * 0.52 S1a：按会话汇总 durable inbox 里尚未消费的条目 id（只读列举，不 hold/不推进）。
   * 退出路径把它写进 SessionState.resume_after_restart.pending_input_ids。
   */
  pendingInboxIdsBySession(): Map<string, string[]>;
  /** 立即落盘待写快照；无 snapshot 或写入成功返回 true，写入失败返回 false */
  flushSnapshot(): Promise<boolean>;
  /**
   * CONTRACT-hot-apply §4：把新的权限规则热应用到**所有存活的成员 ExecutionUnit**。
   *
   * 装配层只需暴露这一条转发入口（执行内核自己知道哪些 ExecutionUnit 还活着）；
   * 返回成功应用的 ExecutionUnit 数量，0 表示当前没有存活成员。
   * 不影响 owner——owner 的 runtime 由装配层单独处理。
   */
  applyPermissionRules(rules: RuntimePermissionConfig): Promise<number>;
  /**
   * CONTRACT-hot-apply §4（additive，可选）：把工具面热刷新到所有存活的成员 ExecutionUnit。
   *
   * 装配层只需暴露这一条转发入口；有 active run 的 body 由执行内核延迟到轮边界。
   * `tools` 缺省取成员 runtime 的父宿主；返回成功刷新的 ExecutionUnit 数量，0 表示没有存活成员
   * （或 port 未实现）。
   */
  refreshTools?(tools?: readonly ToolDefinition[]): Promise<number>;
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
  /** 归一化绝对路径；Team 的唯一 workspace 来源 */
  workspace: string;
  /** 自由文本：这个 Team 是什么、找谁、怎么用（0.21 additive） */
  description?: string;
  /** S3 只存不执行 */
  policy: Record<string, unknown>;
  created_at: number;
  /** S10.3 additive：归档时间（epoch ms）；存在即只读。0.51 起 `vessel prune` 会把
   * 「已归档 team 下的 agent + 该 team 记录」当成可移除对象清掉（用户裁决：归档 = 等待移除），
   * 所以「无删除路径」不再成立；但除 prune 之外没有任何代码会改它。 */
  archived_at?: number;
  /** 0.27 additive：冻结期间拒绝该 Team 的所有创建 / 自动创建 / reinstate */
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

export type TeamSystemEvent =
  | 'join'
  | 'leave'
  | 'archive'
  | 'budget_override'
  | 'create'
  /** 旧日志只读值；新代码不再写 `'fork'`。 */
  | 'fork'
  | 'retract';

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
  /** 撤回 tombstone 指向的目标 message_id；只在 `system_event:'retract'` 上出现 */
  retracted_message_id?: string;
  /** 会话分组（0.19 S4；系统消息缺省） */
  conversation_id?: string;
  /** 跨节点来源 / 目标地址（0.21 additive；只在 federation 入站日志出现） */
  federation?: TeamLogFederation;
  /**
   * 附件引用（0.52 additive）：与 `TeamPostInput.refs` 同一形状，**只有路径与元信息**
   * （不存正文 / base64）。只在非空时写；旧日志没有该键 → 读成 `undefined`。
   * 系统行（join / leave / retract 等）永不带 refs。
   */
  refs?: MessageRef[];
}

/** `teams.get` 一页：窗口按文件顺序升序，`hasMore` 表示窗口之前是否还有日志。 */
export interface TeamLogReadWindow {
  entries: TeamLogEntry[];
  hasMore: boolean;
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
  /** 成员角色（roster 只展示 member / temporary） */
  role: AgentRole;
  /** 归属 principal（member = self，temporary = 雇佣者） */
  owner?: string;
  visibility: MemberVisibility;
  state: MemberState;
  epoch: number;
  /** 最后活跃时间（0.21 additive；epoch ms） */
  last_seen?: number;
  /** 已退役 Binding 历史（0.19 S6 additive；可选，旧数据缺失不报错） */
  body_history?: BindingHistoryEntry[];
}

export interface TeamSummary {
  team_id: string;
  name: string;
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
  /**
   * 本次返回窗口之前是否还有日志。由有界回扫计算；旧传输缺省视为 false。
   * 客户端只应在带 `before` 的响应上更新翻页状态，轮询尾页不覆盖。
   */
  messages_has_more?: boolean;
}

export interface TeamDelivery {
  agent_id: string;
  status: 'queued' | 'rejected' | 'error';
  message_id?: string;
  resolution?: 'live' | 'resumed' | 'rotating' | 'created';
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
  /**
   * 附件引用（0.52，additive）：只有路径与种类，随 @ 投递写成成员侧的 core
   * `Message.refs`（成员靠 `[refs]` 环境信息行知道该用 `media` 工具按需读）。
   *
   * 同时**写进 Team 日志**（`TeamLogEntry.refs`）并原样回显在 `TeamPostResult.refs`，
   * 时间线据此显示引用 chip；系统行（seed / retract / join 等）不带。
   * 形状由 serve 的 `teams.post` handler 严格校验，这里再归一一次（丢弃坏条目）。
   */
  refs?: MessageRef[];
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
  /** 已写进日志的引用（0.52 additive；无引用时该键不出现），供乐观更新直接用。 */
  refs?: MessageRef[];
}

/** 撤回一条 Team 日志消息：只追加 tombstone，不改写 / 不级联删除。 */
export interface TeamRetractInput {
  team_id: string;
  message_id: string;
  /** 操作者 principal；缺省 `human`（不暴露为 RPC 参数） */
  from?: string;
}

export interface TeamRetractResult {
  /** tombstone 自己的 message_id */
  message_id: string;
  team_id: string;
  retracted_message_id: string;
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
  /** 稳定游标：返回该 `message_id` 之前、最多 `limit` 条（不含该条）。 */
  before?: string;
  /** roster 条数窗口（0.21）；缺省 20，最大 100；live 优先、last_seen 降序 */
  members_limit?: number;
}

export interface TeamRosterOptions {
  viewer?: string;
}

/** 成员 ExecutionUnit 的 A2A send（agent 工具用）；from 由 session 解析，模型不能伪造 */
export interface TeamAgentSendInput {
  from_session_id: string;
  to: string;
  content: string;
  /** 会话分组；缺省继承调用者当前 turn（0.19 S4） */
  conversation_id?: string;
  /** 0.41：urgent（取消 active 并重投到队首）；与 `delivery: 'wake'` 互斥。 */
  interrupt?: boolean;
  /**
   * 内部投递模式（tool → TeamService，非 wire）：缺省 `input`（消息本体作为下一轮
   * run input）；`wake` = 只追加 inbox unread + 摘要唤醒。wire 上的 `notify: true`
   * 在 tool 边界转成 `wake`，不用布尔在这里二传。
   */
  delivery?: AgentInboxDelivery;
  /** 0.41：与 interrupt 同用时优先投递既有 inbox 消息。 */
  message_id?: string;
  /** 0.41：内部（非 wire、非持久）调用者 session / run。 */
  origin_session_id?: string;
  origin_run_id?: string;
  /** 0.41：内部（非 wire、非持久）一次 messages 数组的 wake 边计数 key。 */
  batch_key?: string;
}

export interface TeamAgentSendResult {
  status: 'queued' | 'rejected' | 'error';
  resolved_to?: string;
  message_id?: string;
  resolution?: 'live' | 'resumed' | 'rotating' | 'created';
  code?: string;
  reason?: string;
  /** 是否写入了同 Team 的 mention 日志 */
  logged: boolean;
  /** 本次 send 的会话分组（0.19 S4） */
  conversation_id?: string;
}

/**
 * 地址归属判定（纯解析，不发网络）。
 *
 * `local_*` 由 Team 层在本机完成投递：判断「是不是本机」只有 app 层知道
 * （`node_id` + 展示名），但投递要用调用者的 agent id 与 Team roster，
 * 只有 Team 层有。所以 port 只回答「指向哪里」，不代做本地投递。
 */
export type FederationAddressPlacement =
  | { kind: 'local_human'; team_id?: string }
  | { kind: 'local_member'; principal: string; team_id: string }
  | { kind: 'remote' }
  | { kind: 'invalid'; code: string; reason: string };

/**
 * 裸 agent 名在可访问节点上的查找结果（0.27）。
 *
 * 候选用**地址**表示而不是 agent id：`team-info` 是脱敏目录（ADR-094 明确不返回
 * agent id / workspace / policy），而且在本方案里地址本来就是精确定位手段 ——
 * `<name>@<node_id>:<team_id>` 可以直接发回去。
 */
export interface FederationAgentCandidate {
  /** 完整地址 `<name>@<node_id>:<team_id>` */
  address: string;
  name: string;
  node_id: string;
  team_id: string;
}

export interface FederationLookupResult {
  candidates: FederationAgentCandidate[];
  /**
   * 预算内没查完（有 peer 超时 / 不可达）。
   *
   * 调用方要据此区分「查完了确实没有」和「没查完」：后者不能报 unknown，
   * 否则离线 peer 会被误报成「这个人不存在」。
   */
  timedOut: boolean;
}

/**
 * 跨节点发送端口（0.21）。由 app 层注入：`packages/agent` 不依赖 federation
 * client / 配置 / HTTP，只负责判断地址形式、填 `from` 与映射结果。
 */
export interface FederationSendPort {
  /** 本机节点 id；`from` 由 agent 层用 `<caller>@<nodeId>:<team>` 构造。 */
  readonly nodeId: string;
  /**
   * 判定地址指向本机还是远端（0.27）。本机结果由调用方就地投递，绝不出网。
   * 非法地址也在这里判，不发任何请求。
   */
  resolve(to: string): FederationAddressPlacement;
  /**
   * 在所有可访问节点上按名字找候选人（0.27）。
   *
   * **必须有总预算**：并发打所有 out peer，共用一个 deadline；不是每个 peer 各等
   * 一次超时。预算耗尽时返回已拿到的候选 + `timedOut: true`。
   */
  lookup(principal: string): Promise<FederationLookupResult>;
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
  /** 自动创建：只读 TeamRecord（workspace）；不存在返回 undefined */
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
  /** 同 `readLog`，但额外返回窗口前是否还有日志（供 `teams.get` 游标翻页）。 */
  readLogWindow(
    teamId: string,
    options?: { limit?: number; before?: string },
  ): Promise<TeamLogReadWindow>;
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
  /** 追加撤回 tombstone；目标必须仍在可读日志窗口内。 */
  retract(input: TeamRetractInput): Promise<TeamRetractResult>;
  /** 未知 Team 返回 undefined；业务失败抛 TeamError */
  members(input: TeamMembersInput): Promise<TeamMembersResult | undefined>;
  /** 成员 ExecutionUnit 的 A2A send */
  send(input: TeamAgentSendInput): Promise<TeamAgentSendResult | SendResult>;
  /** 成员 ExecutionUnit 的 list：有 Team 只返回同 Team  roster；无 Team 返回自己的可见成员 */
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
  | 'not_visible'
  // 0.38：撤回目标不在可读窗口 / 已被撤回。
  | 'message_not_found'
  | 'conflict';

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

/**
 * Additive: upper bound for an explicit session title (sessions.create / rotate).
 * Same order of magnitude as sessions.rename (512) but short enough to stay a
 * sidebar label; the value is documented in the rotate schema and error text.
 */
export const MAX_SESSION_TITLE_LENGTH = 120;
