/**
 * 进程内成员执行内核适配（MemberExecutionPort）。
 *
 * 每个成员独占一个 ExecutionUnit / Context / EventStream；工具从父 PluginHost
 * **全量复制**（0.51：节点有什么就给什么，只减 deny 档的只读集合与「需要人类应答但没有
 * bridge」这一条，见 `toolBlocked`），hooks / guardrails 一并继承。
 * `permissionMode: 'bridge'` 时
 * 成员的权限/提问请求转发到 `parentEvents`，父级应答原样回灌成员事件流；
 * 没有 `parentEvents` 时退化为 ask → deny（A3a 行为），避免 run 永久等待。
 *
 * @module @vessel-agent/agent
 */

import { randomUUID } from 'node:crypto';
import type { TeamPermissionPolicy } from '@vessel-agent/config';
import {
  type ContextSummarizer,
  DEFAULT_COMPACT_THRESHOLD,
  type EventStream,
  type ExecutionUnitOptions,
  type LeaseGrant,
  type Logger,
  type MemberBodyContribution,
  type MemberBodyNoticeEvent,
  type MemberBodyPort,
  MemoryEventStream,
  MemoryPluginHost,
  MemoryWorkingContext,
  type Message,
  noopLogger,
  type PluginHost,
  type RunEvent,
  type RunInterruptReason,
  type RunnableAgent,
  type RunOptions,
  type RunRecord,
  type Runtime,
  type RuntimePermissionConfig,
  type SelfCardOptions,
  type SessionState,
  type SessionTitleSource,
  type TerminationPolicy,
  type ToolDefinition,
  type Usage,
  type UsageLimits,
  type WorkingContext,
} from '@vessel-agent/core';
import { type AgentInboxPort, createInboxNoticeHook, createInboxTool } from './inbox.js';
import { resolveMemberCwd } from './member-cwd.js';
import { buildMemberBodyPorts } from './member-ports.js';
import { createSelfCardDeltaHook, selfCardIdentityOf } from './self-card-delta.js';
import { HUMAN_PRINCIPAL, SYSTEM_PRINCIPAL } from './team-address.js';
import type {
  AgentMessage,
  AgentRole,
  MemberExecutionMember,
  MemberExecutionPort,
  MemberPermissionState,
  MemberToolEntry,
  MemberTurnResult,
} from './types.js';

/*
 * 成员工具面 = **节点全量**（0.51 权限模型变更，用户裁定）。
 *
 * 工具面共有 **4 层闸门**，这里只是「成员选择」这一层。改工具面前先看清改的是哪层：
 *   1. 本文件 —— 成员能从父宿主挑哪些（**父宿主注册了什么就给什么**；只剩两条真实闸：
 *      deny 档收成只读集合、`ask` 这类需要父级应答的工具要求 bridge）
 *   2. `packages/config/src/tenant-tools.ts` —— tenant 级 allow/deny（**注册侧**）
 *   3. `packages/core/src/runtime/permission-policy.ts` —— 单次调用放行（allow/ask/deny）
 *   4. `src/permission-store.ts` —— `autoApprove` / `neverAutoApprove`（是否跳过审批）
 *
 * 为什么不再有白名单（0.51 之前是 `bash`/`read`/`edit`/`agent` 四件套）：白名单要求
 * 「节点上每加一个工具就要记得在这里加一条」，漏加是**静默**的能力缺失（`ask` 就这样
 * 丢过一次 —— 注册侧加了、选择侧不认、且不报错，见 `docs/lessons/L-011`）。用户裁定
 * 「节点有的 agent 都可以用，现在不做 agent 细分，所以也不需要白名单」，判据因此变成
 * 「父宿主有什么就给什么」：注册侧是唯一的能力声明，本层没有任何按工具名的清单，
 * 只留两条例外规则（deny 只读档、`ask` 缺 bridge）。
 *
 * **安全影响是明知故犯，不是隐式默认**：成员现在能拿到节点插件面里的一切 —— 含插件
 * 工具与 MCP 动态注册的外部工具 —— 并且装配侧的 `withMemberAutoApprove` 会给成员免确认
 * `agent`（bridge 档的其余工具仍按 `permission` 逐次确认）。这由用户在 0.51 明确接受
 * （「全部放开（含 MCP 动态工具），接受成员自动放行」）。要收紧就收紧**注册侧**
 * （#2 tenant allow/deny）或权限策略（#3/#4），不要在下面重新长出一份白名单。
 */

/**
 * deny（只读）档保留的工具：用户点名的这三件（`read` + `media` + `subscribe`）。
 *
 * 注意 `subscribe` 是按**工具**粒度给的：它的 `add` / `remove` 会改会话订阅状态，这里
 * 给的就是整个工具。用户知情的取舍 —— 只读档要能把「订阅了什么」读出来、能订阅后再读，
 * 代价是 deny 档下仍可增删订阅（不改工作区文件，只改本会话的订阅表）。
 */
const DEFAULT_READ_ONLY_TOOLS = ['read', 'media', 'subscribe'] as const;

/**
 * 需要父级（有人类应答者）转发才能收口的工具。
 *
 * 这些工具通过事件流发布请求并等待应答；成员 ExecutionUnit 只有 bridge 才能把请求送到
 * 父事件流。没有 bridge / 父流时注册进来只会让 run 永久等待，因此不放行。
 *
 * `ask` 是现行工具名；`ask_user` 是它的历史名（0.52 前）—— 双认，免得旧装配 / 旧插件
 * 注册的旧名工具绕过闸门、让成员 run 永久等待。
 */
const PARENT_ANSWERED_TOOL_NAMES: ReadonlySet<string> = new Set(['ask', 'ask_user']);

/** 缺省终止策略：不设累计上限（交互 run 靠自动压缩、模型自然停止与用户中断收口） */
const DEFAULT_TERMINATION: TerminationPolicy = {};

/** 缺省上下文预算 */
const DEFAULT_CONTEXT_MAX_TOKENS = 1_000_000;

/**
 * 成员 ExecutionUnit 恒定免确认的工具：`agent` 工具只允许成员操作自己（rotate）/ 可见 roster
 * / 自有 contractor，close 的审批由工具 `checkPermission` 与 `neverAutoApprove`
 * （`agent.close`）决定。owner 同源规则在热应用时会整体替换，这里每次应用前补回。
 */
function withMemberAutoApprove(rules: RuntimePermissionConfig): RuntimePermissionConfig {
  return {
    ...rules,
    autoApprove: [...new Set([...(rules.autoApprove ?? []), 'agent'])],
  };
}

/** 未 spawn 成员的待注入 notice 上限（按成员条数 / 成员数双边界） */
const MAX_PENDING_NOTICES = 20;
const MAX_PENDING_NOTICE_MEMBERS = 100;

/**
 * 按角色包装 per-body `WorkingContext`：**自动压缩开关可在活体上热切换**。
 *
 * 为什么不是 spawn 时直接把 `autoCompact` 交给 core（0.28 之前的做法）：那是构造期
 * 配置，没有 setter。转正（`temporary → member`）要求「同一具 live body 不重建，
 * 但下一次 run 按新身份生效」，于是开关必须能在活体上翻转（契约 §5 / D6）。
 *
 * 分层不变：本类只接收**裸参数**（一个布尔），不认 `role`；角色语义仍留在本文件的
 * spawn（`role === 'temporary'`）与 `applyContextPolicy`。本类只使用 `WorkingContext`
 * 接口上已有的方法，core 不知道这里存在。
 *
 * 内层 `MemoryWorkingContext` 恒以 `autoCompact: false` 构造，原因有两条：
 * - 真要把开关交给本类，内层就不能自己按阈值压缩（否则 `add()` 会绕过本类的开关，
 *   也就是 temporary 会在 `add()` 里被压缩 —— 正是契约禁止的）；
 * - 内层仍负责**硬兜底**：消息条数上限的摘要与移除在 `add()` 里独立于 `autoCompact`。
 *
 * 因此压缩时机从「`add()` 时」挪到「请求组装前」，这是本包装唯一的可观测差异：
 * 同一轮内水位到阈值时，压缩发生在下一次请求之前而不是写入那一刻。结果一致，
 * 且这正是 core 在有 summarizer 时走的既有路径。
 */
class RoleAwareContext implements WorkingContext {
  /** 自动压缩是否开启；`setAutoCompact` 是唯一的写入口。 */
  private compacting: boolean;

  constructor(
    private readonly inner: MemoryWorkingContext,
    autoCompact: boolean,
  ) {
    this.compacting = autoCompact;
  }

  /** 热切换自动压缩；返回是否真的变了（调用方据此决定要不要提示）。 */
  setAutoCompact(next: boolean): boolean {
    if (this.compacting === next) return false;
    this.compacting = next;
    return true;
  }

  /** 当前开关（供装配层 / 探针直接读）。 */
  get enabled(): boolean {
    return this.compacting;
  }

  add(msg: Message): void {
    this.inner.add(msg);
  }

  get messages(): Message[] {
    return this.inner.messages;
  }

  compact(): number {
    return this.inner.compact();
  }

  /**
   * 手动 / overflow 压缩入口，**原样透传**（`compactAsync()` 的 `force` 缺省为 true，
   * 与 core 一致）：调用方是 `compactContext` / `forceCompact`，包装不得改写强制语义。
   */
  compactAsync(): Promise<number> {
    return this.inner.compactAsync();
  }

  /**
   * 主动压缩。关闭时返回 0 —— **硬兜底不经过这里**：消息条数上限由内层 `add()`
   * 处理，provider overflow 由 runtime 的 `forceCompact`（`compactAsync`）处理。
   * 「不主动压缩」≠「绝不压缩」（契约 §5）。
   *
   * 开启时自己判阈值：内层的 `autoCompact` 恒为 false，所以不能委派
   * `inner.autoCompactAsync()`（那会恒返回 0）。判完再走 `inner.compactAsync(false)`，
   * 摘要器 / 并发去重 / 应用逻辑仍然只有 core 一份。
   *
   * **`false` 不是笔误**：core 的 `autoCompactAsync` 也是 `compactAsync(false)`
   * （`context-manager.ts:205`）—— 非强制模式按 token 预算保留最近的尾部消息；
   * 传 `true` 会「至少摘要到只剩 2 条」，比设计意图激进得多。
   */
  async autoCompactAsync(): Promise<number> {
    if (!this.compacting) return 0;
    const max = this.inner.maxTokens;
    if (max !== undefined && max > 0) {
      // 唯一真相源：内层 `WorkingContext.compactThreshold`（应用层由 config 注入，
      // core 未配置时兜底 0.85 —— 与 CONTRACT-0.34-context C5 一致）。
      const threshold = this.inner.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
      if (this.inner.tokenCount <= max * threshold) return 0;
    }
    return this.inner.compactAsync(false);
  }

  clear(): void {
    this.inner.clear();
  }

  get tokenCount(): number {
    return this.inner.tokenCount;
  }

  get maxTokens(): number | undefined {
    return this.inner.maxTokens;
  }

  /**
   * 必须返回**当前**开关：runtime 用它决定压力提示的上界（`agent-runtime.ts:1673`）。
   * 返回固定的 false 会让转正后 0.9 以上的提示继续发；返回固定的 true 会让
   * temporary 的提示在 0.9 以上静默 —— 两边都是契约 §5 明禁的静默。
   */
  get autoCompact(): boolean {
    return this.compacting;
  }

  setSessionId(sessionId: string): void {
    this.inner.setSessionId(sessionId);
  }

  getSessionId(): string {
    return this.inner.getSessionId();
  }

  updateRealTokens(total: number): void {
    this.inner.updateRealTokens(total);
  }
}

