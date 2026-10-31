/**
 * 进程内成员执行内核适配（MemberRuntimePort）。
 *
 * 每个成员独占一个 AgentRuntime / Context / EventStream；工具从父 PluginHost
 * 按白名单复制，hooks / guardrails 一并继承。`permissionMode: 'bridge'` 时
 * 成员的权限/提问请求转发到 `parentEvents`，父级应答原样回灌成员事件流；
 * 没有 `parentEvents` 时退化为 ask → deny（A3a 行为），避免 run 永久等待。
 *
 * @module @vessel-agent/agent
 */

import { randomUUID } from 'node:crypto';
import type { TeamPermissionPolicy } from '@vessel-agent/config';
import {
  AgentRuntime,
  type AgentRuntimeOptions,
  type ContextManager,
  type EventStream,
  type LLMProvider,
  type Logger,
  MemoryContextManager,
  MemoryEventStream,
  MemoryPluginHost,
  type Message,
  noopLogger,
  type PluginHost,
  type RunEvent,
  type RunInterruptReason,
  type RunnableAgent,
  type RunOptions,
  type RuntimePermissionConfig,
  type SelfCardOptions,
  type TerminationPolicy,
  type ToolDefinition,
  type Usage,
  type UsageLimits,
} from '@vessel-agent/core';
import { HUMAN_PRINCIPAL, SYSTEM_PRINCIPAL } from './team-address.js';
import type {
  AgentMessage,
  AgentRole,
  MemberPermissionState,
  MemberRuntimeMember,
  MemberRuntimePort,
  MemberTurnResult,
} from './types.js';

/**
 * 成员默认工具白名单（agent 支持成员换 Body）。
 *
 * 工具面共有 **4 层闸门**，这里只是「成员选择」这一层。改工具面前先看清改的是哪层：
 *   1. 本文件 —— 成员能从父宿主挑哪些（默认 `bash`/`read`/`edit`/`agent`）
 *   2. `packages/config/src/tenant-tools.ts` —— tenant 级 allow/deny（**注册侧**）
 *   3. `packages/core/src/runtime/permission-policy.ts` —— 单次调用放行（allow/ask/deny）
 *   4. `src/permission-store.ts` —— `autoApprove` / `neverAutoApprove`（是否跳过审批）
 *
 * 给成员加工具时 **本文件与 #2 都要过**：只改 #2 会让能力静默消失（`ask_user` 就是这样
 * 丢过一次 —— 注册侧加了、选择侧不认，且不报错）。详见 `docs/lessons/L-011`。
 */
const DEFAULT_ALLOWED_TOOLS = ['bash', 'read', 'edit', 'agent'] as const;

/** deny 模式保留的只读工具（与 delegate 语义一致） */
const DEFAULT_READ_ONLY_TOOLS = ['read'] as const;

/** 成员永远拿不到的工具：team 工具、递归分派 */
const EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set(['delegate_task']);

/**
 * 需要父级（有人类应答者）转发才能收口的工具。
 *
 * 这些工具通过事件流发布请求并等待应答；成员 Body 只有 bridge 才能把请求送到
 * 父事件流。没有 bridge / 父流时注册进来只会让 run 永久等待，因此不放行。
 */
const PARENT_ANSWERED_TOOL_NAMES: ReadonlySet<string> = new Set(['ask_user']);

/** 缺省终止策略（与 delegate 子 agent 一致） */
const DEFAULT_TERMINATION: TerminationPolicy = { maxIterations: 10, maxRuntimeSeconds: 60 };

/** 缺省上下文预算 */
const DEFAULT_CONTEXT_MAX_TOKENS = 1_000_000;

/**
 * 成员 Body 恒定免确认的工具：`agent` 工具只允许成员操作自己（rotate）/ 可见 roster
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
 * temporary 成员的主动压缩阈值（0.28 D6/D7）。
 *
 * core 的 `MemoryContextManager` 把阈值默认成 0.9 且不可见，而角色策略层在这里
 * **不改 core** 的前提下需要自己判断「这次要不要主动压缩」，所以这一个数字被复制。
 * 代价是与 core 有漂移风险；缓解：core 一旦暴露 `compactThreshold` getter，本常量
 * 直接删掉改读 getter（`R4.compact` 探针把两边算出的判定放在一起对比，漂移会被它看见）。
 */
const ROLE_COMPACT_THRESHOLD = 0.9;

/**
 * 按角色包装 per-body `ContextManager`：**自动压缩开关可在活体上热切换**。
 *
 * 为什么不是 spawn 时直接把 `autoCompact` 交给 core（0.28 之前的做法）：那是构造期
 * 配置，没有 setter。转正（`temporary → member`）要求「同一具 live body 不重建，
 * 但下一次 run 按新身份生效」，于是开关必须能在活体上翻转（契约 §5 / D6）。
 *
 * 分层不变：本类只接收**裸参数**（一个布尔），不认 `role`；角色语义仍留在本文件的
 * spawn（`role === 'temporary'`）与 `applyContextPolicy`。本类只使用 `ContextManager`
 * 接口上已有的方法，core 不知道这里存在。
 *
 * 内层 `MemoryContextManager` 恒以 `autoCompact: false` 构造，原因有两条：
 * - 真要把开关交给本类，内层就不能自己按阈值压缩（否则 `add()` 会绕过本类的开关，
 *   也就是 temporary 会在 `add()` 里被压缩 —— 正是契约禁止的）；
 * - 内层仍负责**硬兜底**：消息条数上限的摘要与移除在 `add()` 里独立于 `autoCompact`。
 *
 * 因此压缩时机从「`add()` 时」挪到「请求组装前」，这是本包装唯一的可观测差异：
 * 同一轮内水位到阈值时，压缩发生在下一次请求之前而不是写入那一刻。结果一致，
 * 且这正是 core 在有 summarizer 时走的既有路径。
 */
class RoleAwareContext implements ContextManager {
  /** 自动压缩是否开启；`setAutoCompact` 是唯一的写入口。 */
  private compacting: boolean;