/** temporary 的压力提示（与 0.28 前的文案逐字一致）。 */
const TEMPORARY_PRESSURE_HINT =
  'Report what is done and what remains, then ask the user to start a new ' +
  'session or compact the context; this member does not compact automatically.';

/**
 * 角色 → 上下文策略（**唯一**映射点）。
 *
 * 只这里是 `role` 的消费者：core 不认 role（契约 §5），spawn 与热切换都从这里取
 * 同一份策略，所以「转正后下一次 run 用的策略」与「转正那天新建 body 会用的策略」
 * 结构上不可能漂移。
 */
interface ContextPolicy {
  /** 是否主动按阈值压缩 */
  autoCompact: boolean;
  /** 压力提示尾句；缺省 = core 的 `agent(rotate)` 原文案 */
  pressureHint?: string;
}

function contextPolicyFor(role: AgentRole): ContextPolicy {
  if (role === 'temporary') {
    // rotate 对 temporary 不禁用（D6）：换 body 仍是合法出路。文案只换成
    // 「上报状态 / 请用户手动切上下文」，因为临时会话的收尾由用户决定。
    return { autoCompact: false, pressureHint: TEMPORARY_PRESSURE_HINT };
  }
  return { autoCompact: true };
}

/** 身份变更 notice 的上下文消息形状（与 core appendNotice 一致） */
function noticeMessage(text: string): Message {
  return {
    role: 'user',
    name: 'vessel:notice',
    content: text,
    timestamp: Date.now(),
  };
}

/** 成员权限模式；bridge 把交互请求转到父事件流，缺省 allow */
export type MemberExecutionPermissionMode = 'allow' | 'deny' | 'bridge';

/** 需要父级应答的交互请求事件 */
const PERMISSION_REQUEST_EVENTS: ReadonlySet<string> = new Set([
  'tool.permission.request',
  'ask.user.requested',
]);

/** 父级发回的交互应答事件 */
const PERMISSION_RESPONSE_EVENTS: ReadonlySet<string> = new Set([
  'tool.permission.response',
  'ask.user.answered',
]);

/** run 终态事件：并入父流时补成员归属（TeamService / TUI 都读 data.agent_id） */
const RUN_TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