  constructor(
    private readonly inner: MemoryContextManager,
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
      if (this.inner.tokenCount <= max * ROLE_COMPACT_THRESHOLD) return 0;
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
export type MemberRuntimePermissionMode = 'allow' | 'deny' | 'bridge';

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

/** 成员 runtime 额外需要的中断能力（AgentRuntime 已实现） */
export interface MemberRunnableAgent extends RunnableAgent {
  interrupt?(reason?: RunInterruptReason): void;
  /** 只追加上下文，不启动 turn（AgentRuntime 已实现） */
  appendNotice?(text: string): void;
  /**
   * 0.28（additive）：热应用上下文策略，下一轮请求生效（`AgentRuntime` 已实现）。
   * 只用于压力提示尾句；自动压缩开关由 `RoleAwareContext` 承担。
   */
  applyContextPolicy?(policy: { contextPressureHint?: string }): void;
}

/** 进程内成员 runtime 选项 */
export interface InProcessMemberRuntimeOptions {
  /** 每个成员一个 provider 实例 */
  providerFactory: () => LLMProvider;
  /** 成员未指定 model 时的默认模型；两者都缺省时 spawn 失败 */
  model?: string;
  /** 工具 / hooks / guardrails 的来源（父宿主）；缺省时成员没有工具 */
  pluginHost?: PluginHost;
  /** 在默认 bash/read/edit 之外显式追加的工具名 */
  extraTools?: readonly string[];
  /** deny 模式保留的只读工具（默认 ['read']） */
  readOnlyTools?: readonly string[];
  /** 缺省 allow；deny 只保留只读工具；bridge 需配合 parentEvents */
  permissionMode?: MemberRuntimePermissionMode;
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
  /** tenant SessionBackend；同 session_id 可跨进程续接历史 */
  session?: AgentRuntimeOptions['session'];
  /** tenant 会话事件日志（唯一真相源；存在时成员事件同样落盘） */
  eventLog?: AgentRuntimeOptions['eventLog'];
  /** 0.27：每 body 的 durable checkpoint 存储；透传给每个 AgentRuntime */
  runStore?: AgentRuntimeOptions['runStore'];
  /** 覆盖 runtime 构造（测试捕获 options） */
  runtimeFactory?: (options: AgentRuntimeOptions) => Promise<MemberRunnableAgent>;
}

interface MemberRuntimeEntry {
  runtime: MemberRunnableAgent;
  /** 成员 id（entries 按 Body session 建键，notice 按成员 id 寻址） */
  memberId: string;
  /** per-body 上下文包装：`applyContextPolicy` 靠它在活体上翻转开关 */
  context: RoleAwareContext;
  /**
   * body 独占工具宿主（spawn 时快照）。`refreshTools` 原地替换其中的定义，
   * 不动 runtime / session / context / provider，下一轮请求即读到新工具面。
   */
  pluginHost: MemoryPluginHost;
  /** spawn 时选定的权限模式；refreshTools 用它重新筛工具 */
  mode: MemberRuntimePermissionMode;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** core 的交互事件用 camelCase requestId；应答按它匹配 */
function readRequestId(data: unknown): string | undefined {
  return isRecord(data) && typeof data.requestId === 'string' ? data.requestId : undefined;
}

/** 转发到父流前补齐成员归属字段；已有字段不覆盖 */
function bridgeRequestData(event: RunEvent, member: MemberRuntimeMember): Record<string, unknown> {
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
  if (typeof data.parent_session_id !== 'string' && member.parent_id !== undefined) {
    data.parent_session_id = member.parent_id;
  }
  if (data.delegate_path === undefined) {
    data.delegate_path =
      member.parent_id !== undefined ? [member.parent_id, member.id] : [member.id];
  }
  if (typeof data.tool !== 'string' && event.type === 'ask.user.requested') {
    data.tool = 'ask_user';
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
function withMemberIdentity(event: RunEvent, member: MemberRuntimeMember): RunEvent {
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
 * `InProcessMemberRuntimeOptions.nodeId`），不在这里解析。让模型只学一种地址形态，
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

/** 成员不可见的工具 */
function isExcludedTool(name: string): boolean {
  return EXCLUDED_TOOL_NAMES.has(name) || name.startsWith('team_');
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
];

/** 成员侧 agent 工具的可见参数；父级 schema 有同名字段时沿用父级定义 */
const MEMBER_AGENT_PROPERTIES: Readonly<Record<string, Record<string, unknown>>> = {
  action: {
    type: 'string',
    enum: [...MEMBER_AGENT_ACTIONS],
    description: 'create | hire | close | rotate | post | send | list',
  },
  name: { type: 'string', description: 'create/hire: display name' },
  model: { type: 'string', description: 'create/hire: model override' },
  system_prompt: { type: 'string', description: 'create/hire: optional system prompt' },
  to: {
    type: 'string',
    description:
      'send: target agent; use the location value from the source line as-is, or a member id',
  },
  content: { type: 'string', description: 'send/post: message text' },
  messages: { type: 'array', description: 'send: [{to, content}]' },
  members: {
    type: 'array',
    description:
      'create/hire: [{name?, model?, system_prompt?, visibility?}]; ' +
      'close: [member id or session id]',
  },
  startup_prompt: {
    type: 'string',
    description: 'rotate: required first message for the new body',
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
    description:
      'Member actions: create (create peer member(s) in your team), ' +
      'hire (create contractor member(s) owned by you), ' +
      'close (release member(s); closing a peer requires human approval, while closing ' +
      'your own contractor or yourself needs no approval), ' +
      'rotate (rotate your own body; startup_prompt is required), ' +
      'post (append to your team log only; nobody is notified), ' +
      'send (dispatch a message to a member), list (list the caller-visible roster).',
    inputSchema: {
      ...schema,
      properties,
      required: ['action'],
    },
  };
}

/** 进程内成员执行内核 */
export class InProcessMemberRuntime implements MemberRuntimePort {
  private readonly providerFactory: () => LLMProvider;
  private readonly model?: string;
  private readonly pluginHost?: PluginHost;
  private readonly allowedTools: ReadonlySet<string>;
  private readonly readOnlyTools: ReadonlySet<string>;
  private readonly permissionMode: MemberRuntimePermissionMode;
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
  private readonly depth: number;
  private readonly logger: Logger;
  private readonly tenantId?: string;
  private readonly nodeId?: string;
  private readonly includeReasoning?: boolean;
  private readonly session?: AgentRuntimeOptions['session'];
  private readonly eventLog?: AgentRuntimeOptions['eventLog'];
  private readonly runStore?: AgentRuntimeOptions['runStore'];
  private readonly runtimeFactory: (options: AgentRuntimeOptions) => Promise<MemberRunnableAgent>;
  private readonly entries = new Map<string, MemberRuntimeEntry>();
  /** 未 spawn / 未开跑成员的待注入 notice（member id → 有界文本队列） */
  private readonly pendingNotices = new Map<string, string[]>();

  constructor(options: InProcessMemberRuntimeOptions) {
    this.providerFactory = options.providerFactory;
    this.model = options.model;
    this.pluginHost = options.pluginHost;
    this.allowedTools = new Set([...DEFAULT_ALLOWED_TOOLS, ...(options.extraTools ?? [])]);
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
    this.depth = options.depth ?? 1;
    this.logger = options.logger ?? noopLogger;
    this.tenantId = options.tenantId;
    this.nodeId = options.nodeId;
    this.includeReasoning = options.includeReasoning;
    this.session = options.session;
    this.eventLog = options.eventLog;
    this.runStore = options.runStore;
    this.runtimeFactory =
      options.runtimeFactory ?? ((runtimeOptions) => AgentRuntime.create(runtimeOptions));
    if (this.permissionMode === 'bridge' && this.parentEvents === undefined) {
      this.logger.warn('agent.member.permission_bridge_unavailable', {
        fallback: 'ask_denied',
      });
    }
  }

  async spawn(member: MemberRuntimeMember): Promise<void> {
    if (this.entries.has(member.session_id)) {
      throw new Error(`member runtime already spawned: ${member.session_id}`);
    }
    const model = member.model ?? this.model;
    if (!model) {
      throw new Error(`member runtime model is required: ${member.id}`);
    }

    const mode = this.effectivePermissionMode(member);
    const tools = this.selectTools(mode).map((tool) =>
      this.restrictPermissions(tool, member.id, mode),
    );
    const pluginHost = new MemoryPluginHost();
    for (const hook of this.pluginHost?.getHooks() ?? []) pluginHost.registerHook(hook);
    for (const guardrail of this.pluginHost?.getGuardrails() ?? []) {
      pluginHost.registerGuardrail(guardrail);
    }
    for (const tool of tools) pluginHost.registerTool(tool);

    const selfCard = this.buildSelfCard(member, model, tools);
    const events = new MemoryEventStream();
    // 0.28 D6/D7：temporary 不主动压缩（一具 body 的生命周期由调用方的会话决定，
    // 压缩会把调用方还在看的历史摘要掉）；到线只提示。core 只收到裸参数，不认 role。
    // 两道硬兜底仍然生效：消息条数上限（`RoleAwareContext` 内层，与开关无关）
    // 与 provider overflow 的 forceCompact（runtime 内的 overflow 重试）。
    //
    // 开关放在 `RoleAwareContext` 而不是 core 的构造配置：转正后同一具 live body
    // 必须能翻转策略（契约 §5 / D6）。内层恒 `autoCompact: false`，由包装决定要不要
    // 主动压缩 —— 否则 `add()` 会绕过包装、在 temporary 上按阈值压缩。
    const policy = contextPolicyFor(member.role);
    const context = new RoleAwareContext(
      new MemoryContextManager({ maxTokens: this.contextMaxTokens, autoCompact: false }),
      policy.autoCompact,
    );
    const runtime = await this.runtimeFactory({
      provider: this.providerFactory(),
      model,
      context,
      events,
      pluginHost,
      limits: this.limits,
      termination: this.termination,
      // 与 owner 同源的权限规则：工具 checkPermission 返回 ask 时，core 仍按
      // autoApprove / neverAutoApprove 判定，否则 auto_approve 的 bash/edit 会在
      // 成员 Body 上重新弹卡片（热应用后新建的 Body 同样走这里）。
      permission: this.permission ?? { default: 'allow' },
      selfCard,
      agentId: member.id,
      ...(policy.pressureHint !== undefined ? { contextPressureHint: policy.pressureHint } : {}),
      logger: this.logger,
      ...(member.system_prompt !== undefined ? { systemPrompt: member.system_prompt } : {}),
      ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
      ...(this.includeReasoning !== undefined ? { includeReasoning: this.includeReasoning } : {}),
      ...(this.session !== undefined ? { session: this.session } : {}),
      ...(this.eventLog !== undefined ? { eventLog: this.eventLog } : {}),
      ...(this.runStore !== undefined ? { runStore: this.runStore } : {}),
    });
    const entry: MemberRuntimeEntry = {
      runtime,
      memberId: member.id,
      started: false,
      events,
      unsubscribers: [],
      pendingPermissions: new Map(),
      waiting: false,
      context,
      pluginHost,
      mode,
      running: false,
      toolsRefreshPending: false,
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
          const scoped: RunEvent =
            this.tenantId !== undefined && forwarded.tenant_id === undefined
              ? { ...forwarded, tenant_id: this.tenantId }
              : forwarded;
          parentEvents.publish(scoped);
        }),
      );
    }
  }

  async runTurn(
    member: MemberRuntimeMember,
    message: AgentMessage,
    scheduledRunId?: string,
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
    try {
      const content = await entry.runtime.run(message.content, member.session_id, {
        runId,
        messages: [...pendingNotices.map(noticeMessage), sourceMessage],
      });
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

  /**
   * 从 durable checkpoint 恢复（0.27）。checkpoint 的会话历史由 core 读取；
   * 这里只注入 pending notice / 调用方附加消息，并回连同 run 终态。
   */
  async resume(
    member: MemberRuntimeMember,
    runId: string,
    opts?: RunOptions,
  ): Promise<MemberTurnResult> {
    const entry = this.requireEntry(member);
    const resume = entry.runtime.resume?.bind(entry.runtime);
    if (resume === undefined) throw new Error('member runtime does not support resume');
    entry.started = true;
    entry.running = true;
    const pendingNotices = this.takePendingNotices(member.id);
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
    try {
      const content = await resume(runId, {
        ...opts,
        messages: [...pendingNotices.map(noticeMessage), ...(opts?.messages ?? [])],
      });
      return { content, outcome: 'completed', ...(usage !== undefined ? { usage } : {}) };
    } catch (error) {
      if (terminal === 'cancelled') return { outcome: 'cancelled' };
      throw error;
    } finally {
      unsubscribe();
      this.clearPending(entry);
      if (entry.waiting) {
        entry.waiting = false;
        this.notifyPermissionState(member.id, member.session_id, 'running');
      }
      this.finishRun(member, entry);
    }
  }

  cancel(member: MemberRuntimeMember): void {
    this.entries.get(member.session_id)?.runtime.interrupt?.('user');
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

  async dispose(member: MemberRuntimeMember): Promise<void> {
    const entry = this.entries.get(member.session_id);
    if (!entry) return;
    // 先移除，避免 dispose 期间 / 之后又有 runTurn 走进已释放的 runtime
    this.entries.delete(member.session_id);
    for (const unsubscribe of entry.unsubscribers) unsubscribe();
    entry.unsubscribers.length = 0;
    this.clearPending(entry);
    await entry.runtime.dispose();
  }

  /**
   * CONTRACT-hot-apply §4：把权限规则热应用到所有存活成员 Body。
   *
   * 规则整体替换（与 owner 侧同一语义）。这里只覆盖 core `PermissionPolicy` 的
   * 判定面；成员工具的 checkPermission 包装（`restrictPermissions`）把 ask 折回
   * bridge / deny，属于装配期决定，热应用不改它。
   * `members` 有记录但尚未 spawn 出 Body 时没有可应用的 runtime，跳过并计入未应用。
   */
  applyPermissionRules(rules: RuntimePermissionConfig): number {
    // 热应用来自 owner 同源配置；补回成员自有的 `agent` 免确认后同时供存活的
    // Body 与之后新建的 Body（spawn）使用。
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
        // 单个 Body 失败不影响其它 Body；装配层按数量判定是否全部生效。
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

  /** 轮结束：清 running；若期间收到过工具刷新，在轮边界应用。 */
  private finishRun(member: MemberRuntimeMember, entry: MemberRuntimeEntry): void {
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
   * 把目标工具面替换进 body 自己的宿主。
   *
   * `MemoryPluginHost.registerTool` 对同名重复注册抛错，因此先清空旧工具再注册新集合；
   * 失败时尽量恢复旧定义（best-effort），不让 body 停在半空状态。返回是否成功。
   */
  private applyToolsToEntry(entry: MemberRuntimeEntry, source: readonly ToolDefinition[]): boolean {
    const previous = entry.pluginHost.listTools();
    const tools = this.selectTools(entry.mode, source).map((tool) =>
      this.restrictPermissions(tool, entry.memberId, entry.mode),
    );
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
   * - 自动压缩开关（`RoleAwareContext`）；
   * - 80%–90% 压力提示的尾句文案（core `AgentRuntime.applyContextPolicy`）。
   *
   * 返回实际应用的 body 数。未 spawn（没有活体）时返回 0：那种情况下策略由
   * 下一次 `spawn` 的 `contextPolicyFor(role)` 生效，两条路径共用同一份映射。
   */
  applyContextPolicy(member: MemberRuntimeMember): number {
    const policy = contextPolicyFor(member.role);
    let applied = 0;
    for (const [sessionId, entry] of this.entries) {
      if (entry.memberId !== member.id) continue;
      try {
        let touched = entry.context.setAutoCompact(policy.autoCompact);
        if (typeof entry.runtime.applyContextPolicy === 'function') {
          entry.runtime.applyContextPolicy({ contextPressureHint: policy.pressureHint });
          touched = true;
        }
        if (touched) applied += 1;
      } catch (error) {
        // 单个 Body 失败不影响其它 Body；装配层按数量判定。
        this.logger.warn('agent.member.context_policy_apply_failed', {
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return applied;
  }

  /**
   * 权限 bridge：成员请求 → 父流（补成员归属字段）；父级应答 → 成员流。
   * 只回灌本成员挂起过的 requestId，父流上的其它应答不会串台。
   */
  private attachBridge(member: MemberRuntimeMember, entry: MemberRuntimeEntry): void {
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
        const forwarded: RunEvent = {
          ...event,
          data,
          ...(this.tenantId !== undefined && event.tenant_id === undefined
            ? { tenant_id: this.tenantId }
            : {}),
        };
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
   */
  private effectivePermissionMode(member: MemberRuntimeMember): MemberRuntimePermissionMode {
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

  private clearPending(entry: MemberRuntimeEntry): void {
    for (const pending of entry.pendingPermissions.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
    }
    entry.pendingPermissions.clear();
  }

  private noteBridgeSettled(member: MemberRuntimeMember, entry: MemberRuntimeEntry): void {
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
    member: MemberRuntimeMember,
    entry: MemberRuntimeEntry,
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
        const tenantId = forwarded.tenant_id ?? this.tenantId;
        const response: RunEvent = {
          type: kind === 'ask' ? 'ask.user.answered' : 'tool.permission.response',
          run_id: forwarded.run_id,
          data: responseData,
          ts: Date.now(),
          ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
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

  /**
   * 按模式与白名单从父宿主挑工具。
   *
   * `ask_user` 这类需要人类应答的工具额外要求 bridge：成员只会把请求发到自己的
   * 事件流，没有 bridge 就没人转发、也没人应答，注册进来只会让 run 永久等待。
   * 因此“父宿主注册了它”只是必要条件，真正的判据是本函数的结果（Self Card
   * 的 `how to ask` 也从这里推导，不读入口层的 headless / ui 标志）。
   */
  private selectTools(
    mode: MemberRuntimePermissionMode,
    source: readonly ToolDefinition[] = this.pluginHost?.listTools() ?? [],
  ): ToolDefinition[] {
    const denyFilter = mode === 'deny';
    const bridgeAvailable = mode === 'bridge' && this.parentEvents !== undefined;
    const selected: ToolDefinition[] = [];
    for (const tool of source) {
      if (isExcludedTool(tool.name)) continue;
      if (denyFilter) {
        if (!this.readOnlyTools.has(tool.name)) continue;
      } else if (!this.allowedTools.has(tool.name)) {
        continue;
      }
      if (PARENT_ANSWERED_TOOL_NAMES.has(tool.name) && !bridgeAvailable) continue;
      selected.push(tool.name === 'agent' ? restrictAgentTool(tool) : tool);
    }
    return selected;
  }

  /**
   * ask 在 bridge 可用时放行给 core（发请求事件 → 父级应答）；
   * bridge 关闭 / 缺失时按 deny 收口并记日志，避免 run 永久等待应答。
   * 工具没有 checkPermission 时用权限配置的 default（ask 同样按上述规则处理）。
   */
  private restrictPermissions(
    tool: ToolDefinition,
    memberId: string,
    mode: MemberRuntimePermissionMode,
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
   * 判据只有一个：`ask_user` 是否真的在成员工具面里（即父宿主注册了 + bridge 可用）。
   * 没有它时给异步路径：`agent` 工具的 `action=send` 发到本机人类。
   * 异步路径要同时成立才写：成员能调 `agent`（deny 模式只有 read 工具）；成员有
   * Team（地址路要求 caller.team_id 来补 team 段）。否则只是把阻塞写进最终文本。
   */
  private askHelpText(toolNames: readonly string[], teamId: string | undefined): string {
    if (toolNames.includes('ask_user')) return 'Use the ask_user tool to request human input.';
    if (toolNames.includes('agent') && typeof teamId === 'string' && teamId.length > 0) {
      return (
        'No human is watching this run, so ask_user is unavailable. To reach a human, ' +
        'call the agent tool with action=send and to="human", then end your turn ' +
        'with the blocker in your final text.'
      );
    }
    return 'This is a non-interactive run; state blockers in your final text.';
  }

  private buildSelfCard(
    member: MemberRuntimeMember,
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

  private requireEntry(member: MemberRuntimeMember): MemberRuntimeEntry {
    const entry = this.entries.get(member.session_id);
    if (!entry) throw new Error(`member runtime not spawned: ${member.session_id}`);
    return entry;
  }
}

/** 工厂：入口层只依赖 MemberRuntimePort */
export function createInProcessMemberRuntime(
  options: InProcessMemberRuntimeOptions,
): MemberRuntimePort {
  return new InProcessMemberRuntime(options);
}