/** bridge 内待答请求；deny-after 只挂在有 parentEvents 的桥上 */
interface PendingBridgeRequest {
  kind: 'permission' | 'ask';
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * 成员 runtime 额外需要的中断能力（ExecutionUnit 已实现）。
 *
 * `resumeRun` 用 `RunRecord` 而非公开门面的 `runId`（Stage 4）：调用方
 * （AgentService）先经 RunRecordStore 加载记录，再委托到这里。因此这里用
 * `Omit` 摘掉 `RunnableAgent` 的 runId 签名，避免两条恢复语义并存。
 */
export interface MemberRunnableAgent extends Omit<RunnableAgent, 'resumeRun'> {
  /** Stage 4：用已加载的 RunRecord 恢复同一 run（ExecutionUnit 已实现）。 */
  resumeRun?(record: RunRecord, opts?: RunOptions): Promise<string>;
  /** Stage 4：上一 Run 结束时的上下文水位；无 active Run 时供 host 读取。 */
  lastContextRatio?: number;
  interrupt?(reason?: RunInterruptReason): void;
  /** Stage 3：当前 session 有效 SessionLease 的 fencingToken（ExecutionUnit 已实现）。 */
  sessionLeaseToken?(sessionId: string): number | undefined;
  /** Stage 3：seeded create / restart 预取新 primary 的 SessionLease（ExecutionUnit 已实现）。 */
  ensureSessionLease?(sessionId: string, minFence?: number): Promise<LeaseGrant | undefined>;
  /** 只追加上下文，不启动 turn（ExecutionUnit 已实现） */
  appendNotice?(text: string): void;
  /**
   * 0.28（additive）：热应用上下文策略，下一轮请求生效（`ExecutionUnit` 已实现）。
   * 只用于压力提示尾句；自动压缩开关由 `RoleAwareContext` 承担。
   */
  applyContextPolicy?(policy: { contextPressureHint?: string }): void;
}

/** 进程内成员执行宿主选项 */
export interface MemberExecutionHostOptions {
  /**
   * Stage 4：per-node Runtime（必填）。成员的 ExecutionUnit 一律经
   * `getOrCreateExecutionUnit` 取得，不再在 host 内直接构造。
   */
  runtime: Runtime;
  /** 成员未指定 model 时的默认模型；两者都缺省时 spawn 失败 */
  model?: string;
  /** 工具 / hooks / guardrails 的来源（父宿主）；缺省时成员没有工具 */
  pluginHost?: PluginHost;
  /**
   * deny（只读）档保留的工具名；缺省 `read` / `media` / `subscribe`。
   *
   * 给了就**整体替换**缺省集合（不是追加）：这是「只读档到底给什么」的唯一开关。
   */
  readOnlyTools?: readonly string[];
  /** 缺省 allow；deny 只保留只读工具；bridge 需配合 parentEvents */
  permissionMode?: MemberExecutionPermissionMode;
  /**
   * 有 team_id 的成员强制 bridge（忽略全局 `allow`）；缺省开启。
   * 无 parentEvents 时仍走 fail-closed 的 ask → deny。
   */
  forceBridgeForTeams?: boolean;
  /** 按成员所属 team 解析无人值守策略；只影响 bridge 内的 deny-after 定时器 */
  permissionPolicy?: (teamId: string | undefined) => TeamPermissionPolicy | undefined;
  /** allow / bridge 模式的权限配置（autoApprove / default / timeoutMs） */
  permission?: RuntimePermissionConfig;
  /**
   * 父级事件流（owner）。bridge 模式下把成员的
   * `tool.permission.request` / `ask.user.requested` 转发到这里，并订阅
   * `tool.permission.response` / `ask.user.answered` 回灌成员事件流。
   */
  parentEvents?: EventStream;
  /** bridge 模式下成员进入/离开权限等待时回调（入口层接 AgentService 状态） */
  onPermissionState?: (memberId: string, sessionId: string, state: MemberPermissionState) => void;
  /** 成员引擎事件回流（当前只转发 agent.limit.warning） */
  onMemberEvent?: (memberId: string, sessionId: string, event: RunEvent) => void;
  limits?: UsageLimits;
  termination?: TerminationPolicy;
  /** 上下文预算；同时写入 Self Card 的 context.max */
  contextMaxTokens?: number;
  /**
   * 成员上下文的压缩阈值（0.34 S2 / C5）。装配层传入 `config.context.compactThreshold`；
   * 缺省时内层 `MemoryWorkingContext` 用 core 兜底值。
   */
  contextCompactThreshold?: number;
  /** 成员上下文的真实摘要器；缺省时压缩退回占位摘要。 */
  summarizer?: ContextSummarizer;
  /**
   * 0.34 S4 / R7：按 session 取带熔断的摘要器（与 owner 共享计数）。
   * 缺省时回落到 `summarizer`。
   */
  summarizerForSession?: (sessionId: string) => ContextSummarizer;
  /**
   * 0.51：按成员解析 Team 基础路径（运行期兜底，`MemberRecord.cwd` 缺失时才用）。
   *
   * 为什么还要这一条：记录里的 cwd 是 create 那一刻的快照，老快照 / 手工写的记录没有它；
   * 而 `team_id` 是持久化的，装配层拿 `teamStore.get(teamId)?.workspace` 就能重算。
   * 实现方**必须自己排除锚点 Team**（装配层传 `anchorWorkspaces` 给 AgentService 的那份）。
   */
  cwdFor?: (member: MemberExecutionMember) => string | undefined;
  /** 成员深度（Self Card） */
  depth?: number;
  logger?: Logger;
  tenantId?: string;
  /**
   * 本机 node id，只用于来源行（`<principal>@<node>:<team>`）。
   *
   * 必由装配层从 bootstrap 的 `resolveNodeIdentity()` 传入：那里是 nodeId 的唯一来源。
   * 执行内核不调 `os.hostname()`、不读 config / node.json —— 逐条消息重算会与
   * federation 端口用的 nodeId 漂移，而它本身是进程级常量。
   *
   * 缺省（纯内存构造 / 测试）时来源行退回两段 `principal@<team>`，不报错。
   */
  nodeId?: string;
  includeReasoning?: boolean;
  /** tenant SessionStore；同 session_id 可跨进程续接历史 */
  session?: ExecutionUnitOptions['session'];
  /** tenant 会话事件日志（唯一真相源；存在时成员事件同样落盘） */
  eventLog?: ExecutionUnitOptions['eventLog'];
  /**
   * Stage 3：per-tenant 租约服务，透传给每个成员 ExecutionUnit（SessionLease）。
   * 缺省时 EU 侧租约为 no-op。
   */
  leaseService?: ExecutionUnitOptions['leaseService'];
}

interface MemberExecutionEntry {
  runtime: MemberRunnableAgent;
  /** 成员 id（entries 按 ExecutionUnit session 建键，notice 按成员 id 寻址） */
  memberId: string;
  /**
   * 这具 body 的会话 id（= entries 的键）。
   * 0.51：成员面端口要它 —— 端口是「一具 body 的端口」，`MemberBodyPort.sessionId` 与
   * `read` 的消费归属（`consumed_by_session`）都得说清是哪一具，不能靠调用方另传。
   */
  sessionId: string;
  /**
   * per-body 上下文策略（可变）：每次 Run 新建 `RoleAwareContext` 时读取；
   * `applyContextPolicy` 只改这里，下一次 Run 自然生效（Stage 4 per-Run context）。
   */
  contextPolicy: { autoCompact: boolean };
  /**
   * body 独占工具宿主（spawn 时快照）。`refreshTools` 原地替换其中的定义，
   * 不动 runtime / session / context / provider，下一轮请求即读到新工具面。
   */
  pluginHost: MemoryPluginHost;
  /** spawn 时选定的权限模式；refreshTools 用它重新筛工具 */
  mode: MemberExecutionPermissionMode;
  /** 是否有在跑轮：工具热刷新只在轮边界应用（单 run + prompt prefix 冻结） */
  running: boolean;
  /** 在跑轮期间收到过 refreshTools：轮结束再应用 */
  toolsRefreshPending: boolean;
  /** pending 的工具来源（调用方显式传入的快照；缺省时轮结束再读父宿主） */
  pendingTools?: readonly ToolDefinition[];
  /** 是否已执行过 runTurn；未执行过的空上下文不能直接 appendNotice，否则会跳过历史恢复 */
  started: boolean;
  /** 成员独占事件流；bridge 请求/应答都经过它 */
  events: MemoryEventStream;
  /** bridge 订阅取消函数（dispose 时回收） */
  unsubscribers: Array<() => void>;
  /** 已转发给父级、尚未应答的 requestId；deny-after 的 deadline 随条目清理 */
  pendingPermissions: Map<string, PendingBridgeRequest>;
  /** 是否已通过 onPermissionState 报过 waiting（避免重复回调） */
  waiting: boolean;
  /**
   * 0.32：该 ExecutionUnit 的 inbox hook 开关（spawn 时 attach 了收件箱才有）。
   * hook 在 spawn 时注册、之后才建 entry，故开关由这个可变对象承载。
   */
  inboxState?: { enabled: boolean };
  /**
   * 0.52：这具 body 的「基础信息真值」（spawn 快照起步，之后由 `noteSelfCardIdentity`
   * 推进）。Self Card 本身仍是构造期只读快照；变化经这个盒子在下一轮 BeforeLlm 变成一条
   * 环境信息（`self-card-delta` hook），不重建 body、不改 system 前缀。
   */
  selfCardIdentity: { member: MemberExecutionMember };
}

/** `buildSurface` 的结果：成员应有的工具（spawn / 热刷新 / 推导共用这一份规格）。 */
interface MemberSurfaceBuild {
  mode: MemberExecutionPermissionMode;
  /** 已按 mode / bridge 收窄，按注册顺序排列（父宿主工具 → 注入工具） */
  tools: ToolDefinition[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** core 的交互事件用 camelCase requestId；应答按它匹配 */
function readRequestId(data: unknown): string | undefined {
  return isRecord(data) && typeof data.requestId === 'string' ? data.requestId : undefined;
}

/**
 * 转发到父流前补齐成员归属字段；已有字段不覆盖。
 *
 * 归属**只写 agent 维度**（`parent_agent_id`）是 0.51 的核心不变量：父会话 id 是
 * 从父 agent 上溯出来的展示信息，不是这条请求的事实，多写一个键就多一处会漂移的
 * 来源（0.19 的混用正是这么来的）。这个形状由 `scripts/check-ask-attribution.ts`
 * 按源码对拍（`src/ask-attribution.test.ts` 覆盖读侧 —— 本模块 import 了
 * `@vessel-agent/core`，测试进程里不好单独拉起）。
 */
function bridgeRequestData(
  event: RunEvent,
  member: MemberExecutionMember,
): Record<string, unknown> {
  const data = isRecord(event.data) ? { ...event.data } : {};
  // core 契约用 camelCase requestId；UI / 0.16 形状用 snake_case，别名 additive。
  const requestId = readRequestId(data);
  if (requestId !== undefined && typeof data.request_id !== 'string') {
    data.request_id = requestId;
  }
  data.agent_id = member.id;
  if (typeof data.team_id !== 'string' && typeof member.team_id === 'string' && member.team_id) {
    data.team_id = member.team_id;
  }
  if (typeof data.session_id !== 'string') data.session_id = member.session_id;
  // 父**agent** 归属单独一个键（additive）：父子链的 agent 身份。
  //
  // 归属只需要 agent 这一个维度：会话维度已经由成员自己的 `session_id` 表达了，
  // 而「父会话是谁」是读侧从 `parent_agent_id` + roster 上溯出来的**展示**信息
  // （agent id 与会话 id 只在某具 body 上偶然相等，一旦写进事件就是第二个会漂移的
  // 事实源）。所以这里**刻意不写父会话 id**，也不加回来（`scripts/check-ask-attribution.ts`
  // 的 C1 反向检查盯着这一条）。
  if (typeof data.parent_agent_id !== 'string' && member.parent_id !== undefined) {
    data.parent_agent_id = member.parent_id;
  }
  if (data.delegate_path === undefined) {
    data.delegate_path =
      member.parent_id !== undefined ? [member.parent_id, member.id] : [member.id];
  }
  if (typeof data.tool !== 'string' && event.type === 'ask.user.requested') {
    // 工具名兜底（生产侧）：新名是 `ask`；历史事件里这个字段仍是 `ask_user`。
    data.tool = 'ask';
  }
  if (data.input === undefined && event.type === 'ask.user.requested') {
    data.input = data.questions;
  }
  if (typeof data.source !== 'string') data.source = 'runtime';
  return data;
}

/**
 * run 终态并入父流前补齐成员归属（0.27）：写在 `data` 内而非事件顶层，
 * TeamService 与 TUI 都读 `data.agent_id`。已存在的值不覆盖；`data` 不是
 * 对象时原样返回（不抛错）。
 */
function withMemberIdentity(event: RunEvent, member: MemberExecutionMember): RunEvent {
  if (!isRecord(event.data)) return event;
  const data: Record<string, unknown> = { ...event.data };
  if (data.agent_id === undefined) data.agent_id = member.id;
  if (data.team_id === undefined && member.team_id !== undefined) {
    data.team_id = member.team_id;
  }
  if (data.visibility === undefined) data.visibility = member.visibility;
  return { ...event, data };
}

/** 读 run.completed 事件里的 usage */
function readUsage(data: unknown): Usage | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as Record<string, unknown>).usage;
  return typeof value === 'object' && value !== null ? (value as Usage) : undefined;
}

/** 来源元数据不可信：压成单行并限长，避免伪造出额外的提示行 */
function sanitizeSource(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

/**
 * XML 属性值转义。名字是模型可控的字符串，`"` 不转义就能闭合属性再伪造一个
 * `id="..."`——和块注释结束标记同一类问题：不报错，只会静默错乱。
 * 顺序要紧：`&` 必须先换，否则会把后面换出来的实体再转一遍。
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * principal 段是否合法到能被 `resolveAddress` 接受。
 *
 * 与 `src/federation-address.ts:23` 的 `FEDERATION_PRINCIPAL_RE` 同源同形状
 * （`[A-Za-z0-9_-]{1,64}`）。不 import 它：`packages/agent` 不依赖应用层 `src/`，
 * 方向是 `core ← packages ← src`。改这一处要同步改那边，反之亦然。
 *
 * 需要这个判定是因为成员名只校验非空（`AgentService.create` 的 `optionalString`），
 * 没有任何字符集约束：`my.agent`（含点）、`docs core`（含空格）、中文名、超 64 字符
 * 全都能存进 registry。这类名字直接拼进地址会让 `parseFederationAddress` 在
 * **形状校验**就失败（不是 `unknown_member`，是整个地址非法），模型抄回去必然发不出去。
 */
function isAddressSafePrincipal(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

/**
 * 缺 source 时按 from 退化推断；生产路径由 AgentService 入队时标注。
 *
 * `main` 不在此列：它是 agent（role single），不是人类。曾经把 `main` 当 human
 * 是因为人类消息的 `from` 就是 `main`（成员归属的缺省值被误用成消息发送者）；
 * 缺省发送者改成 `human` 之后这个特例不再成立。
 */
function inferMessageSource(from: string): NonNullable<AgentMessage['source']> {
  if (from === SYSTEM_PRINCIPAL) return 'system';
  if (from === HUMAN_PRINCIPAL) return 'human';
  return 'agent';
}

/**
 * 渲染本轮消息来源。由 `runTurn` 作为 `RunOptions.messages` 注入为持久化的
 * `vessel:source` 消息，不改写 system。
 *
 * **渲染成可回信的地址，不渲染成描述**：`<from location="docs-core@a1b2c3d4:vessel-core" />`。
 * 地址就是 `resolveAddress` / `agent send` 吃的同一形态，模型不需要第二套语法：
 * 回信时把 `location` 的值原样填进 `to` 即可。
 *
 * **本机来源也写满三段**，node 段来自装配层传入的 `nodeId`（见
 * `MemberExecutionHostOptions.nodeId`），不在这里解析。让模型只学一种地址形态，
 * 比「本机两段、跨机三段」少一条分支：早先本机来源省掉 node 段，模型抄回去的
 * 两段地址是否算本机取决于当时有没有 federation 开着，行为不一致。
 *
 * **principal 段必须是能解析到的值**，一条规则两种情况：
 * - 名字合法（见 `isAddressSafePrincipal`）就写名字：`docs-core@<node>:<team>`；
 * - 名字不可用、或成员无名，一律写**完整 uuid**。
 *
 * 不缩成短 id：node 段是精确命中本机的，落到 `registry.resolve("3ae686c0")` 时
 * 只做 id / session / body 的精确匹配、没有前缀匹配，结果必然是 `unknown_member`
 * ——消息发不出去，而不是被误路由到远端。来源行还会持久化进历史，模型下一轮照样抄。
 * 名字不可用时同理不做任何截断降级，uuid 是唯一保证合法的 principal。
 *
 * **缺 `nodeId` 时退回两段** `principal@<team>`（纯内存构造 / 测试路径）：不伪造 node 段，
 * 也不去猜一个主机名。
 *
 * `channel` 是消息的元属性，只进 trace / 日志，不渲染进提示词。
 *
 * 联邦入站的 `from` 已自带 `<principal>@<node>:<team>`：整体作为 location 原样渲染，
 * 不再拼本机 node/team（否则会把它伪装成本机成员）。
 */
function formatMessageSource(
  message: AgentMessage,
  teamId: string | undefined,
  nodeId: string | undefined,
): string {
  if (message.from.startsWith('federation:')) {
    const address = sanitizeSource(message.from.slice('federation:'.length));
    return `<from location="${escapeAttr(address)}" />`;
  }
  const source = message.source ?? inferMessageSource(message.from);
  // 一条规则覆盖两种情况：principal 段必须是 resolveAddress 收得下的形状，
  // 收不下就用完整 uuid（uuid 一定合法）。名字不可用时不做「换个短一点的写法」
  // 之类的降级 —— 解析侧只做精确匹配，任何截断都是另一种死地址。
  const named = message.from_name === undefined ? undefined : sanitizeSource(message.from_name);
  const principal =
    source === 'agent'
      ? named !== undefined && isAddressSafePrincipal(named)
        ? named
        : sanitizeSource(message.from)
      : source;
  const scope = teamId === undefined ? undefined : sanitizeSource(teamId);
  // 段数决定语义：有 node 才写三段，有 team 才写 `@team`。缺的段不补占位符。
  const host = [nodeId, scope].filter((part) => part !== undefined && part !== '');
  const address = host.length === 0 ? principal : `${principal}@${host.join(':')}`;
  return `<from location="${escapeAttr(address)}" />`;
}

/**
 * async `ask` 答案投递的消息名（`Message.name`，随 `user.message` 持久化）。
 *
 * 它不是 `vessel:*`（那是**模型侧上下文**、不算 turn 锚点）：这条消息就是该轮真实的
 * 用户输入，只是人来路不同 —— Web 据此渲染「待批答复」卡而不是用户气泡。
 * 字面量与 `apps/web/src/domains/chat/ask-answer.ts` 必须一致（`check-transcript-items` 守）。
 */
export const ASK_ANSWER_INPUT_NAME = 'ask:answer';

/** `name` 只允许简单标签：Provider 侧把 `name` 当标识符，空格 / 符号 / 中文都不进。 */
function sanitizeAlias(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '');
}

/** `node:agent` / `federation:principal@node:team` → agent / principal 段（取 id 用）。 */
function agentIdOf(from: string): string {
  const stripped = from.startsWith('federation:') ? from.slice('federation:'.length) : from;
  const principal = stripped.split('@')[0] ?? stripped;
  return principal.slice(principal.lastIndexOf(':') + 1);
}

/**
 * 本轮输入那条 user 消息的 `name`：声明的身份优先，否则按 A2A 来源推导。
 *
 * - `message.input_name`：投递方**显式声明**的身份，只用于运行时合成输入与交接嘱托
 *   （idle 唤醒 = `vessel:notice`，见 `AgentService.INBOX_WAKE_NAME`；rotate 交接 =
 *   `rotate:handoff:<epoch>`，见 `AgentService.ROTATE_HANDOFF_INPUT_NAME`）。上下文
 *   身份不只能从 `source` 推理出来：`startup_prompt` 与唤醒同为 system principal
 *   投递，前者在 rotate 路径上是 agent 写的交接书、在 create / restart / activate
 *   路径上是人的开场白，只能由生产者说清楚。
 * - `agent:<alias>`：A2A 投递（`agentInputName`）。
 * - 人类 / 系统 / 联邦来源返回 undefined，消息不带 `name`（保持 nil）。
 *
 * 改动只落在既有的 `Message.name`（已随 `user.message` 持久化）上——不新增字段，
 * 也不把 `vessel:source` 重新放回可见；Web / TUI 侧据此决定这条输入是「谁说的话」。
 */
function inputNameOf(message: AgentMessage): string | undefined {
  const declared = message.input_name;
  if (typeof declared === 'string' && declared.length > 0) return declared;
  return agentInputName(message);
}

/**
 * A2A 输入那条 user 消息的 `name`：`agent:<alias>`。
 *
 * 只标「agent 发来的」：人类 / 系统来源返回 undefined，消息不带 `name`（保持 nil）。
 * alias 用发送者显示名清洗成 `[A-Za-z0-9_-]`；没有显示名（远端 / 联邦 / 未注册）
 * 时退回 agent 地址里的 id 前 8 位。
 */
function agentInputName(message: AgentMessage): string | undefined {
  const source = message.source ?? inferMessageSource(message.from);
  if (source !== 'agent') return undefined;
  const named = sanitizeAlias(message.from_name ?? '');
  const alias = named.length > 0 ? named : sanitizeAlias(agentIdOf(message.from)).slice(0, 8);
  return alias.length > 0 ? `agent:${alias}` : undefined;
}

/** 成员侧 agent 工具可用的动作（close 的审批在 checkPermission；create 需要成员自己所属 Team） */
const MEMBER_AGENT_ACTIONS: readonly string[] = [
  'create',
  'hire',
  'close',
  'rotate',
  'post',
  'send',
  'list',
  'read',
];

/** 成员侧 agent 工具的可见参数；父级 schema 有同名字段时沿用父级定义 */
const MEMBER_AGENT_PROPERTIES: Readonly<Record<string, Record<string, unknown>>> = {
  action: {
    type: 'string',
    enum: [...MEMBER_AGENT_ACTIONS],
    description: 'create | hire | close | rotate | post | send | list | read',
  },
  name: { type: 'string', description: 'create/hire: display name' },
  model: { type: 'string', description: 'create/hire: model override' },
  system_prompt: { type: 'string', description: 'create/hire: optional system prompt' },
  to: {
    type: 'string',
    description:
      'send: target agent; use the location value from the source line as-is, or a member id; ' +
      'read: member id, session id or name',
  },
  content: { type: 'string', description: 'send/post: message text' },
  interrupt: {
    type: 'boolean',
    description:
      'send: urgent — cancel the target body active run and put this message first ' +
      '(work/queued messages are preserved; cannot combine with notify)',
  },
  notify: {
    type: 'boolean',
    description:
      'send: append to the target inbox as unread and wake it with a summary notice; ' +
      'does not run, queue, or cancel anything (cannot combine with interrupt)',
  },
  message_id: {
    type: 'string',
    description:
      'send: with interrupt, deliver an existing inbox message id instead of new content',
  },
  messages: {
    type: 'array',
    description: 'send: [{to, content, interrupt?, notify?, message_id?}]',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 50,
    description: 'read: how many trailing messages to return (default 20, max 50)',
  },
  members: {
    type: 'array',
    description:
      'create/hire: [{name?, model?, system_prompt?, visibility?}]; ' +
      'close: [member id or session id]',
  },
  startup_prompt: {
    type: 'string',
    // 正常路径沿用父级（tool.ts）那份描述，这里只是父级 schema 缺失时的兜底；
    // 两份措辞保持一致，避免成员侧又说回「必填即可」。
    description:
      'rotate: required; the new body first message and the only handoff channel — ' +
      'it does not inherit this conversation, so write everything the next body needs',
  },
  state: { type: 'string', description: 'list: filter by member state' },
  visibility: {
    type: 'string',
    enum: ['private', 'team', 'tenant'],
    description:
      'create: team only; hire: visibility (default private for unbound, team with a team); ' +
      'list: filter by visibility',
  },
};

/** 同一个 agent 工具，按成员能力收窄 schema（handler / checkPermission 原样保留） */
function restrictAgentTool(tool: ToolDefinition): ToolDefinition {
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
  const source = isRecord(schema.properties) ? schema.properties : {};
  // 无论父级 schema 有几种 action，成员侧只暴露 create/hire/rotate/post/send/list
  const properties: Record<string, unknown> = {
    action: isRecord(source.action)
      ? { ...source.action, enum: [...MEMBER_AGENT_ACTIONS] }
      : MEMBER_AGENT_PROPERTIES.action,
  };
  for (const [key, fallback] of Object.entries(MEMBER_AGENT_PROPERTIES)) {
    if (key !== 'action') properties[key] = source[key] ?? fallback;
  }
  return {
    ...tool,
    // 与 owner 侧同一句不变量：交接只有 startup_prompt 一条通道（成员没有别的
    // 手段把信息带给下一个身体）；「必填」不足以表达这一点。
    description:
      'Member actions: create (create peer member(s) in your team), ' +
      'hire (create contractor member(s) owned by you), ' +
      'close (release member(s); closing a peer requires human approval, while closing ' +
      'your own contractor or yourself needs no approval), ' +
      'rotate (rotate your own body; startup_prompt is the only handoff — the new body ' +
      'starts at once and does not inherit this conversation, so it must carry everything ' +
      'the next body needs to know), ' +
      'post (append to your team log only; nobody is notified), ' +
      'send (dispatch a message to a member; interrupt:true for urgent, notify:true to ' +
      'append to the target inbox plus a summary wake), ' +
      'list (list the caller-visible roster), ' +
      'read (read the last messages of a member session; read-only, role + truncated text).',
    inputSchema: {
      ...schema,
      properties,
      required: ['action'],
    },
  };
}

/**
 * 0.51：`ToolDefinition` → `tools.list` 的条目。
 *
 * 没有来源维度：运行期注入的 `inbox` 与父宿主工具在这里是同一种条目。要恢复「哪些是
 * 注入的」这种信息，只能走「inbox 自己也变成插件」这条路（把注入点搬到节点插件面），
 * 不要在这里重新长出 `source` 标记 —— 那是被用户明确删掉的一层区分。
 */
function describeTools(tools: readonly ToolDefinition[]): MemberToolEntry[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    has_permission_check: typeof tool.checkPermission === 'function',
  }));
}

/**
 * 推导路径（没有活身体，或只是问「新身体会拿到什么」）用的端口载体：`isActive` 恒 true、
 * `publish` 是 noop —— 那是 `tools()` 的纯度要求，不是「假装活着」。真 body 的实例在 spawn 里建。
 */
const DERIVED_BODY: {
  isActive: () => boolean;
  publish: (event: MemberBodyNoticeEvent) => void;
} = {
  isActive: () => true,
  publish: () => {},
};

/** 进程内成员执行内核 */
export class MemberExecutionHost implements MemberExecutionPort {
  private readonly model?: string;
  private readonly pluginHost?: PluginHost;
  private readonly readOnlyTools: ReadonlySet<string>;
  private readonly permissionMode: MemberExecutionPermissionMode;
  private readonly forceBridgeForTeams: boolean;
  private readonly permissionPolicy?: (
    teamId: string | undefined,
  ) => TeamPermissionPolicy | undefined;
  /** 成员兜底权限（热应用会整体替换，故非 readonly） */
  private permission?: RuntimePermissionConfig;
  private readonly parentEvents?: EventStream;
  private readonly onPermissionState?: (
    memberId: string,
    sessionId: string,
    state: MemberPermissionState,
  ) => void;
  private readonly onMemberEvent?: (memberId: string, sessionId: string, event: RunEvent) => void;
  private readonly limits: UsageLimits;
  private readonly termination: TerminationPolicy;
  private readonly contextMaxTokens: number;
  private readonly contextCompactThreshold: number | undefined;
  private readonly summarizer: ContextSummarizer | undefined;
  private readonly summarizerForSession: ((sessionId: string) => ContextSummarizer) | undefined;
  private readonly depth: number;
  /** 0.51：记录里没有 cwd 时的运行期兜底（装配层按 team_id 查 Team 基础路径） */
  private readonly cwdFor: ((member: MemberExecutionMember) => string | undefined) | undefined;
  private readonly logger: Logger;
  private readonly tenantId?: string;
  private readonly nodeId?: string;
  private readonly includeReasoning?: boolean;
  private readonly session?: ExecutionUnitOptions['session'];
  private readonly eventLog?: ExecutionUnitOptions['eventLog'];
  private readonly leaseService?: ExecutionUnitOptions['leaseService'];
  private readonly runtime: Runtime;
  private readonly entries = new Map<string, MemberExecutionEntry>();
  /** 未 spawn / 未开跑成员的待注入 notice（member id → 有界文本队列） */
  private readonly pendingNotices = new Map<string, string[]>();
  /** 0.32：由装配层挂上的收件箱；spawn 时据此注册 notice hook 与 `inbox` 工具 */
  private inbox?: AgentInboxPort;

  constructor(options: MemberExecutionHostOptions) {
    this.model = options.model;
    this.pluginHost = options.pluginHost;
    this.readOnlyTools = new Set(options.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS);
    this.permissionMode = options.permissionMode ?? 'allow';
    this.forceBridgeForTeams = options.forceBridgeForTeams !== false;
    this.permissionPolicy = options.permissionPolicy;
    this.permission =
      options.permission !== undefined ? withMemberAutoApprove(options.permission) : undefined;
    this.parentEvents = options.parentEvents;
    this.onPermissionState = options.onPermissionState;
    this.onMemberEvent = options.onMemberEvent;
    this.limits = options.limits ?? {};
    this.termination = options.termination ?? DEFAULT_TERMINATION;
    this.contextMaxTokens = options.contextMaxTokens ?? DEFAULT_CONTEXT_MAX_TOKENS;
    this.contextCompactThreshold = options.contextCompactThreshold;
    this.summarizer = options.summarizer;
    this.summarizerForSession = options.summarizerForSession;
    this.depth = options.depth ?? 1;
    this.cwdFor = options.cwdFor;
    this.logger = options.logger ?? noopLogger;
    this.tenantId = options.tenantId;
    this.nodeId = options.nodeId;
    this.includeReasoning = options.includeReasoning;
    this.session = options.session;
    this.eventLog = options.eventLog;
    this.leaseService = options.leaseService;
    this.runtime = options.runtime;
    if (this.permissionMode === 'bridge' && this.parentEvents === undefined) {
      this.logger.warn('agent.member.permission_bridge_unavailable', {
        fallback: 'ask_denied',
      });
    }
  }

  async spawn(member: MemberExecutionMember): Promise<void> {
    if (this.entries.has(member.session_id)) {
      throw new Error(`member runtime already spawned: ${member.session_id}`);
    }
    const model = member.model ?? this.model;
    if (!model) {
      throw new Error(`member runtime model is required: ${member.id}`);
    }

    const surface = this.buildSurface(member);
    const mode = surface.mode;
    // 0.32：只有 spawn 时已 attach 收件箱的 ExecutionUnit 才注册 notice hook 与 inbox 工具；
    // 开关放在可变对象里，`disableInbox` 之后（rotate / retire 的旧 ExecutionUnit）hook 直接返回。
    const inbox = this.inbox;
    const inboxState = inbox !== undefined ? { enabled: true } : undefined;
    const pluginHost = new MemoryPluginHost();
    for (const hook of this.pluginHost?.getHooks() ?? []) pluginHost.registerHook(hook);
    for (const guardrail of this.pluginHost?.getGuardrails() ?? []) {
      pluginHost.registerGuardrail(guardrail);
    }
    for (const tool of surface.tools) pluginHost.registerTool(tool);

    const selfCard = this.buildSelfCard(member, model, surface.tools);
    // 0.52：Self Card 是构造期只读快照 —— 基础信息改了不能热替换它（那是 system 前缀，
    // 变一次就让整段历史缓存失效）。改成「增量告知」：这具 body 自带一个真值盒（此刻 =
    // 这张卡），`AgentService.update` 时推进；hook 每轮 diff「模型相信的值」与它，变了就
    // 注入一条环境信息。每个 hook 实例 = 一具 body，rotate 换身体时状态自然重置。
    const selfCardIdentity = { member };
    pluginHost.registerHook(
      createSelfCardDeltaHook({
        baseline: selfCardIdentityOf(member, mode),
        // 权限档每轮现算：Team 成员在 `forceBridgeForTeams` 下会被强制 bridge，是「进队 /
        // 转正」直接改出来的身份变化，不能只报 team 那一行。
        current: () =>
          selfCardIdentityOf(
            selfCardIdentity.member,
            this.effectivePermissionMode(selfCardIdentity.member),
          ),
      }),
    );
    const events = new MemoryEventStream();
    if (inbox !== undefined && inboxState !== undefined) {
      pluginHost.registerHook(
        createInboxNoticeHook({
          inbox,
          agentId: member.id,
          isEnabled: () => inboxState.enabled,
          onNotified: ({ runId, unread, pending }) => {
            // 人类可见的提示：模型侧另有一条 `vessel:notice` 尾消息（不含正文）。
            events.publish({
              type: 'runtime.notice',
              run_id: runId,
              data: {
                scope: 'inbox',
                summary:
                  `[inbox] ${unread} unread message(s), ${pending} pending; ` +
                  'use the inbox tool (action="list") to view them.',
                ok: true,
              },
              ts: Date.now(),
            });
          },
        }),
      );
    }
    // 0.51：成员面贡献的 hook —— 一具 body 只在这里建一次（`hooks()` 的契约）；工具不在这里，
    // 它们在 `buildSurface` 里按同一份贡献产出，好让「推导值 = 新身体会拿到的」继续成立。
    this.registerContributionHooks(pluginHost, member, inboxState, events);
    // 0.28 D6/D7：temporary 不主动压缩（一具 body 的生命周期由调用方的会话决定，
    // 压缩会把调用方还在看的历史摘要掉）；到线只提示。core 只收到裸参数，不认 role。
    // 两道硬兜底仍然生效：消息条数上限（`RoleAwareContext` 内层，与开关无关）
    // 与 provider overflow 的 forceCompact（runtime 内的 overflow 重试）。
    //
    // 开关放在 `RoleAwareContext` 而不是 core 的构造配置：转正后同一具 live body
    // 必须能翻转策略（契约 §5 / D6）。内层恒 `autoCompact: false`，由包装决定要不要
    // 主动压缩 —— 否则 `add()` 会绕过包装、在 temporary 上按阈值压缩。
    const policy = contextPolicyFor(member.role);
    // per-body 可变策略：每次 Run 的 `contextFactory` 读取同一对象，
    // `applyContextPolicy` 只改这里，下一次 Run 自然生效。
    const contextPolicy = { autoCompact: policy.autoCompact };
    // 0.51 Bug 1：成员 cwd 在 spawn 时定一次（与 selfCard / systemPrompt 同一档快照语义）。
    // 拿不到有效目录就**降级**：warn 一次，然后不注入 —— 工具会退回 agent.cwd / process.cwd()。
    // 绝不让「Team 目录不在」把 bash / read / edit 变成硬错（`main` 的工具面同理）。
    const memberCwd = this.memberCwdFor(member);
    const runtime = await this.runtime.getOrCreateExecutionUnit({
      tenantId: this.tenantId ?? 'default',
      sessionId: member.session_id,
      agentId: member.id,
      // 成员自有事件流；所有 body 事件仍由下方订阅并入父流。
      events,
      ...(this.session !== undefined ? { session: this.session } : {}),
      ...(this.eventLog !== undefined ? { eventLog: this.eventLog } : {}),
      ...(this.leaseService !== undefined ? { leaseService: this.leaseService } : {}),
      // Stage 3：ControlPlane 获取的 BindingLease 凭据随 spawn 透传给 EU（EU 只续租/释放）。
      ...(member.binding_lease !== undefined ? { bindingLease: member.binding_lease } : {}),
      // 0.51 Bug 1：成员 cwd 的唯一注入点 —— EU 每次工具调用把它放进 `ToolContext.cwd`。
      ...(memberCwd !== undefined ? { cwd: memberCwd } : {}),
      pluginHost,
      // 成员宿主已自带工具面；不让 tenant profile 的插件再次安装进来。
      plugins: [],
      limits: this.limits,
      termination: this.termination,
      ...(this.includeReasoning !== undefined ? { includeReasoning: this.includeReasoning } : {}),
      logger: this.logger,
      // Stage 4：WorkingContext 是 per-Run 实例；这里只给工厂，EU 每次 Run 调用它。
      contextFactory: () => {
        // R7：成员与 owner 按同一 session_id 取熔断器；未接线时回落裸 summarizer。
        const summarizer = this.summarizerForSession?.(member.session_id) ?? this.summarizer;
        return new RoleAwareContext(
          new MemoryWorkingContext({
            maxTokens: this.contextMaxTokens,
            autoCompact: false,
            compactThreshold: this.contextCompactThreshold,
            ...(summarizer !== undefined ? { summarizer } : {}),
          }),
          contextPolicy.autoCompact,
        );
      },
      overrides: {
        model,
        // 与 owner 同源的权限规则：工具 checkPermission 返回 ask 时，core 仍按
        // autoApprove / neverAutoApprove 判定，否则 auto_approve 的 bash/edit 会在
        // 成员 ExecutionUnit 上重新弹卡片（热应用后新建的 ExecutionUnit 同样走这里）。
        permission: this.permission ?? { default: 'allow' },
        selfCard,
        ...(policy.pressureHint !== undefined ? { contextPressureHint: policy.pressureHint } : {}),
        ...(member.system_prompt !== undefined ? { systemPrompt: member.system_prompt } : {}),
      },
    });
    const entry: MemberExecutionEntry = {
      runtime,
      memberId: member.id,
      sessionId: member.session_id,
      started: false,
      events,
      unsubscribers: [],
      pendingPermissions: new Map(),
      waiting: false,
      contextPolicy,
      pluginHost,
      mode,
      running: false,
      toolsRefreshPending: false,
      // 与注册给 hook 的是**同一个对象**：`noteSelfCardIdentity` 写这里，hook 下一轮就读到。
      selfCardIdentity,
      ...(inboxState !== undefined ? { inboxState } : {}),
    };
    this.entries.set(member.session_id, entry);
    if (this.onMemberEvent !== undefined) {
      const onMemberEvent = this.onMemberEvent;
      entry.unsubscribers.push(
        entry.events.subscribe((event: RunEvent) => {
          if (event.type !== 'agent.limit.warning') return;
          try {
            onMemberEvent(member.id, member.session_id, event);
          } catch (error) {
            this.logger.warn('agent.member.event_callback_failed', {
              member_id: member.id,
              session_id: member.session_id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    }
    if (mode === 'bridge' && this.parentEvents !== undefined) {
      this.attachBridge(member, entry);
    }
    // 0.27：所有 body 事件无条件并入父事件流；权限/ask 请求与应答仍由 bridge 独占。
    if (this.parentEvents !== undefined) {
      const parentEvents = this.parentEvents;
      entry.unsubscribers.push(
        entry.events.subscribe((event: RunEvent) => {
          // 权限/提问请求与应答由 bridge 独占转发；这里再发一次会重复卡片并形成回环。
          if (
            PERMISSION_REQUEST_EVENTS.has(event.type) ||
            PERMISSION_RESPONSE_EVENTS.has(event.type)
          ) {
            return;
          }
          if (this.entries.get(member.session_id) !== entry) return;
          // 成员 run 与 owner run 一样并入 tenant 事件流：Web 会话窗口 / trace /
          // 观测都靠这条流看到 llm、tool 与 run 生命周期事件（session_id 已在 payload 内）。
          // 终态事件额外补成员归属，Team 侧才能把 reply / 失败写进团队日志。
          const forwarded: RunEvent = RUN_TERMINAL_EVENTS.has(event.type)
            ? withMemberIdentity(event, member)
            : event;
          parentEvents.publish(forwarded);
        }),
      );
    }
  }

  async runTurn(
    member: MemberExecutionMember,
    message: AgentMessage,
    scheduledRunId?: string,
  ): Promise<MemberTurnResult> {
    return this.executeTurn(member, message, scheduledRunId, false);
  }

  /**
   * Q5：按 session 历史启动一次新 run（`-r/--resume` 与 AgentService 的
   * resume 准入路径显式走这里）。与 `runTurn` 共用调度、事件、终态逻辑；
   * 唯一区别是 core 侧调用 `resumeSession(sessionId, input)` 而不是 `run`。
   */
  async resumeTurn(
    member: MemberExecutionMember,
    message: AgentMessage,
    scheduledRunId?: string,
  ): Promise<MemberTurnResult> {
    return this.executeTurn(member, message, scheduledRunId, true);
  }

  private async executeTurn(
    member: MemberExecutionMember,
    message: AgentMessage,
    scheduledRunId: string | undefined,
    resume: boolean,
  ): Promise<MemberTurnResult> {
    const entry = this.requireEntry(member);
    entry.started = true;
    entry.running = true;
    // 未 spawn / 未开跑期间暂存的 notice 在历史恢复之后、用户输入之前注入。
    const pendingNotices = this.takePendingNotices(member.id);
    const runId = scheduledRunId ?? randomUUID();
    let terminal: 'completed' | 'failed' | 'cancelled' | undefined;
    let usage: Usage | undefined;
    const unsubscribe = entry.runtime.events.subscribe((event: RunEvent) => {
      if (event.run_id !== runId) return;
      if (event.type === 'run.completed') {
        terminal = 'completed';
        usage = readUsage(event.data);
      } else if (event.type === 'run.cancelled') {
        terminal = 'cancelled';
      } else if (event.type === 'run.failed') {
        terminal = 'failed';
      }
    });

    // 来源标注作为用户输入之前的持久化消息注入；不改 system，也不改写用户文本。
    const sourceMessage: Message = {
      role: 'user',
      name: 'vessel:source',
      content: formatMessageSource(message, member.team_id, this.nodeId),
      timestamp: Date.now(),
    };
    // 输入本身可能带结构化身份：A2A 是 agent:<alias>（Web 渲染成 agent 消息卡），
    // 运行时合成输入（idle 唤醒）是 vessel:notice（环境信息卡），async ask 的答案
    // （human 来源）是 ask:answer（待批答复卡），rotate 交接嘱托是
    // rotate:handoff:<epoch>（交接卡）。人类 / 系统正文来源保持 nil。
    const inputName =
      message.origin === 'ask_answer' ? ASK_ANSWER_INPUT_NAME : inputNameOf(message);
    // 附件引用（0.52）：只有路径与种类，随 user 消息落进 `user.message` 事件与
    // SessionState。refs 不进 `RunOptions.messages`，正文也永不在这里被读出来。
    const refs = message.refs !== undefined && message.refs.length > 0 ? message.refs : undefined;
    const userInput: string | Message =
      inputName === undefined && refs === undefined
        ? message.content
        : {
            role: 'user',
            content: message.content,
            ...(inputName !== undefined ? { name: inputName } : {}),
            ...(refs !== undefined ? { refs } : {}),
          };
    try {
      const turnOptions = {
        runId,
        messages: [...pendingNotices.map(noticeMessage), sourceMessage],
      };
      const content =
        resume && entry.runtime.resumeSession !== undefined
          ? await entry.runtime.resumeSession(member.session_id, userInput, turnOptions)
          : await entry.runtime.run(userInput, member.session_id, turnOptions);
      return {
        content,
        outcome: 'completed',
        ...(usage !== undefined ? { usage } : {}),
      };
    } catch (error) {
      // 取消不是失败：interrupt('user') 让 core 发 run.cancelled 并 reject。
      if (terminal === 'cancelled') return { outcome: 'cancelled' };
      throw error;
    } finally {
      unsubscribe();
      // 取消 / 失败时可能仍停在等待：清掉挂起请求与 deadline，把状态还回 running，
      // 让 AgentService 能正常进入终态（应答随后到达时已无人等待）。
      this.clearPending(entry);
      if (entry.waiting) {
        entry.waiting = false;
        this.notifyPermissionState(member.id, member.session_id, 'running');
      }
      this.finishRun(member, entry);
    }
  }

  cancel(member: MemberExecutionMember, reason: RunInterruptReason = 'user'): void {
    this.entries.get(member.session_id)?.runtime.interrupt?.(reason);
  }

  /**
   * 身份变更 notice：live 且已开跑 → 立即追加到上下文（本轮后续请求可见）；
   * 未 spawn / 未开跑 → 暂存，下一次 runTurn 注入。不启动 turn、不入队。
   */
  notice(memberId: string, text: string): void {
    if (text.length === 0) return;
    let delivered = false;
    for (const entry of this.entries.values()) {
      if (entry.memberId !== memberId) continue;
      if (entry.started && entry.runtime.appendNotice !== undefined) {
        entry.runtime.appendNotice(text);
        delivered = true;
      }
    }
    if (!delivered) this.queuePendingNotice(memberId, text);
  }

  /**
   * 0.31：body 上下文水位。Stage 4 起读上一 Run 结束时 EU 记录的标量，
   * 不重建窗口、不推断；没有活体或无 token 预算时返回 undefined。
   */
  contextRatio(sessionId: string): number | undefined {
    return this.entries.get(sessionId)?.runtime.lastContextRatio;
  }

  /**
   * 0.31：该 body 的交互请求能否到达人类。只认「bridge 已挂上」：
   * permissionMode=allow 的无 team body 不发请求，避免请求发进无人订阅的
   * 成员事件流后永久等待。有父流但没 bridge 同样不算。
   */
  canConfirm(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    return entry !== undefined && entry.mode === 'bridge' && this.parentEvents !== undefined;
  }

  /**
   * 0.32：挂上 / 摘掉收件箱。只影响之后 spawn 的 ExecutionUnit；已存在的 ExecutionUnit 按 CONTRACT
   * 保留 spawn 时的决定（`disableInbox` 负责逐 ExecutionUnit 关闭）。
   */
  attachInbox(inbox: AgentInboxPort | undefined): void {
    this.inbox = inbox;
  }

  /** 0.32：旧 ExecutionUnit 的 inbox hook 不再取消息（rotate / retire）。 */
  disableInbox(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry?.inboxState !== undefined) entry.inboxState.enabled = false;
  }

  /** 0.32：rotate 回滚时恢复旧 ExecutionUnit 的 inbox hook。 */
  enableInbox(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry?.inboxState !== undefined) entry.inboxState.enabled = true;
  }

  /** 0.32：清掉该成员尚未注入的 notice（retire 时避免串到新 ExecutionUnit）。 */
  clearPendingNotices(memberId: string): void {
    this.pendingNotices.delete(memberId);
  }

  private queuePendingNotice(memberId: string, text: string): void {
    const existing = this.pendingNotices.get(memberId);
    if (existing !== undefined) {
      existing.push(text);
      if (existing.length > MAX_PENDING_NOTICES) {
        existing.splice(0, existing.length - MAX_PENDING_NOTICES);
      }
      return;
    }
    if (this.pendingNotices.size >= MAX_PENDING_NOTICE_MEMBERS) {
      const oldest = this.pendingNotices.keys().next().value;
      if (oldest !== undefined) this.pendingNotices.delete(oldest);
    }
    this.pendingNotices.set(memberId, [text]);
  }

  private takePendingNotices(memberId: string): string[] {
    const notices = this.pendingNotices.get(memberId);
    if (notices === undefined) return [];
    this.pendingNotices.delete(memberId);
    return notices;
  }

  async dispose(member: MemberExecutionMember): Promise<void> {
    const entry = this.entries.get(member.session_id);
    if (!entry) return;
    // 先移除，避免 dispose 期间 / 之后又有 runTurn 走进已释放的 runtime
    this.entries.delete(member.session_id);
    for (const unsubscribe of entry.unsubscribers) unsubscribe();
    entry.unsubscribers.length = 0;
    this.clearPending(entry);
    // Stage 4：EU 生命周期归 Runtime 目录；直接 dispose 会留下 stale cache，
    // 同 (tenant, session) 再 spawn 时拿回已释放的实例。
    await this.runtime.retireExecutionUnit({
      tenantId: this.tenantId ?? 'default',
      sessionId: member.session_id,
    });
  }

  /**
   * Stage 4：用已加载的 RunRecord 恢复成员的一轮 run。
   *
   * 调用方（AgentService）负责 RunRecord 加载与 scheduler 串行；这里只按
   * `record.session_id` 找活的 ExecutionUnit。未 spawn 时抛稳定错误码，
   * 由装配层映射到 RPC，不做隐式 spawn（语义由 AgentService 决定）。
   */
  async resumeRun(record: RunRecord, opts?: RunOptions): Promise<string> {
    const entry = this.entries.get(record.session_id);
    if (entry === undefined || entry.runtime.resumeRun === undefined) {
      throw new Error(`member_execution_not_found: ${record.session_id}`);
    }
    return entry.runtime.resumeRun(record, opts);
  }

  sessionLeaseToken(sessionId: string): number | undefined {
    return this.entries.get(sessionId)?.runtime.sessionLeaseToken?.(sessionId);
  }

  /**
   * Additive (title_source): name a session shell explicitly.
   *
   * Only touches the shell (title / title_source / updated_at); messages and run
   * state stay with the Run projection. A shell already marked 'manual' is never
   * downgraded by a 'generated' write, so a late AI pass cannot clobber a rename.
   * Returns false when this host has no SessionStore (headless / pure memory).
   */
  async setSessionTitle(
    sessionId: string,
    title: string,
    source: SessionTitleSource,
  ): Promise<boolean> {
    const store = this.session;
    if (store === undefined) return false;
    const stored = await store.load(sessionId);
    if (stored?.title_source === 'manual' && source !== 'manual') return false;
    const now = Date.now();
    // A brand-new body has no shell yet: synthesise a name-only one. status must
    // not be left to the backend default (SQLite stores 'running'), otherwise the
    // liveness sweep would treat a session that never ran as a crashed run.
    const base: SessionState = stored ?? {
      session_id: sessionId,
      created_at: now,
      updated_at: now,
      status: 'completed',
    };
    await store.save({ ...base, title, title_source: source, updated_at: now });
    return true;
  }

  async ensureSessionLease(sessionId: string, minFence?: number): Promise<LeaseGrant | undefined> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return undefined;
    return entry.runtime.ensureSessionLease?.(sessionId, minFence);
  }

  /**
   * CONTRACT-hot-apply §4：把权限规则热应用到所有存活成员 ExecutionUnit。
   *
   * 规则整体替换（与 owner 侧同一语义）。这里只覆盖 core `PermissionPolicy` 的
   * 判定面；成员工具的 checkPermission 包装（`restrictPermissions`）把 ask 折回
   * bridge / deny，属于装配期决定，热应用不改它。
   * `members` 有记录但尚未 spawn 出 ExecutionUnit 时没有可应用的 runtime，跳过并计入未应用。
   */
  applyPermissionRules(rules: RuntimePermissionConfig): number {
    // 热应用来自 owner 同源配置；补回成员自有的 `agent` 免确认后同时供存活的
    // ExecutionUnit 与之后新建的 ExecutionUnit（spawn）使用。
    const memberRules = withMemberAutoApprove(rules);
    this.permission = memberRules;
    let applied = 0;
    for (const [sessionId, entry] of this.entries) {
      const runtime = entry.runtime as MemberRunnableAgent & {
        applyPermissionRules?: (next: RuntimePermissionConfig) => void;
      };
      if (typeof runtime.applyPermissionRules !== 'function') continue;
      try {
        runtime.applyPermissionRules(memberRules);
        applied += 1;
      } catch (error) {
        // 单个 ExecutionUnit 失败不影响其它 ExecutionUnit；装配层按数量判定是否全部生效。
        this.logger.warn('agent.member.permission_apply_failed', {
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return applied;
  }

  /**
   * 工具热重载（CONTRACT-hot-apply §4，additive）：在**同一具 body** 上重跑工具筛选，
   * 原地替换 body 自己的工具宿主，不重建 body、不动 session / context / provider。
   *
   * - 没有在跑轮 → 立即应用；
   * - 有在跑轮 → 置 pending，run 结束再应用（ADR-054 单 run；run 中途换工具面会打乱
   *   已在途的工具调用与 prompt prefix）。
   *
   * `tools` 缺省取父宿主当前工具面；传入时以传入集合为来源（调用方刚应用过的快照）。
   * 返回实际刷新的 body 数。
   */
  refreshTools(tools?: readonly ToolDefinition[]): number {
    const source = tools ?? this.pluginHost?.listTools() ?? [];
    let applied = 0;
    for (const entry of this.entries.values()) {
      if (entry.running) {
        entry.toolsRefreshPending = true;
        entry.pendingTools = source;
        continue;
      }
      if (this.applyToolsToEntry(entry, source)) applied += 1;
    }
    return applied;
  }

  /**
   * 0.51：该成员这一份工具清单（canonical `tools.list{agent_id}` 的唯一数据源）。
   *
   * 两条路径，都是真实注册路径的结果：
   * - **有活身体**：直接读那具 body 自己的 `MemoryPluginHost`。工具热刷新、`disableInbox`、
   *   `inboxState` 之类只在运行期发生的事都会被如实反映 —— 这是实读，不是按配置重算。
   * - **当前没有活身体**：调用 `buildSurface`，也就是 `spawn` 注册进新宿主用的**同一个
   *   函数**（同一个 `effectivePermissionMode` 判定、同一份 `selectTools(mode)` +
   *   `restrictPermissions`、同一个 inbox 工具判定）。所以它答出的就是「一具新身体此刻
   *   会拿到什么」；唯一差别是这里不建 body —— 不 spawn、不占 `maxLiveBodies` 名额、
   *   不留任何副作用。想让两条路径保持一致，唯一的办法就是共用 `buildSurface`。
   *
   * 为什么不再报 `surface: 'live' | 'derived'`：那是「两个工具面」的残留口径。成员用的
   * 就是节点那一份清单，实读与推导只是取数路径的差别，调用方不需要知道。
   */
  toolSurface(member: MemberExecutionMember): MemberToolEntry[] {
    const entry = this.entries.get(member.session_id);
    if (entry !== undefined && entry.memberId === member.id) {
      return describeTools(entry.pluginHost.listTools());
    }
    return describeTools(this.buildSurface(member).tools);
  }

  /** 轮结束：清 running；若期间收到过工具刷新，在轮边界应用。 */
  private finishRun(member: MemberExecutionMember, entry: MemberExecutionEntry): void {
    entry.running = false;
    if (!entry.toolsRefreshPending) return;
    entry.toolsRefreshPending = false;
    const source = entry.pendingTools ?? this.pluginHost?.listTools() ?? [];
    entry.pendingTools = undefined;
    // body 已被 dispose（entries 里已无此条目）时不再触碰其宿主。
    if (this.entries.get(member.session_id) !== entry) return;
    this.applyToolsToEntry(entry, source);
  }

  /**
   * 成员应有的工具面（**唯一一份规格**）。
   *
   * spawn、工具热刷新、`tools.list{agent_id}` 的推导路径都调这里：谁都不许再写一份
   * 「成员有哪些工具」——无身体时答出的「新身体会拿到的」，靠的就是这里与 spawn 是
   * 同一个函数，不是两段长得像的代码。
   *
   * 内容 = `effectivePermissionMode`（或调用方钉死的 mode）+ `selectTools(mode)` +
   * `restrictPermissions` + inbox 工具判定 + 成员面贡献的工具。
   *
   * `injectInbox` 缺省按「这台内核此刻是否 attach 了收件箱」；工具热刷新要沿用**该 body
   * 建成时**的判定（`entry.inboxState`），所以可以显式覆盖。
   */
  private buildSurface(
    member: Pick<MemberExecutionMember, 'id' | 'session_id'> & { team_id?: string },
    options: {
      mode?: MemberExecutionPermissionMode;
      /** 显式工具来源快照；缺省读父宿主当前工具面 */
      source?: readonly ToolDefinition[];
      injectInbox?: boolean;
    } = {},
  ): MemberSurfaceBuild {
    const mode = options.mode ?? this.effectivePermissionMode(member);
    const tools = this.selectTools(mode, options.source).map((tool) =>
      this.restrictPermissions(tool, member.id, mode),
    );
    const inboxTool =
      (options.injectInbox ?? this.inbox !== undefined)
        ? this.inboxTool(member.id, mode)
        : undefined;
    // 0.51：成员面贡献（插件申请端口后给这具 body 的工具）。与 inbox 工具同在
    // `selectTools` 交集之后追加 —— 只注册在成员身体、不是工作区能力，deny 模式也给。
    const contributed = this.contributionTools(
      member,
      new Set([
        ...tools.map((tool) => tool.name),
        ...(inboxTool === undefined ? [] : [inboxTool.name]),
      ]),
    );
    // inbox 工具只读本地队列，不是工作区能力：deny 模式也注册；顺序恒定在父宿主工具之后，
    // 与 spawn 注册进宿主、`--tools` / 卡片展示的顺序一致。贡献工具排在它后面（0.51 期 0
    // 的空壳贡献不产出工具，输出因此与 0.50 逐字相同）。
    return {
      mode,
      tools: [...tools, ...(inboxTool === undefined ? [] : [inboxTool]), ...contributed],
    };
  }

  /** 运行期注入的收件箱工具；内核没 attach 收件箱时没有这个工具。 */
  private inboxTool(
    memberId: string,
    mode: MemberExecutionPermissionMode,
  ): ToolDefinition | undefined {
    const inbox = this.inbox;
    if (inbox === undefined) return undefined;
    return this.restrictPermissions(createInboxTool({ inbox, agentId: memberId }), memberId, mode);
  }

  /** 本内核能拿到的成员面贡献。老宿主 / 纯内存构造没实现这两个可选方法 ⇒ 空数组。 */
  private memberBodyContributions(): readonly MemberBodyContribution[] {
    return this.pluginHost?.getMemberBodyContributions?.() ?? [];
  }

  /**
   * 一具 body 由成员面贡献产出的工具（纯函数，可重复调用）。
   *
   * 这里给的端口是**推导值**：`isActive()` 恒 true、`publish` 是 noop。理由：`tools()` 的
   * 契约是纯函数，不该看 rotate 开关、也不该发事件；推导路径（`tools.list{agent_id}` 没有
   * 活身体时、工具热刷新）就在这类调用里。真 body 的端口在 spawn 里另建一次（只有 hooks 用它）。
   *
   * @param taken 已经占用的工具名（父宿主 + inbox 注入的）：同名冲突以既有定义为谁，
   *   贡献顶不掉宿主工具，也不能让 `registerTool` 在 spawn 时抛错把整具 body 建失败
   */
  private contributionTools(
    member: { id: string; session_id: string },
    taken: ReadonlySet<string>,
  ): ToolDefinition[] {
    const contributed: ToolDefinition[] = [];
    const used = new Set(taken);
    for (const contribution of this.memberBodyContributions()) {
      const port = this.memberBodyPort(contribution, member, DERIVED_BODY);
      if (port === undefined) continue;
      for (const tool of contribution.tools(port)) {
        if (used.has(tool.name)) continue;
        used.add(tool.name);
        contributed.push(tool);
      }
    }
    return contributed;
  }

  /**
   * 一具 body 的端口载体（含端口表）。
   *
   * 端口表缺任何一项 ⇒ 返回 undefined，这条贡献在这具 body 上**整条不生效**（fail-closed）。
   * 典型来源：内核没 attach 收件箱（未配置 dataDir），端口无从谈起 —— 给它一个方法全抛错的
   * 壳只会把「没有这个能力」变成更晚、更难查的运行期惊喜。
   */
  private memberBodyPort(
    contribution: MemberBodyContribution,
    member: { id: string; session_id: string },
    body: { isActive: () => boolean; publish: (event: MemberBodyNoticeEvent) => void },
  ): MemberBodyPort | undefined {
    const ports = buildMemberBodyPorts({
      requested: contribution.ports,
      inbox: this.inbox,
      agentId: member.id,
      sessionId: member.session_id,
    });
    if (ports === undefined) return undefined;
    return {
      pluginId: contribution.name,
      agentId: member.id,
      sessionId: member.session_id,
      ports,
      isActive: body.isActive,
      publish: body.publish,
    };
  }

  /**
   * spawn 里一次性登记成员面贡献的 hook。
   *
   * 与 `contributionTools` 分开的**唯一**原因：`hooks()` 一具 body 只许调一次（它内部持有
   * per-body 状态）。若让它也在推导路径跑，rotate 期间就会多出一批不该存在的 hook。
   */
  private registerContributionHooks(
    bodyHost: MemoryPluginHost,
    member: MemberExecutionMember,
    inboxState: { enabled: boolean } | undefined,
    events: MemoryEventStream,
  ): void {
    for (const contribution of this.memberBodyContributions()) {
      const port = this.memberBodyPort(contribution, member, {
        // 与 0.32 的 `disableInbox` 一一对应：rotate / retire 后旧 body 的 `enabled` 翻 false。
        // 没 attach 收件箱时没有这层开关，恒 true（这具 body 就是它身份的唯一持有者）。
        isActive: () => inboxState?.enabled ?? true,
        // notice 必须写进**这具 body** 的事件流：写父流会让 rotate 期间新旧 body 的提示串台。
        publish: (event) => events.publish(event),
      });
      if (port === undefined) continue;
      for (const hook of contribution.hooks?.(port) ?? []) bodyHost.registerHook(hook);
    }
  }

  /**
   * 把目标工具面替换进 body 自己的宿主。
   *
   * `MemoryPluginHost.registerTool` 对同名重复注册抛错，因此先清空旧工具再注册新集合；
   * 失败时尽量恢复旧定义（best-effort），不让 body 停在半空状态。返回是否成功。
   */
  private applyToolsToEntry(
    entry: MemberExecutionEntry,
    source: readonly ToolDefinition[],
  ): boolean {
    const previous = entry.pluginHost.listTools();
    // 与 spawn 同一套判定（`buildSurface`）；只有「来源快照 / 该 body 的 mode /
    // 它建成时是否已 attach 收件箱」这三项按 entry 走。
    const surface = this.buildSurface(
      { id: entry.memberId, session_id: entry.sessionId },
      {
        mode: entry.mode,
        source,
        injectInbox: this.inbox !== undefined && entry.inboxState !== undefined,
      },
    );
    const tools = surface.tools;
    try {
      for (const existing of previous) entry.pluginHost.unregisterTool(existing.name);
      for (const tool of tools) entry.pluginHost.registerTool(tool);
      return true;
    } catch (error) {
      try {
        for (const tool of entry.pluginHost.listTools()) {
          entry.pluginHost.unregisterTool(tool.name);
        }
        for (const tool of previous) entry.pluginHost.registerTool(tool);
      } catch {
        // 回滚是 best-effort：不掩盖原始错误
      }
      this.logger.warn('agent.member.tools_refresh_failed', {
        member_id: entry.memberId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * 0.28 D6：角色转换后把上下文策略热应用到该成员的**活体**（契约 §5 / R4）。
   *
   * 两件事一起换，body 不重建、历史不动 —— 「转正那天同一具活着的 body
   * 不必重建，但下一次 run 的上下文策略按新身份生效」：
   * - 自动压缩开关（entry 上的可变 `contextPolicy`，per-Run 工厂读取）；
   * - 80%–90% 压力提示的尾句文案（core `ExecutionUnit.applyContextPolicy`）。
   *
   * 返回实际应用的 body 数。未 spawn（没有活体）时返回 0：那种情况下策略由
   * 下一次 `spawn` 的 `contextPolicyFor(role)` 生效，两条路径共用同一份映射。
   */
  applyContextPolicy(member: MemberExecutionMember): number {
    const policy = contextPolicyFor(member.role);
    let applied = 0;
    for (const [sessionId, entry] of this.entries) {
      if (entry.memberId !== member.id) continue;
      try {
        let touched = entry.contextPolicy.autoCompact !== policy.autoCompact;
        entry.contextPolicy.autoCompact = policy.autoCompact;
        if (typeof entry.runtime.applyContextPolicy === 'function') {
          entry.runtime.applyContextPolicy({ contextPressureHint: policy.pressureHint });
          touched = true;
        }
        if (touched) applied += 1;
      } catch (error) {
        // 单个 ExecutionUnit 失败不影响其它 ExecutionUnit；装配层按数量判定。
        this.logger.warn('agent.member.context_policy_apply_failed', {
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return applied;
  }

  /**
   * 0.52：基础信息变更的真值同步（**不**重建 body、**不**碰 Self Card）。
   *
   * `member` 是变更后的完整身份（`AgentService` 从 registry 记录现算）。这里只把它写进该
   * body 的真值盒：下一轮 BeforeLlm 由 `self-card-delta` hook 与「模型相信的值」diff，变了
   * 就注入一条环境信息，没变就什么都不发（同一变更因此只报一次）。
   *
   * 返回命中的 body 数（与 `applyContextPolicy` 同口径）。0 = 没有活体：此时下一次 spawn
   * 直接用新记录建卡，本来就不需要告知。
   */
  noteSelfCardIdentity(member: MemberExecutionMember): number {
    const entry = this.entries.get(member.session_id);
    if (entry === undefined || entry.memberId !== member.id) return 0;
    entry.selfCardIdentity.member = member;
    return 1;
  }

  /**
   * 权限 bridge：成员请求 → 父流（补成员归属字段）；父级应答 → 成员流。
   * 只回灌本成员挂起过的 requestId，父流上的其它应答不会串台。
   */
  private attachBridge(member: MemberExecutionMember, entry: MemberExecutionEntry): void {
    const parentEvents = this.parentEvents;
    if (!parentEvents) return;

    entry.unsubscribers.push(
      entry.events.subscribe((event: RunEvent) => {
        if (!PERMISSION_REQUEST_EVENTS.has(event.type)) return;
        if (this.entries.get(member.session_id) !== entry) return;

        const kind = event.type === 'ask.user.requested' ? 'ask' : 'permission';
        const requestId = readRequestId(event.data);
        if (requestId !== undefined) entry.pendingPermissions.set(requestId, { kind });
        if (!entry.waiting) {
          entry.waiting = true;
          this.notifyPermissionState(member.id, member.session_id, 'waiting');
        }
        const data = bridgeRequestData(event, member);
        const forwarded: RunEvent = { ...event, data };
        parentEvents.publish(forwarded);
        if (requestId !== undefined) {
          this.scheduleDenyAfter(member, entry, requestId, kind, forwarded);
        }
      }),
    );

    entry.unsubscribers.push(
      parentEvents.subscribe((event: RunEvent) => {
        if (!PERMISSION_RESPONSE_EVENTS.has(event.type)) return;
        if (this.entries.get(member.session_id) !== entry) return;

        const requestId = readRequestId(event.data);
        if (requestId === undefined) return;
        const pending = entry.pendingPermissions.get(requestId);
        if (pending === undefined) return;

        // only-human：缺 answered_by 视为 legacy human；policy 只接受 deny_after。
        const data = isRecord(event.data) ? event.data : {};
        const answeredBy = data.answered_by;
        if (
          answeredBy !== undefined &&
          answeredBy !== 'human' &&
          !(answeredBy === 'policy' && data.policy === 'deny_after')
        ) {
          this.logger.warn('agent.member.permission_response_dropped', {
            member_id: member.id,
            session_id: member.session_id,
            request_id: requestId,
            answered_by: answeredBy,
            policy: data.policy,
          });
          return;
        }

        entry.pendingPermissions.delete(requestId);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        // 原样交给成员事件流，由 core 按 requestId 路由回发起请求的 waitFor。
        entry.events.publish(event);
        this.noteBridgeSettled(member, entry);
      }),
    );
  }

  /**
   * 非空 team_id 的成员把全局 allow 提升为 bridge；显式 deny 保持只读工具，
   * 不因 Team 绑定放宽。缺 parentEvents 时仍由 ask → deny 收口。
   *
   * 只读 `team_id`：`tools.list{agent_id}` 的推导路径只有一份成员视图，不必拼整条
   * `MemberExecutionMember`（推导不 spawn，用不到 session / binding）。
   */
  private effectivePermissionMode(member: { team_id?: string }): MemberExecutionPermissionMode {
    if (
      this.forceBridgeForTeams &&
      this.permissionMode === 'allow' &&
      typeof member.team_id === 'string' &&
      member.team_id.length > 0
    ) {
      return 'bridge';
    }
    return this.permissionMode;
  }

  private clearPending(entry: MemberExecutionEntry): void {
    for (const pending of entry.pendingPermissions.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
    }
    entry.pendingPermissions.clear();
  }

  private noteBridgeSettled(member: MemberExecutionMember, entry: MemberExecutionEntry): void {
    if (entry.pendingPermissions.size === 0 && entry.waiting) {
      entry.waiting = false;
      this.notifyPermissionState(member.id, member.session_id, 'running');
    }
  }

  /**
   * team 显式 deny-after 的单次 deadline；hold / 缺失 / 非法秒数都不建定时器。
   * 到期后把 normal response 同时交给成员流（解除等待）与父流（供父入口观测）。
   */
  private scheduleDenyAfter(
    member: MemberExecutionMember,
    entry: MemberExecutionEntry,
    requestId: string,
    kind: 'permission' | 'ask',
    forwarded: RunEvent,
  ): void {
    // 定时器只能由 bridge 创建；没有父流就没有人端，走既有的 ask → deny。
    if (this.parentEvents === undefined) return;
    const policy = this.permissionPolicy?.(member.team_id);
    if (policy?.unattended !== 'deny-after') return;
    const seconds = policy.denyAfterSeconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return;

    const timer = setTimeout(
      () => {
        if (this.entries.get(member.session_id) !== entry) return;
        const pending = entry.pendingPermissions.get(requestId);
        if (pending === undefined || pending.kind !== kind) return;
        entry.pendingPermissions.delete(requestId);
        const data = isRecord(forwarded.data) ? forwarded.data : {};
        const sessionId =
          typeof data.session_id === 'string' && data.session_id.length > 0
            ? data.session_id
            : undefined;
        const responseData =
          kind === 'ask'
            ? {
                requestId,
                answers: [],
                ...(sessionId !== undefined ? { session_id: sessionId } : {}),
                answered_by: 'policy',
                answered_via: 'policy',
                policy: 'deny_after',
              }
            : {
                requestId,
                decision: 'deny',
                scope: 'once',
                ...(sessionId !== undefined ? { session_id: sessionId } : {}),
                answered_by: 'policy',
                answered_via: 'policy',
                policy: 'deny_after',
                reason: 'deny_after',
              };
        const response: RunEvent = {
          type: kind === 'ask' ? 'ask.user.answered' : 'tool.permission.response',
          run_id: forwarded.run_id,
          data: responseData,
          ts: Date.now(),
        };
        entry.events.publish(response);
        this.parentEvents?.publish(response);
        this.noteBridgeSettled(member, entry);
      },
      Math.round(seconds * 1000),
    );
    // 不能 unref：Bun 在只剩 unref 定时器的 await 上会直接退出/不触发 deadline。
    entry.pendingPermissions.set(requestId, { kind, timer });
  }

  private notifyPermissionState(
    memberId: string,
    sessionId: string,
    state: MemberPermissionState,
  ): void {
    try {
      this.onPermissionState?.(memberId, sessionId, state);
    } catch (error) {
      this.logger.warn('agent.member.permission_state_callback_failed', {
        member_id: memberId,
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 该身体能否把「等人类应答」的请求送到父事件流（只有 bridge 有这个订阅）。 */
  private bridgeAvailable(mode: MemberExecutionPermissionMode): boolean {
    return mode === 'bridge' && this.parentEvents !== undefined;
  }

  /**
   * 该工具在这具成员身体上是否被规则挡住（0.51 只剩两条真实闸）。
   *
   * 这是成员侧筛选规则的**唯一**实现：`selectTools` 只问它一个问题。判据顺序有语义 —
   * - `read`/`media`/`subscribe` 之外的 deny（只读）档：先判，所以 `ask` 在这一档的
   *   原因是「档位不给」（就算有 bridge，deny 也不会放它）；
   * - 需要父级转发人类应答的 `ask` / `ask_user`：只在真能 bridge 时才进面 —— 成员只会把
   *   请求发到自己的事件流，没人转发就没人应答，注册进来只会让 run 永久等待。
   */
  private toolBlocked(name: string, mode: MemberExecutionPermissionMode): boolean {
    if (mode === 'deny' && !this.readOnlyTools.has(name)) return true;
    return PARENT_ANSWERED_TOOL_NAMES.has(name) && !this.bridgeAvailable(mode);
  }

  /**
   * 从父宿主挑工具：**父宿主有什么就给什么**，只减上面那两条闸（0.51）。
   *
   * 0.51 起不再产出「谁被挡 / 为什么被挡」：那层解释只服务于「两个工具面」的展示，
   * 用户已裁定删掉。判据没有删 —— 它仍然决定这具身体能调什么。
   */
  private selectTools(
    mode: MemberExecutionPermissionMode,
    source: readonly ToolDefinition[] = this.pluginHost?.listTools() ?? [],
  ): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const tool of source) {
      if (this.toolBlocked(tool.name, mode)) continue;
      tools.push(tool.name === 'agent' ? restrictAgentTool(tool) : tool);
    }
    return tools;
  }

  /**
   * ask 在 bridge 可用时放行给 core（发请求事件 → 父级应答）；
   * bridge 关闭 / 缺失时按 deny 收口并记日志，避免 run 永久等待应答。
   * 工具没有 checkPermission 时用权限配置的 default（ask 同样按上述规则处理）。
   */
  private restrictPermissions(
    tool: ToolDefinition,
    memberId: string,
    mode: MemberExecutionPermissionMode,
  ): ToolDefinition {
    const check = tool.checkPermission;
    return {
      ...tool,
      checkPermission: async (input, ctx) => {
        const decision = check ? await check(input, ctx) : this.fallbackDecision(tool.name);
        if (decision !== 'ask') return decision;
        if (mode === 'bridge' && this.parentEvents !== undefined) return 'ask';
        this.logger.warn('agent.member.permission_ask_denied', {
          member_id: memberId,
          tool: tool.name,
        });
        return 'deny';
      },
    };
  }

  /** 无 checkPermission 的工具：autoApprove 放行，default=ask 因无 bridge 转为 deny */
  private fallbackDecision(toolName: string): 'allow' | 'deny' {
    if (this.permission?.autoApprove?.includes(toolName)) return 'allow';
    return this.permission?.default === 'ask' ? 'deny' : 'allow';
  }

  /**
   * `how to ask for help` 文案。
   *
   * 判据只有一个：`ask` 是否真的在成员工具面里（即父宿主注册了 + bridge 可用）。
   * 没有它时给异步路径：`agent` 工具的 `action=send` 发到本机人类。
   * 异步路径要同时成立才写：成员能调 `agent`（deny 档只留只读工具，没有 `agent`）；成员有
   * Team（地址路要求 caller.team_id 来补 team 段）。否则只是把阻塞写进最终文本。
   */
  private askHelpText(toolNames: readonly string[], teamId: string | undefined): string {
    // 双认工具名：新名 `ask`，旧名 `ask_user`（0.52 前注册的成员工具面仍可能带旧名）。
    if (toolNames.includes('ask') || toolNames.includes('ask_user')) {
      return 'Use the ask tool to request human input.';
    }
    if (toolNames.includes('agent') && typeof teamId === 'string' && teamId.length > 0) {
      return (
        'No human is watching this run, so ask is unavailable. To reach a human, ' +
        'call the agent tool with action=send and to="human", then end your turn ' +
        'with the blocker in your final text.'
      );
    }
    return 'This is a non-interactive run; state blockers in your final text.';
  }

  /**
   * 解析本具 body 的 cwd（0.51 Bug 1）。
   *
   * 顺序：记录快照（`member.cwd`，create 时烧进去的显式 Team 基础路径）> 装配层的
   * `cwdFor`（按 `team_id` 重查 Team）。两级都不可用 → 返回 `undefined`，工具退回
   * `agent.cwd` / `process.cwd()`。
   *
   * 为什么在这里做 fs 校验并 warn：这是**唯一**知道「这个值是从哪一级来的」的地方，
   * 也是第一个有 logger 的地方。工具侧还会再判一次（目录可能在 body 活着的过程中消失），
   * 那次只能静默降级 —— 所以「降级发生过」这件事只能在这里说清楚。
   */
  private memberCwdFor(member: MemberExecutionMember): string | undefined {
    const teamCwd = member.cwd === undefined ? this.cwdFor?.(member) : undefined;
    const picked = resolveMemberCwd({
      ...(member.cwd !== undefined ? { recordCwd: member.cwd } : {}),
      ...(teamCwd !== undefined ? { teamCwd } : {}),
    });
    if (picked.cwd !== undefined) return picked.cwd;
    if (picked.degraded === 'not_a_directory') {
      this.logger.warn('agent.member.cwd_degraded', {
        member_id: member.id,
        session_id: member.session_id,
        ...(member.team_id !== undefined ? { team_id: member.team_id } : {}),
        rejected: picked.rejected,
        fallback: 'agent.cwd / process.cwd()',
      });
    }
    return undefined;
  }

  private buildSelfCard(
    member: MemberExecutionMember,
    model: string,
    tools: readonly ToolDefinition[],
  ): SelfCardOptions {
    const toolNames = tools.map((tool) => tool.name);
    const teamId =
      typeof member.team_id === 'string' && member.team_id.length > 0 ? member.team_id : undefined;
    return {
      role: member.name ?? 'member',
      ...(member.parent_id !== undefined ? { parent_id: member.parent_id } : {}),
      // 只有绑定 Team 的成员才带该字段；unbound 不伪造。
      ...(teamId !== undefined ? { team_id: teamId } : {}),
      depth: this.depth,
      model,
      tools: toolNames,
      limits: {
        ...this.limits,
        ...(this.termination.maxIterations !== undefined
          ? { maxIterations: this.termination.maxIterations }
          : {}),
        ...(this.termination.maxRuntimeSeconds !== undefined
          ? { maxRuntimeSeconds: this.termination.maxRuntimeSeconds }
          : {}),
      },
      context: { max: this.contextMaxTokens },
      how_to_ask: this.askHelpText(toolNames, teamId),
    };
  }

  private requireEntry(member: MemberExecutionMember): MemberExecutionEntry {
    const entry = this.entries.get(member.session_id);
    if (!entry) throw new Error(`member runtime not spawned: ${member.session_id}`);
    return entry;
  }
}

/** 工厂：入口层只依赖 MemberExecutionPort */
export function createMemberExecutionHost(
  options: MemberExecutionHostOptions,
): MemberExecutionPort {
  return new MemberExecutionHost(options);
}
