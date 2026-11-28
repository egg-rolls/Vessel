/**
 * AgentService：Agent 身份、多 ExecutionUnit 生命周期、统一准入与回复投递。
 *
 * 0.27 不变量：
 * - 一个 Agent 可有多个 live ExecutionUnit（`body_id ≡ session_id`），每 ExecutionUnit 独立 runtime /
 *   历史 / checkpoint / 队列；同 ExecutionUnit 串行、不同 ExecutionUnit 并发由 Scheduler 保证；
 * - 所有入口（send / dispatch / Team @ / runs.start）只调用 `admit`；
 * - `run.*` 是唯一执行生命周期，本服务不 emit `agent.turn.*` / `agent.reply.posted`；
 * - 队列按 ExecutionUnit，不按 Agent；预算 block 的消息留在 ExecutionUnit mailbox。
 *
 * @module @vessel-agent/agent
 */

import { randomUUID } from 'node:crypto';
import {
  type AgentHandle,
  armProjectionDeclaration,
  assertProjectionModeAllowedForChild,
  assertTenantId,
  type ContextSummarizer,
  classifyProviderRetry,
  // CREATE-0.39 内部改名：与 core 导出同名，不再使用 import alias。
  compactMessagesForSeed,
  declareProjection,
  type EventStream,
  forgetProjectionDeclaration,
  knownProjectionMode,
  LeaseExpiredError,
  type LeaseGrant,
  type LeaseServicePort,
  type Logger,
  type Message,
  type MessageRef,
  noopLogger,
  PROJECTION_MODE_STRICTNESS,
  type ProjectionDeclaration,
  type ProjectionMode,
  type ProjectionParams,
  projectMessages,
  type RunEvent,
  type RunHandle,
  type RunInterruptReason,
  type RunOptions,
  type RunRecord,
  type RunRecordStore,
  RunResumeError,
  type RunStatus,
  type RuntimePermissionConfig,
  type ScheduledTask,
  type Scheduler,
  type SessionEventLogPort,
  seedMessageIdOf,
  type ToolDefinition,
  toErrorEnvelope,
  type Usage,
  withMessageId,
} from '@vessel-agent/core';
import { generateConversationId, isValidConversationId } from './conversation-budget.js';
import {
  classifyDistress,
  DISTRESS_COOLDOWN_MS,
  DISTRESS_HISTORY_SCAN,
  DISTRESS_SPAWN_FAILED,
  renderDistressContent,
} from './distress.js';
import { errorText } from './error-text.js';
import {
  type AgentInboxChange,
  type AgentInboxDelivery,
  type AgentInboxListEntry,
  AgentInboxStore,
  deliveryFromNotify,
  type InboxAsyncJobMeta,
} from './inbox.js';
import { memberCwdFromTeam } from './member-cwd.js';
import { normalizeRefs } from './refs.js';
import {
  type BindingRecord,
  currentBindingSession,
  findSessionState,
  liveBindings,
  type MemberRecord,
  MemberRegistry,
  primaryBinding,
  type SessionBindingState,
  toMemberStatus,
  toPersistedRecord,
  toRuntimeMember,
} from './registry.js';
import { AgentSnapshotStore, snapshotPath } from './snapshot.js';
import {
  HUMAN_PRINCIPAL,
  isReservedPrincipal,
  RESERVED_PRINCIPALS,
  SYSTEM_PRINCIPAL,
} from './team-address.js';
import {
  type AdmitDeferredReason,
  type AdmitInput,
  type AdmitResult,
  type AgentAsyncJobReconcileResult,
  type AgentClaimInput,
  type AgentClaimResult,
  type AgentClaimSkip,
  type AgentDispatchSweepResult,
  type AgentDrainOptions,
  type AgentDrainOutcome,
  AgentError,
  type AgentEvent,
  type AgentEventListener,
  type AgentMessage,
  type AgentRecallInput,
  type AgentRecallResult,
  type AgentRecallSkip,
  type AgentRecoverResult,
  type AgentRole,
  type AgentService,
  type AgentServiceOptions,
  type AgentUpdateBatchInput,
  type AgentUpdateField,
  type AgentUpdateInput,
  type AgentUpdateResult,
  type BatchItemResult,
  type BatchResult,
  type BodyBlocked,
  type BudgetBlockReason,
  type BudgetCheckResult,
  type BudgetOverrideInput,
  type BudgetOverview,
  type BudgetStatusInput,
  type CloseBatchInput,
  type CloseInput,
  type CloseResult,
  type ConversationBudgetPort,
  type CreateBatchInput,
  type CreateMemberInput,
  type CreateSeed,
  DEFAULT_OWNER,
  type DispatchInput,
  type DispatchResult,
  type EnvironmentCardAnnouncement,
  type ExecutionUnitStatus,
  type ListFilter,
  MAX_BINDING_HISTORY,
  MAX_MESSAGE_BYTES,
  MAX_SESSION_TITLE_LENGTH,
  type MemberExecutionMember,
  type MemberPermissionState,
  type MemberState,
  type MemberStatus,
  type MemberToolEntry,
  type MemberTurnResult,
  type MemberVisibility,
  type PeerStopChange,
  type PeerStopKind,
  type PersistedAgentRecord,
  RELEASED_MEMBER_DEFAULT_FIELDS,
  RELEASED_MEMBER_FIELDS,
  RELEASED_MEMBER_LIMIT_DEFAULT,
  RELEASED_MEMBER_LIMIT_MAX,
  type ReinstateInput,
  type ReleasedMemberField,
  type ReleasedMembersPage,
  type ReleasedMembersQuery,
  type ReleasedMemberView,
  type ReplyResult,
  type SendBatchInput,
  type SendInput,
  type SendResult,
  type SessionActivateInput,
  type SessionActivateResult,
  type SessionCreateInput,
  type SessionCreateInternalOptions,
  type SessionCreateResult,
  type SessionRestartInput,
  type SessionRestartResult,
  type TeamBinder,
  type TeamRecord,
} from './types.js';

const VISIBILITIES: readonly MemberVisibility[] = ['private', 'team', 'tenant'];

/**
 * `agent.snapshot.duplicate_name` 的进程级首次 warn 记账：同一个 name 只在进程内
 * 第一次快照发现时 warn，之后降 debug（事实没变，不该每次快照都重复打扰）。
 * key 是成员名（≤64 字符），数量随名集合有界。
 */
const duplicateNameWarned = new Set<string>();

/**
 * Team 内 present 成员上限的缺省值（peer + contractor 都计入）。
 * q-team-limit-config：20 → 100（用户裁定），可经 `agent.teamMemberLimit` 配置
 * （装配层注入 `AgentServiceOptions.teamMemberLimit`，构造期读取，改后需重启）。
 * 计数口径不变：`presentTeamCount` 仍数 `membership === 'present'`（含 closed）。
 */
const DEFAULT_TEAM_MEMBER_LIMIT = 100;

/**
 * 人类 principal：消息的**缺省发送者**。
 *
 * 取值来自保留名词典（`team-address.ts` 的 `HUMAN_PRINCIPAL`）—— app 层的
 * `LOCAL_HUMAN_PRINCIPAL` 也从那里 re-export，所以这边不再是「本包自己一份、
 * 与那边必须同改」。
 *
 * 这里**不能**用 `defaultOwner`：那是「临时成员归谁管」的缺省值（`MemberRecord.owner`），
 * 是 agent 的归属；消息的归属是另一个 principal。两者曾是同一个字符串
 * （都是 `'main'`），于是人类从 CLI / Web 发消息时 `from` 变成了 `main` 这个 agent
 * 的 id —— `messageSource` 再也分不出「main 在说话」和「人类在说话」。
 */
const DEFAULT_MESSAGE_SENDER = HUMAN_PRINCIPAL;

/**
 * ask 答复在 inbox 里的来源名（`AgentInboxEntry.source`）。
 *
 * 为什么答案不写 `human`：待处理条带 / 时间线都要能指出「这是人对某个提问的答复」，
 * 而不是人自己随口说的一句。消息本身的 `from` 仍是人类 principal —— 那是权限主体与
 * 模型侧的来源标注，换掉它会动摇与「谁在说话」无关的判定。
 *
 * 副作用（已确认，方向正确）：`agents.recall` 对非 human 源是「unhold 留档」而不是真删，
 * 于是人对 ask 的答复不会被静默删除。
 */
export const ASK_ANSWER_INBOX_SOURCE = 'ask';

/**
 * 0.55：后台 bash 作业结果的 inbox 来源标签。
 *
 * 与 `ask` 同级：`from` 是成员自己（它自己的作业回报它自己），直接拿 `from` 当来源会在
 * 条带里显示成「自己发给自己」。固定标签让时间线能指出「这是运行时送回来的作业结果」。
 */
export const BASH_JOB_INBOX_SOURCE = 'bash';

/**
 * inbox 来源的**固定标签 enum**（用户裁定：来源在创建源头规定，渲染侧读 enum 判显示）。
 *
 * `source` 字段的取值域 = 这四个固定标签 + principal 地址（本机成员 UUID / `federation:`
 * 地址）。固定标签表达「不是谁说的话」的来源类别（人类 / 系统 / ask 答复 / bash 作业），
 * 地址表达「谁说的话」。赋值统一收口在 {@link inboxSourceOf}（admit / trackInbox /
 * rotate 窗口 / 还原 unread 共用），**不允许**旁路直接拿 `from` 当来源 —— 那会把
 * 「作业回报自己」写成「自己发给自己」。
 *
 * 不另设第二个 kind 字段：source 已承载同一事实，第二字段就是第二套口径（同
 * `pending` / `held` 之鉴）。旧条目（加标签之前落盘的 source=成员 id）不迁移，渲染侧
 * 按既有 agent 身份 / 短 id 降级 —— 缺 enum 是合法的老状态，不是损坏。
 */
export type InboxSourceLabel =
  | typeof HUMAN_PRINCIPAL
  | typeof SYSTEM_PRINCIPAL
  | typeof ASK_ANSWER_INBOX_SOURCE
  | typeof BASH_JOB_INBOX_SOURCE;

/** inbox 条目的来源：只有「人对 ask 的答复」与普通人类消息在这里分家。 */
function inboxSourceOf(message: AgentMessage): string {
  if (message.origin === 'ask_answer') return ASK_ANSWER_INBOX_SOURCE;
  // 0.55：后台作业的结果不是「谁说的话」，用固定标签而不是 from（from 就是收件人自己）
  if (message.origin === 'bash_job') return BASH_JOB_INBOX_SOURCE;
  return message.from;
}

/**
 * rotate 交接嘱托在会话里的身份（`AgentMessage.input_name` → `Message.name`）。
 *
 * 内置 `agent` 工具的 rotate 动作把上一具身体写好的 `startup_prompt` 投给新身体
 * （`tool.ts` → `createSession({ allowActiveRun: true })`）。那是 **agent 写的交接书**，
 * 不是人坐在键盘前打的字；`input_name` 留空时它和人类消息长得一模一样（`runtime.ts`
 * 的 `inputNameOf` 返回 undefined ⇒ 那条 user 消息不带 `name`）。标上身份后 Web 渲染成
 * 「rotate 交接」卡、TUI 渲成可读标题，两边都不再把它画成用户气泡。
 *
 * 只能用 `rotate:` 前缀，**不能用 `vessel:`**：`isRuntimeSeedMessage()` 把 `vessel:*`
 * 当运行时种子消息（早期历史投影会受影响），TUI 的人类可读投影也整体跳过 `vessel:*`
 * —— 那样这张卡在 TUI 里就看不见了。这条消息仍然是该轮真实的用户输入（turn 锚点），
 * 与 `vessel:*` 的「模型侧上下文」不是一回事。
 *
 * 字面量与 `apps/web/src/domains/chat/rotate-handoff.ts` 必须一致
 * （`check-transcript-items` 守）。
 */
export const ROTATE_HANDOFF_INPUT_NAME = 'rotate:handoff';

/**
 * rotate 交接嘱托的完整 `Message.name`：`种类:参数`，与 `agent:<alias>` 同一形状。
 *
 * 第三段是新身体的 epoch：`Message` 只有 role / content / name / timestamp，
 * **name 是唯一能随消息持久化的身份位**，正文不能为此改动一个字。卡片据此在刷新后
 * 仍能显示「epoch N」（不靠数历史里的交接次数去猜）。读不懂第三段时（旧数据 / 手改）
 * 卡片退回不带 epoch 的卡头 —— 宁可少写，不编造。
 */
function rotateHandoffInputName(epoch: number): string {
  return `${ROTATE_HANDOFF_INPUT_NAME}:${epoch}`;
}

/**
 * restart --self 跨进程续作嘱托在会话里的身份（`Message.name`）。
 *
 * 续作嘱托是上一具身体重启前写好的交接书（rotate 交接的跨进程版，见
 * `deliverContinuationPrompt`），由 system principal 投递。`input_name` 留空时
 * `inputNameOf` 对 system 来源返回 undefined ⇒ 那条 user 消息不带 `name`，Web 把它
 * 画成用户气泡（用户反馈的正是这条：续作嘱托看起来像人坐在键盘前打的字）。
 *
 * 复用 `tool:` 卡族（与 `tool:bash` 同形，见 `runtime.ts` 的 `BASH_JOB_INPUT_NAME`）：
 * Web 的 `senderOfName` 已认这个前缀，渲成「来自 system」卡（`chat.toolMessage.from`），
 * 渲染层不新增前缀 / 判定；与 inbox-read 的 system 源承接卡同一口径
 * （`TranscriptWindow` 的 `fixedSourceLabel`：SYSTEM_SOURCE → senderKind='tool'）。
 *
 * 不能用 `vessel:*`：`isRuntimeSeedMessage()` 把它当运行时种子消息，TUI 的人类可读
 * 投影也整体跳过 —— 这条消息是该轮真实的用户输入（turn 锚点）、新进程首轮唯一的
 * 指令，必须可见。
 *
 * create / hire 路径的 startup_prompt 不标 input_name：agent 经内置工具创建时
 * 来源归属创建者（from=创建者，`agent:<alias>` 由 source + from_name 推导）；
 * 人 / RPC 的开场白保持 from=system、按正文渲染 —— 谁写的这句话由生产者声明，
 * 不能从 system 来源统一推断（见 `deliverStartupPrompt`、types.ts 的
 * `input_name` 裁定）。
 */
export const CONTINUATION_INPUT_NAME = 'tool:system';

/**
 * 成员名合法形状：1-64 位字母 / 数字 / `_` / `-`。
 *
 * **与 `src/federation-address.ts` 的 `FEDERATION_PRINCIPAL_RE` 同源同义**（那边是
 * `[A-Za-z0-9_-]{1,64}`）。两处必须同改：名字会被拼进跨节点地址的 principal 段
 * （`team-service.ts` 出站 from），不合法的名字建得出来、却永远发不出去。
 *
 * 不在 create 时校验的后果实测过：`my.agent` / `docs core` / 中文名 / 超 64 字符
 * 都能存进 registry，但 `parseFederationAddress` 在形状校验就拒绝整条地址 ——
 * 不是 `unknown_member`，是地址本身非法。本机按 id 仍能用，跨节点完全不可达。
 */
const MEMBER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 非法名字的拒绝理由：必须说明允许的形状，不能只说 invalid。 */
function nameShapeError(name: string): AgentError {
  return new AgentError(
    'invalid_input',
    `name must match ${MEMBER_NAME_RE.source} (letters, digits, underscore, hyphen; ` +
      `1-64 chars); "${name}" is not addressable cross-node`,
  );
}

/**
 * 保留 principal（`human` / `system`）的拒绝理由：同样要说清为什么不能用，而不是
 * 只说 invalid —— 名字形状本身合法，只报「不匹配 RE」会让人查不出原因。
 */
function nameReservedError(field: 'name' | 'id', value: string): AgentError {
  return new AgentError(
    'invalid_input',
    `${field} must not be a reserved principal (${[...RESERVED_PRINCIPALS].join(', ')}); ` +
      `"${value}" is read as that principal on the addressing / message-source path, ` +
      'not as a member, so its traffic would be attributed to it instead of to the member',
  );
}

/** 显式 name 的形状与保留名校验；缺省（undefined）放行，由调用方决定是否自动命名。 */
function assertMemberName(name: string | undefined): void {
  if (name === undefined) return;
  if (!MEMBER_NAME_RE.test(name)) throw nameShapeError(name);
  if (isReservedPrincipal(name)) throw nameReservedError('name', name);
}

/**
 * 显式 id 的保留名校验：与 name 同理 —— id 也是 principal（`send` 的 from / to、
 * `dispatch` 的解析阶梯都会先按 id / name 找成员），保留 id 会把人类消息读成 agent。
 *
 * **只校验调用方显式传入的 id**，不校验生成器产物与 `defaultOwner`：配置里的
 * `agent.ownerId` 是既有约定（`main`），改它属于迁移语义，不在本次范围内。
 */
function assertExplicitId(id: string): void {
  if (isReservedPrincipal(id)) throw nameReservedError('id', id);
}

/**
 * turn 域预算维度：投递侧不拦（否则消息进不了 body mailbox，override 也无从恢复）；
 * 由 turn_start 检查后留在 mailbox，override / release 后重新准入。
 */
const TURN_DIMENSIONS: ReadonlySet<string> = new Set(['turns', 'tokens']);

/**
 * 启动恢复一次最多动手的会话数（0.53）。
 *
 * 启动时 spawn 是真实成本（runtime 构建 + 一次 LLM turn）：不能让「崩溃恢复」变成
 * 「一开机所有 agent 一起跑」。超出的会话条目保持 unread，下次启动顺延。
 */
const RECOVER_MAX_SESSIONS = 8;

/**
 * `status: 'deferred'` 的建议重问间隔（毫秒，0.57）。
 *
 * 给的是「多久之后再问一次有没有接单」的量级，**不是**完成的承诺：
 * - `rotate`：新 body 的 spawn 是秒级（真机最坏十几秒），10 s 后再问是安全的；
 * - `draining`：进程要退出再起来，30 s 只是让调用方别在此期间空转；
 * - `stopped`：**没有**时间答案 —— 要一条显式人工动作（人类投递 / interrupt / 换 body），
 *   所以这里不给数字（`retry_after_ms` 缺省 = 别按时间重试）。
 */
const DEFERRED_RETRY_AFTER_MS: Readonly<Partial<Record<AdmitDeferredReason, number>>> = {
  draining: 30_000,
  rotate: 10_000,
};

/**
 * 临时 agent 空闲回收 TTL 缺省值（小时，D5）；0 = 关闭。
 *
 * 2 小时是裁决值：回收可逆（`reinstate` 原地复活），代价只是复活一次。
 */
const DEFAULT_TEMPORARY_TTL_HOURS = 2;

/**
 * 成员停下后的判定窗口（毫秒）：终态后等这么久再判一次，仍无新工作才报给父级。
 *
 * 用户裁定「停了马上又拿到下一条消息」属于噪音：一个终态紧接着又有新 run / 未读
 * 消息 / rotate 窗口时，这次「停了」不是结论，窗口到期时直接丢弃。
 * 同一成员同时最多一个待发判定（新终态覆盖旧的并重新计时）。
 */
const PEER_STOP_WINDOW_MS = 2000;

/** sweep 节奏：`clamp(ttl / 10, 60s, 15min)`；不做独立配置键 */
const SWEEP_INTERVAL_MIN_MS = 60_000;
const SWEEP_INTERVAL_MAX_MS = 900_000;

/**
 * 历史视图的释放原因（与 `agent.closed` 事件的 `reason` 同一口径）。
 *
 * `closed` = 显式 close（人 / 父级 / 批量）；`idle_ttl` = 空闲回收（sweep 传入）。
 * 未知字符串原样保留：历史视图只展示记录里写着的事实，不按白名单改写。
 */
const CLOSE_REASON_CLOSED = 'closed';

/** 已释放 = 已离开在册。close 与空闲回收都同时改这两个字段，任一命中即算释放。 */
function isReleased(record: MemberRecord): boolean {
  return record.membership === 'left' || record.state === 'closed';
}

/** 历史视图上限：缺省 20；非数 / 小于 1 回默认；超过硬顶钳到 200（封顶而不是报错） */
function releasedLimit(value: unknown): number {
  if (value === undefined) return RELEASED_MEMBER_LIMIT_DEFAULT;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return RELEASED_MEMBER_LIMIT_DEFAULT;
  return Math.min(Math.floor(parsed), RELEASED_MEMBER_LIMIT_MAX);
}

/**
 * 历史视图字段：缺省给精简集；未知字段名直接拒绝。
 *
 * 静默忽略未知字段会让调用方以为拿到了自己要的东西（尤其 `cost` 这类可能缺值的），
 * 所以宁可在入参处失败。重复字段去重，保持调用方给的顺序。
 */
function releasedFields(value: readonly string[] | undefined): ReleasedMemberField[] {
  if (value === undefined || value.length === 0) return [...RELEASED_MEMBER_DEFAULT_FIELDS];
  const fields: ReleasedMemberField[] = [];
  for (const entry of value) {
    if (!(RELEASED_MEMBER_FIELDS as readonly string[]).includes(entry)) {
      throw new AgentError(
        'invalid_input',
        `unknown field "${entry}" (expected ${RELEASED_MEMBER_FIELDS.join('|')})`,
      );
    }
    const field = entry as ReleasedMemberField;
    if (!fields.includes(field)) fields.push(field);
  }
  return fields;
}

/** 历史排序：释放时刻新的在前；未知释放时刻用 last_seen 兜底，最后按 id 稳定 */
function compareReleased(left: MemberRecord, right: MemberRecord): number {
  const leftAt = left.closedAt ?? left.lastSeen ?? 0;
  const rightAt = right.closedAt ?? right.lastSeen ?? 0;
  if (leftAt !== rightAt) return rightAt - leftAt;
  return left.id.localeCompare(right.id);
}

/** 记录 → 历史条目：只放调用方点名的字段，记录里没有的事实就不出现（不补默认值） */
function releasedMemberView(
  record: MemberRecord,
  fields: readonly ReleasedMemberField[],
): ReleasedMemberView {
  const view: ReleasedMemberView = {};
  for (const field of fields) {
    switch (field) {
      case 'name':
        if (record.name !== undefined) view.name = record.name;
        break;
      case 'role':
        view.role = record.role;
        break;
      case 'state':
        view.state = record.state;
        break;
      case 'membership':
        view.membership = record.membership;
        break;
      case 'presence':
        view.presence = record.presence;
        break;
      case 'closed_at':
        if (record.closedAt !== undefined) view.closed_at = record.closedAt;
        break;
      case 'close_reason':
        if (record.closeReason !== undefined) view.close_reason = record.closeReason;
        break;
      case 'session_id':
        view.session_id = currentBindingSession(record);
        break;
      // 记录里只有 token 用量，没有货币成本：原样给出 usage，绝不编造 total_cost。
      case 'cost':
        if (record.usage !== undefined) view.cost = record.usage;
        break;
    }
  }
  return view;
}

/** ExecutionUnit 执行态（对外 ExecutionUnitStatus.state） */
type ExecutionUnitState = 'idle' | 'running' | 'waiting_permission' | 'closed';

/** 单个 ExecutionUnit 的运行态（不落 snapshot） */
interface ExecutionUnitEntry {
  agentId: string;
  bindingId: string;
  epoch: number;
  state: ExecutionUnitState;
  primary: boolean;
  createdAt: number;
  lastActiveAt: number;
  retired: boolean;
  /**
   * 「退役发生在本轮 run 内」的现场记录（run id + 退役原因）。
   *
   * 为什么必须记在这里：收口处只有一个 `retired` 布尔，分不出「自己交棒的那一轮」
   * （合法收尾，该正常记账）与「真迟到的旧轮」（该 epoch fencing）。退役那一刻
   * `entry.active` 就是「被退役时正在跑的那一轮」，只有在那里才拿得到这个 id ——
   * 到收口时它已经被清空，再判就只能靠猜（0.51 报告 §1 的事故正是被混判的一轮）。
   * 判据本身在 `classifyRetiredTurn`。
   */
  retirement?: { runId: string; reason: string };
  runtimeMember: MemberExecutionMember;
  /** 预算 block 留在 mailbox 的消息；正常消息 submit 后即移出 */
  pending: AgentMessage[];
  /** 已提交给 scheduler、尚未开始执行的 run */
  queuedRuns: Set<string>;
  /** 正在执行的 run（同 body 同时最多一个） */
  active?: {
    runId: string;
    messageId?: string;
    conversationId?: string;
  };
  budgetHold: Set<string>;
  /**
   * 硬错误闸（0.55）：不可重试的 provider 硬错误之后落下的现场（单对象，有上界）。
   *
   * 存在即「这具 body 不再自动接单」：新消息照常入 inbox + pending/hold，但不 submit
   * 新 run（`startExecutionUnitRun` / `admitInternal` / `canDispatchInbox` 三处同判）；
   * 清空只有显式解闸一条路（`unblockBodies`）。不落盘：重启 = 人类显式动作。
   */
  hardStop?: BodyBlocked;
  closing: boolean;
  spawned: boolean;
  /** 在途 spawn（single-flight）：并发 admit 只 spawn 一次 */
  spawning?: Promise<void>;
  /** BindingLease 凭据（Stage 3，内存；dispose 时释放） */
  leaseId?: string;
  /** 该 binding 的 fencing token（Stage 3，内存；传给 EU） */
  fencingToken?: number;
}

/** 事件 extra 允许预算字段（开放字符串事件，不在 AgentEvent 里加常量） */
type AgentEventExtra = Omit<Partial<AgentEvent>, 'type' | 'agent_id' | 'session_id' | 'ts'> &
  Record<string, unknown>;

/**
 * 被退役的 body 交出来的这一轮，属于哪一类。
 *
 * - `handoff`：**自己交棒的那一轮**——模型在本轮 run 里调 rotate，工具内的退役把
 *   自己这具 body 标成 retired，然后这一轮照常跑完（`tool.ts` 明确要求它收尾）。
 *   它是合法的收尾，按正常轮记账（ADR-092 非目标写的就是「旧 Body 跑完当前轮再退役」）。
 * - `late`：**真迟到的旧轮**——退役来自外部（TTL 回收 / close / delete / RPC rotate），
 *   这一轮的产出来得太晚，继续按 epoch fencing 丢弃（ADR-092 第 8 条）。
 */
export type RetiredTurnKind = 'handoff' | 'late';

/**
 * 收口判据：这一轮是「自己交棒的那一轮」还是「真迟到的旧轮」。
 *
 * 三个条件缺一不可 —— **故意不写成「`retired` 就交棒」**：那会把所有被 fence 的轮
 * 一并算成正常收尾，迟到正文又会被记进 agent 状态、又不会留下任何解释。
 *
 * 1. `retired`：没被退役的体不谈这两类（走正常收口）；
 * 2. `retirement.runId === runId`：退役发生在**这一轮**的 run 内。空闲时被别人退役、
 *    然后才起的那一轮不是交棒，是迟到；
 * 3. `retirement.reason === 'rotation'`：退役原因是 rotate。TTL 回收 / close / delete
 *    即使真的赶在 run 内退役，那一轮也该按迟到处理（它的产出对谁都不算交接）。
 */
export function classifyRetiredTurn(
  entry: { retired: boolean; retirement?: { runId: string; reason: string } },
  runId: string,
): RetiredTurnKind {
  const retirement = entry.retirement;
  if (!entry.retired || retirement === undefined) return 'late';
  return retirement.runId === runId && retirement.reason === 'rotation' ? 'handoff' : 'late';
}

/** 预算拒绝结果的窄类型 */
type BudgetBlockedCheck = Extract<BudgetCheckResult, { ok: false }>;

/** rotate 窗口内的旧 / 新 ExecutionUnit 身份（agentId → state） */
interface RotationState {
  fromSessionId: string;
  fromEpoch: number;
  toSessionId: string;
  toEpoch: number;
}

/** dispatch 自动创建结果：成功带新记录；失败带稳定 code 与 `code: reason` 文本 */
type CreateDerivedOutcome =
  | { ok: true; member: MemberRecord }
  | {
      ok: false;
      code:
        | 'auto_create_not_allowed'
        | 'auto_create_failed'
        | 'agent_left'
        | 'team_full'
        | 'team_frozen';
      reason: string;
    };

/** seeded create 的种子计算结果（不写源） */
interface SeedResult {
  messages: Message[];
  keepProjected: number;
  copiedMessages: number;
}

/** 一条可带 `origin` 的消息（`Message` 类型本身不声明 origin，事件按开放形状保存） */
type SeedMessage = Message & { origin?: string };

/** 一次准入的内部结果（message_id 供 send / dispatch 复用） */
interface AdmitOutcome {
  result: AdmitResult;
  message: AgentMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** 稳定错误码：只取错误对象自带的 string `code`，不猜测 / 不解析消息 */
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

/** 按输入顺序把 allSettled 转成逐条结果；单条失败不影响其它条目 */
function settleBatch<T>(settled: PromiseSettledResult<T>[]): BatchResult<T> {
  return {
    results: settled.map((item): BatchItemResult<T> => {
      if (item.status === 'fulfilled') return { ok: true, status: item.value };
      const code = errorCode(item.reason);
      return {
        ok: false,
        error: errorText(item.reason),
        ...(code !== undefined ? { code } : {}),
      };
    }),
  };
}

/** 校验 visibility 或返回缺省 */
function resolveVisibility(value: unknown, fallback: MemberVisibility): MemberVisibility {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !VISIBILITIES.includes(value as MemberVisibility)) {
    throw new AgentError(
      'invalid_input',
      `invalid visibility "${String(value)}" (expected private|team|tenant)`,
    );
  }
  return value as MemberVisibility;
}

/** 内部 ExecutionUnit → 对外状态 */
function toExecutionUnitStatus(entry: ExecutionUnitEntry): ExecutionUnitStatus {
  return {
    session_id: entry.bindingId,
    epoch: entry.epoch,
    state: entry.state,
    primary: entry.primary,
    created_at: entry.createdAt,
    last_active_at: entry.lastActiveAt,
    // 0.55：硬错误闸随状态一起出去 —— 「这个 body 因为什么跑不动」必须在状态查询里
    // 一眼可见，不能只留在节点日志里（那对 WebUI / 父 agent 都是不可见的）。
    ...(entry.hardStop !== undefined ? { blocked: entry.hardStop } : {}),
  };
}

/**
 * 一次 provider 失败里「必然再失败」的那一类（0.55 硬错误闸的判据）。
 *
 * 两套既有分类同时点头才算，理由：
 * - `classifyProviderRetry` 决定「能不能自动重发同一请求」——它说能重发（传输层 / 429）
 *   的，本就不是硬错误，不该立闸；
 * - `toErrorEnvelope` 给出稳定错误码与 category —— 只有 category=provider 且
 *   retryable=false（400 上下文超限 / 401·403 认证 / 402 余额 / 模型不存在 / 其它 4xx）
 *   才是「同一份请求重发必然再失败」。工具错误 / 权限超时 / 内部 bug 都落在别的 category，
 *   立闸只会把可自愈的失败变成要人捞的失败。
 *
 * 不另造分类：两个函数都是既有判据的唯一实现，这里只做合取。
 */
function hardProviderFailure(error: unknown, at: number): BodyBlocked | undefined {
  if (classifyProviderRetry(error).retryable) return undefined;
  // 不传 options：让 envelope 自己按错误文本判 category。强行传 phase='llm' 会把
  // 工具 / 权限失败也算成 provider。
  const envelope = toErrorEnvelope(error);
  if (envelope.category !== 'provider' || envelope.retryable) return undefined;
  return { code: envelope.error_code, reason: singleLineReason(errorText(error)), at };
}

/** 闸里的原因上限：与 Team 日志的失败原因同口径，超出截断并加标记 */
const MAX_BLOCKED_REASON_CHARS = 500;

/** 失败原因折成单行并截断（一条状态 / 一行日志不该被 provider 的多行正文撑开） */
function singleLineReason(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_BLOCKED_REASON_CHARS
    ? `${flat.slice(0, MAX_BLOCKED_REASON_CHARS)}...`
    : flat;
}

/**
 * 从快照恢复记录：engine 状态是进程内易失，重启后非 left 一律 idle + gone。
 *
 * 0.28：文件格式仍是 v4 `bodies[]`，但语义收窄为「一具 live ExecutionUnit」。存量多 body
 * 快照按 PLAN §5.3 迁移：primary 留作 `binding`，其余 live body 以
 * `retired_at = last_active_at` 进 `body_history`。**绝不在 parse 阶段 reject** ——
 * 那会把整条成员丢掉，其全部 session 不可见。
 */
function recordFromStatus(status: PersistedAgentRecord, now: number): MemberRecord {
  const state: MemberState =
    status.membership === 'left' || status.state === 'closed' ? 'closed' : 'idle';
  const bodies: BindingRecord[] = (status.bodies ?? []).map((body) => ({
    bindingId: body.body_id,
    epoch: body.epoch,
    createdAt: body.created_at,
    lastActiveAt: body.last_active_at,
    ...(body.retired_at !== undefined ? { retiredAt: body.retired_at } : {}),
    primary: body.primary === true,
  }));
  if (bodies.length === 0) {
    const live = status.current_body ?? {
      session_id: status.session_id,
      epoch: 0,
      started_at: status.last_seen ?? now,
    };
    bodies.push({
      bindingId: live.session_id,
      epoch: live.epoch,
      createdAt: live.started_at,
      lastActiveAt: status.last_seen ?? live.started_at,
      primary: true,
    });
  }
  const live = bodies.filter((body) => body.retiredAt === undefined);
  const declaredPrimaryId =
    status.primary_body_id ?? status.current_body?.session_id ?? status.session_id;
  // primary 选取阶梯：显式指针 → primary 标记 → 最近活跃 → 第一具 live；
  // 全 body 都已退役时退回「任意一具」（保底可寻址，见 PLAN §5.3 末条）。
  const chosen =
    live.find((body) => body.bindingId === declaredPrimaryId) ??
    live.find((body) => body.primary) ??
    [...live].sort((left, right) => right.lastActiveAt - left.lastActiveAt)[0] ??
    bodies.find((body) => body.bindingId === declaredPrimaryId) ??
    bodies[0];
  const bindingHistory = [...(status.body_history ?? [])];
  const seenHistory = new Set(bindingHistory.map((entry) => entry.session_id));
  const retired: BindingRecord[] = [];
  for (const body of bodies) {
    if (body === chosen || body.retiredAt !== undefined) continue;
    // 降级为历史的 live body：必须有 history 条目，否则 `ensureExecutionUnit` 认不出它已退役，
    // 会被惰性 createBinding 复活成第二具 live ExecutionUnit。
    if (!seenHistory.has(body.bindingId)) {
      bindingHistory.push({
        session_id: body.bindingId,
        epoch: body.epoch,
        started_at: body.createdAt,
        retired_at: body.lastActiveAt,
      });
      seenHistory.add(body.bindingId);
    }
    retired.push(body);
  }
  if (retired.length > 0) {
    bindingHistory.sort((left, right) => left.retired_at - right.retired_at);
  }
  const primary = chosen === undefined ? undefined : { ...chosen, primary: true };
  return {
    id: status.id,
    sessionId: status.session_id,
    ...(primary !== undefined ? { binding: primary } : {}),
    ...(status.name !== undefined ? { name: status.name } : {}),
    ...(status.parent_id !== undefined ? { parentId: status.parent_id } : {}),
    role: status.role,
    owner: status.owner,
    visibility: status.visibility,
    state,
    presence: 'gone',
    membership: status.membership,
    ...(status.team_id !== undefined ? { teamId: status.team_id } : {}),
    rotation: 'stable',
    bindingHistory: bindingHistory.slice(-MAX_BINDING_HISTORY),
    ...(status.model !== undefined ? { model: status.model } : {}),
    ...(status.system_prompt !== undefined ? { systemPrompt: status.system_prompt } : {}),
    // 0.51：成员 cwd 快照随记录一起恢复；缺省 = 没有成员 cwd（工具退回全局默认）
    ...(status.cwd !== undefined ? { cwd: status.cwd } : {}),
    ...(status.source_agent_id !== undefined ? { sourceAgentId: status.source_agent_id } : {}),
    ...(status.current_tool !== undefined ? { currentTool: status.current_tool } : {}),
    ...(status.last_seen !== undefined ? { lastSeen: status.last_seen } : {}),
    ...(status.usage !== undefined ? { usage: status.usage } : {}),
    // 0.53：释放时刻 / 原因随记录一起恢复（历史视图的唯一来源；缺省 = 未知，不补）
    ...(status.closed_at !== undefined ? { closedAt: status.closed_at } : {}),
    ...(status.close_reason !== undefined ? { closeReason: status.close_reason } : {}),
  };
}

/** Scheduler 返回的 RunHandle 适配器：把 runtime 轮次包装成 run 生命周期 */
class ExecutionUnitRunHandle implements RunHandle {
  readonly result: Promise<string>;
  private state: RunStatus = 'running';
  private usageValue: Usage | undefined;
  private resolveResult!: (value: string) => void;
  private rejectResult!: (reason?: unknown) => void;
  cancelRequested = false;
  cancelHandler: ((reason?: string) => void) | undefined;

  constructor(
    readonly id: string,
    readonly agentId: string,
    readonly sessionId: string,
  ) {
    this.result = new Promise<string>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    void this.result.catch(() => {});
  }

  status(): RunStatus {
    return this.state;
  }

  usage(): Usage | undefined {
    return this.usageValue;
  }

  setUsage(usage: Usage | undefined): void {
    this.usageValue = usage;
  }

  cancel(reason?: string): void {
    if (this.terminal()) return;
    this.cancelRequested = true;
    this.cancelHandler?.(reason);
  }

  terminal(): boolean {
    return this.state === 'completed' || this.state === 'failed' || this.state === 'cancelled';
  }

  complete(content: string): void {
    if (this.terminal()) return;
    this.state = 'completed';
    this.resolveResult(content);
  }

  fail(error: unknown): void {
    if (this.terminal()) return;
    this.state = 'failed';
    this.rejectResult(error instanceof Error ? error : new Error(String(error)));
  }

  markCancelled(reason?: string): void {
    if (this.terminal()) return;
    this.state = 'cancelled';
    this.rejectResult(new Error(reason ?? 'run cancelled'));
  }
}

/** 默认实现 */
export class AgentServiceImpl implements AgentService {
  private readonly registry: MemberRegistry;
  private readonly runtime: AgentServiceOptions['runtime'];
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly logger: Logger;
  private readonly snapshot: AgentSnapshotStore | undefined;
  /** 临时 agent 空闲回收 TTL（毫秒）；0 = 关闭 */
  private readonly temporaryTtlMs: number;
  /** Team 内 present 成员上限（缺省 100；config agent.teamMemberLimit 注入） */
  private readonly teamMemberLimit: number;
  private readonly leaseService: LeaseServicePort | undefined;
  private readonly summarizer: ContextSummarizer | undefined;
  private readonly contextMaxTokens: number | undefined;
  /**
   * createBinding 获取、entryFor 消费的 BindingLease 凭据（bindingId → grant）。
   * 只覆盖两者之间极短的窗口；entry 建立后凭据保存在 `ExecutionUnitEntry.leaseId`。
   */
  private readonly pendingBindingLeases = new Map<string, LeaseGrant>();
  /** seeded create：来源 transcript 读取 / 新 session 种子写入 */
  private readonly eventLog: SessionEventLogPort | undefined;
  /** 内部 create 失败后清理新 session 事件日志（可缺省） */
  private readonly deleteSessionData: AgentServiceOptions['deleteSessionData'];
  /** Stage 4：成员 run durable 记录；resumeRun 的加载端口 */
  private readonly runStore: RunRecordStore | undefined;
  /**
   * 附件入池（0.56）：注入时在 `admit` 里把图片引用算 sha256 + 落 blob。
   * 缺省 = 不入池（图不内联，`not_ingested`）——fail-closed 且不静默。
   */
  private readonly attachIngest: AgentServiceOptions['attachIngest'];
  /** 0.32：持久化收件箱；有 `dataDir` 时唯一实例，否则 undefined（行为不变） */
  private readonly inbox: AgentInboxStore | undefined;
  /** AgentService 的 body registry：agentId → bindingId → ExecutionUnitEntry（含已退役直到清理） */
  private readonly executionUnitRegistry = new Map<string, Map<string, ExecutionUnitEntry>>();
  /** run_id → 准入消息 id（send / dispatch 复用） */
  private readonly runMessageIds = new Map<string, string>();
  /**
   * 0.53：启动恢复每进程只扫一次（同一进程里本地 dispatcher 与 `--serve` gateway 共存，
   * 各自都会调一次 `recoverPendingInputs`；第二次扫到的是已被 hold 的条目，本可自然跳过，
   * 但这个位让「扫过一次」这件事显式，而不是靠副作用）。
   */
  private startupRecoveryDone = false;
  /**
   * 启动 dispatch sweep 每进程只跑一次（审计 §5.4 幂等闸，与 startupRecoveryDone 同款）：
   * 不与 live 投递竞争，只碰未 held 条目（单消费者规则）。
   */
  private startupSweepDone = false;
  /**
   * q-async-job-reconcile：启动对账孤儿 running 占位卡每进程只跑一次
   * （与 startupRecoveryDone 同款幂等闸：本地 dispatcher 与 gateway 共存时各自都会调）。
   */
  private asyncJobReconcileDone = false;
  /** body 级串行操作（0.32-D 打断重排）；按 bindingId 排队，避免两次打断交错。 */
  private readonly executionUnitOps = new Map<string, Promise<unknown>>();
  /**
   * 0.32-D：run_id → 取消原因。scheduler 在 real handle attach 之前被取消时，
   * `attach()` 会用固定 'run cancelled' 调 cancel，丢掉原始 reason；打断按 id 修正。
   */
  private readonly interruptReasons = new Map<string, RunInterruptReason>();
  /** 0.41：当前处于 urgent 语义的消息 id；run terminal 时清理（被抢占者保留以重投）。 */
  private readonly urgentMessageIds = new Set<string>();
  /**
   * 0.41：in-flight urgent 的消息正文（内存，非持久）。inbox append 会全局先裁
   * consumed，active urgent 的记录可能已被裁掉；重投时优先用这里的快照，避免
   * `reinject_missing`。与 `urgentMessageIds` 同生命周期清理。
   */
  private readonly urgentMessages = new Map<string, AgentMessage>();
  /** 0.41：因后续 urgent 被取消、但消息会重投的 run id；settle 时不清理 urgent id。 */
  private readonly interruptCancelledRunIds = new Set<string>();
  /**
   * 0.41：一次 inbox 投递（队头直投）在途的 agent id。
   *
   * 同一目标同时只允许一步投递：否则两次 settle / 一次 notify 撞上一次 settle 会把
   * 同一条队头投两遍。忙时不入这个集合（根本没开始投）。
   */
  private readonly inboxPending = new Set<string>();
  /**
   * 0.41：队列里「还有没投出去的东西」的 agent id；settle 后补检一次。
   *
   * 点亮 = 落盘了一次 wake 投递、或直投没成功；只在 `inputHead` 拿不到可直投条目时清掉。
   * 直投成功时**保持点亮**，这样下一轮收口会继续抽队头（多条消息一条一条变成 run）。
   */
  private readonly noticeDirty = new Set<string>();
  /**
   * q-distress-message：每 agent 最近一次**成功送达**的求救时刻（内存，非持久）。
   *
   * 冷却窗口内再遇致命错误只留诊断日志不重发（去重 / 防风暴）。重启清零 =
   * 新进程第一次致命错误仍可求救（进程重启本身就是一次新事故）。
   */
  private readonly distressSentAt = new Map<string, number>();
  /** 成员停下通知端口（装配层注入；缺省不报）。 */
  private readonly peerStops: AgentServiceOptions['peerStops'];
  /** 人类求救兜底端口（q-distress-message 顶层 fallback；缺省无人类通道）。 */
  private readonly humanDistress: AgentServiceOptions['humanDistress'];
  /** 显式 model pin 的注册 ref 校验口（第 6 修；装配层注入，缺省不校验）。 */
  private readonly modelRefError: AgentServiceOptions['modelRefError'];
  /**
   * 成员停下判定的待发定时器（agentId → timer）。
   *
   * 同一成员同时最多一个：新终态先 cancel 旧的再重排，避免短时间多轮收口叠出多条。
   */
  private readonly peerStopTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * peer 成员 → 创建者成员 id（**只在进程内**，不落盘、不进 schema）。
   *
   * 为什么需要：peer 成员（`role: 'member'`）按设计**没有 `parentId`**（`createOne` 拒绝
   * member 带 parentId），创建人只出现在 `agent.spawned` 审计事件里（`spawnedBy`
   * 按 types.ts 的裁定不持久化）。于是 `peerStopChangeFor` 拿不到「谁该收到停下通知」，
   * 父级是 `main`、成员是 peer 这种最常见的场景一条通知都发不出去。
   *
   * 未命中（进程重启后的老成员、来源不可知）就**静默不报**：绝不伪造父级、也不遍历成员去猜。
   */
  private readonly peerOrigins = new Map<string, string>();
  /**
   * 0.41：run id → 已计过的 cycle 边（同 run 同 from/to 只计一次）；run settle 清理。
   * owner run 由 root runtime 直跑、AgentService 不 settle；按契约 §9 A5b option b
   * 接受进程内小泄漏，重启清空，A5b 探针记录。不做容量淘汰（淘汰会让同 run 的边重计、
   * 绕过冷却）。
   */
  private readonly runCycleEdges = new Map<string, Set<string>>();
  /** 0.41：一次 send 调用 / messages 数组的 wake 边计数（每批最多 bump 1 次）。 */
  private readonly wakeBatchEdges = new Map<string, Set<string>>();
  /** drain 之后不再从队列起新轮（关闭窗口内排队的消息随进程退出丢弃） */
  private draining = false;
  /** 同一源成员的 single-flight 自动创建；并发只 spawn 一个新 Agent */
  private readonly creatingOnDispatch = new Map<string, Promise<CreateDerivedOutcome>>();
  /** 进行中的 rotate（agentId → 旧 / 新 ExecutionUnit）；只在内存 */
  private readonly rotations = new Map<string, RotationState>();
  private readonly listeners = new Set<AgentEventListener>();
  private readonly eventStream: EventStream | undefined;
  /** `create` 未显式指定 owner 时的默认 owner；不持久化 */
  private readonly defaultOwner: string;
  /** `new` 未显式传 workspace 时的默认 workspace；无配置声明时为 undefined */
  private readonly defaultWorkspace: string | undefined;
  private readonly teamBinder: TeamBinder | undefined;
  private readonly teamPolicy: AgentServiceOptions['teamPolicy'];
  /** 0.51：系统锚点 workspace（不进成员 cwd；见 `member-cwd.ts` 的铁律 1） */
  private readonly anchorWorkspaces: readonly string[];
  private readonly budgetPort: ConversationBudgetPort | undefined;
  /** 进程内 blocked 事件去重（每个 conversation 一次；release / override 清） */
  private readonly blockedBudgetEvents = new Set<string>();
  private readonly ready: Promise<void>;

  constructor(options: AgentServiceOptions) {
    if (!options || !nonEmpty(options.tenantId)) {
      throw new AgentError('invalid_input', 'tenantId is required');
    }
    assertTenantId(options.tenantId);
    if (!options.runtime) {
      throw new AgentError('invalid_input', 'runtime is required');
    }
    if (!options.scheduler) {
      throw new AgentError('invalid_input', 'scheduler is required');
    }

    this.registry = new MemberRegistry(options.now);
    this.runtime = options.runtime;

    this.scheduler = options.scheduler;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.logger = options.logger ?? noopLogger;
    this.eventStream = options.events;
    this.defaultOwner = options.ownerId ?? DEFAULT_OWNER;
    this.defaultWorkspace = nonEmpty(options.defaultWorkspace)
      ? options.defaultWorkspace
      : undefined;
    this.teamBinder = options.teamBinder;
    this.teamPolicy = options.teamPolicy;
    this.anchorWorkspaces = options.anchorWorkspaces ?? [];
    this.budgetPort = options.budget;
    const ttlHours =
      typeof options.temporaryTtlHours === 'number' && options.temporaryTtlHours >= 0
        ? options.temporaryTtlHours
        : DEFAULT_TEMPORARY_TTL_HOURS;
    this.temporaryTtlMs = ttlHours * 60 * 60 * 1000;
    // 非法注入值防御性回落缺省（config validator 已在加载期拒绝非法值）。
    this.teamMemberLimit =
      typeof options.teamMemberLimit === 'number' &&
      Number.isSafeInteger(options.teamMemberLimit) &&
      options.teamMemberLimit >= 1
        ? options.teamMemberLimit
        : DEFAULT_TEAM_MEMBER_LIMIT;
    this.leaseService = options.leaseService;
    this.summarizer = options.summarizer;
    this.contextMaxTokens = options.contextMaxTokens;
    this.eventLog = options.eventLog;
    this.deleteSessionData = options.deleteSessionData;
    this.runStore = options.runStore;
    this.attachIngest = options.attachIngest;

    const dataDir = options.dataDir;
    const snapshotEnabled = dataDir !== undefined && options.snapshot?.enabled !== false;
    this.snapshot =
      snapshotEnabled && dataDir !== undefined
        ? new AgentSnapshotStore(snapshotPath(dataDir, options.tenantId), {
            ...(options.snapshot?.throttleMs !== undefined
              ? { throttleMs: options.snapshot.throttleMs }
              : {}),
            ...(options.snapshot?.mode !== undefined ? { mode: options.snapshot.mode } : {}),
            logger: this.logger,
            now: this.now,
          })
        : undefined;
    this.inbox =
      dataDir !== undefined
        ? new AgentInboxStore({
            dataDir,
            tenantId: options.tenantId,
            logger: this.logger,
            ...(options.inboxMaxMessages !== undefined
              ? { maxMessages: options.inboxMaxMessages }
              : {}),
            // claim 的执行侧前置收口：只有这里知道 scheduler / body mailbox。store 在标
            // consumed 之前调这一步，`inbox{action:'claim'}`（模型侧工具）与 `agents.claim`
            // 才会真的「拿走就再也不投」。
            beforeClaim: (agentId, ids) => this.withdrawQueuedRuns(agentId, ids),
            // inbox 统一批 §6.2：状态机每个 mutation 口落状态后发一条 agent.inbox.changed
            // 帧（recall/claim 无事件的缺口由此补齐；数据仍走 RPC，帧只是触发器）。
            onChange: (agentId, change) => this.emitInboxChanged(agentId, change),
          })
        : undefined;
    if (this.inbox !== undefined) this.runtime.attachInbox?.(this.inbox);
    this.peerStops = options.peerStops;
    this.humanDistress = options.humanDistress;
    this.modelRefError = options.modelRefError;
    this.ready = this.loadSnapshot();
  }

  /**
   * 重启恢复：非 left 成员一律 idle + gone（engine 状态是进程内易失）。
   * ExecutionUnit 只恢复记录，运行时在首次 admit 时惰性重建。
   */
  private async loadSnapshot(): Promise<void> {
    if (!this.snapshot) return;
    let members: PersistedAgentRecord[] = [];
    try {
      members = await this.snapshot.load();
    } catch (error) {
      this.logger.error('agent.snapshot.load_failed', { error: errorText(error) });
      return;
    }
    const idsByName = new Map<string, string[]>();
    let restored = 0;
    let migrated = 0;
    for (const status of members) {
      const record = recordFromStatus(status, this.now());
      // 0.28 迁移收尾（见 `snapshot.ts`）：存量 `single` 降级成 `member`，但它带着
      // `visibility: private` 且没有 Team。member 只允许 team 可见，所以
      // 「member + private」这个组合只可能由迁移产生（`create` 从不产出）。
      // 不处理的话：成员对自己之外的入口全部 `member_not_visible`，也不在任何
      // roster 里 —— 升级即静默消失。按不变式识别，不新增持久字段。
      if (record.role === 'member' && record.visibility === 'private') {
        if (await this.bindMigratedMember(record)) migrated += 1;
      }
      try {
        this.registry.add(record);
        restored += 1;
      } catch (error) {
        this.logger.warn('agent.snapshot.member_skipped', {
          member_id: status.id,
          error: errorText(error),
        });
        continue;
      }
      if (record.name !== undefined) {
        const ids = idsByName.get(record.name);
        if (ids === undefined) idsByName.set(record.name, [record.id]);
        else ids.push(record.id);
      }
      if (record.membership === 'present') {
        this.emit('agent.stale', record, { state: 'idle', presence: 'gone' });
        // q-session-fix：存量记录补壳 —— 修复发生在「创建时补壳」之前的 fleet
        // （典型：fresh fleet 的 owner main，session_id 即成员 id，从未跑过 run，
        // 只有时间线没有壳）。只补 live primary；已退役 / 已关闭成员不动。
        // 幂等：壳在 ⇒ 零写入；失败只 warn，不影响恢复。
        if (record.binding !== undefined && record.binding.retiredAt === undefined) {
          await this.ensureSessionShell(record.binding.bindingId, record.id);
        }
      }
    }
    for (const [name, ids] of idsByName) {
      if (ids.length > 1) {
        if (duplicateNameWarned.has(name)) {
          this.logger.debug('agent.snapshot.duplicate_name', { name, ids });
        } else {
          duplicateNameWarned.add(name);
          this.logger.warn('agent.snapshot.duplicate_name', { name, ids });
        }
      }
    }
    if (migrated > 0) {
      this.logger.warn('agent.snapshot.single_role_migrated', { count: migrated });
    }
    if (restored > 0) this.scheduleSnapshot();
  }

  /**
   * 把迁移后的成员接回 Team：有 defaultWorkspace 时 ensure（幂等）并绑定；
   * 返回是否绑定成功。失败只警告、保留记载 —— 成员仍可按 id 寻址，
   * 只是没有 Team 归属，绝不因为绑定失败把记录丢掉。
   */
  private async bindMigratedMember(record: MemberRecord): Promise<boolean> {
    if (this.teamBinder === undefined || this.defaultWorkspace === undefined) {
      this.logger.warn('agent.snapshot.single_role_unbound', { member_id: record.id });
      return false;
    }
    try {
      const team = await this.teamBinder.ensureForWorkspace({ workspace: this.defaultWorkspace });
      record.teamId = team.team_id;
      record.visibility = 'team';
      return true;
    } catch (error) {
      this.logger.warn('agent.snapshot.single_role_bind_failed', {
        member_id: record.id,
        error: errorText(error),
      });
      return false;
    }
  }

  async create(input: CreateMemberInput): Promise<MemberStatus>;
  async create(input: CreateBatchInput): Promise<BatchResult<MemberStatus>>;
  async create(
    input: CreateMemberInput | CreateBatchInput,
  ): Promise<MemberStatus | BatchResult<MemberStatus>> {
    await this.ready;
    const record = input as unknown as Record<string, unknown>;
    if ('members' in record) {
      if (
        record.id !== undefined ||
        record.role !== undefined ||
        record.name !== undefined ||
        record.model !== undefined ||
        record.systemPrompt !== undefined ||
        record.visibility !== undefined ||
        record.parentId !== undefined ||
        record.owner !== undefined ||
        record.kind !== undefined ||
        record.teamId !== undefined ||
        record.spawnedBy !== undefined ||
        record.workspace !== undefined ||
        record.from_session_id !== undefined ||
        record.seed !== undefined ||
        record.keep_messages !== undefined ||
        record.startup_prompt !== undefined
      ) {
        throw new AgentError(
          'invalid_input',
          'pass either single member fields or members, not both',
        );
      }
      const members = record.members;
      if (!Array.isArray(members)) {
        throw new AgentError('invalid_input', 'members must be an array');
      }
      if (members.length === 0) {
        throw new AgentError('invalid_input', 'members must not be empty');
      }
      const settled = await Promise.allSettled(
        members.map((entry) =>
          isRecord(entry)
            ? this.createOne(entry)
            : Promise.reject(new AgentError('invalid_input', 'member entries must be objects')),
        ),
      );
      return settleBatch(settled);
    }
    return this.createOne(record);
  }

  /**
   * 0.53 U1（ADR-104 §4.6 / §7.2 / §8.3）：给「刚创建 / 刚换 body」的会话声明投射模式。
   *
   * 这一段**只做声明**：
   *
   * - 校验词表与形状（未知 mode / `externalize` 都在这里被拒，见 `declareProjection`）；
   * - 权限收窄：子不能放松父（父 `placeholder` ⇒ 子不能 `passthrough`；
   *   父 `passthrough` ⇒ 子可选 `placeholder`；`archive_notice` 与 `placeholder` 同层）；
   * - 登记到进程内声明表（`armProjectionDeclaration`），由状态写入路径合并落盘。
   *
   * 不改任何运行时行为：没有任何路径读它去裁剪窗口，缺省与有值的会话行为一致。
   *
   * 调用方没要求（`projection` 缺省）时也要写一条：`placeholder` + `default`。
   * 这是「`SessionState.context_projection` 会话创建时写入、**总是在**」的来源，
   * 也让「谁都没声明」和「声明了默认值」在盘上是同一个东西 —— 唯一的区别是后者
   * 带 `declaration_id`，前者（0.53 之前的旧会话）读侧走 `legacy` 解析。
   */
  private declareSessionProjection(options: {
    sessionId: string;
    source: 'session_created' | 'rotate';
    requested: unknown;
    parentSessionIds: readonly (string | undefined)[];
  }): ProjectionDeclaration {
    const requested = options.requested;
    const explicit = requested !== undefined && requested !== null;

    let mode = 'placeholder';
    let rawParams: unknown;
    if (explicit) {
      let requestedMode: unknown;
      if (typeof requested === 'string') {
        requestedMode = requested;
      } else if (isRecord(requested)) {
        requestedMode = requested.mode;
        rawParams = requested.params;
      } else {
        throw new AgentError('invalid_input', 'projection must be a mode string or an object');
      }
      if (requestedMode === undefined) requestedMode = 'placeholder';
      if (typeof requestedMode !== 'string') {
        throw new AgentError('invalid_input', 'projection.mode must be a string');
      }
      mode = requestedMode;
    }

    // 校验 / 收窄失败时抛 `ProjectionPolicyError`：它的 `.code` 就是 ADR-104 §6.4 的
    // 拒绝码，原样出到 RPC 层（gateway 的 `agentErrorCode()` 读的就是 `.code`），
    // 不降级成 `invalid_input`。
    const declaration = declareProjection({
      mode,
      source: explicit ? options.source : 'default',
      params: readProjectionParams(rawParams),
    });
    // 子不能放松父：读不到父会话状态时按默认 placeholder 保守裁决。
    let strictest: ProjectionMode | undefined;
    for (const parentSessionId of options.parentSessionIds) {
      if (parentSessionId === undefined) continue;
      const parentMode = knownProjectionMode(parentSessionId);
      if (parentMode === undefined) continue;
      if (
        strictest === undefined ||
        PROJECTION_MODE_STRICTNESS[parentMode] > PROJECTION_MODE_STRICTNESS[strictest]
      ) {
        strictest = parentMode;
      }
    }
    if (options.parentSessionIds.some((id) => id !== undefined)) {
      assertProjectionModeAllowedForChild(strictest ?? 'placeholder', declaration.mode);
    }
    return armProjectionDeclaration(options.sessionId, declaration);
  }

  /**
   * 第 6 修（CHAIN-11/SPAWN-05）：显式 model pin 落盘前的注册 ref 闸。
   * 与 gateway `agents.create|update` 参数闸同一校验口（装配层注入 validateModelRef）；
   * 缺省不校验（mock / 纯内存零回归）。错误码 invalid_input 与 RPC 闸同形。
   * q-error-e2（§3.6）：结构化透传 ref/candidates（details），不再拼 string。
   */
  private assertModelRef(model: string): void {
    const info = this.modelRefError?.(model);
    if (info !== undefined) {
      throw new AgentError('invalid_input', `model: ${info.message}`, {
        operation: 'assertModelRef',
        details: {
          domain_code: info.code,
          ref: info.ref,
          ...(info.candidates !== undefined ? { candidates: info.candidates } : {}),
        },
      });
    }
  }

  /**
   * q-error-e2（§3.6）：spawn_failed 证据契约 details（各收口点共用）。
   * resolution 按收口点局部知识派生：record.model 有值 = pin（seeded 拷贝点
   * 显式传 'inherit'）；无值 = 宿主缺省（ref 经 port additive getter，裁定 B）。
   * candidates 从 cause 错误结构化读取（ModelRefError 形状），不拼 string。
   */
  private spawnFailureDetails(
    record: MemberRecord,
    error: unknown,
    stage?: 'inherit',
  ): Record<string, unknown> {
    const defaultRef = this.runtime.defaultModelRef?.();
    const modelRef = record.model ?? defaultRef;
    const resolution =
      record.model !== undefined
        ? {
            stage: stage ?? ('pin' as const),
            ref: record.model,
            via: stage === 'inherit' ? ['source.record', 'record.model'] : ['record.model'],
          }
        : {
            stage: 'default' as const,
            ...(defaultRef !== undefined ? { ref: defaultRef } : {}),
            via: ['host.default'],
          };
    const causeCandidates = (error as { candidates?: unknown } | null)?.candidates;
    return {
      ...(record.parentId !== undefined ? { parent_id: record.parentId } : {}),
      ...(record.teamId !== undefined ? { team_id: record.teamId } : {}),
      ...(modelRef !== undefined ? { model_ref: modelRef } : {}),
      resolution,
      ...(Array.isArray(causeCandidates) && causeCandidates.every((c) => typeof c === 'string')
        ? { candidates: causeCandidates }
        : {}),
    };
  }

  private async createOne(input: Record<string, unknown>): Promise<MemberStatus> {
    // CREATE-0.39：有来源走独立的 seeded 分支；公共路径不再受「每源一个派生」限制。
    const fromSessionId =
      input.from_session_id === undefined
        ? undefined
        : readRequiredString(input, 'from_session_id');
    const seed = readCreateSeed(input.seed);
    const keepMessages = readKeepMessages(input.keep_messages);
    // q-session-naming：首会话显式标题（与 rotate 同一形状）。校验早于任何副作用。
    const title = readSessionTitle(input.title);
    // q-hire-prompt：可选启动任务（与 rotate 的 startup_prompt 同一形状）。
    // 校验早于任何副作用；seeded 分支由 createFromSource 自行读取。
    const startupPrompt =
      input.startup_prompt === undefined ? undefined : readContent(input, 'startup_prompt');
    if (fromSessionId === undefined) {
      if (input.seed !== undefined || input.keep_messages !== undefined) {
        throw new AgentError('invalid_input', 'seed / keep_messages require from_session_id');
      }
    } else {
      return this.createFromSource(input, fromSessionId, seed ?? 'copy', keepMessages);
    }
    const kind = input.kind;
    if (kind !== undefined && kind !== 'peer' && kind !== 'contractor') {
      throw new AgentError('invalid_input', 'kind must be peer or contractor');
    }
    const rawOwner = input.owner;
    if (rawOwner !== undefined && rawOwner !== null && !nonEmpty(rawOwner)) {
      throw new AgentError('invalid_input', 'owner must be a non-empty string or null');
    }
    const explicitRole = input.role === undefined ? undefined : readAgentRole(input, 'role');
    if (kind === 'contractor' && rawOwner === null) {
      throw new AgentError('invalid_input', 'contractor requires an owner');
    }
    const peer = kind === 'peer' || rawOwner === null;
    if (peer && typeof rawOwner === 'string') {
      throw new AgentError('invalid_input', 'peer must not specify an owner');
    }

    const id = input.id === undefined ? this.newId() : readRequiredString(input, 'id');
    if (!nonEmpty(id)) throw new AgentError('invalid_input', 'id generator returned an empty id');
    // 保留 id 与保留名同样要拒（只有调用方显式传 id 时才会命中）。
    if (input.id !== undefined) assertExplicitId(id);
    if (this.registry.resolve(id) !== undefined || this.registry.getBySession(id) !== undefined) {
      throw new AgentError('invalid_input', `duplicate member id: ${id}`);
    }
    // v3 映射：peer → member（owner=self）；contractor / 无 kind → temporary（owner=雇佣者）。
    const role: AgentRole = peer ? 'member' : 'temporary';
    // `role` 参数只用于一致性校验，不参与推导：`main` 走 peer，成员由 kind / owner 决定。
    // 允许覆盖会让「显式 role」与「kind 推导」产生两种互相矛盾的身份，所以冲突即拒绝。
    if (explicitRole !== undefined && explicitRole !== role) {
      throw new AgentError(
        'invalid_input',
        `role ${explicitRole} conflicts with the role derived from kind / owner (${role})`,
      );
    }
    // temporary 的缺省 owner 是**人类**（发起创建的人），不是 `defaultOwner`（`main`）。
    // 人类消息的缺省 `from` 就是 `human`；缺省成 `main` 会让每个渠道 / 本地新会话的
    // private 成员对人类不可见，随后每条消息都以 `member_not_visible` 结束。
    const owner = role === 'member' ? id : ((rawOwner as string | undefined) ?? HUMAN_PRINCIPAL);

    const name = optionalString(input.name);
    // 形状校验必须早于任何 registry / team 副作用：名字最终会进跨节点地址，
    // 建出来再发现发不出去，代价是调用方已经拿到 id 了。
    assertMemberName(name);
    const spawnedBy = optionalString(input.spawnedBy);
    // 显式 workspace 只由 CLI 传入；默认 workspace 来自配置声明。
    const explicitWorkspace =
      input.workspace === undefined ? undefined : readRequiredString(input, 'workspace');
    const explicitTeamId =
      input.teamId === undefined ? undefined : readRequiredString(input, 'teamId');
    if (explicitTeamId !== undefined && explicitWorkspace !== undefined) {
      throw new AgentError('invalid_input', 'pass either teamId or workspace, not both');
    }

    let teamId: string | undefined;
    /**
     * 用户在**这个成员身上**显式选中的 Team（0.51 Bug 1 的 cwd 来源）。
     *
     * 只有两种入口算「显式」：传了 `team_id`，或传了 `workspace`（CLI `--workspace`）。
     * `defaultWorkspace` 不算 —— 它是配置声明 / `agent.cwd` 的产物，语义属于全局默认，
     * 烧成成员 cwd 只会把「全局默认」伪装成「per-member 选择」。
     */
    let chosenTeam: TeamRecord | undefined;
    if (explicitTeamId !== undefined) {
      const explicitTeam = this.teamBinder?.get(explicitTeamId);
      if (explicitTeam === undefined) {
        throw new AgentError('invalid_input', `team_not_found: ${explicitTeamId}`);
      }
      teamId = explicitTeamId;
      chosenTeam = explicitTeam;
    } else {
      const workspace = explicitWorkspace ?? this.defaultWorkspace;
      if (workspace !== undefined && name !== undefined) {
        if (this.teamBinder === undefined) {
          throw new AgentError('invalid_input', 'team binding is not configured');
        }
        // Team ensure 必须在名字检查 / registry.add 之前完成（F7：之后不得有 await）。
        const team = await this.teamBinder.ensureForWorkspace({ workspace, name });
        teamId = team.team_id;
        if (explicitWorkspace !== undefined) chosenTeam = team;
      } else if (explicitWorkspace !== undefined) {
        // 默认 workspace 无名字时保持 unbound；显式 workspace 无名字则拒绝绑定。
        throw new AgentError('invalid_input', 'team binding requires a name');
      }
    }

    if (peer && teamId === undefined) {
      throw new AgentError('invalid_input', 'peer members require a team');
    }

    let parentId: string | undefined;
    if (role === 'member') {
      if (input.parentId !== undefined) {
        throw new AgentError('invalid_input', 'peer members must not have a parent');
      }
    } else {
      parentId = optionalString(input.parentId);
      // contractor 缺省以 owner（雇佣者）为 parent；无 kind 的旧请求保持无 parent。
      if (kind === 'contractor' && parentId === undefined) parentId = owner;
    }

    // member 强制 team 可见；temporary 缺省 team（有 Team）或 private（unbound）。
    let visibility: MemberVisibility;
    if (role === 'member') {
      if (input.visibility !== undefined && input.visibility !== 'team') {
        throw new AgentError('invalid_input', 'peer members must use team visibility');
      }
      visibility = 'team';
    } else {
      visibility =
        input.visibility === undefined
          ? teamId !== undefined
            ? 'team'
            : 'private'
          : resolveVisibility(input.visibility, 'private');
    }

    // 名称只由 present 成员占用：同 Team 内唯一；unbound 沿用 tenant 全扫。
    // 名字表达的是职位 / 功能，同 Team 已有同名成员说明这个职能已经有人承担：
    // 复用已存在的成员，不再造一个同职能的。create / hire 缺省不发消息，
    // 「返回 id 让调用方自己决定要不要 send」不会引入隐式动作；显式 startup_prompt
    // 才在创建提交后投递首条任务（q-hire-prompt），复用成员上声明则显式拒绝。
    //
    // **必须排在冻结 / 上限闸门之前**：复用不创建成员、不占额度，上面两条闸门
    // 限制的是「再塞一个进来」。放在后面的话，Team 满员时这条分支永远走不到，
    // 调用方拿到 `team_full` 而看不到「这个职能已经有人做」——恰好是最需要它的
    // 场景。冻结同理：冻结禁止新增，不禁止把已有的交回来。
    if (name !== undefined) {
      const existing = this.reusableByName(name, teamId);
      if (existing !== undefined) {
        // 0.53 U1（ADR-104 §7.2）：复用的是**已经有会话**的成员，它的投射模式早就写定了。
        // 同 mode 重复请求算幂等成功；不同 mode / 读不到模式一律拒绝 —— 静默丢掉
        // 调用方写下的 projection 等于骗他「已经照你说的设好了」。
        if (input.projection !== undefined && input.projection !== null) {
          const requestedMode = requestedProjectionMode(input.projection);
          const existingMode = knownProjectionMode(existing.sessionId);
          if (requestedMode === undefined || existingMode !== requestedMode) {
            throw new AgentError(
              'invalid_input',
              'projection cannot be declared on a reused member; use rotate to give the next ' +
                `session a projection (existing: ${existingMode ?? 'unknown'})`,
            );
          }
        }
        if (title !== undefined) {
          throw new AgentError(
            'invalid_input',
            'title cannot be declared on a reused member; use rotate to name the next session',
          );
        }
        // q-hire-prompt：复用成员已有会话与队列，启动任务不再适用 —— 静默丢掉
        // 调用方写下的任务等于骗他「已经派出去了」，与 title / projection 同例拒绝。
        if (startupPrompt !== undefined) {
          throw new AgentError(
            'invalid_input',
            'startup_prompt cannot be delivered to a reused member; use send to give it a task',
          );
        }
        return { ...this.statusFor(existing), reused: true };
      }
    }
    // 冻结 / 上限 / registry.add 之间不得有 await（F7）。
    // `reusableByName` 是同步的（`registry.findByName`），上面那次提前返回不破坏窗口。
    if (teamId !== undefined && this.teamBinder?.get(teamId)?.spawn_frozen === true) {
      throw new AgentError('team_frozen', `team_frozen: ${teamId}`);
    }
    if (teamId !== undefined && this.presentTeamCount(teamId) >= this.teamMemberLimit) {
      throw new AgentError('team_full', `team_full: ${teamId}`);
    }
    const resolvedName = name !== undefined ? name : this.autoNameFor(spawnedBy, teamId);

    const now = this.now();
    const record: MemberRecord = {
      id,
      sessionId: id,
      binding: { bindingId: id, epoch: 0, createdAt: now, lastActiveAt: now, primary: true },
      role,
      owner,
      visibility,
      state: 'created',
      presence: 'gone',
      membership: 'present',
      rotation: 'stable',
      bindingHistory: [],
    };
    record.name = resolvedName;
    if (teamId !== undefined) record.teamId = teamId;
    // 0.51 Bug 1（方案 C）：把「显式选中 Team 的基础路径」烧进记录，作为成员 cwd 的快照。
    // 锚点 Team 不参与（`<dataDir>/default` 这类目录可能不存在，当 cwd 会打死 main 的工具）。
    const memberCwd = this.createMemberCwd(chosenTeam);
    if (memberCwd !== undefined) record.cwd = memberCwd;
    if (parentId !== undefined) record.parentId = parentId;
    // 只存显式 pin；缺省跟随当前 config（宿主 model），不把默认值烧进记录 ——
    // 烧死默认值会让 config 换模型后旧记录永远优先。
    const model = optionalString(input.model);
    if (model !== undefined) {
      // 第 6 修（CHAIN-11/SPAWN-05）：tool 层 create/hire 与 RPC 同闸——显式 pin
      // 必须是可解析 ref，落盘前拒绝毒 pin（batch 经 createOne 逐条拒绝，不整批抛错）。
      this.assertModelRef(model);
      record.model = model;
    }
    const systemPrompt = optionalString(input.systemPrompt);
    if (systemPrompt !== undefined) record.systemPrompt = systemPrompt;

    // 0.53 U1（ADR-104）：首会话的上下文投射声明。校验 / 收窄都在 spawn 之前，
    // 声明失败不留半个成员；声明只登记不裁剪窗口（行为与现在完全一致）。
    this.declareSessionProjection({
      sessionId: record.sessionId,
      source: 'session_created',
      requested: input.projection,
      parentSessionIds: [parentId, spawnedBy],
    });

    try {
      await this.spawnRecord(record);
    } catch (error) {
      throw new AgentError('spawn_failed', errorText(error), {
        cause: error,
        operation: 'create.spawn',
        details: this.spawnFailureDetails(record, error),
      });
    }
    this.emit('agent.spawned', record, {
      state: 'idle',
      presence: 'live',
      ...(spawnedBy !== undefined ? { spawned_by: spawnedBy } : {}),
    });
    this.rememberPeerOrigin(record, spawnedBy);
    // 事件描述实体：冷建也发 `session.created`（不带 source 字段）。best-effort。
    await this.appendSessionEvent(record.id, 'session.created', {
      side: 'new',
      agent_id: record.id,
      session_id: record.id,
      primary: true,
    }).catch((error: unknown) => {
      this.logger.warn('agent.session.created_failed', {
        agent_id: record.id,
        session_id: record.id,
        error: errorText(error),
      });
    });
    // q-session-naming：agent 派生的成员（spawnedBy 有值）首会话按成员身份命名，
    // 不再依赖「截断首消息 / AI 摘要」；显式 title 优先。bootstrap 创建（如 main，
    // 无 spawnedBy）保持既有派生 + AI 命名链路。
    if (title !== undefined || spawnedBy !== undefined) {
      await this.nameNewSession(record, record.sessionId, title);
    }
    // q-hire-prompt：启动任务在创建提交后投递（首轮 run input）；statusFor 在
    // 投递之后取，调用方看到的 state 已反映首轮（queued / running）。
    if (startupPrompt !== undefined) {
      // q-startup-source-fix：创建者 = spawnedBy（工具层声明）或 parentId
      // （contractor 的 parent 缺省 owner）；peer 无 parentId，人 RPC 缺省
      // owner=human ⇒ 未登记 ⇒ deliverStartupPrompt 回落 system。
      await this.deliverStartupPrompt(record, startupPrompt, spawnedBy ?? parentId);
    }
    return this.statusFor(record);
  }

  /**
   * q-hire-prompt：create / hire 的可选启动任务投递 —— 与 createSession 的
   * startup_prompt 同一形状（admitInternal `startup: true`：直接作首轮 run input，
   * 不进 inbox，后续 send 正常排队）。
   *
   * q-startup-source-fix：来源归属创建者。agent 经内置工具 create / hire 时生产者
   * 就是创建者（tool.ts 写 spawnedBy=caller.id）；创建者是本机登记成员时
   * from=创建者 ⇒ source='agent' + from_name ⇒ 执行内核推导 `agent:<alias>`
   * （runtime.ts `agentInputName`），Web 走正常 from-card，来源行被吸收进卡、
   * 卡上回信地址指向创建者。人 / RPC 创建（无创建者声明，或创建者未在本机登记）
   * 保持 from=system，开场白按正文渲染（types.ts `input_name` 裁定：谁写的这句话
   * 由生产者声明，不从 system 来源统一推断）。不标 input_name：身份由
   * from / source / from_name 承载，与正常 send 同一条推导路。
   *
   * best-effort：失败只 warn，不回滚已提交的创建（与
   * `agent.session_create.startup_failed` 同口径）。
   */
  private async deliverStartupPrompt(
    record: MemberRecord,
    startupPrompt: string,
    creatorId?: string,
  ): Promise<void> {
    // 只认本机登记的创建者：保留 principal（human / system）、已失效的 id、
    // 未登记的外部地址一律回落 system —— 宁可保持现状，不冒认 agent。
    const from =
      creatorId !== undefined && this.registry.get(creatorId) !== undefined
        ? creatorId
        : SYSTEM_PRINCIPAL;
    try {
      await this.admitInternal(
        {
          content: startupPrompt,
          agent_id: record.id,
          session_id: record.sessionId,
          from,
          channel: 'direct',
          conversation_id: generateConversationId(this.newId),
          strict: false,
        },
        { startup: true },
      );
    } catch (error) {
      this.logger.warn('agent.create.startup_failed', {
        agent_id: record.id,
        error: errorText(error),
      });
    }
  }

  /**
   * 自重启 Option A（runlost-graceful-restart-audit §4.2 件 3）：跨进程续作投递。
   *
   * 新进程启动扫到 continuation 标记且触发者 run 已 completed 时，把嘱托以
   * `admitInternal {startup:true}` 投递（deliverStartupPrompt 同款通道：直接作
   * 首轮 run input、不进 inbox）→ 新 run 发起 → 续作开始。这是 rotate 交接嘱托
   * 的跨进程版——机制已存在，这里只补持久化触发源的公开入口。嘱托标
   * `tool:system` 身份（`CONTINUATION_INPUT_NAME`）：Web 渲成「来自 system」卡，
   * 不再画成用户气泡。
   *
   * 判据与 announceEnvironmentCard 同口径：no_member / left / closed / retired
   * 不投递（装配层据此清僵尸标记或降级）。失败如实回报，不抛错。
   */
  async deliverContinuationPrompt(
    sessionId: string,
    prompt: string,
  ): Promise<{ delivered: boolean; reason?: string }> {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return { delivered: false, reason: 'empty_prompt' };
    }
    await this.ready;
    const record = this.registry.getBySession(sessionId);
    if (record === undefined) return { delivered: false, reason: 'no_member' };
    if (record.membership === 'left') return { delivered: false, reason: 'left' };
    if (record.state === 'closed') return { delivered: false, reason: 'closed' };
    if (this.registry.isRetiredSession(sessionId)) return { delivered: false, reason: 'retired' };
    try {
      // 声明会话身份：嘱托是上一具身体写的交接书，不是人打的字（见
      // `CONTINUATION_INPUT_NAME`）。不声明时 system 来源落不到 name ⇒ Web 画成用户气泡。
      const outcome = await this.admitInternal(
        {
          content: prompt,
          agent_id: record.id,
          session_id: sessionId,
          from: SYSTEM_PRINCIPAL,
          channel: 'direct',
          conversation_id: generateConversationId(this.newId),
          strict: false,
        },
        { startup: true, inputName: CONTINUATION_INPUT_NAME },
      );
      if (outcome.result.status === 'deferred') {
        return { delivered: false, reason: outcome.result.reason ?? 'deferred' };
      }
      this.logger.info('agent.continuation.delivered', {
        agent_id: record.id,
        session_id: sessionId,
        ...(outcome.result.run_id !== undefined ? { run_id: outcome.result.run_id } : {}),
      });
      return { delivered: true };
    } catch (error) {
      this.logger.warn('agent.continuation.delivery_failed', {
        agent_id: record.id,
        session_id: sessionId,
        error: errorText(error),
      });
      return { delivered: false, reason: 'failed' };
    }
  }

  /**
   * `agents.create{from_session_id}`：新 agent + 新 session，种子来自源 transcript。
   *
   * 源 agent / 源 session 零改动、仍可跑；不受「每源一个派生」限制（该限制只
   * 保留在内部 dispatch 的 `createDerivedAgent`）。新 agent + 新 session 失败一起清理。
   */
  private async createFromSource(
    input: Record<string, unknown>,
    fromSessionId: string,
    seed: CreateSeed,
    keepMessages: number | undefined,
  ): Promise<MemberStatus> {
    if (this.eventLog === undefined) {
      throw new AgentError('invalid_input', 'seed_unavailable: event_log_unavailable');
    }
    const sourceHit = this.findSessionAnyState(fromSessionId);
    if (sourceHit === undefined) {
      throw new AgentError('unknown_member', `not_found: session ${fromSessionId}`);
    }
    if (sourceHit.state !== 'primary') {
      throw new AgentError('conflict', `not_primary: ${fromSessionId}`);
    }
    const source = sourceHit.record;
    if (source.visibility === 'private') {
      throw new AgentError('invalid_input', `source_private: ${source.id}`);
    }
    await this.assertSourceIdle(source, fromSessionId);

    // q-session-naming：首会话显式标题（与 createOne / rotate 同一形状）。
    const title = readSessionTitle(input.title);
    // q-hire-prompt：seeded 路径同样支持可选启动任务（校验早于任何副作用）。
    const startupPrompt =
      input.startup_prompt === undefined ? undefined : readContent(input, 'startup_prompt');

    const kind = input.kind;
    if (kind !== undefined && kind !== 'peer' && kind !== 'contractor') {
      throw new AgentError('invalid_input', 'kind must be peer or contractor');
    }
    const derivedKind = source.role === 'member' ? 'peer' : 'contractor';
    if (kind !== undefined && kind !== derivedKind) {
      throw new AgentError(
        'invalid_input',
        `kind conflicts with source role (${source.role} implies ${derivedKind})`,
      );
    }
    if (input.workspace !== undefined) {
      throw new AgentError('invalid_input', 'workspace is not allowed with from_session_id');
    }
    // 结构字段不可覆盖。
    if (input.owner !== undefined || input.parentId !== undefined) {
      throw new AgentError(
        'invalid_input',
        'owner / parentId are derived from the source and cannot be overridden',
      );
    }
    if (input.role !== undefined && readAgentRole(input, 'role') !== source.role) {
      throw new AgentError('invalid_input', `role conflicts with source role (${source.role})`);
    }
    if (input.teamId !== undefined && readRequiredString(input, 'teamId') !== source.teamId) {
      throw new AgentError('invalid_input', 'teamId conflicts with source team');
    }

    const teamId = source.teamId;
    if (teamId === undefined || this.teamBinder === undefined) {
      throw new AgentError('invalid_input', 'source_no_team: source agent has no team');
    }
    const team = this.teamBinder.get(teamId);
    if (team === undefined) {
      throw new AgentError('invalid_input', `source_no_team: ${teamId}`);
    }
    if (team.spawn_frozen === true) {
      throw new AgentError('team_frozen', `team_frozen: ${teamId}`);
    }
    if (this.presentTeamCount(teamId) >= this.teamMemberLimit) {
      throw new AgentError('team_full', `team_full: ${teamId}`);
    }

    const id = input.id === undefined ? this.newId() : readRequiredString(input, 'id');
    if (!nonEmpty(id)) throw new AgentError('invalid_input', 'id generator returned an empty id');
    if (input.id !== undefined) assertExplicitId(id);
    if (this.registry.resolve(id) !== undefined || this.registry.getBySession(id) !== undefined) {
      throw new AgentError('invalid_input', `duplicate member id: ${id}`);
    }

    const explicitName = optionalString(input.name);
    assertMemberName(explicitName);
    let name: string;
    if (explicitName !== undefined) {
      if (this.nameOccupied(explicitName, teamId)) {
        throw new AgentError('invalid_input', `name_taken: ${explicitName}`);
      }
      name = explicitName;
    } else {
      const derived = this.derivedNameFor(source.name ?? source.id, seed, teamId);
      if (derived === undefined) {
        throw new AgentError('invalid_input', 'name_exhausted');
      }
      name = derived;
    }

    const role = source.role;
    const owner = role === 'member' ? id : source.owner;
    let visibility: MemberVisibility;
    if (role === 'member') {
      if (input.visibility !== undefined && input.visibility !== 'team') {
        throw new AgentError('invalid_input', 'peer members must use team visibility');
      }
      visibility = 'team';
    } else {
      visibility =
        input.visibility === undefined
          ? source.visibility
          : resolveVisibility(input.visibility, source.visibility);
    }
    // 只存显式 pin：input 显式 > 源的显式 pin（派生 = 身份拷贝，pin 随源）；缺省跟随 config。
    // 第 6 修：只校验**显式 input**；源记录 pin 拷贝不重验（存量 legacy pin 不因派生被误杀）。
    const inputModel = optionalString(input.model);
    if (inputModel !== undefined) this.assertModelRef(inputModel);
    const model = inputModel ?? source.model;
    const systemPrompt = optionalString(input.systemPrompt) ?? source.systemPrompt;
    const spawnedBy = optionalString(input.spawnedBy);

    // 先只读源、计算种子；任何校验/读取失败都发生在创建之前。
    const seedResult = await this.buildSeed(fromSessionId, seed, keepMessages);
    const seedMeta = {
      agentId: id,
      sessionId: id,
      sourceSessionId: fromSessionId,
      seed,
      ...(keepMessages !== undefined ? { keepMessages } : {}),
      keepProjected: seedResult.keepProjected,
      copiedMessages: seedResult.copiedMessages,
    };

    const now = this.now();
    const record: MemberRecord = {
      id,
      sessionId: id,
      binding: { bindingId: id, epoch: 0, createdAt: now, lastActiveAt: now, primary: true },
      name,
      role,
      owner,
      visibility,
      state: 'created',
      presence: 'gone',
      membership: 'present',
      rotation: 'stable',
      bindingHistory: [],
      sourceAgentId: source.id,
    };
    record.teamId = teamId;
    if (source.parentId !== undefined) record.parentId = source.parentId;
    if (model !== undefined) record.model = model;
    if (systemPrompt !== undefined) record.systemPrompt = systemPrompt;
    // 派生成员与源同一个 Team ⇒ 同一个成员 cwd（仍是快照，不重新判定「显式」与否）。
    if (source.cwd !== undefined) record.cwd = source.cwd;

    // 0.53 U1（ADR-104）：派生会话同样在创建时声明投射模式；父 = 源会话。
    // 校验 / 收窄失败发生在 spawn 之前，不留半个成员。
    this.declareSessionProjection({
      sessionId: record.sessionId,
      source: 'session_created',
      requested: input.projection,
      parentSessionIds: [fromSessionId, record.parentId, spawnedBy],
    });

    // E2 §3.6：pin 来自源拷贝（无显式 input）时 resolution.stage='inherit'。
    const inheritStage =
      inputModel === undefined && source.model !== undefined ? ('inherit' as const) : undefined;

    try {
      await this.spawnRecord(record);
    } catch (error) {
      const failure = new AgentError('spawn_failed', errorText(error), {
        cause: error,
        operation: 'create.spawn',
        details: this.spawnFailureDetails(record, error, inheritStage),
      });
      this.emitForSession('agent.create.failed', source, fromSessionId, {
        from: source.id,
        to: name,
        reason: errorText(error),
        error_id: failure.errorId,
        operation: 'create.spawn',
        from_session_id: fromSessionId,
        seed,
      });
      throw failure;
    }

    try {
      await this.writeSeedEvents(seedMeta, seedResult);
    } catch (error) {
      // 新 agent + 新 session 原子清理；源零改动。
      await this.disposeAgentBodies(record);
      this.registry.remove(record.id);
      this.executionUnitRegistry.delete(record.id);
      await this.cleanupSessionData(record.id, record.id);
      this.scheduleSnapshot();
      const failure = new AgentError('spawn_failed', errorText(error), {
        cause: error,
        operation: 'create.seed',
        details: this.spawnFailureDetails(record, error, inheritStage),
      });
      this.emitForSession('agent.create.failed', source, fromSessionId, {
        from: source.id,
        to: name,
        reason: errorText(error),
        error_id: failure.errorId,
        operation: 'create.seed',
        from_session_id: fromSessionId,
        seed,
      });
      throw failure;
    }

    this.emit('agent.spawned', record, {
      state: 'idle',
      presence: 'live',
      ...(spawnedBy !== undefined ? { spawned_by: spawnedBy } : {}),
      source_agent_id: source.id,
      from_session_id: fromSessionId,
      seed,
      // CONTRACT r10 §5.1：事件只带投影边界，不带 wire keep_messages。
      keep_projected: seedResult.keepProjected,
      copied_messages: seedResult.copiedMessages,
    });
    this.rememberPeerOrigin(record, spawnedBy);
    // q-session-naming：与 createOne 同口径 —— 显式 title 优先，agent 派生缺省用成员名。
    if (title !== undefined || spawnedBy !== undefined) {
      await this.nameNewSession(record, record.sessionId, title);
    }
    // q-hire-prompt：与 createOne 同口径 —— 创建提交后投递启动任务（best-effort）。
    if (startupPrompt !== undefined) {
      // q-startup-source-fix：只认 spawnedBy —— seeded 路径的 record.parentId
      // 是**源**的 parent，不是本次创建的创建者，不能拿来兜底。
      await this.deliverStartupPrompt(record, startupPrompt, spawnedBy);
    }
    return this.statusFor(record);
  }

  /**
   * 运行入口未收口判据：active / 首个 queued / 在途 spawn。
   * 返回 run id（queued 取第一个）；spawn 窗口返回 `'spawn'`。
   */
  private pendingRunId(entry: ExecutionUnitEntry | undefined): string | undefined {
    if (entry === undefined) return undefined;
    if (entry.active !== undefined) return entry.active.runId;
    const queued = entry.queuedRuns.values().next().value;
    if (queued !== undefined) return queued;
    if (entry.spawning !== undefined) return 'spawn';
    return undefined;
  }

  /** 源 primary 有 active / queued / 在途 spawn 时拒绝（不排队、不取消）。 */
  private assertSourceIdle(record: MemberRecord, sessionId: string): void {
    const pending = this.pendingRunId(this.findEntry(record.id, sessionId));
    if (pending !== undefined) {
      throw new AgentError('conflict', `run_in_progress: ${pending}`);
    }
  }

  /**
   * create 失败后的新 session 清理：只删事件日志 / 元数据，不碰源。
   * 未注入清理能力时记录 `agent.create_cleanup_skipped`；清理抛错记录
   * `agent.create_cleanup_failed`，不影响原始失败返回。
   */
  private async cleanupSessionData(sessionId: string, agentId: string): Promise<void> {
    // 0.53 U1：会话被清掉时同时忘掉进程内的投射声明登记，别让登记表长成泄漏。
    forgetProjectionDeclaration(sessionId);
    if (this.deleteSessionData === undefined) {
      this.logger.warn('agent.create_cleanup_skipped', {
        agent_id: agentId,
        session_id: sessionId,
        reason: 'no_cleanup_injected',
      });
      return;
    }
    try {
      await this.deleteSessionData(sessionId);
    } catch (error) {
      this.logger.warn('agent.create_cleanup_failed', {
        agent_id: agentId,
        session_id: sessionId,
        error: errorText(error),
      });
    }
  }

  /** 只读反查 session 属于哪个记录、处于什么状态；未知返回 undefined。 */
  private findSessionAnyState(
    sessionId: string,
  ): { record: MemberRecord; state: SessionBindingState } | undefined {
    for (const record of this.registry.all()) {
      const state = findSessionState(record, sessionId);
      if (state !== undefined) return { record, state };
    }
    return undefined;
  }

  /**
   * 从来源事件日志投影出种子：先 slice(0, keepProjected)，再过滤运行时提示 /
   * 重复压缩摘要，修掉被边界切断的 tool 配对，最后深拷贝 + 重赋时间戳。
   * 源事件 / 源 SessionState 只读。
   */
  private async buildSeed(
    sourceSessionId: string,
    seed: CreateSeed,
    keepMessages: number | undefined,
  ): Promise<SeedResult> {
    if (this.eventLog === undefined) {
      throw new AgentError('invalid_input', 'seed_unavailable: event_log_unavailable');
    }
    await this.eventLog.flush(sourceSessionId);
    const events = await this.eventLog.read(sourceSessionId);
    // 0.54：种子会被写成新会话的 `message.injected` **事实**（`writeSeedEvents`）。
    // 事实日志里不许出现清集替换的占位正文 —— 否则「原文只剩事件日志」这条读回路径
    // 在新会话上当场失效：`sessions.get` 的 projection 会按「正文已是占位」判成
    // `original_available:'readback'`，而日志里回的仍然是占位。
    // 新会话自己的模型视图不受影响：段起点按它自己的窗口重算集合
    // （`freezeSegmentClearedToolResults`），请求视图照旧有占位。
    const projected = projectMessages(events, { applyClearedReplacements: false });
    if (keepMessages !== undefined && keepMessages > projected.length) {
      throw new AgentError(
        'invalid_input',
        `keep_messages out of range: ${keepMessages} > ${projected.length}`,
      );
    }
    const keepProjected = keepMessages === undefined ? projected.length : keepMessages;
    let prefix = projected.slice(0, keepProjected);
    // 防御性丢弃 base system（projection 不产生）。
    prefix = prefix.filter(
      (message) => !(message.role === 'system' && message.compaction_summary !== true),
    );
    // 丢弃旧 session 的运行时提示（vessel:notice / limit / source / hook / subscription）。
    prefix = prefix.filter((message) => !isRuntimeSeedMessage(message));
    // 压缩摘要最多保留最后一条。
    prefix = keepLastCompactionSummary(prefix);
    // 修掉被 keep 边界切断的 tool 配对。
    prefix = repairCutToolPairs(prefix);
    if (seed === 'compact') {
      prefix = await compactMessagesForSeed(prefix, {
        ...(this.summarizer !== undefined ? { summarizer: this.summarizer } : {}),
        ...(this.contextMaxTokens !== undefined ? { maxTokens: this.contextMaxTokens } : {}),
      });
      prefix = repairCutToolPairs(prefix);
    }
    const baseTs = this.now();
    const messages: Message[] = prefix.map((message, index) => {
      const cloned = structuredClone(message) as Message;
      cloned.timestamp = baseTs + index;
      return cloned;
    });
    return { messages, keepProjected, copiedMessages: messages.length };
  }

  /**
   * 把种子写进新 session 的事件日志：message.injected × N → vessel:created → session.created。
   *
   * 三点取舍：
   * - **整批单次 write + 单次 fsync**（`SessionEventLog.appendMany`）：逐条 append 的
   *   成本是 1.52ms/条（durable：每条一次 stat + 一次 write + 一次 fsync），1814 条
   *   消息的种子 ≈ 2.8s 全串行卡在 create RPC 里；只关掉逐条 fsync 也还有
   *   0.58ms/条 ≈ 1.05s（每条仍是 stat + write）。整批拼一个 buffer 后这一项从
   *   「按条数线性」变成「按批一次」≈1ms。
   * - **崩溃安全没有变弱，反而更强**：逐条 fsync 并**不**给种子任何原子性——它只保证
   *   「已经返回的那次 append 已落盘」，写到一半崩溃同样会留下「消息只写了一截」的
   *   会话；而这里 `session.created` 排在最后，最坏情况是「消息前缀 + 没有
   *   session.created」（该事件当前没有读取方，缺失即视为「不存在的会话」）。
   *   改成整批写之后，崩溃只会让整批停在某个前缀，**不会**出现逐条 fsync 才可能
   *   出现的空洞（后面的条目已落盘、前面的没有）；返回前的最后一次 fsync 则保证
   *   调用方拿到新 session 时整批都已在盘上。换句话说：崩溃时的可能性集合是
   *   「前缀 + 无 created」，比「逐条已落盘、彼此之间可缺」更小。
   * - **`session.created` 最后写**：崩溃时新会话要么不存在、要么完整，不再留下
   *   「已创建、消息只写了一截」的半成品。
   */
  private async writeSeedEvents(
    meta: {
      agentId: string;
      sessionId: string;
      sourceSessionId: string;
      seed: CreateSeed;
      keepMessages?: number;
      keepProjected: number;
      copiedMessages: number;
      mode?: 'conversation' | 'both';
    },
    seedResult: SeedResult,
  ): Promise<void> {
    const eventLog = this.eventLog;
    if (eventLog === undefined) {
      throw new Error('event_log_unavailable');
    }
    const baseData: Record<string, unknown> = {
      side: 'new',
      agent_id: meta.agentId,
      session_id: meta.sessionId,
      source_session_id: meta.sourceSessionId,
      seed: meta.seed,
      // CONTRACT r10 §5.4：事件只带投影边界，不带 wire keep_messages。
      keep_projected: meta.keepProjected,
      copied_messages: meta.copiedMessages,
      ...(meta.mode !== undefined ? { mode: meta.mode } : {}),
    };
    // 事件输入类型直接由端口函数取，种子路径不需要新增 core 的公开类型导出。
    type SeedEventInput = Parameters<SessionEventLogPort['append']>[0];
    // 0.56：种子消息也走同一条身份口径 —— 它们是**进了新会话的消息**，落盘后前端要按
    // `message_id` 归并；没有 id 的话 fork 出来的会话整段历史都退回内容比较。
    // `withMessageId` 只补缺：从父会话复制来的消息带着它当初的身份，原样保留。
    const events: SeedEventInput[] = seedResult.messages.map((message, index) => ({
      session_id: meta.sessionId,
      run_id: meta.sessionId,
      type: 'message.injected',
      ts: this.now(),
      data: { message: withMessageId(message, seedMessageIdOf(meta.sessionId, index)) },
    }));
    events.push({
      session_id: meta.sessionId,
      run_id: meta.sessionId,
      type: 'message.injected',
      ts: this.now(),
      data: {
        message: withMessageId(
          createdNotice(meta),
          seedMessageIdOf(meta.sessionId, seedResult.messages.length),
        ),
      },
    });
    events.push({
      session_id: meta.sessionId,
      run_id: meta.sessionId,
      type: 'session.created',
      ts: this.now(),
      data: baseData,
    });

    // 批量端口（`SessionEventLog.appendMany`）：整批一次 write、一次 fsync。
    type BatchAppender = {
      appendMany?: (inputs: readonly SeedEventInput[]) => Promise<unknown>;
    };
    const appendMany = (eventLog as SessionEventLogPort & BatchAppender).appendMany;
    if (typeof appendMany === 'function') {
      await appendMany.call(eventLog, events);
      return;
    }

    // 退化路径（端口实现没有 appendMany）：整批非 durable + 末尾一次 sync()。
    // 实现没有 `sync` 时不能省 fsync，否则「整批落盘」的补偿动作不存在。
    const deferred = typeof eventLog.sync === 'function' ? { durable: false } : {};
    for (const event of events) {
      await eventLog.append({ ...event, ...deferred });
    }
    await eventLog.sync?.(meta.sessionId);
  }

  /**
   * Additive（q-session-fix）：best-effort 补齐会话壳。
   *
   * 会话身份在创建 / 换体 / 快照恢复时就已成立（时间线有 `session.created`），但壳
   * 此前要等首轮 run 才落盘 —— 从未跑过的 body（fresh fleet 的 owner `main`）会让
   * WebUI 默认会话入口 `sessions.get` 直接 not_found。壳写失败只 warn：创建 / 恢复
   * 本身已提交，不能因为补壳失败回滚或丢弃成员（与 `session.created` 同口径）。
   */
  private async ensureSessionShell(sessionId: string, agentId: string): Promise<void> {
    try {
      await this.runtime.ensureSessionShell?.(sessionId);
    } catch (error) {
      this.logger.warn('agent.session.shell_ensure_failed', {
        agent_id: agentId,
        session_id: sessionId,
        error: errorText(error),
      });
    }
  }

  /**
   * q-session-naming：给新建 / 换体的会话一个有意义的名字。
   *
   * 显式 title 优先；缺省退回成员 name（再退 id）。复用 `setSessionTitle` 的
   * 'manual' 口径：命名后派生截断（deriveSessionMeta）与 AI 命名都不再覆盖，
   * 人工 rename 仍然有效。best-effort 与壳 / 事件写入同口径：命名失败只 warn，
   * 绝不回滚已提交的创建 / 换体。
   */
  private async nameNewSession(
    record: MemberRecord,
    sessionId: string,
    explicitTitle?: string,
  ): Promise<void> {
    // 显式 title 优先；缺省退回成员 name（再退 id）。跳过 undefined / 空串候选，
    // 保证落壳的永远是一个有意义的名字（undefined / 空标题不该出现）。record.id
    // 恒为非空字符串，是最终兜底。
    const title =
      [explicitTitle, record.name, record.id].find(
        (candidate): candidate is string =>
          typeof candidate === 'string' && candidate.trim() !== '',
      ) ?? record.id;
    try {
      const applied = await this.runtime.setSessionTitle?.(sessionId, title, 'manual');
      if (applied !== true) {
        this.logger.warn('agent.session_create.title_unavailable', {
          agent_id: record.id,
          session_id: sessionId,
        });
      }
    } catch (error) {
      this.logger.warn('agent.session_create.title_failed', {
        agent_id: record.id,
        session_id: sessionId,
        error: errorText(error),
      });
    }
  }

  /** session 级事件 best-effort 写入（事件日志缺失时静默跳过）。 */
  private async appendSessionEvent(
    sessionId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (this.eventLog === undefined) return;
    await this.eventLog.append({
      session_id: sessionId,
      run_id: sessionId,
      type,
      ts: this.now(),
      data,
    });
  }

  /**
   * 派生名：`<source>-<copy|compact>` → `-2..-100`；同 Team present 占用才跳过。
   */
  private derivedNameFor(
    base: string,
    suffix: string,
    teamId: string | undefined,
  ): string | undefined {
    const safeBase = MEMBER_NAME_RE.test(base) ? base : 'agent';
    for (let index = 1; index <= 100; index += 1) {
      const candidate = index === 1 ? `${safeBase}-${suffix}` : `${safeBase}-${suffix}-${index}`;
      if (!MEMBER_NAME_RE.test(candidate)) continue;
      if (!this.nameOccupied(candidate, teamId)) return candidate;
    }
    return undefined;
  }

  /** 同 Team 的 present 成员数（上限闸门；与 name 检查同在无 await 窗口） */
  private presentTeamCount(teamId: string): number {
    let count = 0;
    for (const record of this.registry.all()) {
      if (record.membership === 'present' && record.teamId === teamId) count += 1;
    }
    return count;
  }

  /** name 是否被 present 成员占用：同 Team 内唯一；unbound 沿用 tenant 全扫 */
  private nameOccupied(name: string, teamId: string | undefined): boolean {
    return this.reusableByName(name, teamId) !== undefined;
  }

  /**
   * create 时的成员 cwd（0.51 Bug 1 方案 C）。
   *
   * 只认**显式选中**的 Team（`chosenTeam`），并排除系统锚点 workspace：锚点是按路径派生的
   * 身份（`<dataDir>/default` / `<dataDir>/headless`），目录可能不存在 —— 当 cwd 用会让
   * `main` 的 bash / read / edit 直接硬报错（`member-cwd.ts` 的铁律 1）。
   *
   * 这里**不做存在性校验**：目录可能在 create 之后才建（用户先建 Team 再 clone 仓库）。
   * 校验与降级都在 spawn 侧（那时才知道能不能用），本函数只负责「记下用户选了什么」。
   */
  private createMemberCwd(team: TeamRecord | undefined): string | undefined {
    // 判据只此一处（`memberCwdFromTeam`）：装配层 `cwdFor` 与这里必须同源。
    return memberCwdFromTeam(team?.workspace, this.anchorWorkspaces);
  }

  /**
   * 记录换 / 绑 Team 后重算成员 cwd 快照（0.51）。
   *
   * 为什么必须跟着 `team_id` 走：cwd 与 `team_id` 是同一份身份的两种表达。Team 变了而快照
   * 不跟着变，这具 body 会一直在旧 Team 的目录里跑，且**下一具 body 也照样错**（快照是
   * spawn 的输入）。锚点 Team / unbound ⇒ 清空，工具退回 `agent.cwd` / `process.cwd()`。
   */
  private syncMemberCwd(record: MemberRecord, teamId: string | undefined): void {
    const cwd = this.createMemberCwd(
      teamId === undefined ? undefined : this.teamBinder?.get(teamId),
    );
    if (cwd === undefined) delete record.cwd;
    else record.cwd = cwd;
  }

  /**
   * 同 Team present 成员里叫这个名字的那个（unbound 时 tenant 全扫）。
   * 名字是职能标签，重名即「这个职能已有人做」——create / hire 复用它而不是新建。
   */
  private reusableByName(name: string, teamId: string | undefined): MemberRecord | undefined {
    return this.registry
      .findByName(name)
      .find(
        (record) =>
          record.membership === 'present' && (teamId === undefined || record.teamId === teamId),
      );
  }

  /**
   * `${base}-2..${base}-101` 中第一个未被占用的名字；100 次仍冲突则 name_exhausted。
   * 占用判据就是 `nameOccupied`：同 Team 的 present 成员（unbound 时 tenant 全扫），
   * 不同 Team 可以同名。
   */
  private numberedNameFor(base: string, teamId: string | undefined): string {
    for (let index = 2; index <= 101; index += 1) {
      const candidate = `${base}-${index}`;
      if (!this.nameOccupied(candidate, teamId)) return candidate;
    }
    throw new AgentError('invalid_input', `name_exhausted: ${base}`);
  }

  /**
   * 缺省名：以派生出的 base 走 numbering。
   *
   * base 可能来自 `spawnedBy` 的既有名字 —— 存量快照里可能有形状非法的名字
   * （校验是后加的），派生出来的名字同样进跨节点地址，所以 base 不合法就退回
   * `agent`，不让一条旧记录把非法形状传染给新建成员。
   *
   * 保留 principal（`human` / `system`）不会由这里派生出来：base 无论是什么都要经
   * `numberedNameFor` 变成 `${base}-<n>`（n ≥ 2），结果永远不是保留名 —— 所以
   * `spawnedBy: 'human'` 得到的是 `human-2`，可以合法存在。这也是这里**不**额外
   * 加保留名回退的原因：加了会把既有自动命名从 `human-2` 改成 `agent-2`。
   * 若以后改 `numberedNameFor` 让它可能返回裸 base，保留名回退必须补在这里。
   */
  private autoNameFor(spawnedBy: string | undefined, teamId: string | undefined): string {
    const derived =
      (spawnedBy !== undefined ? this.registry.resolve(spawnedBy)?.name : undefined) ??
      spawnedBy ??
      'agent';
    const base = MEMBER_NAME_RE.test(derived) ? derived : 'agent';
    return this.numberedNameFor(base, teamId);
  }

  /**
   * 创建路径共用的 spawn / 回滚骨架（createOne / createFromSource / createDerivedAgent）。
   * registry.add → 首个 ExecutionUnit lease + runtime.spawn；失败移除记录 / ExecutionUnit 后重抛。
   */
  private async spawnRecord(record: MemberRecord): Promise<void> {
    const body = primaryBinding(record);
    if (body === undefined) throw new Error('missing initial body');
    this.registry.add(record);
    let entry: ExecutionUnitEntry | undefined;
    try {
      entry = await this.entryFor(record, body);
      await this.runtime.spawn(entry.runtimeMember);
      entry.spawned = true;
    } catch (error) {
      if (entry !== undefined) await this.disposeEntry(entry);
      this.registry.remove(record.id);
      this.executionUnitRegistry.delete(record.id);
      throw error;
    }
    this.registry.setState(record.id, 'idle');
    this.registry.setPresence(record.id, 'live');
    this.scheduleSnapshot();
    // q-session-fix：首会话壳随创建落地（此前要等首轮 run），否则从未跑过的 body
    // 在 WebUI 默认会话入口里是「会话不存在」。best-effort，不影响 spawn 结果。
    await this.ensureSessionShell(body.bindingId, record.id);
  }

  /**
   * 内部 dispatch 自动创建：resume 失败后的兜底。single-flight（同一源并发只 spawn 一次）。
   * 失败一律显式且零写入；成功时源仍保持 present + gone。
   * 只有这条内部路径保留「每源一个 present 派生」幂等检查；公共 seeded create 不受限。
   */
  private async ensureCreatedOnDispatch(
    sourceId: string,
    options: { name?: string } = {},
  ): Promise<CreateDerivedOutcome> {
    const inflight = this.creatingOnDispatch.get(sourceId);
    if (inflight) return inflight;
    const promise = this.createDerivedAgent(sourceId, options);
    this.creatingOnDispatch.set(sourceId, promise);
    try {
      return await promise;
    } finally {
      if (this.creatingOnDispatch.get(sourceId) === promise) {
        this.creatingOnDispatch.delete(sourceId);
      }
    }
  }

  private async createDerivedAgent(
    sourceId: string,
    options: { name?: string } = {},
  ): Promise<CreateDerivedOutcome> {
    const source = this.registry.get(sourceId);
    // 自动创建不是复活路径：left / closed / 正在关闭一律 agent_left。
    if (
      source === undefined ||
      source.membership === 'left' ||
      source.state === 'closed' ||
      this.hasClosingExecutionUnit(sourceId)
    ) {
      return { ok: false, code: 'agent_left', reason: `agent_left: ${sourceId}` };
    }
    if (source.visibility === 'private') {
      return {
        ok: false,
        code: 'auto_create_not_allowed',
        reason: 'auto_create_not_allowed: private',
      };
    }
    const teamId = source.teamId;
    if (teamId === undefined || this.teamBinder === undefined) {
      return {
        ok: false,
        code: 'auto_create_not_allowed',
        reason: 'auto_create_not_allowed: no_team',
      };
    }
    const team = this.teamBinder.get(teamId);
    if (team === undefined) {
      return {
        ok: false,
        code: 'auto_create_not_allowed',
        reason: 'auto_create_not_allowed: no_team',
      };
    }
    if (team.spawn_frozen === true) {
      return { ok: false, code: 'team_frozen', reason: `team_frozen: ${teamId}` };
    }
    if (this.presentTeamCount(teamId) >= this.teamMemberLimit) {
      return { ok: false, code: 'team_full', reason: `team_full: ${teamId}` };
    }

    // 内部 dispatch 幂等：同一 gone 源只自动创建一个 present 派生。
    const existing = this.registry
      .all()
      .find((record) => record.sourceAgentId === sourceId && record.membership === 'present');
    if (existing !== undefined) {
      return {
        ok: false,
        code: 'auto_create_not_allowed',
        reason: `auto_create_not_allowed: already_created:${existing.id}`,
      };
    }

    const name =
      options.name !== undefined
        ? options.name
        : this.derivedNameFor(source.name ?? source.id, 'created', teamId);
    if (name === undefined) {
      return {
        ok: false,
        code: 'auto_create_not_allowed',
        reason: 'auto_create_not_allowed: name_exhausted',
      };
    }
    if (options.name !== undefined && this.nameOccupied(options.name, teamId)) {
      return {
        ok: false,
        code: 'auto_create_not_allowed',
        reason: 'auto_create_not_allowed: name_taken',
      };
    }

    const id = this.newId();
    if (!nonEmpty(id) || this.registry.resolve(id) !== undefined) {
      return {
        ok: false,
        code: 'auto_create_failed',
        reason: 'session_id_collision',
      };
    }

    const now = this.now();
    const record: MemberRecord = {
      id,
      sessionId: id,
      binding: { bindingId: id, epoch: 0, createdAt: now, lastActiveAt: now, primary: true },
      name,
      role: source.role,
      // member 的 owner 恒为 self；temporary 沿用雇佣者。
      owner: source.role === 'temporary' ? source.owner : id,
      visibility: source.visibility,
      state: 'created',
      presence: 'gone',
      membership: 'present',
      teamId,
      rotation: 'stable',
      bindingHistory: [],
      sourceAgentId: source.id,
    };
    if (source.systemPrompt !== undefined) record.systemPrompt = source.systemPrompt;
    if (source.parentId !== undefined) record.parentId = source.parentId;
    // 只继承源的显式 pin；缺省跟随当前 config，不落库。
    if (source.model !== undefined) record.model = source.model;
    // 派生成员与源同一个 Team ⇒ 同一个成员 cwd（0.51 Bug 1：cwd 也是身份快照的一部分）
    if (source.cwd !== undefined) record.cwd = source.cwd;

    try {
      await this.spawnRecord(record);
    } catch (error) {
      // E2 §3.6：废手拼前缀；code 已表达 auto_create_failed，reason 只留原文。
      const failure = new AgentError('spawn_failed', errorText(error), {
        cause: error,
        operation: 'team.auto_create',
        details: this.spawnFailureDetails(record, error, 'inherit'),
      });
      const sourceSessionId = primaryBinding(source)?.bindingId ?? source.sessionId;
      this.emitForSession('agent.create.failed', source, sourceSessionId, {
        from: source.id,
        to: name,
        reason: errorText(error),
        error_id: failure.errorId,
        operation: 'team.auto_create',
      });
      return { ok: false, code: 'auto_create_failed', reason: errorText(error) };
    }

    // spawn 期间源可能已被 close：踢人不得凭空产生新 Agent。
    const currentSource = this.registry.get(source.id);
    if (
      currentSource === undefined ||
      currentSource.membership === 'left' ||
      currentSource.state === 'closed' ||
      this.hasClosingExecutionUnit(source.id)
    ) {
      await this.disposeAgentBodies(record);
      this.registry.remove(record.id);
      this.scheduleSnapshot();
      return { ok: false, code: 'agent_left', reason: `agent_left: ${sourceId}` };
    }

    this.emit('agent.spawned', record, {
      state: 'idle',
      presence: 'live',
      source_agent_id: source.id,
    });
    // q-session-naming：自动创建恒为 agent 驱动，首会话同样按成员身份命名。
    await this.nameNewSession(record, record.sessionId);
    return { ok: true, member: record };
  }

  // ─── ExecutionUnit registry ──────────────────────────────────────────────

  private entryMap(agentId: string): Map<string, ExecutionUnitEntry> {
    let map = this.executionUnitRegistry.get(agentId);
    if (!map) {
      map = new Map();
      this.executionUnitRegistry.set(agentId, map);
    }
    return map;
  }

  private liveEntries(agentId: string): ExecutionUnitEntry[] {
    const map = this.executionUnitRegistry.get(agentId);
    if (!map) return [];
    return [...map.values()].filter((entry) => !entry.retired && !entry.closing);
  }

  private findEntry(agentId: string, bindingId: string): ExecutionUnitEntry | undefined {
    return this.executionUnitRegistry.get(agentId)?.get(bindingId);
  }

  private hasClosingExecutionUnit(agentId: string): boolean {
    return this.liveEntries(agentId).some((entry) => entry.closing);
  }

  /**
   * 从记录构造 ExecutionUnitEntry。
   * binding 租约优先消费 `createBinding` 预获取的 grant；否则此处获取
   * （首次 create 的初始 binding 走的正是后者）。
   */
  private async entryFor(record: MemberRecord, body: BindingRecord): Promise<ExecutionUnitEntry> {
    const existing = this.findEntry(record.id, body.bindingId);
    if (existing !== undefined) return existing;
    let grant = this.pendingBindingLeases.get(body.bindingId);
    if (grant !== undefined) this.pendingBindingLeases.delete(body.bindingId);
    if (grant === undefined && this.leaseService !== undefined) {
      try {
        grant = await this.leaseService.acquire('binding', body.bindingId);
      } catch (error) {
        throw new AgentError('spawn_failed', errorText(error), {
          cause: error,
          operation: 'body.lease',
          details: this.spawnFailureDetails(record, error),
        });
      }
    }
    const runtimeMember: MemberExecutionMember = {
      ...toRuntimeMember(record),
      session_id: body.bindingId,
      ...(grant !== undefined ? { binding_lease: grant } : {}),
    };
    const entry: ExecutionUnitEntry = {
      agentId: record.id,
      bindingId: body.bindingId,
      epoch: body.epoch,
      state: 'idle',
      primary: body.primary,
      createdAt: body.createdAt,
      lastActiveAt: body.lastActiveAt,
      retired: false,
      runtimeMember,
      pending: [],
      queuedRuns: new Set(),
      budgetHold: new Set(),
      closing: false,
      spawned: false,
      spawning: undefined,
      ...(grant !== undefined ? { leaseId: grant.leaseId, fencingToken: grant.fencingToken } : {}),
    };
    this.entryMap(record.id).set(body.bindingId, entry);
    return entry;
  }

  /**
   * 新增一个 live body —— **唯一闸门**（0.28 单 body 不变量）。
   *
   * 已有 live body 时只允许 `rotation: true`（rotate 窗口内新体与待退役体短暂共存）；
   * 其它任何路径（`ensureExecutionUnit` 惰性创建 / `create`）一律 `body_limit`。
   * rotate 的 count 检查已删除：与这里重复，且 max = 1 时会让 rotate 恒失败。
   */
  private async createBinding(
    record: MemberRecord,
    bindingId: string,
    options: {
      epoch?: number;
      primary?: boolean;
      rotation?: boolean;
      /** restart 专用：同 id 旧 binding 已退役进 history，允许重新入主位 */
      restart?: boolean;
    } = {},
  ): Promise<BindingRecord> {
    const live = liveBindings(record);
    if (live.length > 0 && options.rotation !== true) {
      throw new AgentError('body_limit', `body_limit: ${record.id} (max 1 live body)`);
    }
    if (
      this.registry.getBySession(bindingId) !== undefined ||
      record.binding?.bindingId === bindingId ||
      record.retiringBinding?.bindingId === bindingId ||
      // 已退役的 session 不得重新准入：复活只走 `reinstate`（原地 unretire）。
      // restart 是唯一例外：同一个 session 由调用方显式重启为新 epoch。
      (!options.restart && this.registry.isRetiredSession(bindingId))
    ) {
      throw new AgentError('invalid_input', `duplicate session id: ${bindingId}`);
    }
    const now = this.now();
    const body: BindingRecord = {
      bindingId,
      epoch: options.epoch ?? 0,
      createdAt: now,
      lastActiveAt: now,
      primary: options.primary ?? live.length === 0,
    };
    let grant: LeaseGrant | undefined;
    if (this.leaseService !== undefined) {
      try {
        grant = await this.leaseService.acquire('binding', bindingId);
      } catch (error) {
        throw new AgentError('spawn_failed', errorText(error), {
          cause: error,
          operation: 'body.lease',
          details: this.spawnFailureDetails(record, error),
        });
      }
    }
    try {
      this.registry.addBinding(record.id, body);
    } catch (error) {
      if (grant !== undefined) await this.releaseLeaseGrant(grant);
      throw error;
    }
    // 交给紧随其后的 entryFor 消费；entry 建立后凭据落在 entry.leaseId。
    if (grant !== undefined) this.pendingBindingLeases.set(bindingId, grant);
    return body;
  }

  /** 释放一个尚未落到 entry 上的 grant（createBinding 回滚 / 未消费的 pending）。 */
  private async releaseLeaseGrant(grant: LeaseGrant): Promise<void> {
    if (this.leaseService === undefined) return;
    try {
      await this.leaseService.release(grant.leaseId);
    } catch (error) {
      this.logger.warn('agent.body.lease_release_failed', {
        session_id: grant.key,
        error: errorText(error),
      });
    }
  }

  /** 回滚未消费的 pending binding lease（createBinding 成功但 entry 未建立）。 */
  private async releasePendingBindingLease(bindingId: string): Promise<void> {
    const grant = this.pendingBindingLeases.get(bindingId);
    if (grant === undefined) return;
    this.pendingBindingLeases.delete(bindingId);
    await this.releaseLeaseGrant(grant);
  }

  /** 解析或惰性创建 body；`requested` 是显式 session（必须未退役） */
  private async ensureExecutionUnit(
    record: MemberRecord,
    requested?: string,
  ): Promise<{ entry: ExecutionUnitEntry; body: BindingRecord }> {
    let body: BindingRecord | undefined;
    if (requested !== undefined) {
      if (record.binding?.bindingId === requested) body = record.binding;
      else if (record.retiringBinding?.bindingId === requested) body = record.retiringBinding;
      if (body !== undefined && body.retiredAt !== undefined) {
        throw new AgentError('conflict', `session_not_runnable: ${requested}`);
      }
      if (body === undefined) {
        // `bindingHistory` 里的 id 也在这里被拒：否则惰性 createBinding 会把它复活成
        // 第二具 live body（D2 不变量破且无任何报错）。
        if (this.registry.isRetiredSession(requested)) {
          throw new AgentError('conflict', `session_not_runnable: ${requested}`);
        }
        body = await this.createBinding(record, requested, { epoch: 0 });
      }
    } else {
      body = primaryBinding(record);
      if (body?.retiredAt !== undefined) {
        // 只剩退役 body：不自动开新体，否则复活路径永远走不到（必须 reinstate）。
        throw new AgentError('conflict', `session_not_runnable: ${body.bindingId}`);
      }
      if (body === undefined) {
        body = await this.createBinding(record, this.newId(), { epoch: 0 });
      }
    }
    const entry = await this.entryFor(record, body);
    entry.primary = body.primary;
    return { entry, body };
  }

  /**
   * 惰性重建 body runtime；并发 admit single-flight，只 spawn 一次。
   * `presence === gone`（重启 / stale）时即使 entry 标记为 spawned 也要重新 spawn：
   * registry presence 是进程外可观测的唯一真相。
   */
  private async ensureRuntime(entry: ExecutionUnitEntry): Promise<void> {
    const record = this.registry.get(entry.agentId);
    const stale = record === undefined || record.presence === 'gone';
    if (entry.spawned && !stale) return;
    if (entry.spawning !== undefined) {
      await entry.spawning;
      return;
    }
    const spawning = (async () => {
      await this.runtime.spawn(entry.runtimeMember);
      entry.spawned = true;
      this.registry.setPresence(entry.agentId, 'live');
    })();
    entry.spawning = spawning;
    try {
      await spawning;
    } finally {
      entry.spawning = undefined;
    }
  }

  /**
   * 0.56 send-first：把 spawn 踢出去、**不等待**（`runs.start` 的冷态返回时间由此从
   * 「秒级」回到「毫秒级」）。
   *
   * 三件事必须成立，否则这个方法就是错的：
   * 1. **不能吞掉错误**：拒绝只在这里记一条 warn；真正的判定在
   *    `startExecutionUnitRun` 的 `await this.ensureRuntime(entry)`（那一处会把 run 收成
   *    `spawn_failed` 并保住消息）。这里再抛一次没有意义 —— 调用方已经返回了。
   * 2. **不能并发 spawn 两具**：`ensureRuntime` 自己 single-flight（`entry.spawning`），
   *    所以「这里踢一次 + 稍后 run 里等一次」只会跑一次 spawn。
   * 3. **不能拦住别的东西**：`void` + catch 之后不留任何引用，事件循环不被挂住。
   */
  private startSpawn(entry: ExecutionUnitEntry): void {
    void this.ensureRuntime(entry).catch((error: unknown) => {
      this.logger.warn('agent.body.spawn_deferred_failed', {
        member_id: entry.agentId,
        session_id: entry.bindingId,
        error: errorText(error),
      });
    });
  }

  private async disposeEntry(entry: ExecutionUnitEntry): Promise<boolean> {
    let ok = true;
    if (entry.spawned) {
      try {
        await this.runtime.dispose(entry.runtimeMember);
        entry.spawned = false;
      } catch (error) {
        ok = false;
        this.logger.warn('agent.dispose.failed', {
          member_id: entry.agentId,
          session_id: entry.bindingId,
          error: errorText(error),
        });
      }
    }
    if (entry.leaseId !== undefined && this.leaseService !== undefined) {
      try {
        await this.leaseService.release(entry.leaseId);
        entry.leaseId = undefined;
      } catch (error) {
        this.logger.warn('agent.body.lease_release_failed', {
          session_id: entry.bindingId,
          error: errorText(error),
        });
      }
    }
    this.executionUnitRegistry.get(entry.agentId)?.delete(entry.bindingId);
    return ok;
  }

  /** 退役一个 body：取消排队 run、清 mailbox、迁 primary、落 snapshot */
  private async retireExecutionUnitEntry(
    record: MemberRecord,
    entry: ExecutionUnitEntry,
    reason: string,
    at: number = this.now(),
  ): Promise<void> {
    if (entry.retired) return;
    const wasWaitingPermission = entry.state === 'waiting_permission';
    // 0.32：先关旧 body 的 inbox hook，再放 hold —— 顺序反了旧 body 仍可能消费。
    this.runtime.disableInbox?.(entry.bindingId);
    const wasPrimary = entry.primary || record.binding?.bindingId === entry.bindingId;
    // 交棒判据的唯一写入点（见 `classifyRetiredTurn`）：此刻 `entry.active` 就是
    // 「被退役时正在跑的那一轮」。只有 rotate 会在 run 内走到这里（RPC rotate /
    // restart / delete 都先要求 idle，TTL 回收跳过有活轮的 agent），所以这条记录
    // 等价于「本轮的模型自己提交了 rotate」。
    entry.retirement =
      entry.active === undefined ? undefined : { runId: entry.active.runId, reason };
    entry.retired = true;
    entry.state = 'closed';
    entry.primary = false;
    entry.closing = true;
    // I3（审计点 4/6）：清空 mailbox 不必先快照 id —— `held` 记的是持有者 bodyId，
    // 收口 = 下面按 body 释放（`releaseHeldFor`）。
    entry.pending.length = 0;
    for (const runId of entry.queuedRuns) {
      this.scheduler.cancel(runId, `body retired: ${reason}`);
    }
    entry.queuedRuns.clear();
    this.inboxPending.delete(entry.agentId);
    // 仍有 active run 时（典型是 rotate 在自己的 run 里执行）不要清 noticeDirty：
    // 该 run 结束时 settle 还要据此补排一次 wake；提前清掉会吞掉本 run 内到达的 wake 投递。
    if (entry.active === undefined) this.noticeDirty.delete(entry.agentId);
    if (wasWaitingPermission) {
      // 旧 body 上等待人类的权限请求随 body 一起失效；留事件让入口侧收口交互卡。
      try {
        this.runtime.cancel(entry.runtimeMember);
      } catch (error) {
        this.logger.warn('agent.cancel.failed', {
          member_id: entry.agentId,
          session_id: entry.bindingId,
          error: errorText(error),
        });
      }
      this.emitForSession('agent.permission.cancelled', record, entry.bindingId, {
        reason: 'body_retired',
      });
    }
    // 旧队列（含 hold）转为可注入；pendingNotices 不得串到新 body。
    // D2/I4：只放**这具 body** 的持有，多 live body 时不得顺手放出别人的在途队列。
    this.inbox?.releaseHeldFor(record.id, entry.bindingId);
    // 刚被放出来的那批，原本是「这具 body 的下一轮输入」——它们自己的 queued run 刚刚被
    // 取消（上面那一圈 cancel），此刻没有 run 会去消费它们。记一次 dirty，让这台 agent
    // 下一次跑完一轮（新 body / 别的 body）时按队头把它们投回去；不记的话它们只能等
    // 模型自己 read，正是 0.51 之前「N 条堆在一起」的样子。
    this.noticeDirty.add(record.id);
    this.runtime.clearPendingNotices?.(record.id);
    // `retireBinding` 自己记 `body_history`；这里不再重复 push，否则同一 session
    // 会在 DTO 的 body_history 里出现两次。
    this.registry.retireBinding(record.id, entry.bindingId, at);
    if (wasPrimary) this.promotePrimary(record);
    this.emitForSession('agent.retired', record, entry.bindingId, {
      body_id: entry.bindingId,
      epoch: entry.epoch,
      reason,
      // B′（0.52）：rotate 交棒轮不是迟到旧轮。把退役时 in-flight 的 run id 随事件带出去，
      // 让 TeamService 只 fence「run id 对不上」的旧轮，交棒轮照常记账。
      // 只有 rotation 才带：close / delete 等路径保持「一律 fence」的旧语义。
      ...(entry.retirement?.reason === 'rotation'
        ? { retired_during_run_id: entry.retirement.runId }
        : {}),
    });
    this.scheduleSnapshot();
    if (entry.active === undefined) await this.disposeEntry(entry);
    this.updateAgentState(record.id);
  }

  /** primary 晋升：最近活跃的 live body；没有则清空 */
  private promotePrimary(record: MemberRecord): void {
    const entries = this.liveEntries(record.id)
      .filter((entry) => !entry.retired)
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt);
    const next = entries[0];
    for (const entry of entries) entry.primary = entry === next;
    this.registry.setPrimaryBinding(record.id, next?.bindingId);
  }

  /** 关闭 agent 的所有 body（cancel/dispose/release） */
  private async disposeAgentBodies(record: MemberRecord): Promise<void> {
    const entries = [...(this.executionUnitRegistry.get(record.id)?.values() ?? [])];
    for (const entry of entries) {
      // 0.32：body 关闭时旧 hook 立即停止读取 inbox；通知队列同时清空。
      this.runtime.disableInbox?.(entry.bindingId);
      this.runtime.clearPendingNotices?.(entry.agentId);
      entry.closing = true;
      entry.pending.length = 0;
      for (const runId of entry.queuedRuns) {
        this.scheduler.cancel(runId, 'agent closed');
      }
      entry.queuedRuns.clear();
      this.inboxPending.delete(entry.agentId);
      this.noticeDirty.delete(entry.agentId);
      if (entry.active !== undefined) {
        try {
          this.runtime.cancel(entry.runtimeMember);
        } catch (error) {
          this.logger.warn('agent.cancel.failed', {
            member_id: entry.agentId,
            session_id: entry.bindingId,
            error: errorText(error),
          });
        }
      }
      entry.retired = true;
      entry.state = 'closed';
      entry.primary = false;
      this.registry.retireBinding(record.id, entry.bindingId, this.now());
      // I3（审计点 5/6）：清空 mailbox 的收口 = 按 body 释放它自己的 hold ——
      // 关闭后未消费的消息回到 unread，reinstate 的 body 才能再注入它们。
      this.inbox?.releaseHeldFor(record.id, entry.bindingId);
      await this.disposeEntry(entry);
    }
    this.executionUnitRegistry.delete(record.id);
  }

  // ─── 统一准入 ───────────────────────────────────────────────────

  async admit(input: AdmitInput): Promise<AdmitResult> {
    await this.ready;
    const outcome = await this.admitInternal(input);
    return outcome.result;
  }

  /**
   * q-async-bash-viz：起异步作业时往 inbox 插一条 **running 占位回调卡**（灵魂出窍复原，
   * **kind 无关通用机制**）。bash 首个消费者（kind='bash'），ask 未来消费者复用同机制。
   *
   * 会话绑定：经 sessionId resolve 成员，inbox 按 agentId。占位 `quiet`（永不当 run input）、
   * running 态不可被 read 消费 / 弹出（readable 排除）、list 沉底。完成时
   * {@link completeAsyncJob} 按 jobId **原位更新占位**（卡片视觉），结果另落独立正常
   * 条目投递（q-inbox-admit-restore：占位卡与结果投递解耦）。
   *
   * kind 专属细节放 `payload`（机制层不解释）：bash={command,pid,log_path}；ask={question,...}。
   * 占位的 `session_id` 只放进 `async_job` 元数据（展示 / 归属关联），**不**写条目级
   * `session_id`（quiet 条目带归属会被重启恢复重投，见 trackInbox 的分界）。
   * 返回是否插入成功（无 inbox / 无成员 = false ⇒ 完成退回旧 admit 投递路径，不丢结果）。
   */
  async insertAsyncPlaceholder(meta: {
    kind: string;
    jobId: string;
    sessionId: string;
    startedAt: number;
    payload?: Record<string, unknown>;
    summary?: string;
  }): Promise<boolean> {
    await this.ready;
    const inbox = this.inbox;
    if (inbox === undefined) return false;
    const record = this.registry.resolve(meta.sessionId);
    if (record === undefined) return false;
    const result = inbox.append(
      record.id,
      {
        id: `async-job-${meta.jobId}`,
        ts: meta.startedAt,
        // source 用 kind（bash→'bash'、ask→'ask'），与 InboxSourceLabel 口径一致。
        source: meta.kind,
        text: meta.summary ?? `[${meta.kind} job ${meta.jobId}] running`,
        async_job: {
          job_id: meta.jobId,
          kind: meta.kind,
          status: 'running',
          started_at: meta.startedAt,
          session_id: meta.sessionId,
          ...(meta.payload !== undefined ? { payload: meta.payload } : {}),
        },
      },
      { delivery: 'quiet' },
    );
    return result.accepted;
  }

  /**
   * q-inbox-admit-restore（用户裁示：恢复正文 admit 投递，废 synthetic wake）：
   * 异步作业完成 —— 按 jobId **原位更新占位**（running→done/failed + 填结果正文 +
   * 合并 kind 专属 payload），占位卡自此**只管卡片视觉**（quiet 留档，模型可 read）。
   *
   * **结果投递与占位卡解耦**：结果另落一条正常可消费条目（wake 模式，origin 随条目
   * 落盘），走 {@link dispatchInbox} 收口链 —— idle → 队头直投成正文 run（正文 = 作业
   * 结果，不是「去 inbox 读」的 synthetic 唤醒）；busy → 留队列 + noticeDirty，
   * run 收口由 settleHandle 补投（既有链条，无上界延迟）。预算拒绝同样留队列
   * （dispatchInbox 不再点火兜底），预算允许时再投。
   *
   * 返回是否更新成功（无占位 = false ⇒ 调用方退回 admit 旧路径）。
   */
  async completeAsyncJob(meta: {
    jobId: string;
    sessionId: string;
    status: 'done' | 'failed';
    content: string;
    endedAt?: number;
    payload?: Record<string, unknown>;
  }): Promise<boolean> {
    await this.ready;
    const inbox = this.inbox;
    if (inbox === undefined) return false;
    const record = this.registry.resolve(meta.sessionId);
    if (record === undefined) return false;
    const updated = inbox.updateAsyncJob(record.id, meta.jobId, {
      status: meta.status,
      text: meta.content,
      ...(meta.payload !== undefined ? { payload: meta.payload } : {}),
      ...(meta.endedAt !== undefined ? { ended_at: meta.endedAt } : {}),
    });
    if (!updated) return false;
    // kind 取自占位卡（机制层 kind 无关）：source 用 kind 标签（与占位同口径），
    // origin 按 kind 映射（bash → bash_job；未来消费者在此扩展映射）。
    const card = inbox.findByIds(record.id, [`async-job-${meta.jobId}`])[0];
    const kind = card?.async_job?.kind ?? 'bash';
    const appended = inbox.append(
      record.id,
      {
        // 独立 id：占位卡（quiet）与结果投递条目（可消费、可成 run input）是两条，
        // 同 id 幂等会吞掉这次 append。jobId 派生 ⇒ 重复完成调用不产生第二条。
        id: `async-job-${meta.jobId}-result`,
        ts: meta.endedAt ?? this.now(),
        source: kind,
        text: meta.content,
        ...(kind === 'bash' ? { origin: 'bash_job' as const } : {}),
      },
      { delivery: 'wake' },
    );
    if (!appended.accepted) {
      // inbox 满：结果仍在占位卡里（可 read），不丢；只记日志，不点火。
      this.logger.warn('agent.async_job.result_enqueue_failed', {
        agent_id: record.id,
        job_id: meta.jobId,
        reason: appended.reason,
      });
      return true;
    }
    this.noticeDirty.add(record.id);
    void this.dispatchInbox(record.id).catch(() => {});
    return true;
  }

  /**
   * q-async-job-reconcile：启动对账孤儿 running 占位卡（见接口注释）。
   *
   * 判据为什么干净：作业注册表（basic-tools asyncJobs）是进程内存，进程死亡即清空；
   * 占位卡随 inbox 落盘。所以**本进程启动时**盘上任何 running 占位卡都必然属于上一个
   * 进程 —— 它的子进程已被 exit sweep 停掉（killLiveAsyncJobs），结果不可能再回来。
   * 不需要 pid 探活 / 超时猜测：running 本身就是孤儿证明。
   *
   * 只改卡片视觉：updateAsyncJob 原位回写 failed（quiet 条目保持 quiet，inputHead
   * 跳过 ⇒ 不会被 startupDispatchSweep 误点火），不起 run、不另插结果条目（结果已丢，
   * 没有可投的正文）。left / closed 成员也扫：孤儿卡是留档视觉，与成员能否接活无关。
   *
   * 枚举走 registry.all() + history()（与 recover 同口径，不扫 inbox/ 目录）：
   * history 是唯一不过滤 running 占位的只读口（list / read 都把 running 排除在外）。
   * 逐卡失败不阻断（保持 running，下次启动再试）；每进程一次（幂等闸）。
   */
  async reconcileAsyncJobs(): Promise<AgentAsyncJobReconcileResult> {
    await this.ready;
    const empty: AgentAsyncJobReconcileResult = { reconciled: 0, failed: 0 };
    const store = this.inbox;
    if (store === undefined) return empty;
    if (this.asyncJobReconcileDone) return empty;
    this.asyncJobReconcileDone = true;
    const result: AgentAsyncJobReconcileResult = { ...empty };
    for (const record of this.registry.all()) {
      let orphans: ReturnType<typeof store.history>;
      try {
        orphans = store
          .history(record.id)
          .filter(
            (message) => message.status === 'unread' && message.async_job?.status === 'running',
          );
      } catch (error) {
        result.failed += 1;
        this.logger.warn('agent.async_job.reconcile_scan_failed', {
          agent_id: record.id,
          error: errorText(error),
        });
        continue;
      }
      for (const message of orphans) {
        const meta = message.async_job;
        if (meta === undefined) continue;
        const logPath =
          typeof meta.payload?.log_path === 'string' ? meta.payload.log_path : undefined;
        // kind 无关措辞（机制层不解释 kind）：进程退出 ⇒ 作业被停、结果丢失。
        const text =
          `[${meta.kind} job ${meta.job_id}] failed — the host process exited before this job finished; ` +
          `the job process was stopped at exit and its result is lost.` +
          (logPath !== undefined ? ` Partial log: ${logPath}` : '');
        try {
          const updated = store.updateAsyncJob(record.id, meta.job_id, {
            status: 'failed',
            text,
            // 真实退出时刻不可知（上一进程没留）：ended_at 记对账时刻，payload 标明成因。
            ended_at: this.now(),
            payload: { swept_by: 'exit', reconciled_at: this.now() },
          });
          if (!updated) continue;
          result.reconciled += 1;
          this.logger.info('agent.async_job.reconciled', {
            agent_id: record.id,
            job_id: meta.job_id,
            kind: meta.kind,
            session_id: meta.session_id,
          });
        } catch (error) {
          result.failed += 1;
          this.logger.warn('agent.async_job.reconcile_failed', {
            agent_id: record.id,
            job_id: meta.job_id,
            error: errorText(error),
          });
        }
      }
    }
    return result;
  }

  async bodies(agentId: string): Promise<ExecutionUnitStatus[]> {
    await this.ready;
    const record = this.registry.get(agentId);
    if (record === undefined) throw new AgentError('unknown_member', `unknown_member: ${agentId}`);
    const entries = this.liveEntries(agentId).sort(
      (left, right) => Number(right.primary) - Number(left.primary),
    );
    if (entries.length === 0) {
      return liveBindings(record).map((body) => ({
        session_id: body.bindingId,
        epoch: body.epoch,
        state: 'idle' as const,
        primary: body.primary,
        created_at: body.createdAt,
        last_active_at: body.lastActiveAt,
      }));
    }
    return entries.map(toExecutionUnitStatus);
  }

  /**
   * 统一准入主链路：resolve → membership/visibility → body → budget → mailbox → scheduler。
   *
   * `internal.startup` 由 rotate / create / hire / 跨进程续作使用：启动嘱托直接作为
   * run input，不进 inbox，也不受 rotate 窗口守卫影响（否则新 body 的首轮会被当成旧队列）。
   * `internal.inputName` 是内部调用方**声明**的会话身份（标 `Message.name`）：rotate
   * 交接嘱托（`ROTATE_HANDOFF_INPUT_NAME`）与跨进程续作嘱托（`CONTINUATION_INPUT_NAME`）
   * 用它。不走 `AdmitInput` 是因为
   * 那是投递侧（含 RPC）的公共形状，谁说的这句话只能由生产者说清楚，不能开成一个
   * 可以被外部填的字段。
   *
   * `internal.recovery` / `internal.redelivery` 都只改**失败出口**：投递没提交成功时
   * 消息留在队列（unhold 回 unread）而不是 discard —— 启动恢复与队头直投投的都是
   * 「已经在库里的正文」，丢掉它就是丢掉用户的消息。
   */
  private async admitInternal(
    input: AdmitInput,
    internal?: {
      startup?: boolean;
      recovery?: boolean;
      redelivery?: boolean;
      inputName?: string;
    },
  ): Promise<AdmitOutcome> {
    await this.ready;
    // 0.28：不再在 admit 里顺带 sweep —— 那会回收调用方正要投递的目标（竞态）。
    // 回收只由装配层的定时器驱动（`AgentService` 保持无定时器）。
    const content = readContent(input as unknown as Record<string, unknown>, 'content');
    // 缺省发送者是人类，不是 default owner：owner 是**成员归属**的缺省值，
    // 拿来填消息的 from 会让人类发出的消息带上 `main` 这个 agent 的 id。
    const from =
      input.from === undefined
        ? DEFAULT_MESSAGE_SENDER
        : readRequiredString(input as never, 'from');
    const channel = input.channel ?? 'direct';
    if (channel !== 'direct' && channel !== 'team') {
      throw new AgentError('invalid_input', 'channel must be direct or team');
    }
    const strict = input.strict === true;
    // Q5：仅内部装配传入；runs.start RPC 不暴露该字段。
    const resume = input.resume === true;
    // 0.52：async ask 的答案投递（见 AdmitInput.origin）。
    const fromAskAnswer = input.origin === 'ask_answer';
    // 0.55：后台 bash 作业的结果投递（见 AdmitInput.origin）。
    const fromBashJob = input.origin === 'bash_job';
    // 附件引用（0.52）：只收「绝对路径 + 已知 kind」，逐条丢弃其余；条数有上限。
    // 越界 / deny 目录的判定属于写侧闸门（runs.start 的 refs 闸门），这里只做形状归一。
    //
    // 0.56（决策 2：上传即落）：这是引用**到达节点的第一刻** —— 图片在这里就冻结成字节
    // （sha256 + blob）。之后请求期只读 blob，不再碰这条路径（`refs[].path` 只留给
    // 展示与人工排查）。失败（越界 / 读不到 / 太大）不报错：引用原样往下走，请求期
    // 明确记 `not_ingested`，chip 显示「未发送」。
    const refs = await this.ingestRefs(normalizeRefs(input.refs));

    // q-inbox-ux-fix（承 0.52 S1a fence）：node 退出期间**不再按来源拒绝**。
    // 人类与 agent 来源的写一律走下面「只落 durable inbox、返回 deferred(draining)」
    // 的排队路（见 fence 段）：正文先持久化，刷新不丢；node 回来由 recoverPendingInputs
    // 重投（hold 只在内存，重启后条目回到 unread）。没有 durable inbox 时那里才明确
    // 拒绝（node_draining → RPC gateway_restarting）—— 没有「排队」这回事可言。

    // 1. session → agent/body 解析（绑定优先；矛盾输入 = invalid_input）
    let record: MemberRecord;
    let requestedBindingId: string | undefined;
    if (input.session_id !== undefined) {
      const sessionId = readRequiredString(input as never, 'session_id');
      const bound = this.registry.getBySession(sessionId);
      if (bound !== undefined) {
        if (input.agent_id !== undefined && input.agent_id !== bound.id) {
          throw new AgentError(
            'invalid_input',
            `session ${sessionId} belongs to ${bound.id}, not ${input.agent_id}`,
          );
        }
        record = bound;
        requestedBindingId = sessionId;
      } else {
        record = this.requireAgent(input.agent_id ?? this.defaultOwner);
        requestedBindingId = sessionId;
      }
    } else {
      record = this.requireAgent(input.agent_id ?? this.defaultOwner);
    }

    // 2. membership / presence / visibility（只按 sender 自身的可见性判定）
    //    0.52 例外：async ask 的答案是**成员自己提的问题**被人类回答，投递不受
    //    「谁能驱动这个成员」的可见性闸门约束 —— 否则 private 成员的提问永远答不了。
    //    0.55 同理：后台 bash 作业的结果是**成员自己的作业回报它自己**，不是「谁能驱动
    //    它」的问题；private 成员（owner 不是运行期身份自己）否则永远收不到作业结果。
    //    跳过的是**可见性**闸门：下面的 member_closed / strict / 预算 / inbox 投递全部照旧。
    if (!fromAskAnswer && !fromBashJob && !this.canAdmitView(record, from)) {
      throw new AgentError('member_not_visible', `member_not_visible: ${record.id}`);
    }
    if (record.membership === 'left' || record.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${record.id}`);
    }
    if (strict && record.presence === 'gone') {
      throw new AgentError('member_stale', `member_stale: ${record.id}`);
    }

    // 3. body resolve / 创建（每 agent 上限 body_limit）
    const { entry } = await this.ensureExecutionUnit(record, requestedBindingId);
    if (strict) {
      // send 不自动恢复 gone；但同 agent 其它 live body 存在时允许投递到该 body。
      if (entry.retired) throw new AgentError('member_closed', `member_closed: ${record.id}`);
    } else {
      // 0.56 send-first：**body spawn 不进 runs.start 的关键路径**。
      //
      // 一具 body 的首次 spawn（插件安装 + 工具表拼装 + EU 构造 + Runtime 登记）在真机
      // 上是秒级（0.55 §6.3 记的是 11.7 s），而它卡在「用户点发送」与「消息真的开始处理」
      // 之间 —— 用户看到的就是「输入框清空了，消息列表里什么都没有」。
      //
      // spawn 仍然**必须**在「出队 + 消费」之前完成（D1 不变量：消息离开 mailbox 之前
      // body 必须起得来），那一次等待在 `startExecutionUnitRun` 里，是唯一的一处。
      // 这里只是不再等它：RPC 带着 run_id 立刻返回，spawn 同时进行。
      // 失败也不会静默丢消息 —— 见 `startExecutionUnitRun` 里那条 catch（run 以明确的
      // `spawn_failed` 终态收口，正文留在 mailbox / inbox 里可以读回、可以重投）。
      // q-inbox-ux-fix：drain 期间不 kick spawn —— 这一进程不会再起任何 run，
      // 消息只落 durable inbox（下面的 fence 段），spawn 留给重启后的恢复链路。
      if (!this.draining) this.startSpawn(entry);
    }

    // 0.55 硬错误闸的解闸动作（第一处，共三处）：
    // **人类**投递 = 人在键盘前说「再试一次」。agent 投递**不**解闸 —— 今天事故正是
    // 别的成员每来一条报告就自动把 main 唤醒重发同一份必然 400 的上下文；把「agent
    // 发消息」当成解闸信号，等于把那个循环原样搬回来。
    // q-inbox-ux-fix：drain 期间不解闸 —— 解闸会触发 retryHeldMessages / dispatchInbox，
    // 而这一进程不会再起任何 run；消息照常走下面的 draining 排队路，闸留到重启后。
    if (this.isHumanPrincipal(from) && !this.draining) this.unblockBodies(record.id, 'human');

    // 4. 预算：human 直接对话免 conversation budget（替代原 externalOwner 特例）；
    //    面向 member 的投递（含 human → member）仍走 budget，与旧口径一致。
    //    投递侧只拦 hop / cycle / wall-clock / team 不一致；turns / tokens 是 turn 域，
    //    留给 turn_start 检查（block 时消息留在 body mailbox，override 后重新准入）。
    const conversationId = this.resolveConversationForDelivery(
      input.conversation_id,
      input.origin_session_id,
      record,
    );
    const originTeamId = input.origin_team_id;
    if (!this.isHumanPrincipal(record.id)) {
      const teamId = originTeamId ?? this.resolveOriginTeam(from, record);
      const runKey =
        input.origin_run_id ??
        (input.origin_session_id !== undefined
          ? this.activeRunIdForSession(input.origin_session_id)
          : undefined);
      const edgeSeen = this.hasRunCycleEdge(runKey, from, record.id);
      const check = this.checkDelivery(
        record,
        from,
        conversationId,
        teamId,
        originTeamId !== undefined,
        { edge: edgeSeen ? 'skip' : 'bump' },
      );
      // 检查通过后才记账：失败（例如 cycle 冷却中）不占边，同 run 再投会重新检查。
      if (check.ok) this.recordRunCycleEdge(runKey, from, record.id);
      if (!check.ok && !TURN_DIMENSIONS.has(check.dimension)) {
        this.emitBudgetBlocked(record, check, {
          conversation_id: conversationId,
          from,
          to: record.id,
          phase: 'enqueue',
          ...(teamId !== undefined ? { teamId } : {}),
        });
        throw this.budgetFailureError(check, conversationId, teamId);
      }
    }

    // 5. 入该 body mailbox，满足条件时 submit
    const senderName = this.senderName(from);
    // 启动恢复复用条目自己的 id（见 `recoverPendingInputs`）：append 同 id 幂等，
    // `markConsumed` 天然指向同一条，磁盘上不会因为重投而多出一条。
    const reuseMessageId = input.reuse_message_id;
    const message: AgentMessage = {
      id: reuseMessageId !== undefined && reuseMessageId !== '' ? reuseMessageId : this.newId(),
      from,
      to: record.id,
      content,
      ts: this.now(),
      ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
      source: this.messageSource(from),
      channel,
      // team 日志关联随消息进 inbox（trackInbox / rotate quiet 两条落盘路都带）。
      ...(input.team_message_id !== undefined ? { team_message_id: input.team_message_id } : {}),
      // 名字随消息带上：执行内核不持有 registry，渲染时无处可查。
      ...(senderName !== undefined ? { from_name: senderName } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      // 求救标记（q-distress-message）：生产侧 maybeSendDistress / 重投路径声明，
      // 随消息进 inbox 落盘；防循环判定在 executeExecutionUnitTurn 的失败出口读它。
      ...(input.distress === true ? { distress: true as const } : {}),
      // E2 §3.7：RPC correlation 内存元数据（不落 snapshot），执行内核透传进 run.started。
      ...(input.triggered_by !== undefined ? { triggered_by: input.triggered_by } : {}),
      // 会话身份（`Message.name`）：rotate 交接嘱托（`ROTATE_HANDOFF_INPUT_NAME`）与
      // 跨进程续作嘱托（`CONTINUATION_INPUT_NAME`）声明。缺省不写 —— 人类正文的载荷
      // 与今天逐字节一致。
      ...(internal?.inputName !== undefined ? { input_name: internal.inputName } : {}),
      // 附件引用：只有路径 + 元信息，随消息进执行内核 → core Message.refs；
      // inbox 副本同样保留（trackInbox / rotate quiet 两条落盘路都带），取走时不丢附件。
      ...(refs.length > 0 ? { refs } : {}),
    };
    // rotate 窗口内：旧 body 即将退役，消息只落 inbox（不进旧队列、不提交）。
    // 启动嘱托本身例外：它是新 body 的 run input，永不进 inbox。
    // 投递模式 quiet：不唤醒、也不当作 run input —— 0.51 起正文不再自动注入，新 body 的
    // notice hook 只报「N 条 unread」，模型自己 `inbox read` 取。所以这条消息**不会**
    // 自动变成 run（这是既有语义，不是本次改动引入的）；deferred 的 `reason: 'rotate'`
    // 说的就是这件事：收下了、这一轮没跑，正文在收件箱里。
    if (this.inbox !== undefined && internal?.startup !== true && this.rotations.has(record.id)) {
      const rotation = this.rotations.get(record.id);
      if (rotation !== undefined) {
        this.inbox.append(
          record.id,
          {
            id: message.id,
            ts: message.ts,
            // 与 `trackInbox` 同一口径：ask 答复的来源不是 human（见 `inboxSourceOf`）。
            source: inboxSourceOf(message),
            text: content,
            ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
            // team 关联同样带进 quiet 条目：rotate 窗口落盘的那一份也要能被
            // 「编辑 / 删除 team 消息」级联定位到。
            ...(message.team_message_id !== undefined
              ? { team_message_id: message.team_message_id }
              : {}),
            // 显示名同样带进 quiet 条目：rotate 窗口落盘的消息之后也会上条带，
            // 缺了它卡头一样只剩 UUID（本来就知道的名字，没有理由丢掉）。
            ...(senderName !== undefined ? { from_name: senderName } : {}),
            // 求救标记同样带进 quiet 条目（q-distress-message）：rotate 窗口收到的
            // 求救之后由新 body read / 重投，防循环标记不能在落盘这一层丢。
            ...(message.distress === true ? { distress: true as const } : {}),
            // 附件引用同样随 quiet 条目落盘：rotate 窗口收到的带图消息之后由新 body
            // `inbox read` 取走 —— 这里不带 refs，附件就在落盘这一层丢了（与 trackInbox
            // 同口径：存储保留，取走时随正文一并交出）。
            ...(message.refs !== undefined && message.refs.length > 0
              ? { refs: message.refs }
              : {}),
          },
          { delivery: 'quiet' },
        );
        // quiet 投递：只落 inbox，不进旧队列 —— 不带 state（见 emitMessageQueued）。
        this.emitMessageQueued(record, rotation.toSessionId, 'quiet', {
          message_id: message.id,
          from,
          ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
        });
        // 不编 run id：这条消息只落 inbox（quiet，正文由模型自己 read），永远不会有一个
        // 与它对应的这一轮 run，回一个永不起跑的号只会让调用方等一个永不发生的事件。
        return {
          result: this.deferredResult(record, rotation.toSessionId, message, 'rotate'),
          message,
        };
      }
    }
    // 0.52 S1a / q-inbox-ux-fix：node 正在退出 —— **所有来源**（人类 runs.start /
    // agents.send 与 agent 投递）都落 durable inbox 即返回 deferred(draining)。
    // 语义就是「排队」：不提交、不入 mailbox、不唤醒（admit 本身不等任何 run；
    // drain-to-quiesce 只等已受理的 live run）；正文留在 inbox 里，下次启动由
    // recoverPendingInputs / 启动续作投递接着处理。没有 durable inbox 就没有
    // 「排队」这回事，只能明确拒绝。
    if (this.draining) {
      if (this.inbox === undefined || internal?.startup === true) {
        throw new AgentError('node_draining', 'node_draining: startup');
      }
      this.trackInbox(record.id, message, entry.bindingId);
      this.emitMessageQueued(record, entry.bindingId, 'input', {
        state: record.state,
        message_id: message.id,
        from,
        ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
      });
      this.scheduleSnapshot();
      // 同上：正文已经落 durable inbox，但这一进程不会再起它 —— 不编 run id。
      return {
        result: this.deferredResult(record, entry.bindingId, message, 'draining'),
        message,
      };
    }
    // 写前日志：先落 inbox 再进 mailbox / scheduler；held 表示「某个 body 的 mailbox 已接管」。
    const inboxed = this.inbox !== undefined && internal?.startup !== true;
    // I1：唯一的 hold 写入点（见 trackInbox）。
    if (inboxed) this.trackInbox(record.id, message, entry.bindingId);
    entry.pending.push(message);
    this.registry.touchBinding(record.id, entry.bindingId, this.now());
    this.emitMessageQueued(record, entry.bindingId, 'input', {
      state: record.state,
      message_id: message.id,
      from,
      ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
    });
    this.scheduleSnapshot();

    // 0.55 硬错误闸（通往 scheduler 的闸）：body 被闸住时**只排队、不 submit**。
    //
    // 与上面 draining 那段同形：消息已经落 durable inbox 并 hold 成 pending（看得见、
    // 读得到、id 不变），只是不再开新 run。为什么不 throw：投递失败会让
    // `admitInternal` 的失败出口把消息 discard 掉（用户正文丢失），而这里要的恰恰是
    // 「收下、留着、等一条显式动作」。所以回 `deferred`（不是 `queued`）：**没有 run**，
    // 解闸后（`unblockBodies` → `retryHeldMessages`）才是一个新 run。
    if (entry.hardStop !== undefined) {
      return {
        result: this.deferredResult(record, entry.bindingId, message, 'stopped'),
        message,
      };
    }

    let submitted: { runId: string; handle: RunHandle };
    try {
      submitted = await this.submitMessage(record, entry, message, resume);
    } catch (error) {
      if (inboxed) {
        if (
          entry.retired ||
          entry.closing ||
          this.draining ||
          internal?.recovery === true ||
          // 队头直投是「把已经在队列里的条目再投一次」：scheduler 拒绝时消息必须留在
          // 队列（unhold 回 unread），discard 等于把这条正文从用户手里删掉。
          internal?.redelivery === true
        ) {
          // 恢复路径的失败也要保留未读（用户没取消那条消息，下次启动再试）。
          // rotate / close 竞争：投递还没提交，body 已收口。保留未读，交给新 body 注入。
          this.inbox?.unhold(record.id, [message.id]);
        } else {
          // 调度拒绝 = 明确投递失败：清掉写前日志，避免重启后被重新注入。
          this.inbox?.discard(record.id, [message.id]);
        }
      }
      throw error;
    }
    this.runMessageIds.set(submitted.runId, message.id);
    const status = submitted.handle.status();
    const queuePosition = this.queuePositionFor(submitted.runId, status);
    return {
      result: {
        run_id: submitted.runId,
        agent_id: record.id,
        session_id: entry.bindingId,
        message_id: message.id,
        status,
        ...(queuePosition !== undefined ? { queue_position: queuePosition } : {}),
      },
      message,
    };
  }

  /**
   * 「现在不能接」的统一出口（0.57）：**不编 run id**，用 `reason` 说清为什么。
   *
   * 以前这三条路（draining / rotate 静默窗口 / hardStop）各自 `newId()` 一个 run id 回
   * `status: 'queued'`。那个号**永不执行**：消息留在 durable inbox / mailbox 里，真正起跑
   * 时是**另一个** run（新 body 的 hook 注入、下次启动的 `recoverPendingInputs`、解闸后的
   * `retryHeldMessages`）。调用方拿一个永不起跑的号 ⇒ 永远等不到带它的事件（前端气泡停在
   * 「已排队」直到超时兜底）。这里改成「明确未接单」：`deferred` + `reason`
   * + 建议的重问间隔 `retry_after_ms`，`message_id` 是真实身份（inbox 里看得到、撤得掉）。
   *
   * 消息本身三条路都**已经落盘**，但落到哪儿 / 之后会不会自己动，各有事实（不要互相套用）：
   * - `draining`：held pending；进程存活期间不会再起 run。重启后 human 源的条目由
   *   `recoverPendingInputs` 重投，agent 源的条目保持 unread（模型 `inbox read` 取）；
   * - `rotate`：quiet 条目（不 hold、不带 session_id、**永不当 run input**）；新 body 的
   *   notice hook 只报计数，正文由模型 `inbox read` 取 —— 它不会自动变成一轮 run；
   * - `stopped`：held pending；解闸（`unblockBodies` → `retryHeldMessages`）后真的重投并起跑。
   *
   * 所以调用方**不要重发**（重发就是两份），而是按 `reason` 告诉用户接下来会发生什么。
   */
  private deferredResult(
    record: MemberRecord,
    sessionId: string,
    message: AgentMessage,
    reason: AdmitDeferredReason,
  ): AdmitResult {
    const retryAfterMs = DEFERRED_RETRY_AFTER_MS[reason];
    // 单行观测：谁、哪条消息、为什么没接、多久后可以再问（排查「气泡为什么不动」）。
    this.logger.info('session.input.deferred', {
      agent_id: record.id,
      session_id: sessionId,
      message_id: message.id,
      reason,
      ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
    });
    return {
      status: 'deferred',
      reason,
      message_id: message.id,
      agent_id: record.id,
      session_id: sessionId,
      ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
    };
  }

  /**
   * 提交一条消息给 scheduler；预算 turn-start block 时留在 mailbox（不 submit）。
   * 每个 run id 在提交前固定，保证 entry 返回 / events 一致。
   */
  private async submitMessage(
    record: MemberRecord,
    entry: ExecutionUnitEntry,
    message: AgentMessage,
    resume = false,
  ): Promise<{ runId: string; handle: RunHandle }> {
    if (this.draining || entry.closing || entry.retired) {
      throw new AgentError('member_closed', `member_closed: ${record.id}`);
    }
    const runId = this.newId();
    entry.queuedRuns.add(runId);
    const task: ScheduledTask = {
      agent: { id: record.id } as AgentHandle,
      runId,
      sessionId: entry.bindingId,
      input: message.content,
      executor: async (scheduledRunId) => {
        entry.queuedRuns.delete(scheduledRunId);
        return this.startExecutionUnitRun(record, entry, message, scheduledRunId, resume);
      },
    };
    try {
      const handle = await this.scheduler.submit(task);
      return { runId, handle };
    } catch (error) {
      entry.queuedRuns.delete(runId);
      // I3（审计点 1/6）：出队**必须**收口 —— 调用方决定选哪个出口：
      // `admitInternal` = unhold（body 已收口）或 discard（明确投递失败）；
      // `interrupt` = restoreConsumedUnread / unhold。
      const index = entry.pending.indexOf(message);
      if (index >= 0) entry.pending.splice(index, 1);
      throw error;
    }
  }

  /**
   * I1（唯一 hold 写入点）：写前日志 + 登记持有者 body。
   *
   * 所有把消息交给 body mailbox 的路径都必须经过这里：先 append（同 id 幂等，已存在
   * 则不改状态），再 hold。**不要在别处直接调 `inbox.hold`**，否则 `held` 会重新变回
   * 第二套独立状态（case 0 的 D1–D3）。
   *
   * 投递模式恒为 `input`：这里写下的消息本体就是下一轮 run input。既有消息被
   * urgent `message_id` 复用时，这也是把它从 quiet / wake 升级成 input 的唯一入口。
   *
   * **`session_id` 的分界（0.53，写在这里而不是别处）**：只有这条路（input 投递）把
   * `session_id = bodyId` 落进条目，因为只有这条路的消息「会变成某个会话的下一轮输入」。
   * `wake` / `quiet` 的 append（rotate 窗口 `:2225`、notify `:3611`、`inbox insert`）**一律
   * 不传 `session_id`** —— 那两类消息本来就不该执行，带上归属会让进程重启后的恢复扫描
   * 把它们重投一次（把「只留档」变成「再执行一遍」）。恢复的唯一判据就是这个字段，
   * 所以这条分界是**语义边界**，不是可选的注释。
   */
  private trackInbox(agentId: string, message: AgentMessage, bodyId: string): void {
    if (this.inbox === undefined) return;
    this.inbox.append(
      agentId,
      {
        id: message.id,
        ts: message.ts,
        source: inboxSourceOf(message),
        text: message.content,
        // 归属会话 = 接管这条消息的 body（`entry.bindingId`）。
        session_id: bodyId,
        // 会话血缘随条目落盘：队头直投（以及重启恢复）要把这条送回它原本的
        // conversation，否则每条重投都会新开一个会话。
        ...(message.conversation_id !== undefined
          ? { conversation_id: message.conversation_id }
          : {}),
        // 附件引用随条目落盘：重启恢复重投时带上，附件不丢。
        ...(message.refs !== undefined ? { refs: message.refs } : {}),
        // team 日志关联随条目落盘：编辑 / 删除 team 消息时按它定位这份副本。
        ...(message.team_message_id !== undefined
          ? { team_message_id: message.team_message_id }
          : {}),
        // 显示名随条目落盘（只给条带身份行）：入队这一刻 registry 里还有发送方，
        // 之后渲染时已经无处可查 —— 不存下来，卡头就只能摆一串 UUID。
        ...(message.from_name !== undefined ? { from_name: message.from_name } : {}),
        // 求救标记随条目落盘（q-distress-message）：重投 / 重启恢复后防循环仍认得它。
        ...(message.distress === true ? { distress: true as const } : {}),
      },
      { delivery: 'input' },
    );
    this.inbox.hold(agentId, message.id, bodyId);
  }

  /**
   * I2（唯一消费点）：消息真正作为本轮 run input 时收口 inbox（consumed + unhold）。
   *
   * 必须与「从 `entry.pending` 出队」紧邻，中间不得插入 `await` 或早返回：出队而没消费
   * 会让这条永远停在 unread+held（谁都不再投递它）；消费而没出队会被重投一次。
   */
  private async consumeAsRunInput(
    agentId: string,
    messageId: string,
    bodyId: string,
  ): Promise<void> {
    await this.inbox?.markConsumed(agentId, [messageId], bodyId);
  }

  private holdBlockedMessage(
    record: MemberRecord,
    entry: ExecutionUnitEntry,
    message: AgentMessage,
    check: BudgetBlockedCheck,
  ): void {
    const conversationId = message.conversation_id;
    if (conversationId === undefined) return;
    entry.budgetHold.add(conversationId);
    this.budgetPort?.noteHold?.(conversationId, record.id);
    this.budgetPort?.noteTurnBlocked?.({
      conversation_id: conversationId,
      ...(record.teamId !== undefined ? { team_id: record.teamId } : {}),
      dimension: check.dimension,
      reason: check.reason,
    });
    if (this.blockedBudgetEvents.has(conversationId)) return;
    this.blockedBudgetEvents.add(conversationId);
    this.emitBudgetBlocked(record, check, {
      conversation_id: conversationId,
      message_id: message.id,
      from: message.from,
      to: record.id,
      phase: 'turn_start',
    });
  }

  private queuePositionFor(runId: string, status: RunStatus): number | undefined {
    if (status !== 'queued' || this.scheduler.snapshot === undefined) return undefined;
    const index = this.scheduler.snapshot().queued.findIndex((run) => run.runId === runId);
    return index >= 0 ? index + 1 : undefined;
  }

  // ─── ExecutionUnit 执行 ─────────────────────────────────────────────────

  /**
   * scheduler executor：开始该 body 的一轮。
   * 预算 turn_start 检查在这里（而不是提交时）：block 时消息留在 body mailbox，
   * override / release 后由 `retryHeldMessages` 重新准入。
   */
  private async startExecutionUnitRun(
    record: MemberRecord,
    entry: ExecutionUnitEntry,
    message: AgentMessage,
    runId: string,
    resume = false,
  ): Promise<RunHandle> {
    if (entry.retired || entry.closing) {
      // I3（审计点 2/6）：body 已收口 → 不出队、不消费；hold 由 retire / close 的
      // `releaseHeldFor` 统一释放（消息回到 unread，交给新 body 注入）。
      const cancelled = new ExecutionUnitRunHandle(runId, record.id, entry.bindingId);
      cancelled.markCancelled('body closed');
      return cancelled;
    }
    if (entry.hardStop !== undefined) {
      // 0.55 硬错误闸（最后一道）：闸之前就已经 submit 出去的 run 也会走到这里。
      // 与预算 turn_start 阻塞同一形态 —— 不出队、不消费、不调 provider，消息留在
      // `entry.pending` + held；解闸（`unblockBodies`）后由 `retryHeldMessages` 重投。
      // 这是「同一份必然失败的请求只允许发一次」的实现点：闸落下之后任何自动链路
      // （队头直投 / 摘要唤醒 / 已排队 run）都到不了 provider。
      const held = new ExecutionUnitRunHandle(runId, record.id, entry.bindingId);
      held.complete('');
      return held;
    }
    const conversationId = message.conversation_id;
    if (!this.isHumanPrincipal(record.id)) {
      const check = this.checkTurnStart(record, message, entry.bindingId);
      if (!check.ok) {
        // I3（审计点 3/6）：预算 turn_start 阻塞 → 消息留在 `entry.pending` 且保持
        // hold，收口 = 等 `retryHeldMessages` 重投；期间可用 read includeHeld 看到正文。
        this.holdBlockedMessage(record, entry, message, check);
        const held = new ExecutionUnitRunHandle(runId, record.id, entry.bindingId);
        held.complete('');
        return held;
      }
    }
    if (conversationId !== undefined) {
      this.budgetPort?.noteTurnStarted({
        conversation_id: conversationId,
        ...(record.teamId !== undefined ? { team_id: record.teamId } : {}),
        agent_id: record.id,
        message_id: message.id,
      });
      entry.budgetHold.delete(conversationId);
      this.blockedBudgetEvents.delete(conversationId);
      this.budgetPort?.clearHold?.(conversationId, record.id);
      this.emitBudgetWarnings(record, conversationId, 'turn_start');
    }
    // D1：ensureRuntime 可能抛错，必须在「出队 + 消费」之前完成 —— 否则 body 起不来时
    // 消息已经离开 mailbox 却仍是 unread+held（谁都不再投递它 = 黑洞）。
    //
    // 0.56 send-first：这是 **spawn 的唯一等待点**（admit 只把它踢出去，不再等，见
    // `startSpawn`）。失败必须「明确报错 + 留住消息」，两条都不许省：
    // - 明确报错：handle 收成 failed 终态（`run.failed` 可见、`runs.get` 查得到）；
    // - 留住消息：消息**不**出队、不消费，`unhold` 之后回到 unread —— 人能在收件箱里
    //   读回原文，下一次准入会重投。绝不允许「静默丢掉用户刚发的那句话」。
    try {
      await this.ensureRuntime(entry);
    } catch (error) {
      // q-error-e2（§3.6）：spawn_failed 证据契约——废手拼前缀，结构化 details
      // 携 parent_id/team_id/model_ref/resolution/candidates；error_id 出生点 stamped，
      // cause 链沿原生 Error.cause（errorSummary 摘要上 wire，stack 仅日志）。
      const spawnError = new AgentError('spawn_failed', errorText(error), {
        cause: error,
        operation: 'body.spawn',
        details: this.spawnFailureDetails(record, error),
      });
      const spawnDetails = spawnError.details ?? {};
      this.logger.error('agent.body.spawn_failed', {
        member_id: record.id,
        session_id: entry.bindingId,
        run_id: runId,
        ...(record.parentId !== undefined ? { parent_id: record.parentId } : {}),
        ...(spawnDetails.model_ref !== undefined ? { model_ref: spawnDetails.model_ref } : {}),
        error_id: spawnError.errorId,
        code: 'spawn_failed',
        error: errorText(error),
        // E2 §3.3：stack 全文仅日志面（log-hub 脱敏），不上 wire（裁定⑤）。
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
      });
      this.inbox?.unhold(record.id, [message.id]);
      const failed = new ExecutionUnitRunHandle(runId, record.id, entry.bindingId);
      failed.fail(spawnError);
      // q-distress-message：body 起不来 = 投递终态故障（消息会反复重投反复失败），
      // 以遇难 agent 身份求救；forceCode 声明服务层触发码（错误对象未必有稳定 code）。
      void this.maybeSendDistress(record, entry, error, message, DISTRESS_SPAWN_FAILED).catch(
        (distressError) => {
          this.logger.warn('agent.distress.error', {
            member_id: record.id,
            error: errorText(distressError),
          });
        },
      );
      return failed;
    }
    entry.state = 'running';
    entry.lastActiveAt = this.now();
    entry.active = {
      runId,
      messageId: message.id,
      ...(conversationId !== undefined ? { conversationId } : {}),
    };
    this.registry.touchBinding(record.id, entry.bindingId, entry.lastActiveAt);
    this.updateAgentState(record.id);
    this.scheduleSnapshot();
    const handle = new ExecutionUnitRunHandle(runId, record.id, entry.bindingId);
    this.bindRunCancelHandler(entry, handle);
    // I2 + D1：出队与消费必须紧邻，中间不得有 await / 早返回（本行到下一行是唯一窗口）。
    // 0.32：消息真正作为 run input 开始前标记 consumed（inbox 至多注入一次）；
    // startup 消息不在 inbox 里，markConsumed 对未知 id 无操作。
    const index = entry.pending.indexOf(message);
    if (index >= 0) entry.pending.splice(index, 1);
    await this.consumeAsRunInput(record.id, message.id, entry.bindingId);
    void this.executeExecutionUnitTurn(record, entry, message, handle, resume);
    return handle;
  }

  /** 执行并收口一轮；任何异常都收口为失败，不让后台任务产生未处理 rejection */
  private async executeExecutionUnitTurn(
    record: MemberRecord,
    entry: ExecutionUnitEntry,
    message: AgentMessage,
    handle: ExecutionUnitRunHandle,
    resume = false,
  ): Promise<void> {
    let result: MemberTurnResult | undefined;
    let failure: string | undefined;
    let leaseLostFailure = false;
    try {
      result =
        resume && this.runtime.resumeTurn !== undefined
          ? await this.runtime.resumeTurn(entry.runtimeMember, message, handle.id)
          : await this.runtime.runTurn(entry.runtimeMember, message, handle.id);
    } catch (error) {
      leaseLostFailure = this.isLeaseLossFailure(entry, error);
      if (!handle.cancelRequested && !entry.closing) {
        failure = errorText(error);
        this.logger.error('agent.run.failed', {
          member_id: record.id,
          session_id: entry.bindingId,
          run_id: handle.id,
          error: failure,
        });
        // 0.55 硬错误闸：不可重试的 provider 失败之后，这具 body 停止自动接单。
        // 租约丢失的那一类不算（body 马上被 dispose 重起，闸挂在旧 entry 上没有意义）。
        if (!leaseLostFailure) {
          this.markBlocked(entry, error);
          // q-distress-message：致命错误的通信兜底（与硬错误闸互补）。best-effort，
          // 不影响终态收口；防循环 / 限流 / 收件人解析都在方法内。
          void this.maybeSendDistress(record, entry, error, message).catch((distressError) => {
            this.logger.warn('agent.distress.error', {
              member_id: record.id,
              error: errorText(distressError),
            });
          });
        }
      }
    }
    handle.setUsage(result?.usage);
    const conversationId = message.conversation_id;
    if (conversationId !== undefined) {
      this.budgetPort?.noteTurnFinished({
        conversation_id: conversationId,
        ...(record.teamId !== undefined ? { team_id: record.teamId } : {}),
        agent_id: record.id,
        message_id: message.id,
        ...(result?.usage !== undefined ? { usage: result.usage } : {}),
      });
    }
    // 清空 active（同 body 可继续下一轮）
    entry.active = undefined;
    entry.state = 'idle';
    entry.lastActiveAt = this.now();
    this.registry.touchBinding(record.id, entry.bindingId, entry.lastActiveAt);
    if (result?.usage !== undefined) this.registry.setUsage(record.id, result.usage);

    if (leaseLostFailure && !entry.closing && !entry.retired) {
      // 租约丢失后 EU 内部的 leaseLost 没有重置路径；拆掉这具 body runtime，
      // 下一次 admit 重新 spawn 并重新获取 BindingLease（不改 membership / epoch）。
      // closing / retired 的体由 rotate / close 自己的收口路径 dispose，避免竞态。
      this.logger.warn('agent.body.lease_lost', {
        member_id: record.id,
        session_id: entry.bindingId,
        run_id: handle.id,
      });
      await this.disposeEntry(entry);
    }

    const current = this.registry.get(record.id);
    const cancelled = handle.cancelRequested || result?.outcome === 'cancelled';
    const outcome = cancelled
      ? 'cancelled'
      : failure !== undefined
        ? 'failed'
        : (result?.outcome ?? 'completed');

    // 旧 body（rotate / TTL / close 已退役，或 agent 已关）：先分清这一轮是
    // 「自己交棒的那一轮」还是「真迟到的旧轮」（判据 `classifyRetiredTurn`）。
    if (entry.retired || !current || current.state === 'closed') {
      if (classifyRetiredTurn(entry, handle.id) === 'handoff') {
        // 交棒轮是合法收尾（模型在本轮 run 里提交了 rotate，随后按工具要求把话说完）：
        // 走正常记账 —— 写 agent 终态、正文随 `settleHandle` 采用、父级通知照常发，
        // **不发 `agent.reply.stale`**（它不是迟到结果，没有「未被采用」这回事）。
        //
        // 唯一要显式说的例外：这一轮 failed / cancelled / 正文为空。此时没有收尾正文
        // 可交，parent 只会看到状态变化 —— 与 0.51 之前「什么都不发」一样是静默，所以
        // 复用 `agent.reply.stale` 的 reason 字段新增一个值来发明确 notice。
        // 为什么复用这个类型而不是新事件 / 环境信息：它是既有 `content` 档 + typed
        // notice 的唯一「这一轮为什么没产出正文」通道，新增类型要动三档表、门禁与事件
        // 文档；正文不进事件流（ADR-092 第 18 条）时，reason 就是唯一需要区分的字段。
        if (outcome !== 'completed' || !nonEmpty(result?.content)) {
          this.emitForSession('agent.reply.stale', record, entry.bindingId, {
            body_id: entry.bindingId,
            epoch: entry.epoch,
            message_id: message.id,
            reason: 'handoff_no_reply',
            outcome,
          });
        }
        this.updateAgentState(record.id, outcome);
        this.scheduleSnapshot();
        await this.disposeEntry(entry);
        this.settleHandle(handle, outcome, failure, result?.content);
        return;
      }
      // 真迟到的旧轮：epoch fencing，不写 agent 状态、不投父队列
      if (outcome === 'completed' && nonEmpty(result?.content)) {
        this.emitForSession('agent.reply.stale', record, entry.bindingId, {
          body_id: entry.bindingId,
          epoch: entry.epoch,
          message_id: message.id,
          reason: 'epoch_fenced',
        });
      }
      this.updateAgentState(record.id);
      this.scheduleSnapshot();
      if (entry.retired) await this.disposeEntry(entry);
      this.settleHandle(handle, outcome, failure, result?.content);
      return;
    }

    // 0.41 之后不再有「收口自动回传正文」：成员的显式报告才是权威，父级要原文可以
    // 用 agent read / agents.inbox 自己读；这里只更新状态并收口 handle。
    this.updateAgentState(record.id, outcome);
    this.scheduleSnapshot();
    this.settleHandle(handle, outcome, failure, result?.content);
  }

  // ─── 硬错误闸（0.55） ────────────────────────────────────────────────

  /**
   * 立闸：这具 body 在一轮不可重试的 provider 硬错误之后停止自动接单。
   *
   * 为什么必须立闸（今天 14:52–14:58 的真事故）：`run.failed` 只写一行 Team 日志，
   * 状态与投放链路都不知道这一轮已经废了；下一条 inbox 消息照样把同一份必然 400 的
   * 上下文再发一次，于是 3 分钟里同一份请求被自动重发 3 次、每次都是同一个 400，
   * 最后只能由人手 `turn cancelled`。
   *
   * 落闸只改**闸字段**，不碰 `state`：终态仍由 `updateAgentState(record, 'failed')`
   * 那条既有路径写（对外看到的就是 `failed` + `bodies[].blocked`）。
   */
  private markBlocked(entry: ExecutionUnitEntry, error: unknown): void {
    const blocked = hardProviderFailure(error, this.now());
    if (blocked === undefined) return;
    entry.hardStop = blocked;
    // 已有的 queued run 不再去调 provider：`startExecutionUnitRun` 的闸会拦下它们，
    // 消息留在 pending + held（下面这条日志里的 count 就是它们的条数）。
    this.logger.warn('agent.body.blocked', {
      agent_id: entry.agentId,
      session_id: entry.bindingId,
      code: blocked.code,
      at: blocked.at,
      queued_runs: entry.queuedRuns.size,
      pending: entry.pending.length,
      error: blocked.reason,
    });
  }

  /**
   * 解闸：清掉这具 body 的硬错误闸，并把留在队列里的消息重新准入。
   *
   * 只有**显式动作**能走到这里（见三个调用点），闸本身没有超时 / 自动重试：
   * - 人类投递（`admitInternal` 里 `isHumanPrincipal`）：人在键盘前说「再试一次」；
   * - `interrupt: true` 的 urgent 投递（`interrupt`）：调用者明确要求「现在就做」；
   * - 换新 body（rotate / restart）：新 entry 没有闸，旧 entry 随退役消失。
   *
   * `by` 只进日志：解闸是一条留下痕迹的动作，排查时必须能说出「谁放行的」。
   */
  private unblockBodies(agentId: string, by: string): void {
    let cleared = false;
    for (const entry of this.liveEntries(agentId)) {
      if (this.clearBlocked(entry, by)) cleared = true;
    }
    if (!cleared) return;
    for (const entry of this.liveEntries(agentId)) {
      // 闸期间排进来的消息全都还在：mailbox 里的一批重新 submit，inbox 里未被持有的
      // 那一批交给 `dispatchInbox`（队头直投 / 摘要唤醒，与正常链路同一条路）。
      this.retryHeldMessages(entry);
    }
    if (this.noticeDirty.has(agentId)) {
      void this.dispatchInbox(agentId).catch(() => {});
    }
  }

  /**
   * 清闸 + 留痕（不动队列）。返回 true 表示这具 body 之前确实是闸着的。
   *
   * 与 `unblockBodies` 分开：`interrupt` 那条路会**自己**重排整个 mailbox（打断消息
   * 排最前、旧队列随后），它只需要清闸，不能让 `retryHeldMessages` 抢先出队。
   */
  private clearBlocked(entry: ExecutionUnitEntry, by: string): boolean {
    const blocked = entry.hardStop;
    if (blocked === undefined) return false;
    entry.hardStop = undefined;
    this.logger.info('agent.body.unblocked', {
      agent_id: entry.agentId,
      session_id: entry.bindingId,
      by,
      code: blocked.code,
      blocked_at: blocked.at,
      pending: entry.pending.length,
      error: blocked.reason,
    });
    return true;
  }

  /**
   * 本轮失败是否由租约丢失导致。
   *
   * `LeaseExpiredError`（lease_expired / stale_fence）最直接；但租约丢失时
   * `ExecutionUnit.onLeaseLost` 会以 `shutdown` abort 当前 run，外层看到的只是
   * `Error('shutdown')`，所以再按 EU 的 session lease token 兜底判定。
   */
  private isLeaseLossFailure(entry: ExecutionUnitEntry, error: unknown): boolean {
    if (error instanceof LeaseExpiredError) return true;
    const message = errorText(error);
    if (message.includes('lease_expired') || message.includes('stale_fence')) return true;
    if (this.leaseService === undefined) return false;
    return (
      message === 'shutdown' && this.runtime.sessionLeaseToken?.(entry.bindingId) === undefined
    );
  }

  // ─── 遇难求救（q-distress-message） ─────────────────────────────────

  /**
   * 致命 run 错误之后，以遇难 agent 自身身份（from=record.id）发一条普通求救消息。
   *
   * 与 0.55 硬错误闸互补：闸让 body 停止自动接单（不再重发必然失败的请求），
   * 本方法让停摆**可见可救援** —— parent/创建者（fallback 最近发送者）收到一条
   * 可回复的 inbox 消息，知道谁遇难、在哪、为什么、怎么救。
   *
   * 防循环三道闸：
   * 1. 本轮输入本身是求救消息（`trigger.distress`）⇒ 不发（防级联风暴）；
   * 2. 每 agent 冷却窗口（DISTRESS_COOLDOWN_MS）内至多一条（去重 / 限流）；
   * 3. 收件人解析跳过自身难保的求救者（inbox 历史里 distress 条目不算「最近发送者」）。
   *
   * 投递走既有 `admitInternal`（新 conversation，不带 origin 血缘 ⇒ 不占旧会话的
   * hop/cycle 预算）；失败只留日志、不覆盖原始错误。best-effort：任何异常都不允许
   * 影响 run 终态收口（调用方 `void ... .catch`）。
   *
   * @param forceCode 服务层触发码（spawn_failed）：错误对象没有稳定 code 时由调用方声明。
   */
  private async maybeSendDistress(
    record: MemberRecord,
    entry: ExecutionUnitEntry,
    error: unknown,
    trigger?: AgentMessage,
    forceCode?: string,
  ): Promise<void> {
    // 退役 / 关闭中的 body：rotate 交棒 / close 的迟到轮不是遇难，不发。
    if (entry.retired || entry.closing) return;
    if (trigger?.distress === true) {
      this.logger.info('agent.distress.skipped', {
        member_id: record.id,
        session_id: entry.bindingId,
        reason: 'distress_input',
      });
      return;
    }
    const classified =
      forceCode !== undefined
        ? { code: forceCode, message: errorText(error) }
        : classifyDistress(error);
    if (classified === undefined) return;
    const now = this.now();
    const last = this.distressSentAt.get(record.id);
    if (last !== undefined && now - last < DISTRESS_COOLDOWN_MS) {
      this.logger.info('agent.distress.skipped', {
        member_id: record.id,
        session_id: entry.bindingId,
        reason: 'cooldown',
        code: classified.code,
      });
      return;
    }
    const recipients = this.distressRecipients(record, trigger);
    const baseContent = {
      memberId: record.id,
      ...(record.name !== undefined ? { memberName: record.name } : {}),
      sessionId: entry.bindingId,
      ...(record.teamId !== undefined ? { teamId: record.teamId } : {}),
      code: classified.code,
      message: classified.message,
    };
    const content = renderDistressContent(baseContent);
    for (const recipient of recipients) {
      try {
        await this.admitInternal({
          content,
          agent_id: recipient.id,
          from: record.id,
          channel: 'direct',
          distress: true,
        });
        this.distressSentAt.set(record.id, now);
        this.logger.info('agent.distress.sent', {
          member_id: record.id,
          session_id: entry.bindingId,
          to: recipient.id,
          code: classified.code,
        });
        return;
      } catch (deliveryError) {
        // 单个收件人投不进（可见性 / 预算 / 已关闭）：试下一个候选，不中断求救。
        this.logger.warn('agent.distress.delivery_failed', {
          member_id: record.id,
          to: recipient.id,
          code: classified.code,
          error: errorText(deliveryError),
        });
      }
    }
    // 成员收件人皆无 / 皆投不进 ⇒ 人类兜底（顶层 / 无 parent / 远程根 agent）。
    // 人类不跑 run，天然不触发级联求救；投面向人类的本机 Team 日志（零 dispatch）。
    if (this.humanDistress !== undefined) {
      try {
        await this.humanDistress({
          from: record.id,
          content: renderDistressContent({ ...baseContent, human: true }),
          ...(record.teamId !== undefined ? { teamId: record.teamId } : {}),
        });
        this.distressSentAt.set(record.id, now);
        this.logger.info('agent.distress.sent', {
          member_id: record.id,
          session_id: entry.bindingId,
          to: 'human',
          code: classified.code,
        });
        return;
      } catch (humanError) {
        this.logger.warn('agent.distress.human_delivery_failed', {
          member_id: record.id,
          code: classified.code,
          error: errorText(humanError),
        });
      }
    }
    // 成员与人类通道皆无 / 皆失败：不发，留诊断日志。
    this.logger.warn('agent.distress.no_recipient', {
      member_id: record.id,
      session_id: entry.bindingId,
      code: classified.code,
      error: singleLineReason(classified.message),
    });
  }

  /**
   * 求救收件人解析（按优先级，去重，至多 3 个候选）：
   *
   * 1. **parent/创建者**：contractor 的落盘 `parentId`、peer 的进程内创建者链接
   *    （`peerParentIdFor`），再加持久化的 `sourceAgentId`（重启后 peer 链接丢了它还在）；
   * 2. **fallback 最近发送者**：本轮输入若来自 agent 就是它；否则扫 inbox 历史
   *    （newest-first，含 consumed）找最近一个本机 agent 来源。跳过 distress 条目
   *    （自身难保的求救者不是救援对象）与人类 / 系统 / 联邦来源。
   *
   * 候选必须是在册且未 left/closed 的成员（presence gone 可以 —— admit 会重建 body，
   * 这正是「唤醒救援者」的语义）。全部不满足 ⇒ 空数组，调用方留日志不发。
   */
  private distressRecipients(record: MemberRecord, trigger?: AgentMessage): MemberRecord[] {
    const out: MemberRecord[] = [];
    const seen = new Set<string>([record.id]);
    const push = (id: string | undefined): void => {
      if (!nonEmpty(id) || seen.has(id)) return;
      const candidate = this.registry.get(id) ?? this.registry.getBySession(id);
      if (candidate === undefined) return;
      if (candidate.id === record.id) return;
      if (candidate.membership === 'left' || candidate.state === 'closed') return;
      seen.add(candidate.id);
      out.push(candidate);
    };
    push(this.peerParentIdFor(record));
    push(record.sourceAgentId);
    if (trigger !== undefined && trigger.source === 'agent') push(trigger.from);
    const inbox = this.inbox;
    if (inbox !== undefined) {
      for (const stored of inbox.history(record.id, DISTRESS_HISTORY_SCAN)) {
        if (out.length >= 3) break;
        if (stored.distress === true) continue;
        push(stored.source);
      }
    }
    return out;
  }

  /**
   * Stage 4（内部装配，不暴露为 RPC）：按 run_id 恢复成员的一轮 run。
   *
   * 装配层先加载 RunRecord 并按 `agent_id` 路由到这里；本方法再经 scheduler 的
   * session 串行键提交，复用 `ExecutionUnitRunHandle` 的 active run 记账与取消路由，
   * 不另造队列。`run_not_found` / `agent_not_found` / `member_execution_not_found`
   * 是稳定错误码。
   */
  /**
   * 只读 inbox 视图（`agents.inbox` RPC 的唯一数据源）。
   *
   * **只读**：只调用 `list()` / `findByIds()`，不 markConsumed、不 hold / unhold、
   * 不改任何持久字段与文件格式 —— 返回正文只是把已落盘的 `text` 读出来看一眼。
   * `messageIds` 非空时才带 `text`（最多 10 条，越界由 RPC 层拒绝）。
   */
  inboxSnapshot(
    agentId: string,
    options: {
      includeHeld?: boolean;
      messageIds?: readonly string[];
      /** 只返回归属这个会话的条目（等值比较；缺 `session_id` 的老条目永不命中）。 */
      sessionId?: string;
    } = {},
  ): {
    agent_id: string;
    unread: number;
    pending: number;
    /**
     * 0.55 additive：这具 body 的硬错误闸（缺省 = 能接活）。
     *
     * 放在条带视图中，是因为「排队消息为什么一直不动」的上下文就在这里：用户看到
     * 3 条 pending 时，同一次读里就能看到「因为 400 上下文超限停摆、什么时刻停的」。
     * `agents.inbox` 的 handler 是 `{...snapshot}` 透传，所以这条字段直接上 wire。
     */
    blocked?: BodyBlocked;
    entries: {
      message_id: string;
      from: string;
      summary: string;
      status: 'unread' | 'held';
      ts: number;
      session_id?: string;
      /**
       * 发送者显示名（additive）：条带身份行据此显示 `agent:<name>`。
       * 缺省 = 老条目 / 发送方没有本机成员名 ⇒ 渲染侧退化成短 id（不显示完整 UUID）。
       */
      from_name?: string;
      text?: string;
      /** 异步作业占位元数据（q-async-bash-viz additive，kind 无关）：渲染侧按 kind 画作业卡。 */
      async_job?: InboxAsyncJobMeta;
    }[];
  } {
    const store = this.inbox;
    if (store === undefined) return { agent_id: agentId, unread: 0, pending: 0, entries: [] };
    // includeHeld 固定 true：条带要看到「已排进队列、尚未成为 run input」的那些。
    const listed = store.list(agentId, { includeHeld: options.includeHeld ?? true });
    const wanted = options.messageIds;
    // 只有显式点名才读正文；`findByIds` 不做 status/hold 过滤、也不改状态。
    const bodies =
      wanted !== undefined && wanted.length > 0 ? store.findByIds(agentId, wanted) : [];
    const bodyById = new Map(bodies.map((entry) => [entry.id, entry.text]));
    const sessionId = options.sessionId;
    const entries = listed.messages
      // 归属过滤放在服务端：调用方（条带）只拿得到自己那一份，不需要在客户端猜。
      // 异步作业占位是 quiet（无条目级 session_id，避免重启重投），归属在 async_job 元数据里：
      // 会话视图按它匹配，作业卡才能出现在发起会话的条带里（q-async-bash-viz，kind 无关）。
      .filter(
        (entry) =>
          sessionId === undefined ||
          entry.session_id === sessionId ||
          entry.async_job?.session_id === sessionId,
      )
      .map((entry) => {
        const text = bodyById.get(entry.id);
        return {
          message_id: entry.id,
          from: entry.source,
          summary: entry.summary,
          status: entry.held ? ('held' as const) : ('unread' as const),
          ts: entry.ts,
          ...(entry.session_id !== undefined ? { session_id: entry.session_id } : {}),
          // 显示名只读透传：条带据此把 `agent:<id>` 读成名字，缺省时前端自己退短 id。
          ...(entry.from_name !== undefined ? { from_name: entry.from_name } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(entry.async_job !== undefined ? { async_job: entry.async_job } : {}),
        };
      });
    // `unread` / `pending` 保持 **agent 维度**（过滤前），它们是收件箱口径，不是会话口径。
    // 0.55：闸是 body 维度的事实，与统计口径无关——有闸就带上，没有就不写。
    const blocked = this.liveEntries(agentId).find(
      (entry) => entry.hardStop !== undefined,
    )?.hardStop;
    return {
      agent_id: agentId,
      unread: listed.unread,
      pending: listed.pending,
      ...(blocked !== undefined ? { blocked } : {}),
      entries,
    };
  }

  /**
   * 0.51：该成员这一份工具清单（`tools.list{agent_id}` 的唯一数据源）。
   *
   * 服务层只做「成员是否认识 + 把记录翻成运行期视图」这一件事；工具判据全部在
   * `MemberExecutionHost.toolSurface`（活身体实读 / 无身体按 spawn 同一套推导）。
   * 注册表里没有这个 id 时返回 `undefined`：RPC 层据此报 `not_found`，不静默给空列表。
   */
  toolSurface(agentId: string): MemberToolEntry[] | undefined {
    const record = this.registry.get(agentId);
    if (record === undefined) return undefined;
    // 老执行内核（port 没实现 toolSurface）同样返回 undefined：那就真的答不出，
    // 由 RPC 层给 not_found，而不是让调用方以为「这个成员一个工具都没有」。
    return this.runtime.toolSurface?.(toRuntimeMember(record));
  }

  /**
   * 通用成员级工具（当前只有 `inbox`）：所有成员共有，与具体成员无关。
   *
   * 服务层只透传执行内核的判据（`MemberExecutionPort.commonMemberTools`）；
   * 老内核没实现时返回空数组 —— 节点口径退回纯全局工具，不报错。
   */
  commonMemberTools(): MemberToolEntry[] {
    return this.runtime.commonMemberTools?.() ?? [];
  }

  /**
   * 撤回待处理输入（`agents.recall`，0.53）：把消息从「将执行」集合里拿走。
   *
   * 分档只有一条判据：**消息的 source**（inbox 条目里的 `source` 就是发送者 principal）。
   * - `human`：用户说「这条不发了」⇒ `inbox.discard` 真删（不留墓碑）。
   * - 其它（agent / system）：取消 = 这次不执行，但消息**留档** ⇒ `inbox.unhold`
   *   （回到可读 unread，模型仍能 `inbox read`）。这与 0.32 `interrupt` 分支「不丢正文」
   *   的口径一致。
   *
   * 条目没有也不该有 run id：要取消的 queued run 只能通过 `runMessageIds` 反查（同一条
   * 消息至多对应一个进行中的 run）。正在执行的那条不能撤回（`active`），已消费的也不能
   * （`consumed`）—— 撤回是「还没发出去」的操作。
   */
  async recall(input: AgentRecallInput): Promise<AgentRecallResult> {
    await this.ready;
    const agentId = input.agent_id;
    const ids = [...new Set(input.message_ids)];
    const deleted: string[] = [];
    const skipped: AgentRecallSkip[] = [];
    if (ids.length === 0) return { deleted, skipped };
    const store = this.inbox;
    const known = new Map(
      (store === undefined ? [] : store.findByIds(agentId, ids)).map((entry) => [entry.id, entry]),
    );
    for (const messageId of ids) {
      const entry = known.get(messageId);
      if (entry === undefined) {
        skipped.push({ message_id: messageId, reason: 'not_found' });
        continue;
      }
      if (entry.status === 'consumed') {
        skipped.push({ message_id: messageId, reason: 'consumed' });
        continue;
      }
      const holder =
        entry.session_id !== undefined ? this.findEntry(agentId, entry.session_id) : undefined;
      if (holder?.active?.messageId === messageId) {
        skipped.push({ message_id: messageId, reason: 'active' });
        continue;
      }
      this.cancelQueuedRunsFor(holder, messageId, 'recall');
      // 分档收口：human ⇒ 真删；其它 ⇒ 留档（unhold 回 unread）。
      this.closeWithdrawnMessage(agentId, holder, messageId, entry.source);
      deleted.push(messageId);
    }
    return { deleted, skipped };
  }

  /**
   * 按来源 Team 日志条目 id 撤回 inbox 投递（team 消息编辑 / 删除的级联收口）。
   *
   * 与 `recall` 的唯一差别是**定位方式**：recall 按 inbox 消息 id，这里按条目落盘的
   * `team_message_id`（只有 TeamService.post 的 @ 投递会写）。找到之后走同一段逐条
   * 收口：consumed / active 跳过，其余取消 queued run + 出队 + 按 source 分档。
   * 没有命中（旧条目无关联 / 早被消费裁剪）返回 `skipped: not_found`，不报错 ——
   * 级联是 best-effort，调用方（TeamService）按条如实汇报。
   */
  async recallTeamDelivery(agentId: string, teamMessageId: string): Promise<AgentRecallResult> {
    await this.ready;
    const deleted: string[] = [];
    const skipped: AgentRecallSkip[] = [];
    const store = this.inbox;
    const found = store === undefined ? [] : store.findByTeamMessage(agentId, teamMessageId);
    if (found.length === 0) {
      skipped.push({ message_id: teamMessageId, reason: 'not_found' });
      return { deleted, skipped };
    }
    for (const entry of found) {
      const messageId = entry.id;
      if (entry.status === 'consumed') {
        skipped.push({ message_id: messageId, reason: 'consumed' });
        continue;
      }
      const holder =
        entry.session_id !== undefined ? this.findEntry(agentId, entry.session_id) : undefined;
      if (holder?.active?.messageId === messageId) {
        skipped.push({ message_id: messageId, reason: 'active' });
        continue;
      }
      this.cancelQueuedRunsFor(holder, messageId, 'recall');
      this.closeWithdrawnMessage(agentId, holder, messageId, entry.source);
      deleted.push(messageId);
    }
    return { deleted, skipped };
  }

  /**
   * 认领待处理输入（`agents.claim`，0.51）：「这几条我已经拿到正文了，从队列里拿走」。
   *
   * 0.55 起**模型侧不再有这个动作**：工具的 `read` 就等于拿走（它取到 held 条目时走的是
   * 同一条前置收口）。这条 service 路径保留给 `agents.claim` RPC 与 web 条带（用户手动
   * 「我看到了，别再投」）。
   *
   * 与 `recall` 共用**前置收口**（取消该消息的 queued run + 从 body mailbox 出队），差别
   * 只在出口：recall 按 source 真删 / 留档，`claim` 一律**消费**（inbox `consumed` +
   * 解 hold）。也就是说 claim 之后这条消息不再投递、不再出现在 list / read 里。
   *
   * 为什么前置收口不是可选项：held 的条目**已经**排进了 scheduler 的一次 run，光把它标
   * consumed 拦不住那次投递（执行侧不看 inbox 状态）。少了 `cancelQueuedRunsFor`，claim
   * 一条 pending 之后它仍会被投一次，这个动作就假了。
   *
   * 跳过口径只有两种：库里的确没有这条（`not_found`）、它早就是 consumed（`consumed`，
   * 正在跑的那条也落在这一档 —— 开跑即消费）。认领「不了的」不报错，按条回 skipped。
   */
  async claim(input: AgentClaimInput): Promise<AgentClaimResult> {
    await this.ready;
    const agentId = input.agent_id;
    const ids = [...new Set(input.message_ids)];
    const claimed: string[] = [];
    const skipped: AgentClaimSkip[] = [];
    if (ids.length === 0) return { claimed, skipped };
    const store = this.inbox;
    if (store === undefined) {
      for (const id of ids) skipped.push({ message_id: id, reason: 'not_found' });
      return { claimed, skipped };
    }
    // 判定 + 落状态都在 store.claim 一处（与模型侧工具同一个实现）；执行侧的前置收口由
    // 构造时注入的 `beforeClaim` 完成（见 `withdrawQueuedRuns`）。
    const result = await store.claim(agentId, ids);
    claimed.push(...result.claimed);
    for (const skip of result.skipped) {
      skipped.push({ message_id: skip.id, reason: skip.reason });
    }
    return { claimed, skipped };
  }

  /**
   * `claim` 的执行侧前置收口：把这几条「已经排进 scheduler、还没开跑」的消息撤下来。
   *
   * 与 `recall` 共用同一段实现（`cancelQueuedRunsFor` + `dropFromQueue`），差别只在
   * inbox 出口 —— recall 按 source 真删 / 留档，claim 交给 store 标 consumed。
   *
   * **为什么必须在消费之前**：held 的条目已经排进了一次 run，执行侧不看 inbox 状态 ⇒
   * 只标 consumed 拦不住那次投递，claim 一条 pending 之后它照样会被投一次。
   */
  private withdrawQueuedRuns(agentId: string, ids: readonly string[]): void {
    const store = this.inbox;
    if (store === undefined) return;
    for (const messageId of ids) {
      const entry = store.findByIds(agentId, [messageId])[0];
      if (entry === undefined) continue;
      const holder =
        entry.session_id !== undefined ? this.findEntry(agentId, entry.session_id) : undefined;
      this.cancelQueuedRunsFor(holder, messageId, 'claim');
      this.dropFromQueue(holder, messageId);
    }
  }

  /**
   * 外部取消 queued run 的收口（D-a）：`runs.cancel` 只动 scheduler，不经过 executor，
   * 所以 `entry.queuedRuns` / `entry.pending` / inbox 的 held 全都留在原地。不在这里收口，
   * 这个 agent 就再也不会被投递（`canDispatchInbox` 恒 false）、peer 停止通知与 TTL 回收
   * 失效（`memberStillBusy` 恒 true），而那条消息永远 pending + held。
   *
   * 只处理 **queued** run：active run 的消息早已出队并 consumed，取消由 runtime 负责；
   * resume run 没有 `runMessageIds`，`queuedRuns` 里也没有它的记账（见 `submitResumeRun`）。
   */
  releaseCancelledRun(runId: string, _reason?: string): void {
    const messageId = this.runMessageIds.get(runId);
    for (const [agentId, map] of this.executionUnitRegistry) {
      for (const entry of map.values()) {
        // active run 不在这里收口：消息早已出队并 consumed，取消由 runtime / `settleHandle`
        // 负责（那边还要按 `runMessageIds` 清 urgent 记账，提前删会漏清理）。
        if (entry.active?.runId === runId) return;
        if (!entry.queuedRuns.has(runId)) continue;
        entry.queuedRuns.delete(runId);
        this.runMessageIds.delete(runId);
        this.interruptReasons.delete(runId);
        if (messageId === undefined) return;
        const source = this.inbox?.findByIds(agentId, [messageId])[0]?.source;
        this.closeWithdrawnMessage(agentId, entry, messageId, source);
        return;
      }
    }
    // 找不到持有者（entry 已回收 / resume run 没有消息映射）：只清 run 记账，不动 inbox ——
    // 消息按「未消费」留在库里，重启恢复或用户再次投递都会重新接管它。
    this.runMessageIds.delete(runId);
    this.interruptReasons.delete(runId);
  }

  /**
   * 启动恢复卡（0.52 S1c）：把一条环境信息排进**该会话**的下一次请求。
   *
   * 走既有环境信息通道（`MemberRuntime.notice`）：活体已开跑就立刻 `appendNotice`，
   * 否则按成员暂存到下一轮 `runTurn` —— 那一轮把暂存的 notice 作为**注入消息**
   * 放在**用户输入之前**（`RunOptions.messages`），所以这张卡既进模型上下文，
   * 也作为 `vessel:notice` 消息落进会话流（web 渲染成 EnvCard）：
   * **一张卡，两边同源**（用户裁定：可见性一致，不是隐藏输入）。
   *
   * 返回 false = 这个会话现在收不了卡（不在册 / 已 left / 已 closed / 没有可重建的
   * binding）：调用方（启动恢复）据此记 `skipped`，留给下次启动，不编一条假输入。
   */
  async announceEnvironmentCard(
    sessionId: string,
    text: string,
  ): Promise<EnvironmentCardAnnouncement> {
    // P0-run-stops P4：每个 false 出口带原因（装配层聚合进 recover_done 日志；
    // `no_member` 还是僵尸标记清理判据的一半，见 node-resume / bootstrap）。
    if (typeof text !== 'string' || text.length === 0) {
      return { announced: false, reason: 'empty_text' };
    }
    await this.ready;
    const notice = this.runtime.notice;
    if (notice === undefined) return { announced: false, reason: 'no_notice' };
    const record = this.registry.getBySession(sessionId);
    if (record === undefined) return { announced: false, reason: 'no_member' };
    if (record.membership === 'left') return { announced: false, reason: 'left' };
    if (record.state === 'closed') return { announced: false, reason: 'closed' };
    // 与 `recoverPendingInputs` 同一套「可投递」判据：退役 / 未知会话不做声。
    if (this.registry.isRetiredSession(sessionId)) return { announced: false, reason: 'retired' };
    if (!liveBindings(record).some((body) => body.bindingId === sessionId)) {
      return { announced: false, reason: 'no_binding' };
    }
    try {
      // 卡片的 timestamp ＝ 产生时刻（启动），不是注入时刻：
      // 它必须在被重放的那条输入所在 run 之前（探针 d 的断言口径）。
      const at = Date.now();
      notice.call(this.runtime, record.id, text, { timestamp: at });
      this.logger.info('agent.env_card.announced', {
        agent_id: record.id,
        session_id: sessionId,
      });
      return { announced: true };
    } catch (error) {
      this.logger.warn('agent.env_card.announce_failed', {
        agent_id: record.id,
        session_id: sessionId,
        error: errorText(error),
      });
      return { announced: false, reason: 'failed' };
    }
  }

  /**
   * 启动恢复（0.53）：把**进程死亡时还没变成 run input** 的已接受输入重新投递一次。
   *
   * 判据（唯一）：`status === 'unread'` 且**未被 held** 且 `session_id` 存在且
   * 该 session 还有一个可重建的 binding。
   *
   * **源判据（runlost-graceful-restart-audit §5.3，补 G3）**：human 源 ∪ agent 源
   * （含自述转发）——只要带 `session_id`。`session_id` 是 input 投递的唯一持久判据：
   * wake/quiet 条目**不带**它（G4 语义边界不动），天然排除。0.55 硬错误闸事故的
   * 「报告唤醒循环」由 admitInternal 内的预算/cycle/hop/hardStop 闸拦（细筛），
   * 不靠 source 粗筛——粗筛放宽、细筛原样，安全闸不变。
   *
   * 为什么这条判据干净：`held` 只存内存（见 `AgentInboxStore`），进程死亡后全部失效 ⇒
   * 磁盘上「没被任何 body 接管的输入」恰好就是孤儿集合，不需要任何幂等标记位。
   *
   * **这条消息最终会不会被执行？会。** 触发点就是下一次进程启动的这次扫描（不是「立刻」，
   * 也不是「等用户打开会话」）：扫描按 `ts` 升序把条目逐条交给同一个 `admitInternal`
   * （带 `reuse_message_id`）→ body mailbox → scheduler → 真正开跑时 `markConsumed`。
   *
   * 唯一消费者规则：live 路径 append 后**立刻** hold，这里只碰**未被 held** 的条目 ⇒
   * 两条路互斥。**禁止**再给「带 `session_id` 的 input 条目」加第二条自动注入路径
   * （那会让同一条消息被投两次）。
   *
   * 失败（预算 / spawn / 会话退役）保持 unread（`internal.recovery` 让它 unhold 而不是
   * discard），记 `agent.inbox.recover_failed`，下次启动再试；**绝不 discard**（用户没取消）。
   *
   * 上限 `maxSessions`（缺省 8）个会话：启动时 spawn 是真实成本（runtime 构建 + 一次 LLM
   * turn），不能让「崩溃恢复」变成「一开机所有 agent 一起跑」；其余记
   * `agent.inbox.recover_deferred`，条目仍是 unread，下次启动顺延。
   */
  async recoverPendingInputs(options: { maxSessions?: number } = {}): Promise<AgentRecoverResult> {
    await this.ready;
    const empty: AgentRecoverResult = { recovered: 0, sessions: 0, deferred: 0, failed: 0 };
    const store = this.inbox;
    if (store === undefined) return empty;
    if (this.startupRecoveryDone) return empty;
    this.startupRecoveryDone = true;
    const maxSessions =
      typeof options.maxSessions === 'number' &&
      Number.isInteger(options.maxSessions) &&
      options.maxSessions > 0
        ? options.maxSessions
        : RECOVER_MAX_SESSIONS;

    // 1. 候选：枚举 registry 的成员（**不扫 inbox/ 目录**：不给不在册的 agent 起 body），
    //    每个成员 `inbox.list()` 是纯读盘、不 spawn。`includeHeld: false` 已经满足
    //    「未 held」这一条；剩下判据（有 session_id = input 投递）在这里判。
    //    源不限 human（审计 §5.3 补 G3）：agent 源孤儿同样重放，预算/循环闸在
    //    admitInternal 内原样生效；wake/quiet 无 session_id 天然排除。
    const bySession = new Map<
      string,
      { record: MemberRecord; entries: { id: string; ts: number }[] }
    >();
    for (const record of this.registry.all()) {
      if (record.membership === 'left' || record.state === 'closed') continue;
      const listed = store.list(record.id, { includeHeld: false });
      for (const entry of listed.messages) {
        const sessionId = entry.session_id;
        if (sessionId === undefined) continue;
        const bucket = bySession.get(sessionId) ?? { record, entries: [] };
        bucket.entries.push({ id: entry.id, ts: entry.ts });
        bySession.set(sessionId, bucket);
      }
    }
    if (bySession.size === 0) return empty;

    // 2. 会话按「最早一条候选的 ts」升序：先恢复等得最久的；超出上限的顺延到下次启动。
    const ordered = [...bySession.entries()]
      .map(([sessionId, bucket]) => ({
        sessionId,
        record: bucket.record,
        entries: bucket.entries,
        first: Math.min(...bucket.entries.map((entry) => entry.ts)),
      }))
      .sort((left, right) => left.first - right.first);

    const result: AgentRecoverResult = { ...empty };
    for (const [index, session] of ordered.entries()) {
      if (index >= maxSessions) {
        result.deferred += 1;
        this.logger.warn('agent.inbox.recover_deferred', {
          agent_id: session.record.id,
          session_id: session.sessionId,
          pending: session.entries.length,
        });
        continue;
      }
      // 归属必须还有一个可重建的 binding：退役 / 未知会话不可投递，与 `session_not_runnable`
      // 同一套语义。条目保持 unread（不删），下次启动若 binding 回来还能恢复。
      if (!liveBindings(session.record).some((body) => body.bindingId === session.sessionId)) {
        result.failed += session.entries.length;
        this.logger.warn('agent.inbox.recover_failed', {
          agent_id: session.record.id,
          session_id: session.sessionId,
          reason: 'session_not_runnable',
        });
        continue;
      }
      const ids = session.entries
        .sort((left, right) => left.ts - right.ts)
        .map((entry) => entry.id);
      // 正文与附件只在这里读（list 只给 160 字摘要）。
      for (const body of store.findByIds(session.record.id, ids)) {
        try {
          const outcome = await this.admitInternal(
            {
              content: body.text,
              session_id: session.sessionId,
              // 发送者沿用条目里落的 principal（human / agent 源同口径，审计 §5.3）。
              from: body.source,
              ...(body.refs !== undefined ? { refs: body.refs } : {}),
              // team 关联原样带回：append 同 id 幂等本就保留原条目，这里显式带上
              // 是防条目在恢复前被裁掉后重落盘时丢关联。
              ...(body.team_message_id !== undefined
                ? { team_message_id: body.team_message_id }
                : {}),
              // 求救标记原样带回（q-distress-message）：重启恢复的求救 run 再失败不级联。
              ...(body.distress === true ? { distress: true } : {}),
              reuse_message_id: body.id,
            },
            { recovery: true },
          );
          result.recovered += 1;
          this.logger.info('agent.inbox.recovered', {
            agent_id: session.record.id,
            session_id: session.sessionId,
            message_id: body.id,
            run_id: outcome.result.run_id,
            status: outcome.result.status,
          });
        } catch (error) {
          result.failed += 1;
          this.logger.warn('agent.inbox.recover_failed', {
            agent_id: session.record.id,
            session_id: session.sessionId,
            message_id: body.id,
            error: errorText(error),
          });
        }
      }
      result.sessions += 1;
    }
    return result;
  }

  /**
   * 启动 dispatch sweep（runlost-graceful-restart-audit §5.1，补 G5/G6/G7）。
   *
   * live 期「忙时留队列、空下来再投」的兜底靠内存 `noticeDirty` + 三个 dispatch 调用点；
   * 重启后 noticeDirty 清零、没有 run 收口 ⇒ 有 pending 也点不着火。本方法在启动恢复段
   * （recoverPendingInputs / liveness sweep 之后）跑**一次**有界主动投递：
   *
   * 1. 重建 noticeDirty：枚举 registry 成员（不扫 inbox 目录，与 recover 同口径），
   *    凡 `inputHead` 非空（有 unread 可直投条目）者点亮；
   * 2. 按最早 ts 升序、上限 `maxSessions`（缺省 8，与 recover 同口径防 spawn 风暴），
   *    对每个点亮成员调**既有** `dispatchInbox`（不造新投递语义）；
   * 3. 冷成员特许 spawn（审计 §5.1 推荐档）：重启后除 owner 外皆 gone，「投递不 spawn」
   *    是 live 期裁定，不外推到恢复期——对「有 pending + 未关闭」的 gone 成员经
   *    ensureExecutionUnit 重建 body 再 dispatch。`allowSpawn:false` 可退回保守档。
   *
   * 安全闸原样：dispatch 走 admitInternal，预算/cycle/hop/hardStop 全在；hardStop 闸住的
   * body canDispatchInbox 恒 false ⇒ 留队列等显式解闸（「agent 投递不解闸」裁定不动）。
   * 每进程一次（startupSweepDone 幂等闸）；只碰未 held 条目（单消费者规则）；
   * 失败不阻断启动（条目仍 unread，下次再试）。
   */
  async startupDispatchSweep(
    options: { maxSessions?: number; allowSpawn?: boolean } = {},
  ): Promise<AgentDispatchSweepResult> {
    await this.ready;
    const empty: AgentDispatchSweepResult = {
      lit: 0,
      dispatched: 0,
      spawned: 0,
      deferred: 0,
      failed: 0,
    };
    const inbox = this.inbox;
    if (inbox === undefined) return empty;
    if (this.startupSweepDone) return empty;
    this.startupSweepDone = true;
    if (this.draining) return empty;
    const maxSessions =
      typeof options.maxSessions === 'number' &&
      Number.isInteger(options.maxSessions) &&
      options.maxSessions > 0
        ? options.maxSessions
        : RECOVER_MAX_SESSIONS;
    const allowSpawn = options.allowSpawn !== false;

    // 1. 重建 noticeDirty + 候选（inputHead 非空 = 有可直投队头）。
    const candidates: { record: MemberRecord; ts: number }[] = [];
    for (const record of this.registry.all()) {
      if (record.membership === 'left' || record.state === 'closed') continue;
      const head = inbox.inputHead(record.id);
      if (head === undefined) continue;
      this.noticeDirty.add(record.id);
      candidates.push({ record, ts: head.ts });
    }
    const result: AgentDispatchSweepResult = { ...empty, lit: candidates.length };
    if (candidates.length === 0) return result;

    // 2. 最早 ts 优先 + 有界；串行（每次 dispatch 都可能起 run，不制造 spawn 风暴）。
    candidates.sort((left, right) => left.ts - right.ts);
    for (const [index, candidate] of candidates.entries()) {
      if (index >= maxSessions) {
        result.deferred += 1;
        this.logger.warn('agent.inbox.sweep_deferred', {
          agent_id: candidate.record.id,
          pending_head_ts: candidate.ts,
        });
        continue;
      }
      try {
        // 3. 冷成员特许 spawn：gone + 有 pending + 未关闭 ⇒ 重建 body 再投。
        if (allowSpawn && this.liveEntries(candidate.record.id).length === 0) {
          await this.ensureExecutionUnit(candidate.record);
          result.spawned += 1;
        }
        const moved = await this.dispatchInbox(candidate.record.id);
        if (moved) result.dispatched += 1;
        this.logger.info('agent.inbox.sweep_dispatch', {
          agent_id: candidate.record.id,
          moved,
        });
      } catch (error) {
        result.failed += 1;
        this.logger.warn('agent.inbox.sweep_failed', {
          agent_id: candidate.record.id,
          error: errorText(error),
        });
      }
    }
    return result;
  }

  /**
   * 取消「这条消息对应的」queued run（同 run 记账一起清）。
   *
   * 用 `runMessageIds` 反查而不是给条目加 run id：run 是执行侧的一次尝试，重启后无意义，
   * 写进消息会把「消息」与「执行」变成两份互相指向的真相源。
   */
  private cancelQueuedRunsFor(
    entry: ExecutionUnitEntry | undefined,
    messageId: string,
    reason: string,
  ): void {
    const pendingRunIds = [...this.runMessageIds].filter(([, id]) => id === messageId);
    for (const [runId] of pendingRunIds) {
      if (entry?.queuedRuns.has(runId)) {
        // 只有真的在队列里才动 scheduler：已在跑的去 cancel 会把这次执行打断（撤回不是打断）。
        this.scheduler.cancel(runId, reason);
        entry.queuedRuns.delete(runId);
      }
      this.runMessageIds.delete(runId);
      this.interruptReasons.delete(runId);
    }
  }

  /**
   * 收口一条「已离开将执行集合」的消息：出队 + 清 urgent 记账 + 按 source 决定 inbox 出口。
   *
   * `recall` 与 `releaseCancelledRun` 共用这一段，避免两条路各写一遍（口径一散就会
   * 出现「cancel 走 discard、recall 走 unhold」这类不一致）。
   */
  private closeWithdrawnMessage(
    agentId: string,
    entry: ExecutionUnitEntry | undefined,
    messageId: string,
    source: string | undefined,
  ): void {
    this.dropFromQueue(entry, messageId);
    const store = this.inbox;
    if (store === undefined) return;
    if (source === HUMAN_PRINCIPAL) store.discard(agentId, [messageId]);
    else store.unhold(agentId, [messageId]);
  }

  /**
   * 「这条消息不再属于任何一次执行」的执行侧收口：从 body mailbox 出队 + 清掉 urgent
   * 记账。**只动内存里的执行队列，不碰 inbox 状态** —— inbox 的出口（discard / unhold /
   * consumed）由调用方按语义决定：recall 分档、claim 消费。
   */
  private dropFromQueue(entry: ExecutionUnitEntry | undefined, messageId: string): void {
    if (entry !== undefined) {
      const index = entry.pending.findIndex((message) => message.id === messageId);
      if (index >= 0) entry.pending.splice(index, 1);
    }
    this.urgentMessageIds.delete(messageId);
    this.urgentMessages.delete(messageId);
  }

  async resumeRun(runId: string, opts?: RunOptions): Promise<string> {
    await this.ready;
    if (this.runStore === undefined) {
      throw new RunResumeError('run_store_required', runId);
    }
    const record = await this.runStore.load(runId);
    if (record === null) {
      throw new RunResumeError('run_not_found', runId);
    }
    const agentId = record.agent_id;
    const memberRecord = agentId !== undefined ? this.registry.get(agentId) : undefined;
    if (memberRecord === undefined) {
      throw new RunResumeError('agent_not_found', runId);
    }
    // 重启后 entry 尚未重建：按已有 binding 惰性 spawn，不注入用户消息、不走 admit。
    const entry = await this.resumableEntry(memberRecord, record.session_id);
    if (entry === undefined || !entry.spawned || this.runtime.resumeRun === undefined) {
      throw new Error(`member_execution_not_found: ${record.session_id}`);
    }
    const handle = await this.submitResumeRun(memberRecord, entry, record, opts);
    return handle.result;
  }

  /**
   * 为 resume 取/重建**已存在** binding 的 entry。
   *
   * 不复用 `ensureExecutionUnit`：后者对未知 session 会惰性 `createBinding`，
   * 那等于把一条旧 run 复活成新 body。resume 只允许命中当前 / rotate 窗口内
   * 的 binding；已退役或未知 session 分别保留稳定错误 `session is retired` /
   * `member_execution_not_found`。重启后 entry 不存在时按原 binding 重建并 spawn。
   */
  private async resumableEntry(
    record: MemberRecord,
    sessionId: string,
  ): Promise<ExecutionUnitEntry | undefined> {
    const body =
      record.binding?.bindingId === sessionId
        ? record.binding
        : record.retiringBinding?.bindingId === sessionId
          ? record.retiringBinding
          : undefined;
    if (body === undefined) {
      if (this.registry.isRetiredSession(sessionId)) {
        throw new AgentError('conflict', `session_not_runnable: ${sessionId}`);
      }
      return undefined;
    }
    if (body.retiredAt !== undefined) {
      throw new AgentError('conflict', `session_not_runnable: ${sessionId}`);
    }
    let entry = this.findEntry(record.id, sessionId);
    if (entry !== undefined && (entry.retired || entry.closing)) return undefined;
    if (entry === undefined) {
      entry = await this.entryFor(record, body);
      entry.primary = body.primary;
    }
    // 幂等：已 spawn 且 presence 非 gone 时直接返回；否则（含重启后 gone）重建。
    await this.ensureRuntime(entry);
    return entry;
  }

  /** 提交 resumable run；与 `submitMessage` 共用 scheduler / queuedRuns 记账。 */
  private async submitResumeRun(
    record: MemberRecord,
    entry: ExecutionUnitEntry,
    runRecord: RunRecord,
    opts: RunOptions | undefined,
  ): Promise<RunHandle> {
    if (this.draining || entry.closing || entry.retired) {
      throw new AgentError('member_closed', `member_closed: ${record.id}`);
    }
    const runId = runRecord.run_id;
    entry.queuedRuns.add(runId);
    const task: ScheduledTask = {
      agent: { id: record.id } as AgentHandle,
      runId,
      sessionId: entry.bindingId,
      // resume 不注入新的用户消息；executor 直接驱动 EU.resumeRun(record)。
      input: '',
      executor: async (scheduledRunId) => {
        entry.queuedRuns.delete(scheduledRunId);
        return this.startExecutionUnitResume(record, entry, runRecord, scheduledRunId, opts);
      },
    };
    try {
      return await this.scheduler.submit(task);
    } catch (error) {
      entry.queuedRuns.delete(runId);
      throw error;
    }
  }

  /** scheduler executor：开始一次 resumable run；active run 记账与普通 run 一致。 */
  private async startExecutionUnitResume(
    record: MemberRecord,
    entry: ExecutionUnitEntry,
    runRecord: RunRecord,
    runId: string,
    opts: RunOptions | undefined,
  ): Promise<RunHandle> {
    if (entry.retired || entry.closing) {
      const cancelled = new ExecutionUnitRunHandle(runId, record.id, entry.bindingId);
      cancelled.markCancelled('body closed');
      return cancelled;
    }
    entry.state = 'running';
    entry.lastActiveAt = this.now();
    entry.active = { runId };
    this.registry.touchBinding(record.id, entry.bindingId, entry.lastActiveAt);
    this.updateAgentState(record.id);
    this.scheduleSnapshot();
    const handle = new ExecutionUnitRunHandle(runId, record.id, entry.bindingId);
    this.bindRunCancelHandler(entry, handle);
    void this.executeExecutionUnitResume(record, entry, runRecord, handle, opts);
    return handle;
  }

  /** 执行并收口一次 resume；异常收口为 failed，不让后台任务产生未处理 rejection。 */
  private async executeExecutionUnitResume(
    record: MemberRecord,
    entry: ExecutionUnitEntry,
    runRecord: RunRecord,
    handle: ExecutionUnitRunHandle,
    opts: RunOptions | undefined,
  ): Promise<void> {
    const resume = this.runtime.resumeRun;
    let content: string | undefined;
    let failure: string | undefined;
    try {
      if (resume === undefined) {
        throw new Error(`member_execution_not_found: ${runRecord.session_id}`);
      }
      content = await resume.call(this.runtime, runRecord, opts);
    } catch (error) {
      if (!handle.cancelRequested && !entry.closing) {
        failure = errorText(error);
        this.logger.error('agent.run.failed', {
          member_id: record.id,
          session_id: entry.bindingId,
          run_id: handle.id,
          error: failure,
        });
        // q-distress-message：resume 路径的致命错误同样求救（无触发消息可判防循环，
        // 靠冷却限流兜底）。
        void this.maybeSendDistress(record, entry, error).catch((distressError) => {
          this.logger.warn('agent.distress.error', {
            member_id: record.id,
            error: errorText(distressError),
          });
        });
      }
    }
    entry.active = undefined;
    entry.state = 'idle';
    entry.lastActiveAt = this.now();
    this.registry.touchBinding(record.id, entry.bindingId, entry.lastActiveAt);
    const current = this.registry.get(record.id);
    const cancelled = handle.cancelRequested;
    const outcome = cancelled ? 'cancelled' : failure !== undefined ? 'failed' : 'completed';
    if (entry.retired || !current || current.state === 'closed') {
      this.updateAgentState(record.id);
      this.scheduleSnapshot();
      if (entry.retired) await this.disposeEntry(entry);
      this.settleHandle(handle, outcome, failure, content);
      return;
    }
    this.updateAgentState(record.id, outcome);
    this.scheduleSnapshot();
    this.settleHandle(handle, outcome, failure, content);
  }

  /** 运行 handle 的取消路由；普通 run 与 resume 共用。 */
  private bindRunCancelHandler(entry: ExecutionUnitEntry, handle: ExecutionUnitRunHandle): void {
    handle.cancelHandler = (reason) => {
      try {
        // 0.32-D：打断必须让 core 发出 `run.cancelled` reason=`interrupt`；
        // 其它取消路径（close / rotate / drain）保持 `user`。
        const interruptReason: RunInterruptReason =
          this.interruptReasons.get(handle.id) ?? (reason === 'interrupt' ? 'interrupt' : 'user');
        this.interruptReasons.delete(handle.id);
        this.runtime.cancel(entry.runtimeMember, interruptReason);
      } catch (error) {
        this.logger.warn('agent.cancel.failed', {
          member_id: entry.agentId,
          session_id: entry.bindingId,
          error: errorText(error),
        });
      }
    };
  }

  private settleHandle(
    handle: ExecutionUnitRunHandle,
    outcome: 'completed' | 'failed' | 'cancelled',
    failure: string | undefined,
    content: string | undefined,
  ): void {
    this.interruptReasons.delete(handle.id);
    this.runCycleEdges.delete(handle.id);
    // 被后续 urgent 抢占的 run 不清理 urgent id：它的消息会（或已经）重投。
    if (!this.interruptCancelledRunIds.delete(handle.id)) {
      const messageId = this.runMessageIds.get(handle.id);
      if (messageId !== undefined) {
        this.urgentMessageIds.delete(messageId);
        this.urgentMessages.delete(messageId);
      }
    }
    if (outcome === 'cancelled') handle.markCancelled(failure ?? 'run cancelled');
    else if (outcome === 'failed') handle.fail(failure ?? 'run failed');
    else handle.complete(content ?? '');
    // 成员真停了才报父级（窗口内又拿到工作就丢弃）。
    this.schedulePeerStop(handle.agentId, outcome, failure);
    // run 结束、目标空闲且 run 期间有新 inbox 落盘：补一步投递 —— 队头直投成下一轮，
    // 投不进去才发摘要唤醒（判据见 `dispatchInbox`）。这就是「多条 ⇒ 每轮抽一条队头」
    // 的链条：直投成功时 `noticeDirty` 保持点亮，下一轮收口再来一次，直到队列空。
    if (this.noticeDirty.has(handle.agentId)) {
      void this.dispatchInbox(handle.agentId).catch(() => {});
    }
  }

  /**
   * 成员终态后延迟一个小窗口再判一次：真的停了才报父级（`peerStops` 端口）。
   *
   * 为什么延迟：用户裁定「停了马上又拿到下一条消息」不是结论。窗口内又来了新工作
   * （新 run / 排队消息 / 未读 inbox 消息 / rotate 窗口）就丢掉这次通知，不补发 ——
   * 下一轮真正停下时会再判一次。
   *
   * 同一成员同时最多一个待发判定：新终态取消旧的并重新计时（`cancelled` 之后紧接
   * 一次重投的 `completed` 不该报两条）。
   */
  private schedulePeerStop(agentId: string, kind: PeerStopKind, failure: string | undefined): void {
    if (this.peerStops === undefined) return;
    this.cancelPeerStopTimer(agentId);
    const timer = setTimeout(() => {
      this.peerStopTimers.delete(agentId);
      this.flushPeerStop(agentId, kind, failure);
    }, PEER_STOP_WINDOW_MS);
    // 不让这个窗口挂住进程退出（TUI / headless 一次性进程）。
    (timer as { unref?: () => void }).unref?.();
    this.peerStopTimers.set(agentId, timer);
  }

  private cancelPeerStopTimer(agentId: string): void {
    const timer = this.peerStopTimers.get(agentId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.peerStopTimers.delete(agentId);
  }

  /** 窗口到期：仍无新工作才把「X 停了」交给装配层。 */
  private flushPeerStop(agentId: string, kind: PeerStopKind, failure: string | undefined): void {
    const member = this.registry.get(agentId);
    if (member === undefined) return;
    if (member.membership === 'left' || member.state === 'closed') return;
    if (this.memberStillBusy(agentId)) return;
    const change = this.peerStopChangeFor(member, kind, failure);
    if (change === undefined) return;
    this.publishPeerStop(change);
  }

  /**
   * 「真的停了」的判据：没有任何在途 / 排队 / 待读的工作，也不在 rotate 窗口。
   *
   * 只读内存状态与持久化收件箱计数（`inbox.list` 不改状态），不触发 spawn / sweep。
   */
  private memberStillBusy(agentId: string): boolean {
    // rotate 窗口内旧 body 正在退役、新 body 马上接手：此刻不是「停了」。
    if (this.rotations.has(agentId)) return true;
    for (const entry of this.liveEntries(agentId)) {
      // 0.55 硬错误闸：闸落下的 body 是「真的停了」—— 它不会自己再动，等的是人。
      // 队列里哪怕还压着消息也必须报出去，否则父级只会看到一个 failed 状态、却拿不到
      // 「因为什么跑不动」，于是继续往死里投（今天事故里就是这样一路重发到第 3 次）。
      if (entry.hardStop !== undefined) return false;
      if (entry.active !== undefined) return true;
      if (entry.queuedRuns.size > 0) return true;
      if (entry.spawning !== undefined) return true;
      if (entry.pending.length > 0) return true;
      if (entry.budgetHold.size > 0) return true;
    }
    const counts = this.inbox?.list(agentId);
    if (counts !== undefined && (counts.unread > 0 || counts.pending > 0)) return true;
    return false;
  }

  /**
   * 记录 peer 成员的创建者（进程内）：`role: 'member'` 没有 `parentId`，
   * 创建者只在这一刻可得。只记不可自指、非空的值；不落盘。
   */
  private rememberPeerOrigin(record: MemberRecord, spawnedBy: string | undefined): void {
    if (record.role !== 'member') return;
    if (!nonEmpty(spawnedBy)) return;
    if (spawnedBy === record.id) return;
    this.peerOrigins.set(record.id, spawnedBy);
  }

  /**
   * 成员的父成员 id：contractor 用落盘的 `parentId`；peer 成员没有 parentId，
   * 退回进程内的创建者链接（`peerOrigins`）。两者都没有 → undefined（静默不报，不猜）。
   */
  private peerParentIdFor(member: MemberRecord): string | undefined {
    if (nonEmpty(member.parentId)) return member.parentId;
    const origin = this.peerOrigins.get(member.id);
    if (origin === undefined) return undefined;
    return nonEmpty(origin) ? origin : undefined;
  }

  /**
   * 成员 → 其父成员**当前** primary body 的 session（peer 通知的「同步链接」目标）。
   *
   * 0.53 notice-rotate：变更上落的是**报告时刻**父 session；2s 合并窗口内父若 rotate，
   * 新 body 是另一个 session，通知就只会落在旧 body 的游标上（新 body 永远拉不到）。
   * 装配层于是在**真正投递那一刻**调这个方法重新取一次。
   *
   * 入参是**上报变更的成员（子）id**（即 `PeerStopChange.agent_id`）：顺着它找父成员，
   * 再取父成员当前的 session —— 不要当成父成员 id 传。
   *
   * 推导只复用 `peerParentIdFor` + `currentBindingSession`，这里不写第二套。找不到
   * （记录不在 / 自己或父已 left|closed / 没有父级 / 空串）一律 `undefined` = 调用方
   * 退回报告时刻的 session，绝不抛。
   */
  peerParentSessionOf(memberId: string): string | undefined {
    if (!nonEmpty(memberId)) return undefined;
    const member = this.registry.get(memberId);
    if (member === undefined) return undefined;
    if (member.membership === 'left' || member.state === 'closed') return undefined;
    const parentId = this.peerParentIdFor(member);
    if (parentId === undefined) return undefined;
    const parent = this.registry.get(parentId);
    if (parent === undefined) return undefined;
    if (parent.id === member.id) return undefined;
    if (parent.membership === 'left' || parent.state === 'closed') return undefined;
    const session = currentBindingSession(parent);
    return nonEmpty(session) ? session : undefined;
  }

  /**
   * 成员 → 变更：父 session 取父成员当前 primary body 的 session（notice 的注入目标）。
   *
   * 没有父级（来源不可知的 peer 成员 / main 自身）、父级已 left / closed 时不产生变更：
   * 没人会读它。
   */
  private peerStopChangeFor(
    member: MemberRecord,
    kind: PeerStopKind,
    failure: string | undefined,
  ): PeerStopChange | undefined {
    const parentId = this.peerParentIdFor(member);
    if (parentId === undefined) return undefined;
    const parent = this.registry.get(parentId);
    if (parent === undefined) return undefined;
    if (parent.id === member.id) return undefined;
    if (parent.membership === 'left' || parent.state === 'closed') return undefined;
    return {
      parent_session_id: currentBindingSession(parent),
      agent_id: member.id,
      ...(member.name !== undefined ? { name: member.name } : {}),
      kind,
      ...(nonEmpty(failure) ? { error: failure } : {}),
    };
  }

  private publishPeerStop(change: PeerStopChange): void {
    try {
      this.peerStops?.(change);
    } catch (error) {
      this.logger.warn('agent.peer_stop.notify_failed', {
        member_id: change.agent_id,
        session_id: change.parent_session_id,
        error: errorText(error),
      });
    }
  }

  /** 按 live body 汇总 agent 状态（running / waiting_permission / idle） */
  /**
   * 按 live body 汇总 agent 状态（running / waiting_permission / idle）。
   * `terminal` 是刚结束的一轮结局：没有 active body 时用它（保持 agents 对外终态口径）。
   */
  private updateAgentState(agentId: string, terminal?: 'completed' | 'failed' | 'cancelled'): void {
    const record = this.registry.get(agentId);
    if (!record || record.membership === 'left' || record.state === 'closed') return;
    const entries = this.liveEntries(agentId);
    const anyWaiting = entries.some((entry) => entry.state === 'waiting_permission');
    const anyRunning = entries.some(
      (entry) => entry.state === 'running' || entry.state === 'waiting_permission',
    );
    const target: MemberState = anyWaiting
      ? 'waiting_permission'
      : anyRunning
        ? 'running'
        : (terminal ?? 'idle');
    if (record.state === target) return;
    try {
      if (
        target === 'running' &&
        (record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled')
      ) {
        this.registry.setState(agentId, 'idle');
      } else if (
        (target === 'completed' || target === 'failed' || target === 'cancelled') &&
        record.state === 'idle'
      ) {
        // 交棒轮（0.52 B′）：rotate 的 `createSession` 在**本轮 run 内**就把状态归到 idle
        // （旧 body 一退役就不再算 live，新 body 还没来得及起跑），于是轮末写终态会撞上
        // idle → completed 这条不存在的跳，终态被状态机静默丢掉（只留一条 warn）。
        // 终态描述的是「刚跑完的那一轮」，不是新工作，所以先按「这一轮还在跑」落一次
        // 再转移 —— 与上面那条（终态 → idle → running）对称。
        this.registry.setState(agentId, 'running');
      }
      this.registry.setState(agentId, target);
    } catch (error) {
      // 状态竞争（close / 迟到回调）不应打断执行；只记日志。
      this.logger.warn('agent.state.update_failed', {
        agent_id: agentId,
        state: target,
        error: errorText(error),
      });
    }
  }

  /**
   * 临时 agent 空闲回收（D5）；返回本次回收的 agent 数量。TTL=0 时 no-op。
   *
   * 三条硬约束：
   * 1. **判据读持久化字段**：`max(record.lastSeen, body.lastActiveAt)`。不读内存
   *    `lastEntries` —— 冷启动后无人 admit 的 agent 没有 entry，用内存判据就永不触发。
   * 2. **只回收 `role === 'temporary' && membership === 'present'`**；`member`（含
   *    `main`）永不回收。
   * 3. 有在跑轮 / 排队消息 / 权限等待的 agent 一律跳过：回收不得打断在途工作。
   *
   * 动作复用 `membership='left'` + `state='closed'`（roster 只放 present），
   * **不新增持久字段**；body 记录保留并标 `retiredAt`（续接历史的唯一钥匙）。
   */
  async sweepIdleTemporaries(now: number = this.now()): Promise<number> {
    await this.ready;
    if (this.temporaryTtlMs <= 0) return 0;
    let reclaimed = 0;
    for (const record of this.registry.all()) {
      if (record.role !== 'temporary') continue;
      if (record.membership !== 'present') continue;
      if (record.state === 'closed' || record.state === 'running') continue;
      if (record.state === 'waiting_permission') continue;
      if (this.hasNonIdleWork(record.id)) continue;
      const body = record.binding;
      const lastActive = Math.max(record.lastSeen ?? 0, body?.lastActiveAt ?? 0);
      if (lastActive + this.temporaryTtlMs >= now) continue;
      await this.reclaimAgent(record, now, 'idle_ttl');
      reclaimed += 1;
    }
    return reclaimed;
  }

  /** 该 agent 是否有在跑的轮 / 排队消息 / 权限等待（回收前必须为空） */
  private hasNonIdleWork(agentId: string): boolean {
    const entries = this.executionUnitRegistry.get(agentId);
    if (entries === undefined) return false;
    for (const entry of entries.values()) {
      if (entry.active !== undefined) return true;
      if (entry.queuedRuns.size > 0) return true;
      if (entry.pending.length > 0) return true;
      if (entry.state === 'running' || entry.state === 'waiting_permission') return true;
    }
    return false;
  }

  /**
   * 回收一个 agent：退役其 body，置 `membership='left'` + `state='closed'`。
   * 审计复用 `agent.closed` + `reason`，不新增事件类型。
   */
  private async reclaimAgent(record: MemberRecord, at: number, reason: string): Promise<void> {
    for (const entry of [...(this.executionUnitRegistry.get(record.id)?.values() ?? [])]) {
      await this.retireExecutionUnitEntry(record, entry, reason, at);
    }
    // 没有内存 entry 时也要让 body 记录带上 retiredAt：body 记录永不删。
    if (record.binding !== undefined && record.binding.retiredAt === undefined) {
      this.registry.retireBinding(record.id, record.binding.bindingId, at);
    }
    record.state = 'closed';
    record.membership = 'left';
    // 0.53：与显式 close 同一对 additive 字段（`idle_ttl` 让历史视图能区分「被回收」
    // 和「被人关掉」）；事件里的 reason 已经带着同一个值。
    record.closedAt = at;
    record.closeReason = reason;
    this.registry.setPresence(record.id, 'gone');
    this.emit('agent.closed', record, {
      state: 'closed',
      presence: 'gone',
      reason,
    });
    this.scheduleSnapshot();
  }

  /** sweep 节奏：`clamp(ttl / 10, 60s, 15min)`；TTL=0 时返回 undefined（没有定时器） */
  sweepIntervalMs(): number | undefined {
    if (this.temporaryTtlMs <= 0) return undefined;
    return Math.min(
      SWEEP_INTERVAL_MAX_MS,
      Math.max(SWEEP_INTERVAL_MIN_MS, Math.floor(this.temporaryTtlMs / 10)),
    );
  }

  // ─── send / dispatch ───────────────────────────────────────────

  async send(input: SendInput): Promise<SendResult>;
  async send(input: SendBatchInput): Promise<BatchResult<SendResult>>;
  async send(input: SendInput | SendBatchInput): Promise<SendResult | BatchResult<SendResult>> {
    await this.ready;
    const record = input as unknown as Record<string, unknown>;
    // 0.53 U1（ADR-104 §7.2）：投射模式是**会话级、创建时写定**的声明，`agent send`
    // 不是声明入口 —— 带上这两个参数一律拒绝，不静默忽略（静默忽略等于让调用方
    // 以为自己改成了 passthrough）。
    if (record.projection !== undefined || record.projection_mode !== undefined) {
      throw new AgentError(
        'invalid_input',
        'projection is a session-level declaration; set it on create / rotate, not on send',
      );
    }
    if ('messages' in record) {
      if (
        record.to !== undefined ||
        record.content !== undefined ||
        record.from !== undefined ||
        record.interrupt !== undefined ||
        record.notify !== undefined ||
        record.message_id !== undefined
      ) {
        throw new AgentError(
          'invalid_input',
          'pass either single to/content or messages, not both',
        );
      }
      const messages = record.messages;
      if (!Array.isArray(messages)) {
        throw new AgentError('invalid_input', 'messages must be an array');
      }
      if (messages.length === 0) {
        throw new AgentError('invalid_input', 'messages must not be empty');
      }
      // 一次 messages 数组共享一个 wake 边计数 batch key（每批最多 bump 1 次）。
      const batchKey = this.newId();
      try {
        const settled = await Promise.allSettled(
          messages.map((entry) =>
            isRecord(entry)
              ? this.sendOne(entry, batchKey)
              : Promise.reject(new AgentError('invalid_input', 'messages entries must be objects')),
          ),
        );
        return settleBatch(settled);
      } finally {
        this.wakeBatchEdges.delete(batchKey);
      }
    }
    const batchKey = this.newId();
    try {
      return await this.sendOne(record, batchKey);
    } finally {
      this.wakeBatchEdges.delete(batchKey);
    }
  }

  /** strict send：不自动恢复 gone 成员；走同一个 admit。 */
  private async sendOne(input: Record<string, unknown>, batchKey?: string): Promise<SendResult> {
    const to = readRequiredString(input, 'to');
    const from =
      input.from === undefined ? DEFAULT_MESSAGE_SENDER : readRequiredString(input, 'from');
    const interrupt = readOptionalBoolean(input, 'interrupt');
    // wire 的 notify 布尔在这里就换成 inbox 的投递模式：内部不再有 notify 开关。
    const delivery = deliveryFromNotify(readOptionalBoolean(input, 'notify'));
    const wakes = delivery === 'wake';
    let messageId: string | undefined;
    if (input.message_id !== undefined) messageId = readRequiredString(input, 'message_id');
    if (interrupt && wakes) {
      throw new AgentError('invalid_input', 'conflicting_delivery');
    }
    if (messageId !== undefined && wakes) {
      throw new AgentError('invalid_input', 'message_id is not supported with notify');
    }
    if (messageId !== undefined && !interrupt) {
      throw new AgentError('invalid_input', 'message_id requires interrupt: true');
    }
    if (
      (interrupt || wakes) &&
      (to.includes('@') || to === HUMAN_PRINCIPAL || to.startsWith('federation:'))
    ) {
      throw new AgentError('invalid_input', 'unsupported_delivery');
    }
    // 指定 inbox 消息时不重复给正文；两者同时出现属于歧义输入。
    let content: string;
    if (messageId !== undefined) {
      if (input.content !== undefined && input.content !== '') {
        if (typeof input.content !== 'string' || input.content.trim() !== '') {
          throw new AgentError('invalid_input', 'pass either content or message_id, not both');
        }
      }
      content = '';
    } else {
      content = readContent(input, 'content');
    }
    const target = this.requireMember(to);
    if (target.membership === 'left' || target.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${to}`);
    }
    if (!wakes && target.presence === 'gone') {
      throw new AgentError('member_stale', `member_stale: ${to}`);
    }
    if (!this.registry.canView(target, from)) {
      throw new AgentError('member_not_visible', `member_not_visible: ${to}`);
    }
    const conversationId =
      input.conversation_id !== undefined
        ? readRequiredString(input, 'conversation_id')
        : undefined;
    const originSessionId =
      input.origin_session_id === undefined
        ? undefined
        : readRequiredString(input, 'origin_session_id');
    const originRunId =
      input.origin_run_id === undefined ? undefined : readRequiredString(input, 'origin_run_id');
    // 附件引用与直接投递（runs.start / admit）同口径：形状归一后随投递带上 ——
    // wake 落 inbox 副本、input 进 core Message.refs，两条路都不丢附件。
    const refs = normalizeRefs(input.refs);
    if (wakes) {
      const outcome = await this.wakeDelivery(target, {
        from,
        content,
        ...(conversationId !== undefined ? { conversationId } : {}),
        ...(originSessionId !== undefined ? { originSessionId } : {}),
        ...(batchKey !== undefined ? { batchKey } : {}),
        ...(refs.length > 0 ? { refs } : {}),
      });
      return {
        queued: false,
        notified: true,
        message_id: outcome.message_id,
        wake: outcome.wake,
        resolution: outcome.resolution,
      };
    }
    if (interrupt) {
      return this.sendInterrupt(target, {
        memberKey: to,
        from,
        content,
        ...(messageId !== undefined ? { messageId } : {}),
        ...(conversationId !== undefined ? { conversationId } : {}),
        ...(originSessionId !== undefined ? { originSessionId } : {}),
        ...(originRunId !== undefined ? { originRunId } : {}),
      });
    }
    const sessionId = this.registry.getBySession(to)?.id === target.id ? to : undefined;
    // E2 §3.7：内部装配字段（非 wire），形状归一后透传进 admit → run.started。
    const trigger = input.triggered_by;
    const triggeredBy =
      isRecord(trigger) &&
      typeof trigger.request_id === 'string' &&
      typeof trigger.rpc_method === 'string'
        ? {
            request_id: trigger.request_id,
            rpc_method: trigger.rpc_method,
            ...(typeof trigger.agent_id === 'string' ? { agent_id: trigger.agent_id } : {}),
          }
        : undefined;
    const result = await this.admit({
      content,
      agent_id: target.id,
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      from,
      channel: 'direct',
      ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
      ...(originSessionId !== undefined ? { origin_session_id: originSessionId } : {}),
      ...(originRunId !== undefined ? { origin_run_id: originRunId } : {}),
      ...(refs.length > 0 ? { refs } : {}),
      ...(triggeredBy !== undefined ? { triggered_by: triggeredBy } : {}),
      strict: true,
    });
    // 消息身份直接取 admit 回填的 `message_id`（0.57 起恒有）；`run_id` 只在真起跑时才有
    // —— `deferred` 的投递没有 run，旧写法（runMessageIds 反查）在这里会空转。
    const messageIdResult = result.message_id ?? result.run_id ?? '';
    return {
      queued: true,
      message_id: messageIdResult,
      state: this.registry.get(target.id)?.state ?? target.state,
      run_id: result.run_id,
      session_id: result.session_id,
    };
  }

  /**
   * 0.32-D 紧急打断：取消该 body 当前的 active run（reason `interrupt`），把指定
   * inbox 消息（或本次正文）作为下一条输入，排在现有队列之前；旧队列随后照常。
   *
   * 顺序保证（不新增优先级系统）：
   * 1. 在同一同步块内先 `scheduler.cancel` 掉该 body 所有 queued run 与 active run
   *    （scheduler 的 session_id 串行键仍被 active 占着，drain 不会在此时起新轮）；
   * 2. 依次把打断消息、旧队列消息重新 `submitMessage` 到 scheduler（每次 submit 在
   *    返回 promise 前已同步入队），因此队列顺序 = 打断 → 旧队列原顺序；
   * 3. 旧消息的 inbox 记录始终处于 held/unread，取消的只是尚未执行的 run，重新提交
   *    后只在真正开始执行时 markConsumed —— 每条消息仍只注入一次。
   * 并发打断按 agent 串行（`withExecutionUnitOp`）。
   */
  private async sendInterrupt(
    target: MemberRecord,
    input: {
      memberKey: string;
      from: string;
      content: string;
      messageId?: string;
      conversationId?: string;
      originSessionId?: string;
      originRunId?: string;
      originTeamId?: string;
    },
  ): Promise<SendResult & { conversation_id: string }> {
    return this.withExecutionUnitOp(target.id, async () => {
      if (this.rotations.has(target.id)) {
        throw new AgentError('invalid_input', 'interrupt is not supported during rotate');
      }
      // urgent 不自动 resume / spawn：gone 或无 live body 直接 member_stale。
      if (target.presence === 'gone') {
        throw new AgentError('member_stale', `member_stale: ${target.id}`);
      }
      const sessionId =
        this.registry.getBySession(input.memberKey)?.id === target.id ? input.memberKey : undefined;
      const { entry } = await this.ensureExecutionUnit(target, sessionId);
      if (this.draining || entry.closing || entry.retired) {
        throw new AgentError('member_closed', `member_closed: ${target.id}`);
      }

      // 0.55 硬错误闸的解闸动作（第二处，共三处）：`interrupt: true` 是既有语义里
      // 唯一带「现在就做」意图的显式动作（调用者主动按下去，不是自动链路捡起来的消息）。
      // 这里只清闸；重排由本函数下面那段统一做（打断消息排最前、旧队列随后）。
      if (entry.hardStop !== undefined) this.clearBlocked(entry, `interrupt:${input.from}`);

      // 1. 该 body 当前的 running / queued run（scheduler 快照是活跃状态的唯一真相）。
      const snapshot = this.scheduler.snapshot?.();
      let runningIds: string[];
      let queuedRunIds: string[];
      if (snapshot !== undefined) {
        runningIds = snapshot.running
          .filter((run) => run.sessionId === entry.bindingId)
          .map((run) => run.runId);
        queuedRunIds = snapshot.queued
          .filter((run) => run.sessionId === entry.bindingId)
          .map((run) => run.runId);
      } else {
        runningIds = entry.active !== undefined ? [entry.active.runId] : [];
        queuedRunIds = [...entry.queuedRuns].filter((id) => id !== entry.active?.runId);
      }

      // 2. 先解析打断消息（任何非法 id 都在改动队列之前报错）。
      let interruptMessage: AgentMessage;
      let conversationId: string;
      if (input.messageId !== undefined) {
        const stored = this.inbox?.findByIds(target.id, [input.messageId])[0];
        if (stored === undefined) {
          throw new AgentError('invalid_input', `unknown_message: ${input.messageId}`);
        }
        if (stored.status === 'consumed') {
          throw new AgentError('invalid_input', `message_already_consumed: ${input.messageId}`);
        }
        if (entry.active?.messageId === stored.id) {
          throw new AgentError('invalid_input', `message_already_running: ${input.messageId}`);
        }
        const existing = entry.pending.find((message) => message.id === stored.id);
        // 消息在 pending 时用其 conversation_id；否则用统一解析结果。
        // （active 同 id 已在上方按 message_already_running 提前拒绝，不可达。）
        conversationId =
          existing?.conversation_id ??
          this.resolveConversationForDelivery(input.conversationId, input.originSessionId, target);
        interruptMessage =
          existing ??
          ({
            id: stored.id,
            from: stored.source,
            to: target.id,
            content: stored.text,
            ts: this.now(),
            source: this.messageSource(stored.source),
            channel: 'direct',
            conversation_id: conversationId,
            // 入队时存下的显示名随重建带回：丢了它条带 / 卡头只能退短 id。
            ...(stored.from_name !== undefined ? { from_name: stored.from_name } : {}),
            // team 关联同理带回：urgent 重投不该把「编辑 / 删除 team 消息」的定位弄丢。
            ...(stored.team_message_id !== undefined
              ? { team_message_id: stored.team_message_id }
              : {}),
            // 求救标记同理带回（q-distress-message）：interrupt 重投的求救不丢防循环位。
            ...(stored.distress === true ? { distress: true as const } : {}),
          } satisfies AgentMessage);
      } else {
        conversationId = this.resolveConversationForDelivery(
          input.conversationId,
          input.originSessionId,
          target,
        );
        interruptMessage = {
          id: this.newId(),
          from: input.from,
          to: target.id,
          content: input.content,
          ts: this.now(),
          source: this.messageSource(input.from),
          channel: 'direct',
          conversation_id: conversationId,
        };
      }

      // 3. 预算检查必须在取消任何 run 之前：content 正常计数；message_id 只读
      //    （不补计 hop / edge）。失败直接返回，不取消、不重投、不 unhold。
      if (!this.isHumanPrincipal(target.id)) {
        const teamId = input.originTeamId ?? this.resolveOriginTeam(input.from, target);
        const originExplicit = input.originTeamId !== undefined;
        let check: BudgetCheckResult;
        if (input.messageId !== undefined) {
          check = this.checkDelivery(target, input.from, conversationId, teamId, originExplicit, {
            mode: 'read_only',
          });
        } else {
          const runKey =
            input.originRunId ??
            (input.originSessionId !== undefined
              ? this.activeRunIdForSession(input.originSessionId)
              : undefined);
          const edgeSeen = this.hasRunCycleEdge(runKey, input.from, target.id);
          check = this.checkDelivery(target, input.from, conversationId, teamId, originExplicit, {
            edge: edgeSeen ? 'skip' : 'bump',
          });
          // 检查通过后才记账：失败不占边，同 run 再投会重新 bump / 检查。
          if (check.ok) this.recordRunCycleEdge(runKey, input.from, target.id);
        }
        if (!check.ok) {
          if (!TURN_DIMENSIONS.has(check.dimension)) {
            this.emitBudgetBlocked(target, check, {
              conversation_id: conversationId,
              message_id: interruptMessage.id,
              from: input.from,
              to: target.id,
              phase: 'enqueue',
              ...(teamId !== undefined ? { teamId } : {}),
            });
          }
          throw this.budgetFailureError(check, conversationId, teamId);
        }
      }

      // 4. waiting_permission / active resume 拒绝：不做任何取消 / 入队。
      if (entry.state === 'waiting_permission') {
        throw new AgentError('invalid_input', 'permission_pending');
      }
      if (entry.active !== undefined && entry.active.messageId === undefined) {
        throw new AgentError('invalid_input', 'resume_in_progress');
      }

      // 5. 消息落到 inbox（content 新增；message_id 沿用既有记录），并 hold。
      // I1：统一走 trackInbox —— `message_id` 分支复用既有记录（append 同 id 幂等），
      // 新内容分支顺带落写前日志；两条分支都只在这里登记持有者。
      this.trackInbox(target.id, interruptMessage, entry.bindingId);
      if (!entry.pending.includes(interruptMessage)) entry.pending.push(interruptMessage);
      this.registry.touchBinding(target.id, entry.bindingId, this.now());

      // 6. 取消尚未开始的 run，保留其消息用于按原顺序重投；queued resume 跳过。
      const oldMessages: AgentMessage[] = [];
      const seenMessageIds = new Set<string>();
      for (const runId of queuedRunIds) {
        const messageIdForRun = this.runMessageIds.get(runId);
        if (messageIdForRun === undefined) {
          // queued resume run 没有 runMessageIds，不能安全重投：跳过、不取消。
          continue;
        }
        const message = entry.pending.find((candidate) => candidate.id === messageIdForRun);
        if (message === undefined) {
          this.logger.warn('agent.interrupt.queue_message_missing', {
            agent_id: target.id,
            session_id: entry.bindingId,
            run_id: runId,
          });
          continue;
        }
        this.scheduler.cancel(runId, 'interrupt');
        entry.queuedRuns.delete(runId);
        this.runMessageIds.delete(runId);
        if (message.id !== interruptMessage.id && !seenMessageIds.has(message.id)) {
          seenMessageIds.add(message.id);
          oldMessages.push(message);
        }
      }
      // 0.55：闸期间排进 mailbox 的消息**从来没有 queued run**（`admitInternal` 只排队、
      // 不 submit），上面按 `queuedRunIds` 收集的 oldMessages 里看不到它们。不补这一段，
      // 「用 interrupt 解闸」会把整个队列永久搁在 pending + held —— 解闸动作反而制造黑洞。
      // 判据只看「在 mailbox 里、还没有在途 run」，不猜别的状态。
      const inFlight = new Set<string>();
      for (const runId of entry.queuedRuns) {
        const messageId = this.runMessageIds.get(runId);
        if (messageId !== undefined) inFlight.add(messageId);
      }
      const activeId = entry.active?.messageId;
      if (activeId !== undefined) inFlight.add(activeId);
      for (const message of entry.pending) {
        if (message.id === interruptMessage.id) continue;
        if (inFlight.has(message.id) || seenMessageIds.has(message.id)) continue;
        seenMessageIds.add(message.id);
        oldMessages.push(message);
      }

      // 7. 取消 active；若原消息是 urgent，则重投它（work 消息不重投）。
      const activeMessageId = entry.active?.messageId;
      const activeConversationId = entry.active?.conversationId;
      const reinjected: AgentMessage[] = [];
      if (activeMessageId !== undefined && this.urgentMessageIds.has(activeMessageId)) {
        // 优先用内存快照：append 的 consumed-first 可能已把 active urgent 的 inbox
        // 记录裁掉；快照保留原 id / from / content / conversation_id。
        const remembered = this.urgentMessages.get(activeMessageId);
        const stored = this.inbox?.findByIds(target.id, [activeMessageId])[0];
        if (remembered !== undefined) {
          reinjected.push(remembered);
        } else if (stored === undefined) {
          this.logger.warn('agent.interrupt.reinject_missing', {
            agent_id: target.id,
            session_id: entry.bindingId,
            message_id: activeMessageId,
          });
          this.urgentMessageIds.delete(activeMessageId);
          this.urgentMessages.delete(activeMessageId);
        } else {
          reinjected.push({
            id: stored.id,
            from: stored.source,
            to: target.id,
            content: stored.text,
            ts: this.now(),
            source: this.messageSource(stored.source),
            channel: 'direct',
            ...(activeConversationId !== undefined
              ? { conversation_id: activeConversationId }
              : { conversation_id: conversationId }),
          });
        }
      }
      for (const runId of runningIds) {
        this.interruptReasons.set(runId, 'interrupt');
        this.interruptCancelledRunIds.add(runId);
        this.scheduler.cancel(runId, 'interrupt');
      }

      // 8. 同步入队：新 urgent → 旧 urgent（如有）→ 旧队列原顺序。
      // I3 审计：这里**只增不减**（重排而非移出），所以 hold 保持不动；真正的出队在
      // `startExecutionUnitRun`（I2 消费）与 submit 失败分支（unhold / restoreConsumedUnread）。
      for (const message of reinjected) {
        if (!entry.pending.includes(message)) entry.pending.push(message);
      }
      const queue: AgentMessage[] = [interruptMessage, ...reinjected, ...oldMessages];
      const submissions = queue.map((message) => ({
        message,
        promise: this.submitMessage(target, entry, message),
      }));
      // submit 在返回 promise 前已同步推入 scheduler 队列；这里再统一 await。
      const outcomes = await Promise.allSettled(submissions.map((item) => item.promise));
      const reinjectedIds = new Set(reinjected.map((message) => message.id));
      let newUrgentFailed = false;
      outcomes.forEach((outcome, index) => {
        const item = submissions[index];
        if (item === undefined) return;
        if (outcome.status === 'fulfilled') {
          this.runMessageIds.set(outcome.value.runId, item.message.id);
          return;
        }
        // 队列满：submitMessage 已从 entry.pending 移除（I3 审计点 1/6 的 interrupt 分支）。
        // 被抢占的 active urgent 在 inbox 里已是 consumed，unhold 不会恢复 unread，
        // 必须删掉 consumed 记录再以同 id 重新落为 unread，否则消息丢失。
        if (reinjectedIds.has(item.message.id)) {
          this.restoreConsumedUnread(target.id, item.message);
        } else {
          // 普通 queued 消息只是 unread：unhold 保持未读即可。
          this.inbox?.unhold(target.id, [item.message.id]);
          this.urgentMessageIds.delete(item.message.id);
          this.urgentMessages.delete(item.message.id);
        }
        if (index === 0) {
          newUrgentFailed = true;
        } else {
          this.logger.warn('agent.queue.requeue_failed', {
            agent_id: target.id,
            session_id: entry.bindingId,
            message_id: item.message.id,
            error: errorText(outcome.reason),
          });
        }
      });
      if (newUrgentFailed) {
        throw new AgentError('invalid_input', 'queue_full');
      }
      this.urgentMessageIds.add(interruptMessage.id);
      this.urgentMessages.set(interruptMessage.id, interruptMessage);
      // 旧队列里的 urgent 也补内存快照，后续被抢占时同样不依赖 inbox 正文。
      for (const item of submissions) {
        if (
          this.urgentMessageIds.has(item.message.id) &&
          !this.urgentMessages.has(item.message.id)
        ) {
          this.urgentMessages.set(item.message.id, item.message);
        }
      }
      this.emitMessageQueued(target, entry.bindingId, 'input', {
        state: target.state,
        message_id: interruptMessage.id,
        from: input.from,
        conversation_id: conversationId,
      });
      this.scheduleSnapshot();

      const first = outcomes[0];
      if (first === undefined || first.status !== 'fulfilled') {
        throw new AgentError('invalid_input', 'interrupt produced no run');
      }
      return {
        queued: true,
        message_id: interruptMessage.id,
        state: this.registry.get(target.id)?.state ?? target.state,
        run_id: first.value.runId,
        session_id: entry.bindingId,
        conversation_id: conversationId,
      };
    });
  }

  /**
   * 被抢占的 active urgent 重投失败时把消息还原为 unread。
   *
   * 该消息在 run 启动时已 consumed；`unhold` 不会让 consumed 变回 unread，所以先
   * `discard` 掉 consumed 记录，再以同 id 重新 append（缺省 rejectWhenFull:false）。
   * 不新增 port 方法，只用现有 append / discard 组合。
   */
  private restoreConsumedUnread(agentId: string, message: AgentMessage): void {
    // I3：这里是「重新落为 unread」的合法出口 —— 先 discard（连 consumed 一并删），
    // 再 append 同 id（未 hold）。不要改成 unhold：unhold 恢复不了 consumed。
    // 投递模式 quiet：这条投递已经收口（scheduler 拒绝了它），不让它再被当成待送达输入；
    // 正文留在 inbox 里，由下一轮 notice 提示、模型自己 read。`quiet` 会随条目落盘，
    // 所以队头直投也不会把它当成 run input（唯一的例外出口是 notice 提示后模型自己读）。
    this.inbox?.discard(agentId, [message.id]);
    this.inbox?.append(
      agentId,
      {
        id: message.id,
        ts: message.ts,
        // 与 trackInbox 同一口径（inboxSourceOf）：bash / ask 消息还原后来源仍是固定
        // 标签，不是 from（bash 作业的 from 就是收件人自己 ⇒ 条带「自己发给自己」）。
        source: inboxSourceOf(message),
        text: message.content,
        ...(message.conversation_id !== undefined
          ? { conversation_id: message.conversation_id }
          : {}),
        // 附件引用随还原一并带回：这条之后由模型自己 read，丢了 refs 等于把带图
        // 消息降级成纯文本（与 trackInbox 同口径）。
        ...(message.refs !== undefined && message.refs.length > 0 ? { refs: message.refs } : {}),
      },
      { delivery: 'quiet' },
    );
    this.urgentMessageIds.delete(message.id);
    this.urgentMessages.delete(message.id);
  }

  /**
   * wake 投递模式的内核：先追加 inbox（`delivery: 'wake'`，不 hold / submit / consume），
   * 再让 `dispatchInbox` 决定这一步能不能把**队头正文直投**出去 —— 目标忙时它什么都不做
   * （这一轮继续跑完），空下来后由队头直投接上；真的投不进去才退回 synthetic 摘要唤醒。
   * 唤醒失败也不影响已落盘的消息。
   * 预算走 wake 口径：不 ensure 新 conversation、只认 cycle blocked、跳过 hop /
   * wall-clock / turns / tokens，每批最多 bump 1 次 edge。
   */
  private async wakeDelivery(
    target: MemberRecord,
    input: {
      from: string;
      content: string;
      conversationId?: string;
      originSessionId?: string;
      originTeamId?: string;
      batchKey?: string;
      /** 附件引用（已归一）：随条目落盘，队头直投 / 模型 read 都带得上。 */
      refs?: MessageRef[];
    },
  ): Promise<{
    message_id: string;
    wake: boolean;
    resolution: 'live' | 'gone';
    conversation_id: string;
  }> {
    if (input.from === target.id) {
      throw new AgentError('invalid_input', 'self_notify');
    }
    if (this.inbox === undefined) {
      throw new AgentError('invalid_input', 'inbox_unavailable');
    }
    const live = this.liveEntries(target.id).length > 0;
    const conversationId = this.resolveConversationForDelivery(
      input.conversationId,
      input.originSessionId,
      target,
    );
    const teamId = input.originTeamId ?? this.resolveOriginTeam(input.from, target);
    const originExplicit = input.originTeamId !== undefined;
    // 第一遍只做只读检查（不 bump）：append / 投递失败时就不该留下边计数。
    const check = this.checkDelivery(target, input.from, conversationId, teamId, originExplicit, {
      mode: 'wake',
      edge: 'check',
    });
    if (!check.ok) {
      if (!TURN_DIMENSIONS.has(check.dimension)) {
        this.emitBudgetBlocked(target, check, {
          conversation_id: conversationId,
          from: input.from,
          to: target.id,
          phase: 'enqueue',
          ...(teamId !== undefined ? { teamId } : {}),
        });
      }
      throw this.budgetFailureError(check, conversationId, teamId);
    }
    const messageId = this.newId();
    // 投递模式交给 inbox 自己：wake 不裁 unread（见 append 的模式缺省），失败即 inbox_full。
    // `conversation_id` 随条目落盘：队头直投时要把这条送回它原本的会话。
    const appended = this.inbox.append(
      target.id,
      {
        id: messageId,
        ts: this.now(),
        source: input.from,
        text: input.content,
        conversation_id: conversationId,
        // 附件引用随 wake 条目落盘：notify 投递的带图消息与 input 投递同口径 ——
        // 队头直投（dispatchInbox 读 head.refs）与模型 read 都靠这份副本带上附件。
        ...(input.refs !== undefined && input.refs.length > 0 ? { refs: input.refs } : {}),
      },
      { delivery: 'wake' },
    );
    if (!appended.accepted) {
      throw new AgentError(
        'invalid_input',
        appended.reason === 'full' ? 'inbox_full' : 'inbox_unavailable',
      );
    }
    this.noticeDirty.add(target.id);
    // `wake` 字段的语义（wire 上仍是这个名字）= 「这一步有没有让目标真的动起来」：
    // 队头直投成功或退回摘要唤醒都算，目标忙 / 没有可直投条目则什么都不做。
    const wake = await this.dispatchInbox(target.id);
    // 只有“真的投递了”的投递才计边；每批最多 1 次。第二遍结果忽略：
    // 消息已经 append，cycle 失败也不撤销（它只影响后续投递的环检测）。
    if (wake && this.claimWakeEdge(input.batchKey, input.from, target.id)) {
      this.checkDelivery(target, input.from, conversationId, teamId, originExplicit, {
        mode: 'wake',
        edge: 'bump',
      });
    }
    if (live) {
      const entries = this.liveEntries(target.id);
      const binding = entries.find((entry) => entry.primary) ?? entries[0];
      if (binding !== undefined) {
        // 同一条投递事件，`delivery: 'wake'` 就是旧 `agent.message.notified`；`to` / `wake`
        // 保留旧载荷字段。**绝不写 state**：唤醒不入队，带 state 会让观测面把「只唤醒」
        // 显示成 queued / running。
        this.emitMessageQueued(target, binding.bindingId, 'wake', {
          message_id: messageId,
          from: input.from,
          to: target.id,
          conversation_id: conversationId,
          wake,
        });
      }
    }
    return {
      message_id: messageId,
      wake,
      resolution: live ? 'live' : 'gone',
      conversation_id: conversationId,
    };
  }

  /**
   * 这一刻能不能把队列里的东西交给目标（直投或唤醒）—— 判据只有「有没有活着的、空闲的
   * body」，先查 `liveEntries`，**绝不 ensure / spawn**：投递不该有起 body 的副作用。
   *
   * 忙（active / queuedRuns / pending / running / waiting_permission）时一律返回 false：
   * 用户裁定「忙时只留通知」—— 不打断当前这轮，也不把正文灌进正在跑的那轮。
   */
  private canDispatchInbox(agentId: string): boolean {
    if (this.inbox === undefined) return false;
    if (this.inboxPending.has(agentId)) return false;
    if (this.rotations.has(agentId)) return false;
    const entries = this.liveEntries(agentId);
    if (entries.length === 0) return false;
    for (const entry of entries) {
      if (entry.active !== undefined || entry.queuedRuns.size > 0 || entry.pending.length > 0) {
        return false;
      }
      if (entry.state === 'running' || entry.state === 'waiting_permission') return false;
      // 0.55 硬错误闸：闸落下 = 这一刻不接活。返回 false 而不是继续投，是为了让
      // 消息**留在队列里**（队头仍是 unread，`noticeDirty` 记着），解闸时再投。
      if (entry.hardStop !== undefined) return false;
    }
    return this.registry.get(agentId) !== undefined;
  }

  /**
   * 队列 → 目标的一步投递：**队头直投**（q-inbox-admit-restore 起唯一路径；投不进去
   * 留队列 + noticeDirty，不再点火 synthetic 兜底）。
   *
   * 为什么不再一律发唤醒：唤醒的 run input 只是一句「去 inbox 读」，正文要模型自己拉 ——
   * 实测连发 4 条后模型一次把剩下的全读出来，用户看到「4 条堆在一起」，而每条消息本该
   * 各自是一轮。直投走 `admitInternal`（就是 `agents.send` 的 input 投递那条路），所以
   * markConsumed / refs / conversation_id / from_name（⇒ runtime 推出 `agent:<alias>`）
   * 与 input 逐项一致，没有第二套语义。
   *
   * 每轮只取**一条**（队头）：其余留在队列，本轮跑完 `settleHandle` 再来一次。
   *
   * 什么时候**不能**直投、只能留队列或退回唤醒（判据与理由）：
   * - 目标忙 / rotate 窗口 / draining / 没有 live body（`canDispatchInbox` 为 false）：
   *   没有能接活的执行单元。硬投要么打断这轮，要么为了投递去 spawn 一具身体 ——
   *   两件都不是一次投递该干的。留队列 + `noticeDirty`，空下来再投。
   * - 队头没有可直投条目（`inputHead` 为 undefined：全是 quiet 留档 / 空正文）：
   *   quiet 的语义就是「不要执行」（模型自述、投递失败的留档），唤醒模型去读也读不出
   *   一轮 run，只会白烧一次 turn。所以什么都不做。
   * - 直投本身被拒（预算 cycle 冷却 / member_closed / scheduler 拒绝）：**留队列 +
   *   noticeDirty，不点火兜底**（q-inbox-admit-restore 修3）—— synthetic wake 会在轮间
   *   插系统 run；预算允许 / 下一次 settle 时重投，正文不丢。
   *
   * 返回 true = 这一步真的让目标动了起来（直投或唤醒），用于交付事件与预算计边。
   */
  private async dispatchInbox(agentId: string): Promise<boolean> {
    const inbox = this.inbox;
    if (inbox === undefined) return false;
    if (this.inboxPending.has(agentId)) return false;
    // 先取队头再判能不能投：队列空 / 全留档时不占在途标记，也顺手清掉 dirty。
    const head = inbox.inputHead(agentId);
    if (head === undefined) {
      this.noticeDirty.delete(agentId);
      return false;
    }
    if (!this.canDispatchInbox(agentId)) {
      // 忙：留队列。run 结束后 settleHandle 会带着这个标记再来一次。
      this.noticeDirty.add(agentId);
      return false;
    }
    const record = this.registry.get(agentId);
    const entries = this.liveEntries(agentId);
    const entry = entries.find((candidate) => candidate.primary) ?? entries[0];
    if (record === undefined || entry === undefined) return false;
    this.inboxPending.add(agentId);
    let delivered = false;
    try {
      await this.admitInternal(
        {
          content: head.text,
          agent_id: record.id,
          session_id: entry.bindingId,
          // bash_job = 成员自己的作业回报它自己：source 只是展示标签（'bash'），
          // 真正的发送者是收件人自己（与 0.55 admit 旧路径同口径；origin 跳 canView）。
          from: head.origin === 'bash_job' ? record.id : head.source,
          channel: 'direct',
          // 投递来源语义原样带回（q-inbox-admit-restore）：bash_job 跳 canView，
          // 执行内核据此渲染 tool:bash 身份。
          ...(head.origin !== undefined ? { origin: head.origin } : {}),
          ...(head.refs !== undefined ? { refs: head.refs } : {}),
          ...(head.conversation_id !== undefined ? { conversation_id: head.conversation_id } : {}),
          // team 关联原样带回（append 同 id 幂等，防裁掉重落时丢关联）。
          ...(head.team_message_id !== undefined ? { team_message_id: head.team_message_id } : {}),
          // 求救标记原样带回（q-distress-message）：直投的求救 run 再失败不级联。
          ...(head.distress === true ? { distress: true } : {}),
          // 复用条目自己的 id：append 幂等、markConsumed 天然指向同一条，
          // 这条消息不会因为「先落盘、后被直投」而在磁盘上变成两条。
          reuse_message_id: head.id,
        },
        // 直投失败要**留在队列**（unhold），不能 discard —— 丢掉的是用户的正文。
        { redelivery: true },
      );
      delivered = true;
    } catch (error) {
      this.logger.warn('agent.inbox.deliver_failed', {
        agent_id: agentId,
        session_id: entry.bindingId,
        message_id: head.id,
        error: errorText(error),
      });
    } finally {
      this.inboxPending.delete(agentId);
    }
    if (delivered) return true;
    // 直投被拒（预算 / member_closed / scheduler）：**留队列 + 计数，不点火兜底**
    // （q-inbox-admit-restore 修3）—— synthetic wake 会在轮间插一个系统 run（打断
    // 协调流的根因形状）。消息留在队列，预算允许 / 下一次 settle 时自然重投。
    this.noticeDirty.add(agentId);
    return false;
  }

  /** 同一 agent 的打断重排串行执行（普通 admit 不经过此锁）。 */
  private withExecutionUnitOp<T>(key: string, op: () => Promise<T>): Promise<T> {
    const previous = this.executionUnitOps.get(key) ?? Promise.resolve();
    const next = previous.then(op, op);
    this.executionUnitOps.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * dispatch：统一投递入口。`to` 为 id / session / 唯一 name。
   * 与 strict `send` 的区别：gone 成员会先确保 runtime（可 resume）；失败可按策略自动创建。
   */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    await this.ready;
    const raw = input as unknown as Record<string, unknown>;
    // 0.53 U1（ADR-104 §7.2）：投递入口不声明投射模式（同 `send`）。
    if (raw.projection !== undefined || raw.projection_mode !== undefined) {
      return {
        status: 'rejected',
        code: 'invalid_input',
        reason: 'projection is a session-level declaration; set it on create / rotate',
      };
    }
    const to = readRequiredString(raw, 'to');
    const from = raw.from === undefined ? DEFAULT_MESSAGE_SENDER : readRequiredString(raw, 'from');
    const interrupt = readOptionalBoolean(raw, 'interrupt');
    // wire 的 notify 布尔 ↔ inbox 的 wake 投递模式：dispatch 内部只认模式。
    const delivery = deliveryFromNotify(readOptionalBoolean(raw, 'notify'));
    const wakes = delivery === 'wake';
    let messageId: string | undefined;
    if (raw.message_id !== undefined) messageId = readRequiredString(raw, 'message_id');
    const originSessionId =
      raw.origin_session_id === undefined
        ? undefined
        : readRequiredString(raw, 'origin_session_id');
    const originRunId =
      raw.origin_run_id === undefined ? undefined : readRequiredString(raw, 'origin_run_id');
    const batchKey = raw.batch_key === undefined ? undefined : readRequiredString(raw, 'batch_key');

    // 三档输入互斥与地址限制：在解析目标 / 产生任何副作用之前拒绝。
    if (interrupt && wakes) {
      return { status: 'rejected', code: 'invalid_input', reason: 'conflicting_delivery' };
    }
    if (messageId !== undefined && wakes) {
      return {
        status: 'rejected',
        code: 'invalid_input',
        reason: 'message_id is not supported with notify',
      };
    }
    if (messageId !== undefined && !interrupt) {
      return {
        status: 'rejected',
        code: 'invalid_input',
        reason: 'message_id requires interrupt: true',
      };
    }
    if (
      (interrupt || wakes) &&
      (to.includes('@') || to === HUMAN_PRINCIPAL || to.startsWith('federation:'))
    ) {
      return { status: 'rejected', code: 'invalid_input', reason: 'unsupported_delivery' };
    }
    let content: string;
    if (messageId !== undefined) {
      if (raw.content !== undefined && raw.content !== '') {
        if (typeof raw.content !== 'string' || raw.content.trim() !== '') {
          return {
            status: 'rejected',
            code: 'invalid_input',
            reason: 'pass either content or message_id, not both',
          };
        }
      }
      content = '';
    } else {
      content = readContent(raw, 'content');
    }

    const target = this.resolveDispatchTarget(to, from);
    if (target === undefined || !this.registry.canView(target, from)) {
      return { status: 'rejected', code: 'not_visible', reason: `not_visible: ${to}` };
    }
    if (target.membership === 'left' || target.state === 'closed') {
      return { status: 'rejected', code: 'agent_left', reason: `agent_left: ${target.id}` };
    }
    // wake 投递允许落给 closing / gone（append + wake:false）；input / urgent 仍拒绝 closing。
    if (!wakes && this.hasClosingExecutionUnit(target.id)) {
      return { status: 'rejected', code: 'agent_left', reason: `agent_left: ${target.id}` };
    }

    const originTeamId =
      raw.origin_team_id === undefined ? undefined : readRequiredString(raw, 'origin_team_id');
    // team 日志关联（仅内部装配，TeamService.post 填）：随 inbox 条目落盘，
    // 供「编辑 / 删除 team 消息」级联定位收件箱副本。
    const teamMessageId =
      raw.team_message_id === undefined ? undefined : readRequiredString(raw, 'team_message_id');
    // 附件引用（0.52）：只有路径 + 元信息。input 投递进 admit → core Message.refs；
    // wake 投递随 inbox 条目落盘（队头直投 / 模型 read 都带得上）—— 两条路同口径，
    // 不再「wake 不带引用」（那会让 notify 的带图消息在落盘层丢附件）。
    const refs = normalizeRefs(input.refs);
    if (wakes) {
      try {
        const outcome = await this.wakeDelivery(target, {
          from,
          content,
          ...(input.conversation_id !== undefined ? { conversationId: input.conversation_id } : {}),
          ...(originSessionId !== undefined ? { originSessionId } : {}),
          ...(originTeamId !== undefined ? { originTeamId } : {}),
          ...(batchKey !== undefined ? { batchKey } : {}),
          ...(refs.length > 0 ? { refs } : {}),
        });
        return {
          status: 'notified',
          message_id: outcome.message_id,
          resolved_to: target.id,
          conversation_id: outcome.conversation_id,
          wake: outcome.wake,
          resolution: outcome.resolution,
        };
      } catch (error) {
        return this.rejectAdmit(error);
      }
    }
    if (interrupt) {
      try {
        const result = await this.sendInterrupt(target, {
          memberKey: to,
          from,
          content,
          ...(messageId !== undefined ? { messageId } : {}),
          ...(input.conversation_id !== undefined ? { conversationId: input.conversation_id } : {}),
          ...(originSessionId !== undefined ? { originSessionId } : {}),
          ...(originRunId !== undefined ? { originRunId } : {}),
          ...(originTeamId !== undefined ? { originTeamId } : {}),
        });
        return {
          status: 'queued',
          message_id: result.message_id,
          resolved_to: target.id,
          resolution: 'live',
          conversation_id: result.conversation_id,
        };
      } catch (error) {
        return this.rejectAdmit(error);
      }
    }

    const conversationId = this.resolveConversationForDelivery(
      input.conversation_id,
      originSessionId,
      target,
    );
    const boundSession = this.registry.getBySession(to)?.id === target.id ? to : undefined;
    const attempt = async (agentId: string, sessionId?: string) =>
      this.admit({
        content,
        agent_id: agentId,
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
        from,
        channel: originTeamId === undefined ? 'direct' : 'team',
        ...(originTeamId !== undefined ? { origin_team_id: originTeamId } : {}),
        ...(teamMessageId !== undefined ? { team_message_id: teamMessageId } : {}),
        ...(originSessionId !== undefined ? { origin_session_id: originSessionId } : {}),
        ...(originRunId !== undefined ? { origin_run_id: originRunId } : {}),
        conversation_id: conversationId,
        ...(refs.length > 0 ? { refs } : {}),
        strict: false,
      });

    // admit 会把 presence 拉回 live，所以先捕获投递前的 presence 来区分 live / resumed。
    const wasLive = target.presence === 'live';
    try {
      const result = await attempt(target.id, boundSession);
      return {
        status: 'queued',
        message_id: result.message_id ?? result.run_id ?? '',
        resolved_to: target.id,
        resolution: wasLive ? 'live' : 'resumed',
        conversation_id: conversationId,
      };
    } catch (error) {
      if (!this.resolveAllowAutoCreate(target, raw.allow_auto_create)) {
        const rejected = this.rejectAdmit(error);
        // policy 关闭自动创建：resume 兜底本可覆盖的失败给出明确 wire code；
        // budget / visibility 等已有稳定 code 的失败保持原样。
        if (rejected.status === 'rejected' && rejected.code === 'resume_failed') {
          return {
            status: 'rejected',
            code: 'auto_create_not_allowed',
            reason: 'auto_create_not_allowed: policy',
          };
        }
        return rejected;
      }
      const created = await this.ensureCreatedOnDispatch(target.id);
      if (!created.ok) {
        if (created.code === 'agent_left') {
          return { status: 'rejected', code: 'agent_left', reason: created.reason };
        }
        if (
          created.code === 'auto_create_failed' ||
          created.code === 'auto_create_not_allowed' ||
          created.code === 'team_full' ||
          created.code === 'team_frozen'
        ) {
          return { status: 'rejected', code: created.code, reason: created.reason };
        }
        return { status: 'rejected', code: 'resume_failed', reason: created.reason };
      }
      const derived = this.registry.get(created.member.id);
      if (derived === undefined || derived.membership === 'left' || derived.state === 'closed') {
        return { status: 'rejected', code: 'agent_left', reason: `agent_left: ${target.id}` };
      }
      try {
        const result = await attempt(derived.id);
        return {
          status: 'queued',
          message_id: result.message_id ?? result.run_id ?? '',
          resolved_to: derived.id,
          resolution: 'created',
          conversation_id: conversationId,
        };
      } catch (createError) {
        return this.rejectAdmit(createError);
      }
    }
  }

  /**
   * 附件入池（0.56 决策 2）：把图片引用换成带 `sha256` 的引用。
   *
   * 幂等：装配层没注入（`attachIngest === undefined`）就直接原样返回 —— 纯内存 /
   * 工具清单 / 测试场景不会因为「没有 blob 池」而失败（图只是不内联）。
   * 注入时吸入所有异常：入池失败**不该**让一条消息发不出去（文本仍然要送达），
   * 代价只是那张图显示「未发送 · 未入池」。
   */
  private async ingestRefs(refs: MessageRef[]): Promise<MessageRef[]> {
    if (this.attachIngest === undefined || refs.length === 0) return refs;
    if (!refs.some((ref) => ref.kind === 'image' && ref.sha256 === undefined)) return refs;
    try {
      return await this.attachIngest(refs);
    } catch (error) {
      this.logger.warn('attachment.ingest.failed', {
        error: error instanceof Error ? error.message : String(error),
        refs: refs.length,
      });
      return refs;
    }
  }

  /** admit / spawn 失败 → DispatchResult（稳定 code 尽量保留） */
  private rejectAdmit(error: unknown): DispatchResult {
    const code = errorCode(error);
    if (code === 'member_not_visible') {
      return { status: 'rejected', code: 'not_visible', reason: errorText(error) };
    }
    if (code === 'member_closed') {
      return { status: 'rejected', code: 'agent_left', reason: errorText(error) };
    }
    if (code === 'member_stale') {
      return { status: 'rejected', code: 'member_stale', reason: errorText(error) };
    }
    if (code === 'invalid_input') {
      return { status: 'rejected', code: 'invalid_input', reason: errorText(error) };
    }
    // 0.52 S1a：node 正在退出、又没有 durable inbox 可排队 ⇒ 明确可重试，不伪装成 resume_failed。
    if (code === 'node_draining') {
      return { status: 'rejected', code: 'node_draining', reason: errorText(error) };
    }
    if (
      code === 'budget_exceeded' ||
      code === 'budget_unavailable' ||
      code === 'conversation_team_mismatch'
    ) {
      return { status: 'rejected', code, reason: errorText(error) };
    }
    return { status: 'rejected', code: 'resume_failed', reason: errorText(error) };
  }

  /**
   * dispatch 的 to 解析：id/session 直取；name 需唯一且对 from 可见。
   * 返回 undefined 表示 name 存在但全部不可见（调用方返回 rejected not_visible）。
   */
  private resolveDispatchTarget(to: string, from: string): MemberRecord | undefined {
    const direct = this.registry.resolve(to);
    if (direct) return direct;

    const matches = this.registry.findByName(to);
    if (matches.length === 0) {
      throw new AgentError('unknown_member', `unknown_member: ${to}`);
    }
    const present = matches.filter((record) => record.membership === 'present');
    const pool = present.length > 0 ? present : matches;
    const visible = pool.filter((record) => this.registry.canView(record, from));
    if (visible.length === 0) return undefined;
    if (visible.length > 1) {
      const candidates = visible.map((record) => record.id).join(', ');
      throw new AgentError('invalid_input', `ambiguous name: ${to} candidates: ${candidates}`);
    }
    return visible[0];
  }

  /**
   * 自动创建开关：显式 `allow_auto_create` 优先（只由 owner / CLI 传入）；
   * 缺省看目标 Team 的 `policy.allowAutoCreate`，再缺省 false。
   */
  private resolveAllowAutoCreate(target: MemberRecord, explicit: unknown): boolean {
    if (explicit !== undefined) {
      if (typeof explicit !== 'boolean') {
        throw new AgentError('invalid_input', 'allow_auto_create must be a boolean');
      }
      return explicit;
    }
    if (target.teamId === undefined) return false;
    return this.teamPolicy?.(target.teamId)?.allowAutoCreate === true;
  }

  // ─── sessions.create / restart / activate ──────────────────────────────

  /**
   * `sessions.create`（CREATE-0.39）：同一 agent 新 session，成为唯一 primary。
   *
   * 无来源 = 空 session；有来源 = copy / compact 前缀。成功时旧 primary 直接退役进
   * `bindingHistory`（不以 transient `retiringBinding` 结束）；失败回滚，源仍 primary。
   */
  async createSession(
    input: SessionCreateInput,
    internal?: SessionCreateInternalOptions,
  ): Promise<SessionCreateResult> {
    await this.ready;
    const raw = input as unknown as Record<string, unknown>;
    const fromSessionId =
      raw.from_session_id === undefined ? undefined : readRequiredString(raw, 'from_session_id');
    const seed = readCreateSeed(raw.seed);
    const keepMessages = readKeepMessages(raw.keep_messages);
    const mode = readSessionMode(raw.mode);
    const files = readSessionFiles(raw.files);
    // Additive: explicit title for the new body (rotate naming). Validated here,
    // before any event / binding is touched, so bad input never half-creates.
    const title = readSessionTitle(raw.title);

    let record: MemberRecord;
    let sourceSessionId: string | undefined;
    let seedKind: CreateSeed | undefined;
    let seedResult: SeedResult | undefined;

    if (fromSessionId === undefined) {
      if (seed !== undefined || keepMessages !== undefined) {
        throw new AgentError('invalid_input', 'seed / keep_messages require from_session_id');
      }
      if (mode !== undefined || files !== undefined) {
        throw new AgentError('invalid_input', 'mode / files require from_session_id');
      }
      if (raw.agent_id === undefined) {
        throw new AgentError('invalid_input', 'agent_id is required without from_session_id');
      }
      record = this.requireAgent(readRequiredString(raw, 'agent_id'));
    } else {
      const hit = this.findSessionAnyState(fromSessionId);
      if (hit === undefined) {
        throw new AgentError('unknown_member', `session_not_found: ${fromSessionId}`);
      }
      if (hit.record.membership === 'left' || hit.record.state === 'closed') {
        throw new AgentError('member_closed', `agent_closed: ${hit.record.id}`);
      }
      if (hit.state !== 'primary') {
        throw new AgentError('conflict', `not_primary: ${fromSessionId}`);
      }
      record = hit.record;
      if (raw.agent_id !== undefined && readRequiredString(raw, 'agent_id') !== record.id) {
        throw new AgentError('invalid_input', 'agent_id does not match source session');
      }
      if (mode === 'both' && files === undefined) {
        throw new AgentError('invalid_input', 'files is required when mode=both');
      }
      await this.assertSourceIdle(record, fromSessionId);
      sourceSessionId = fromSessionId;
      seedKind = seed ?? 'copy';
      seedResult = await this.buildSeed(fromSessionId, seedKind, keepMessages);
    }

    if (record.membership === 'left' || record.state === 'closed') {
      throw new AgentError('member_closed', `agent_closed: ${record.id}`);
    }

    const allowActiveRun = internal?.allowActiveRun === true;
    // RPC 路径在写任何事件 / 动 binding 之前先拒绝 active run（无中间态）。
    if (!allowActiveRun) {
      const currentPrimary = primaryBinding(record);
      if (currentPrimary !== undefined) {
        await this.assertSourceIdle(record, currentPrimary.bindingId);
      }
    }

    const newSessionId = this.newId();
    if (
      !nonEmpty(newSessionId) ||
      this.registry.getBySession(newSessionId) !== undefined ||
      this.registry.isRetiredSession(newSessionId)
    ) {
      throw new AgentError('spawn_failed', 'session_id_collision', {
        operation: 'session.create',
        details: this.spawnFailureDetails(record, undefined),
      });
    }

    // 0.53 U1（ADR-104）：新 body 的上下文投射声明。校验 / 收窄排在写事件、换 binding
    // 之前：声明失败不留半个 session，源与旧 primary 都不动。
    // 父 = 源会话（换 body）或该 agent 当前的 primary（新 body 不得比当前更松）。
    this.declareSessionProjection({
      sessionId: newSessionId,
      source: 'rotate',
      requested: raw.projection ?? raw.projection_mode,
      parentSessionIds: [sourceSessionId, primaryBinding(record)?.bindingId],
    });

    // 事件先写（只读源，不动 binding）；写失败时源仍 primary，返回 create_failed。
    try {
      if (seedResult !== undefined && seedKind !== undefined && sourceSessionId !== undefined) {
        await this.writeSeedEvents(
          {
            agentId: record.id,
            sessionId: newSessionId,
            sourceSessionId,
            seed: seedKind,
            ...(keepMessages !== undefined ? { keepMessages } : {}),
            keepProjected: seedResult.keepProjected,
            copiedMessages: seedResult.copiedMessages,
            ...(mode !== undefined ? { mode } : {}),
          },
          seedResult,
        );
      } else {
        await this.appendSessionEvent(newSessionId, 'session.created', {
          side: 'new',
          agent_id: record.id,
          session_id: newSessionId,
          primary: true,
        }).catch((error: unknown) => {
          this.logger.warn('agent.session.created_failed', {
            agent_id: record.id,
            session_id: newSessionId,
            error: errorText(error),
          });
        });
      }
    } catch (error) {
      // 事件可能已部分写入：best-effort 清掉新 session，源 / 旧 primary 不动。
      await this.cleanupSessionData(newSessionId, record.id);
      throw new AgentError('spawn_failed', errorText(error), {
        cause: error,
        operation: 'session.create.seed',
        details: this.spawnFailureDetails(record, error),
      });
    }

    let switchResult: { previousSessionId: string; epoch: number };
    try {
      switchResult = await this.performNewPrimarySwitch(record, newSessionId, allowActiveRun);
    } catch (error) {
      // 切换失败：新 session 事件已写，清理后重新抛出原始错误。
      await this.cleanupSessionData(newSessionId, record.id);
      throw error;
    }
    const { previousSessionId, epoch } = switchResult;

    this.emitForSession('agent.session.activated', record, newSessionId, {
      from: previousSessionId,
      to: newSessionId,
      previous_session_id: previousSessionId,
      epoch,
    });
    await this.appendSessionEvent(newSessionId, 'session.activated', {
      agent_id: record.id,
      session_id: newSessionId,
      previous_session_id: previousSessionId,
      epoch,
    }).catch((error: unknown) => {
      this.logger.warn('agent.session.activated_failed', {
        agent_id: record.id,
        session_id: newSessionId,
        error: errorText(error),
      });
    });

    // q-session-fix：新 body 的壳随换体落地（与 createOne 同一缺口：此前要等首轮
    // run 才有壳，rotate 后从未开口的会话在 WebUI 里同样是 not_found）。
    await this.ensureSessionShell(newSessionId, record.id);

    // 源退役审计（仅 copy / compact）；best-effort，失败只 warn。
    if (seedResult !== undefined && seedKind !== undefined && sourceSessionId !== undefined) {
      await this.appendSessionEvent(sourceSessionId, 'session.created', {
        side: 'source',
        agent_id: record.id,
        to_session_id: newSessionId,
        seed: seedKind,
        // CONTRACT r10 §5.4：事件只带投影边界，不带 wire keep_messages。
        keep_projected: seedResult.keepProjected,
        copied_messages: seedResult.copiedMessages,
        ...(mode !== undefined ? { mode } : {}),
      }).catch((error: unknown) => {
        this.logger.warn('agent.session.source_audit_failed', {
          agent_id: record.id,
          session_id: sourceSessionId,
          error: errorText(error),
        });
      });
    }

    // q-session-naming：显式 title 优先；内置 agent 工具的 rotate（allowActiveRun）
    // 未传 title 时缺省用成员 name（再退 id）—— 新 body 不再依赖「截断首消息」。
    // 人经 RPC 发起的 sessions.create 未传 title 时保持既有派生 + AI 命名链路。
    const effectiveTitle = title ?? (allowActiveRun ? (record.name ?? record.id) : undefined);
    if (effectiveTitle !== undefined) {
      // Name the new body before its first turn: the shell is marked
      // title_source: 'manual', so both the derived title and the AI titler leave
      // it alone. Best-effort like the startup prompt: a shell write failure must
      // not undo a committed rotation.
      await this.nameNewSession(record, newSessionId, effectiveTitle);
    }

    const startupPrompt =
      raw.startup_prompt === undefined ? undefined : readContent(raw, 'startup_prompt');
    if (startupPrompt !== undefined) {
      // 唯一的来源判定点：`allowActiveRun` 只由内置 `agent` 工具的 rotate 动作传入
      // （工具在调用者自身 active run 内换体）。人经 RPC 发起 create / restart /
      // activate 时 startup_prompt 是**人写的开场白**，一个字节都不标 —— 那份裁定
      // （按正文渲染）继续成立，只是不再覆盖 agent 写的交接书。
      const handoffName = allowActiveRun ? rotateHandoffInputName(epoch) : undefined;
      try {
        await this.admitInternal(
          {
            content: startupPrompt,
            agent_id: record.id,
            session_id: newSessionId,
            from: SYSTEM_PRINCIPAL,
            channel: 'direct',
            conversation_id: generateConversationId(this.newId),
            strict: false,
          },
          {
            startup: true,
            ...(handoffName !== undefined ? { inputName: handoffName } : {}),
          },
        );
      } catch (error) {
        this.logger.warn('agent.session_create.startup_failed', {
          agent_id: record.id,
          error: errorText(error),
        });
      }
    }

    this.updateAgentState(record.id);
    this.scheduleSnapshot();
    return {
      agent_id: record.id,
      session_id: newSessionId,
      ...(effectiveTitle !== undefined ? { title: effectiveTitle } : {}),
      ...(sourceSessionId !== undefined
        ? {
            source_session_id: sourceSessionId,
            seed: seedKind,
            ...(keepMessages !== undefined ? { keep_messages: keepMessages } : {}),
            keep_projected: seedResult?.keepProjected ?? 0,
            copied_messages: seedResult?.copiedMessages ?? 0,
          }
        : {}),
      primary: true,
    };
  }

  /**
   * 把 record 的 primary 切到 newSessionId（epoch = 当前 primary + 1）。
   *
   * 单可运行不变量：旧 binding 成功时直接退役进 `bindingHistory`；失败回滚到旧
   * binding，源仍 primary。旧 EU 先 dispose / 释放租约，再建新 EU。
   * `allowActiveRun` 只由内置 rotate 工具传入：defer 旧 EU dispose，由退役 /
   * fencing 路径在轮末收口；RPC 路径为 false。
   */
  private async performNewPrimarySwitch(
    record: MemberRecord,
    newSessionId: string,
    allowActiveRun: boolean,
  ): Promise<{ previousSessionId: string; epoch: number }> {
    const oldBinding = record.binding;
    if (oldBinding === undefined || oldBinding.retiredAt !== undefined) {
      const newBinding = await this.createBinding(record, newSessionId, {
        epoch: 0,
        primary: true,
      });
      const entry = await this.entryFor(record, newBinding);
      await this.ensureRuntime(entry);
      this.registry.setPrimaryBinding(record.id, newSessionId);
      return { previousSessionId: record.sessionId, epoch: 0 };
    }
    const oldSessionId = oldBinding.bindingId;
    const oldEpoch = oldBinding.epoch;
    const newEpoch = oldEpoch + 1;
    const oldToken = this.runtime.sessionLeaseToken?.(oldSessionId) ?? 0;
    const oldEntry = this.findEntry(record.id, oldSessionId);
    const pendingRun = this.pendingRunId(oldEntry);
    const oldEntryPending = pendingRun !== undefined;
    // RPC（allowActiveRun=false）必须拒绝；内置 rotate 工具在自身 run 内执行，
    // 走内部选项放行，旧 run / queued 由退役路径收口。
    if (oldEntryPending && !allowActiveRun) {
      throw new AgentError('conflict', `run_in_progress: ${pendingRun}`);
    }

    this.registry.setRotation(record.id, 'rotating');
    this.rotations.set(record.id, {
      fromSessionId: oldSessionId,
      fromEpoch: oldEpoch,
      toSessionId: newSessionId,
      toEpoch: newEpoch,
    });
    this.runtime.disableInbox?.(oldSessionId);
    await this.inbox?.flush();

    const rollback = async (): Promise<void> => {
      const current = this.findEntry(record.id, newSessionId);
      if (current !== undefined) await this.disposeEntry(current);
      await this.releasePendingBindingLease(newSessionId);
      this.registry.removeBinding(record.id, newSessionId);
      const restored = record.binding;
      if (restored !== undefined && restored.bindingId === oldSessionId) {
        this.registry.setPrimaryBinding(record.id, oldSessionId);
        const entry = await this.entryFor(record, restored);
        await this.ensureRuntime(entry);
        // 旧 entry 未 dispose（active / queued / spawning）时仍持有旧 token；
        // 回滚不得用更高 fence 把它顶掉。
        if (!oldEntryPending) {
          await this.runtime.ensureSessionLease?.(oldSessionId, oldToken + 1);
        }
      }
      this.runtime.enableInbox?.(oldSessionId);
      this.registry.setRotation(record.id, 'stable');
      this.rotations.delete(record.id);
    };

    try {
      await this.retireResidualBinding(record);
      // 非 active 旧 EU 先 dispose（释放 binding lease / SessionLease）；active 旧 run
      // 由 retireExecutionUnitEntry 退役、轮末收口，不能在运行中 dispose。
      const deferOldDispose = allowActiveRun && oldEntryPending;
      if (oldEntry !== undefined && !oldEntry.retired && !deferOldDispose) {
        await this.disposeEntry(oldEntry);
      }
      const newBinding = await this.createBinding(record, newSessionId, {
        epoch: newEpoch,
        primary: true,
        rotation: true,
      });
      const newEntry = await this.entryFor(record, newBinding);
      await this.ensureRuntime(newEntry);
      newEntry.primary = true;
      await this.runtime.ensureSessionLease?.(newSessionId, oldToken + 1);
      this.registry.setPrimaryBinding(record.id, newSessionId);
      // 成功：旧 binding 从 retiringBinding 退役进 history，不以 transient 结束。
      // 有内存 entry 时走统一退役（含 queued run 取消 / 事件 / active run 延迟 dispose）。
      if (oldEntry !== undefined && !oldEntry.retired) {
        await this.retireExecutionUnitEntry(record, oldEntry, 'rotation');
      } else {
        this.registry.retireBinding(record.id, oldSessionId);
      }
      this.registry.setPrimaryBinding(record.id, newSessionId);
      this.registry.setRotation(record.id, 'stable');
      this.rotations.delete(record.id);
      // D2/I4：旧 body 的在途队列转为可注入。retire 路径已按 body 释放过一次，这里
      // 是幂等兜底（`oldEntry` 不在内存时不会走到 retire）。
      this.inbox?.releaseHeldFor(record.id, oldSessionId);
      this.runtime.clearPendingNotices?.(record.id);
      this.scheduleSnapshot();
      return { previousSessionId: oldSessionId, epoch: newEpoch };
    } catch (error) {
      await rollback();
      throw new AgentError('spawn_failed', errorText(error), {
        cause: error,
        operation: 'session.create.switch',
        details: this.spawnFailureDetails(record, error),
      });
    }
  }

  /**
   * `sessions.restart`（CREATE-0.39 §3.2）：同一 session 原地换 binding（epoch+1）。
   *
   * 本地 oldBinding 引用 + 清槽 + 恢复；旧 binding 不先写 history，成功后才
   * `pushBindingHistory`。任一步失败恢复旧 binding / primary；恢复失败显式
   * `restart_rollback_failed`，不得静默成功。
   */
  async restartSession(input: SessionRestartInput): Promise<SessionRestartResult> {
    await this.ready;
    const raw = input as unknown as Record<string, unknown>;
    const sessionId = readRequiredString(raw, 'session_id');
    const hit = this.findSessionAnyState(sessionId);
    if (hit === undefined) {
      throw new AgentError('unknown_member', `session_not_found: ${sessionId}`);
    }
    if (hit.state !== 'primary') {
      throw new AgentError('conflict', `not_primary: ${sessionId}`);
    }
    const record = hit.record;
    if (
      record.membership === 'left' ||
      record.state === 'closed' ||
      this.hasClosingExecutionUnit(record.id)
    ) {
      throw new AgentError('member_closed', `agent_closed: ${record.id}`);
    }
    if (this.rotations.has(record.id) || record.rotation === 'rotating') {
      throw new AgentError('conflict', 'rotating');
    }
    const oldBinding = record.binding;
    if (
      oldBinding === undefined ||
      oldBinding.bindingId !== sessionId ||
      oldBinding.retiredAt !== undefined
    ) {
      throw new AgentError('conflict', `not_primary: ${sessionId}`);
    }
    const oldEpoch = oldBinding.epoch;
    const epoch = oldEpoch + 1;
    const oldToken = this.runtime.sessionLeaseToken?.(sessionId) ?? 0;
    const oldEntry = this.findEntry(record.id, sessionId);
    const pendingRun = this.pendingRunId(oldEntry);
    if (pendingRun !== undefined) {
      throw new AgentError('conflict', `run_in_progress: ${pendingRun}`);
    }

    this.emitForSession('agent.restarting', record, sessionId, {
      from_session_id: sessionId,
      to_session_id: sessionId,
      from_epoch: oldEpoch,
      epoch,
      fencing_token: this.runtime.sessionLeaseToken?.(sessionId) ?? oldEntry?.fencingToken ?? null,
    });
    this.registry.setRotation(record.id, 'rotating');
    this.rotations.set(record.id, {
      fromSessionId: sessionId,
      fromEpoch: oldEpoch,
      toSessionId: sessionId,
      toEpoch: epoch,
    });

    try {
      await this.retireResidualBinding(record);
      // 3. 停旧 EU / 释放 lease；4. 清 binding 槽位（不写 history）。
      this.runtime.disableInbox?.(sessionId);
      if (oldEntry !== undefined) await this.disposeEntry(oldEntry);
      this.registry.removeBinding(record.id, sessionId);
      // 5. 新 binding 同 id、epoch+1；6. 新 EU + 更高的 SessionLease。
      const newBinding = await this.createBinding(record, sessionId, {
        epoch,
        primary: true,
        restart: true,
      });
      const newEntry = await this.entryFor(record, newBinding);
      await this.ensureRuntime(newEntry);
      await this.runtime.ensureSessionLease?.(sessionId, oldToken + 1);
      // 7. primary；8. 旧 epoch 记入 history。
      this.registry.setPrimaryBinding(record.id, sessionId);
      this.registry.pushBindingHistory(record.id, {
        session_id: sessionId,
        epoch: oldEpoch,
        started_at: oldBinding.createdAt,
        retired_at: this.now(),
      });
      // D2/I4：restart 复用同一个 session id，旧 body 记的 hold 仍以它为键，按 body 释放。
      this.inbox?.releaseHeldFor(record.id, sessionId);
      this.runtime.clearPendingNotices?.(record.id);
      this.scheduleSnapshot();
      const flushed = await this.flushSnapshot().catch(() => false);
      if (!flushed) {
        this.logger.warn('agent.restart.snapshot_write_failed', { agent_id: record.id });
      }
      this.updateAgentState(record.id);
      this.emitForSession('agent.restarted', record, sessionId, {
        from_session_id: sessionId,
        to_session_id: sessionId,
        from_epoch: oldEpoch,
        epoch,
        fencing_token: this.runtime.sessionLeaseToken?.(sessionId) ?? newEntry.fencingToken ?? null,
      });

      const startupPrompt =
        raw.startup_prompt === undefined ? undefined : readContent(raw, 'startup_prompt');
      if (startupPrompt !== undefined) {
        try {
          await this.admitInternal(
            {
              content: startupPrompt,
              agent_id: record.id,
              session_id: sessionId,
              from: SYSTEM_PRINCIPAL,
              channel: 'direct',
              conversation_id: generateConversationId(this.newId),
              strict: false,
            },
            { startup: true },
          );
        } catch (error) {
          // q-error-e2（§3.6，裁定 F）：warn-only → A 类 fail-loud。restart 本身已成功
          // 不回滚；startup prompt 投递失败必须 run 面可见（0.56 send-first 口径：
          // 绝不静默丢掉用户刚发的那句话）——结构化失败事件 + error 级日志。
          const startupError = new AgentError('spawn_failed', errorText(error), {
            cause: error,
            operation: 'session.restart.startup',
            details: this.spawnFailureDetails(record, error),
          });
          this.logger.error('agent.restart.startup_failed', {
            agent_id: record.id,
            session_id: sessionId,
            error_id: startupError.errorId,
            code: 'spawn_failed',
            error: errorText(error),
          });
          this.emitForSession('agent.restart.startup_failed', record, sessionId, {
            error: errorText(error),
            error_id: startupError.errorId,
            code: 'spawn_failed',
            operation: 'session.restart.startup',
          });
        }
      }
      return { agent_id: record.id, session_id: sessionId, from_epoch: oldEpoch, epoch };
    } catch (error) {
      try {
        const newEntry = this.findEntry(record.id, sessionId);
        if (newEntry !== undefined) await this.disposeEntry(newEntry);
        await this.releasePendingBindingLease(sessionId);
        this.registry.removeBinding(record.id, sessionId);
        const restoredBody: BindingRecord = { ...oldBinding, retiredAt: undefined };
        this.registry.addBinding(record.id, restoredBody);
        const restoredEntry = await this.entryFor(record, restoredBody);
        await this.ensureRuntime(restoredEntry);
        await this.runtime.ensureSessionLease?.(sessionId, oldToken + 1);
        this.registry.setPrimaryBinding(record.id, sessionId);
        this.runtime.enableInbox?.(sessionId);
        this.scheduleSnapshot();
      } catch (rollbackError) {
        this.logger.error('agent.restart.rollback_failed', {
          agent_id: record.id,
          session_id: sessionId,
          error: errorText(rollbackError),
        });
        throw new AgentError('spawn_failed', errorText(rollbackError), {
          cause: rollbackError,
          operation: 'session.restart.rollback',
          details: this.spawnFailureDetails(record, rollbackError),
        });
      }
      throw new AgentError('spawn_failed', errorText(error), {
        cause: error,
        operation: 'session.restart',
        details: this.spawnFailureDetails(record, error),
      });
    } finally {
      this.rotations.delete(record.id);
      const current = this.registry.get(record.id);
      if (current?.rotation === 'rotating') this.registry.setRotation(record.id, 'stable');
    }
  }

  /**
   * `sessions.activate`（CREATE-0.39）：把 `bindingHistory` 中的 session 切回 primary。
   *
   * epoch = 当前 primary epoch + 1（不是目标旧 epoch + 1）；目标 transcript 不变；
   * 原 primary 退役进 history。目标已是 primary → `noop: true`。
   */
  async activateSession(input: SessionActivateInput): Promise<SessionActivateResult> {
    await this.ready;
    const raw = input as unknown as Record<string, unknown>;
    const sessionId = readRequiredString(raw, 'session_id');
    const hit = this.findSessionAnyState(sessionId);
    if (hit === undefined) {
      throw new AgentError('unknown_member', `session_not_found: ${sessionId}`);
    }
    const record = hit.record;
    if (
      record.membership === 'left' ||
      record.state === 'closed' ||
      this.hasClosingExecutionUnit(record.id)
    ) {
      throw new AgentError('member_closed', `agent_closed: ${record.id}`);
    }
    const current = primaryBinding(record);
    if (current?.bindingId === sessionId) {
      return {
        agent_id: record.id,
        session_id: sessionId,
        previous_session_id: sessionId,
        epoch: current.epoch,
        noop: true,
      };
    }
    if (hit.state !== 'history') {
      // retiringBinding 只在内部事务窗口；不作为外部可激活目标。
      throw new AgentError('conflict', `not_primary: ${sessionId}`);
    }
    if (current === undefined) {
      throw new AgentError('conflict', `not_primary: ${sessionId}`);
    }
    if (this.rotations.has(record.id) || record.rotation === 'rotating') {
      throw new AgentError('conflict', 'rotating');
    }
    const targetPending = this.pendingRunId(this.findEntry(record.id, sessionId));
    if (targetPending !== undefined) {
      throw new AgentError('conflict', `run_in_progress: ${targetPending}`);
    }

    const oldSessionId = current.bindingId;
    const oldEpoch = current.epoch;
    const newEpoch = oldEpoch + 1;
    const oldToken = this.runtime.sessionLeaseToken?.(oldSessionId) ?? 0;
    const oldEntry = this.findEntry(record.id, oldSessionId);
    const pendingRun = this.pendingRunId(oldEntry);
    if (pendingRun !== undefined) {
      throw new AgentError('conflict', `run_in_progress: ${pendingRun}`);
    }

    this.registry.setRotation(record.id, 'rotating');
    this.rotations.set(record.id, {
      fromSessionId: oldSessionId,
      fromEpoch: oldEpoch,
      toSessionId: sessionId,
      toEpoch: newEpoch,
    });

    try {
      await this.retireResidualBinding(record);
      this.runtime.disableInbox?.(oldSessionId);
      if (oldEntry !== undefined) await this.disposeEntry(oldEntry);
      // 目标在 history：`restart: true` 允许同 id 重新入主位。
      const newBinding = await this.createBinding(record, sessionId, {
        epoch: newEpoch,
        primary: true,
        rotation: true,
        restart: true,
      });
      const newEntry = await this.entryFor(record, newBinding);
      await this.ensureRuntime(newEntry);
      await this.runtime.ensureSessionLease?.(sessionId, oldToken + 1);
      this.registry.setPrimaryBinding(record.id, sessionId);
      // 目标现在 live，从 history 移除；原 primary 退役进 history。
      this.registry.setBindingHistory(
        record.id,
        record.bindingHistory.filter((entry) => entry.session_id !== sessionId),
      );
      this.registry.retireBinding(record.id, oldSessionId);
      this.registry.setPrimaryBinding(record.id, sessionId);
      // D2/I4：旧 primary body 的在途队列转为可注入；目标 body 自己的 hold 保持不动。
      this.inbox?.releaseHeldFor(record.id, oldSessionId);
      this.runtime.clearPendingNotices?.(record.id);
      this.scheduleSnapshot();

      this.emitForSession('agent.session.activated', record, sessionId, {
        from: oldSessionId,
        to: sessionId,
        previous_session_id: oldSessionId,
        epoch: newEpoch,
      });
      await this.appendSessionEvent(sessionId, 'session.activated', {
        agent_id: record.id,
        session_id: sessionId,
        previous_session_id: oldSessionId,
        epoch: newEpoch,
      }).catch((error: unknown) => {
        this.logger.warn('agent.session.activated_failed', {
          agent_id: record.id,
          session_id: sessionId,
          error: errorText(error),
        });
      });

      const startupPrompt =
        raw.startup_prompt === undefined ? undefined : readContent(raw, 'startup_prompt');
      if (startupPrompt !== undefined) {
        try {
          await this.admitInternal(
            {
              content: startupPrompt,
              agent_id: record.id,
              session_id: sessionId,
              from: SYSTEM_PRINCIPAL,
              channel: 'direct',
              conversation_id: generateConversationId(this.newId),
              strict: false,
            },
            { startup: true },
          );
        } catch (error) {
          this.logger.warn('agent.session_activate.startup_failed', {
            agent_id: record.id,
            error: errorText(error),
          });
        }
      }

      this.updateAgentState(record.id);
      return {
        agent_id: record.id,
        session_id: sessionId,
        previous_session_id: oldSessionId,
        epoch: newEpoch,
        noop: false,
      };
    } catch (error) {
      try {
        const newEntry = this.findEntry(record.id, sessionId);
        if (newEntry !== undefined) await this.disposeEntry(newEntry);
        await this.releasePendingBindingLease(sessionId);
        this.registry.removeBinding(record.id, sessionId);
        const restored = record.binding;
        if (restored !== undefined) {
          this.registry.setPrimaryBinding(record.id, restored.bindingId);
          const restoredEntry = await this.entryFor(record, restored);
          await this.ensureRuntime(restoredEntry);
          await this.runtime.ensureSessionLease?.(restored.bindingId, oldToken + 1);
        }
        this.runtime.enableInbox?.(oldSessionId);
        this.scheduleSnapshot();
      } catch (rollbackError) {
        this.logger.error('agent.activate.rollback_failed', {
          agent_id: record.id,
          session_id: sessionId,
          error: errorText(rollbackError),
        });
        throw new AgentError('spawn_failed', errorText(rollbackError), {
          cause: rollbackError,
          operation: 'session.activate.rollback',
          details: this.spawnFailureDetails(record, rollbackError),
        });
      }
      throw new AgentError('spawn_failed', errorText(error), {
        cause: error,
        operation: 'session.activate',
        details: this.spawnFailureDetails(record, error),
      });
    } finally {
      this.rotations.delete(record.id);
      const currentRecord = this.registry.get(record.id);
      if (currentRecord?.rotation === 'rotating') {
        this.registry.setRotation(record.id, 'stable');
      }
    }
  }

  // ─── detach ────────────────────────────────────────────────────

  private async retireResidualBinding(record: MemberRecord): Promise<void> {
    const residual = record.retiringBinding;
    if (residual === undefined || residual.retiredAt !== undefined) return;
    if (record.rotation === 'rotating') return;
    const entry = this.findEntry(record.id, residual.bindingId);
    if (entry !== undefined) await this.disposeEntry(entry);
    this.registry.retireBinding(record.id, residual.bindingId);
  }

  async detachSession(sessionId: string): Promise<void> {
    await this.ready;
    const record = this.registry.getBySession(sessionId);
    if (record === undefined) {
      // 已退役但仍留在内存里的旧 entry：同样释放租约，避免 delete 后租约泄漏。
      for (const [agentId, entries] of this.executionUnitRegistry) {
        const entry = entries.get(sessionId);
        if (entry === undefined) continue;
        if (entry.active !== undefined) {
          throw new AgentError('conflict', `session_busy: ${sessionId}`);
        }
        await this.disposeEntry(entry);
        this.updateAgentState(agentId);
      }
      return;
    }
    const entry = this.findEntry(record.id, sessionId);
    if (entry?.spawning !== undefined) await entry.spawning.catch(() => {});
    if (entry?.active !== undefined) {
      throw new AgentError('conflict', `session_busy: ${sessionId}`);
    }
    if (entry !== undefined) {
      await this.retireExecutionUnitEntry(record, entry, 'session_deleted');
    } else {
      this.registry.retireBinding(record.id, sessionId);
      this.promotePrimary(record);
    }
    this.scheduleSnapshot();
    this.updateAgentState(record.id);
  }

  async close(input: CloseInput): Promise<CloseResult>;
  async close(input: CloseBatchInput): Promise<BatchResult<CloseResult>>;
  async close(
    input: CloseInput | CloseBatchInput,
  ): Promise<CloseResult | BatchResult<CloseResult>> {
    await this.ready;
    const record = input as unknown as Record<string, unknown>;
    if ('members' in record) {
      if (record.member !== undefined || record.to !== undefined) {
        throw new AgentError('invalid_input', 'pass either member or members, not both');
      }
      const members = record.members;
      if (!Array.isArray(members)) {
        throw new AgentError('invalid_input', 'members must be an array');
      }
      if (members.length === 0) {
        throw new AgentError('invalid_input', 'members must not be empty');
      }
      const settled = await Promise.allSettled(
        members.map((entry) =>
          nonEmpty(entry)
            ? this.closeOne(entry)
            : Promise.reject(
                new AgentError('invalid_input', 'members entries must be non-empty strings'),
              ),
        ),
      );
      return settleBatch(settled);
    }
    const ref = nonEmpty(record.member) ? record.member : record.to;
    if (!nonEmpty(ref)) {
      throw new AgentError('invalid_input', 'close requires member');
    }
    return this.closeOne(ref);
  }

  private async closeOne(ref: string): Promise<CloseResult> {
    const member = this.requireMember(ref);
    if (member.membership === 'left' || member.state === 'closed') return { state: 'closed' };

    await this.disposeAgentBodies(member);
    this.registry.setState(member.id, 'closed');
    member.membership = 'left';
    this.registry.setPresence(member.id, 'gone');
    // 0.53：释放时刻 / 原因落盘（additive）。历史视图靠它排序，否则释放后只剩
    // `state='closed'`，既不知道什么时候没的，也不知道是显式 close 还是被回收。
    member.closedAt = this.now();
    member.closeReason = CLOSE_REASON_CLOSED;
    this.emit('agent.closed', member, { state: 'closed', presence: 'gone' });
    // close 是确定性的「停了」：不用窗口判定，但必须先掉尚未发出的终态通知（否则
    // 同一成员会先报 stopped 再报 closed）。
    this.cancelPeerStopTimer(member.id);
    const closedNotice = this.peerStopChangeFor(member, 'closed', undefined);
    if (closedNotice !== undefined) this.publishPeerStop(closedNotice);
    this.scheduleSnapshot();

    // owner close 后 private contractor 会对所有人不可见：按 registry 原始记录级联关闭。
    const privateChildren = this.registry
      .all()
      .filter(
        (record) =>
          record.membership === 'present' &&
          record.role === 'temporary' &&
          record.visibility === 'private' &&
          record.owner === member.id &&
          record.id !== member.id,
      );
    for (const child of privateChildren) {
      try {
        await this.closeOne(child.id);
      } catch (error) {
        this.logger.warn('agent.cascade_close.failed', {
          owner_id: member.id,
          agent_id: child.id,
          error: errorText(error),
        });
      }
    }

    await this.flushSnapshot();
    return { state: 'closed' };
  }

  // ─── life-cycle / update / list ────────────────────────────────

  async update(input: AgentUpdateInput): Promise<AgentUpdateResult>;
  async update(input: AgentUpdateBatchInput): Promise<BatchResult<AgentUpdateResult>>;
  async update(
    input: AgentUpdateInput | AgentUpdateBatchInput,
  ): Promise<AgentUpdateResult | BatchResult<AgentUpdateResult>> {
    await this.ready;
    const record = input as unknown as Record<string, unknown>;
    if ('updates' in record) {
      if (record.id !== undefined || record.to !== undefined) {
        throw new AgentError('invalid_input', 'pass either update fields or updates, not both');
      }
      const updates = record.updates;
      if (!Array.isArray(updates)) {
        throw new AgentError('invalid_input', 'updates must be an array');
      }
      if (updates.length === 0) {
        throw new AgentError('invalid_input', 'updates must not be empty');
      }
      const settled = await Promise.allSettled(
        updates.map((entry) =>
          isRecord(entry)
            ? this.updateOne(entry)
            : Promise.reject(new AgentError('invalid_input', 'updates entries must be objects')),
        ),
      );
      return settleBatch(settled);
    }
    return this.updateOne(record);
  }

  private async updateOne(record: Record<string, unknown>): Promise<AgentUpdateResult> {
    const ref = nonEmpty(record.id) ? record.id : nonEmpty(record.to) ? record.to : undefined;
    if (ref === undefined) {
      throw new AgentError('invalid_input', 'update requires id or to');
    }
    const target = this.resolveUpdateTarget(ref);
    if (target.membership === 'left' || target.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${ref}`);
    }

    const name = readUpdateString(record, 'name');
    const model = readUpdateString(record, 'model');
    const systemPrompt = readUpdateString(record, 'systemPrompt');
    const requestedRole = readUpdateRole(record);
    if (
      name === undefined &&
      model === undefined &&
      systemPrompt === undefined &&
      requestedRole === undefined
    ) {
      throw new AgentError('invalid_input', 'update requires name, model, systemPrompt or role');
    }

    const conversion =
      requestedRole !== undefined && requestedRole !== target.role
        ? this.resolveRoleConversion(target, requestedRole, record)
        : undefined;

    const changed: AgentUpdateField[] = [];
    if (name !== undefined && name !== target.name) {
      // 与 create 同一条形状规则：改名是另一条能把「可寻址」变「不可寻址」的路径。
      assertMemberName(name);
      this.assertNameAvailable(target, name);
      target.name = name;
      changed.push('name');
    }
    if (model !== undefined && model !== target.model) {
      target.model = model;
      changed.push('model');
    }
    if (systemPrompt !== undefined && systemPrompt !== target.systemPrompt) {
      target.systemPrompt = systemPrompt;
      changed.push('system_prompt');
    }

    this.registry.touch(target.id);
    if (changed.length > 0) {
      this.emit('agent.updated', target, { changed });
    }

    if (conversion !== undefined) {
      const previousRole = target.role;
      target.role = conversion.role;
      target.owner = conversion.owner;
      if (conversion.parentId === undefined) delete target.parentId;
      else target.parentId = conversion.parentId;
      this.registry.setTeamId(target.id, conversion.teamId);
      // 0.51：换 Team ⇒ 重算成员 cwd 快照（否则会一直在旧 Team 的目录里跑）
      this.syncMemberCwd(target, conversion.teamId);
      target.visibility = conversion.visibility;

      this.emit('agent.role.changed', target, {
        from: previousRole,
        to: conversion.role,
        owner: conversion.owner,
        ...(conversion.teamId !== undefined ? { team_id: conversion.teamId } : {}),
      });
      // 0.28 D6 / R4：**同一具活体**按新身份换策略，不重建 body（契约 §5）。
      // 两条路径共用 `role → policy` 的唯一映射：
      // - 有活体 ⇒ `applyContextPolicy` 立刻翻转开关；
      // - 无活体 ⇒ 返回 0，下一次 spawn 读同一份映射，结果一致。
      const applied = await this.applyContextPolicyToBodies(target);
      this.announceContextPolicy(target, previousRole, applied);
      await this.flushSnapshot();
    } else {
      this.scheduleSnapshot();
    }

    // 0.52：基础信息变了就把真值推进给活体（Self Card 不重建、body 不重建）。放在 role
    // 转换**之后**：转换顺带改 parent / team / 权限档，一次同步就能把这三项一起带上，
    // 下一轮变成一条环境信息；没有活体时是 no-op（下一次 spawn 直接用新记录建卡）。
    if (changed.length > 0 || conversion !== undefined) this.syncSelfCardIdentity(target);

    const affectsNextBinding = changed.includes('model') || changed.includes('system_prompt');
    return {
      agent: this.statusFor(target),
      changed,
      ...(affectsNextBinding ? { applies_to: 'next_body' as const } : {}),
    };
  }

  /**
   * 把转换后的上下文策略应用到该成员的活体（0.28 D6 / R4）。
   *
   * 只给 port 支持时调用；未实现 / 抛错一律按 0 处理 —— 策略轮换失败不得让
   * 身份转换本身失败（转换已经落盘，回滚代价更大）。
   */
  private async applyContextPolicyToBodies(target: MemberRecord): Promise<number> {
    const apply = this.runtime.applyContextPolicy;
    if (apply === undefined) return 0;
    try {
      // 每个活体都发给 `runtimeMember`（`session_id` 是 body；`role` 是转换后的角色）。
      // 单 body 不变量下只有一具，但 rotate 窗口内可能有两具，两具都要跟上。
      let applied = 0;
      for (const entry of this.liveEntries(target.id)) {
        const runtimeMember: MemberExecutionMember = {
          ...entry.runtimeMember,
          role: target.role,
        };
        // 同步条目缓存的身份：`entry.runtimeMember` 是 spawn 时的快照，转换后已过期。
        // 不同步它，之后 dispose / 重 spawn / 任何按活体身份读 role 的路径都会看到旧
        // 角色 —— 比「策略没换」更难发现的静默不一致。
        entry.runtimeMember = runtimeMember;
        applied += (await apply.call(this.runtime, runtimeMember)) ?? 0;
      }
      return applied;
    } catch (error) {
      this.logger.warn('agent.context_policy.apply_failed', {
        member_id: target.id,
        role: target.role,
        error: errorText(error),
      });
      return 0;
    }
  }

  /**
   * 基础信息变更 → 活体「真值盒」（0.52）。
   *
   * 为什么只推进真值、不动别处：Self Card 是构造期只读快照（system 前缀的一部分），
   * `agents.update` 改不了模型看到的那张卡；而模型「我是谁 / 用哪个 model」只能从卡里读。
   * 于是把这件事实交给 body 自己：下一轮 BeforeLlm 的 `self-card-delta` hook 会 diff
   * 「模型相信的值」与这里的真值，变了就注入一条 `vessel:notice` 环境信息，字段没变 /
   * 同一变更都不再报。不重建 body、不热替换 system、不动 cwd 与工具面。
   *
   * 只发给 `liveEntries`：没有活体时下一次 spawn 用新记录重新建卡，本来就不需要告知。
   * 单个 body 失败不影响其它 body，也不让 update 本身失败（身份已经落盘，回滚更贵）。
   */
  private syncSelfCardIdentity(target: MemberRecord): void {
    const note = this.runtime.noteSelfCardIdentity;
    if (note === undefined) return;
    for (const entry of this.liveEntries(target.id)) {
      try {
        note.call(this.runtime, { ...toRuntimeMember(target), session_id: entry.bindingId });
      } catch (error) {
        this.logger.warn('agent.self_card.sync_failed', {
          member_id: target.id,
          session_id: entry.bindingId,
          error: errorText(error),
        });
      }
    }
  }

  /**
   * 身份转换后的上下文策略告知（0.28 R4）。
   *
   * 转换后活体上的策略（自动压缩开关 + 压力提示尾句）已经就位，这里只把结果
   * 显式说给模型：哪条策略、从下一轮起对**这具 body** 生效。不再需要「忽略旧
   * 压力文案」的补丁式说明 —— 文案本身已随转换热替换。
   */
  private announceContextPolicy(
    target: MemberRecord,
    previousRole: AgentRole,
    applied: number,
  ): void {
    const compress = target.role === 'member';
    const live =
      applied > 0
        ? 'This body now follows it from the next turn, including the pressure warning wording'
        : 'It applies from the next body';
    this.runtime.notice?.(
      target.id,
      `[runtime] identity changed: ${previousRole} → ${target.role}; owner=${target.owner}; ` +
        `team=${target.teamId ?? 'none'}. Context policy: automatic compaction is ` +
        `${compress ? 'on' : 'off'}. ${live}.`,
    );
  }

  /**
   * 角色转换目标状态（不写记录）：
   * - member：Team 必需（显式或已有），owner=self，清 parent，team 可见；
   * - temporary：owner / parent = 转换者 `from`，Team 显式或沿用，有 Team 则 team 可见。
   */
  private resolveRoleConversion(
    target: MemberRecord,
    role: AgentRole,
    record: Record<string, unknown>,
  ): {
    role: AgentRole;
    owner: string;
    parentId?: string;
    teamId?: string;
    visibility: MemberVisibility;
  } {
    const from =
      record.from === undefined ? DEFAULT_MESSAGE_SENDER : readRequiredString(record, 'from');
    const explicitTeamId =
      record.teamId === undefined ? undefined : readRequiredString(record, 'teamId');
    if (explicitTeamId !== undefined) {
      if (this.teamBinder === undefined || this.teamBinder.get(explicitTeamId) === undefined) {
        throw new AgentError('invalid_input', `team_not_found: ${explicitTeamId}`);
      }
    }

    if (role === 'member') {
      const teamId = explicitTeamId ?? target.teamId;
      if (teamId === undefined) {
        throw new AgentError('invalid_input', 'member role requires a team');
      }
      return { role, owner: target.id, teamId, visibility: 'team' };
    }
    if (role === 'temporary') {
      const teamId = explicitTeamId ?? target.teamId;
      return {
        role,
        owner: from,
        parentId: from,
        ...(teamId !== undefined ? { teamId } : {}),
        visibility: teamId !== undefined ? 'team' : 'private',
      };
    }
    // AgentRole 只剩两值（0.28）；走到这里说明 role 不是 member / temporary。
    throw new AgentError('invalid_input', `unsupported role conversion: ${role}`);
  }

  /** update 选择器：id / 任一 live ExecutionUnit session 直取；否则唯一当前名字。 */
  private resolveUpdateTarget(ref: string): MemberRecord {
    const direct = this.registry.resolve(ref);
    if (direct !== undefined) return direct;
    const matches = this.registry.findByName(ref);
    if (matches.length === 0) {
      throw new AgentError('unknown_member', `unknown_member: ${ref}`);
    }
    const present = matches.filter((record) => record.membership === 'present');
    const pool = present.length > 0 ? present : matches;
    if (pool.length > 1) {
      const candidates = pool.map((record) => record.id).join(', ');
      throw new AgentError('invalid_input', `ambiguous name: ${ref} candidates: ${candidates}`);
    }
    const [only] = pool;
    if (only === undefined) {
      throw new AgentError('unknown_member', `unknown_member: ${ref}`);
    }
    return only;
  }

  /** 与创建一致：present 成员在 Team 内唯一；unbound 成员在整个 tenant 内唯一。 */
  private assertNameAvailable(target: MemberRecord, name: string): void {
    const duplicate = this.registry
      .findByName(name)
      .some(
        (record) =>
          record.id !== target.id &&
          record.membership === 'present' &&
          (target.teamId === undefined || record.teamId === target.teamId),
      );
    if (duplicate) {
      throw new AgentError('invalid_input', `duplicate member name: ${name}`);
    }
  }

  /**
   * roster add：绑定 Team 并把 `left` / `closed` 恢复为 `present`。
   * 只由 roster 管理调用；不 spawn、不新建 session。
   */
  async reinstate(input: ReinstateInput): Promise<MemberStatus> {
    await this.ready;
    const raw = input as unknown as Record<string, unknown>;
    const to = readRequiredString(raw, 'to');
    const teamId = readRequiredString(raw, 'team_id');
    const from =
      input.from === undefined ? DEFAULT_MESSAGE_SENDER : readRequiredString(raw, 'from');

    const target = this.resolveDispatchTarget(to, from);
    if (target === undefined || !this.registry.canView(target, from)) {
      throw new AgentError('member_not_visible', `member_not_visible: ${to}`);
    }
    if (target.teamId !== undefined && target.teamId !== teamId) {
      throw new AgentError('invalid_input', `already_in_team: ${target.teamId}`);
    }

    const stillPresent = target.membership === 'present' && target.state !== 'closed';
    if (stillPresent && target.teamId === teamId) {
      return this.statusFor(target);
    }

    const team = this.teamBinder?.get(teamId);
    if (team?.spawn_frozen === true) {
      throw new AgentError('team_frozen', `team_frozen: ${teamId}`);
    }
    if (team !== undefined && this.presentTeamCount(teamId) >= this.teamMemberLimit) {
      throw new AgentError('team_full', `team_full: ${teamId}`);
    }

    // member 的可见性由角色决定（team），不能停在 private：绑上 Team 之后仍是
    // private 的 member 是个不可达组合（`create` 从不产出，只有存量迁移会出现），
    // 而 private 只对 owner 可见 —— main 之外的入口会全部 `member_not_visible`。
    if (stillPresent) {
      this.registry.setTeamId(target.id, teamId);
      if (target.role === 'member' && target.visibility === 'private') target.visibility = 'team';
    } else {
      this.registry.setTeamId(target.id, teamId);
      this.registry.setMembership(target.id, 'present');
      target.state = 'idle';
      this.registry.setPresence(target.id, 'gone');
      // 0.53：复活后不再是「已释放成员」，释放时刻 / 原因必须一起清掉，
      // 否则历史视图会把一个在册成员当历史条目继续展示。
      target.closedAt = undefined;
      target.closeReason = undefined;
      // 复活 = 三件事（CONTRACT §4.2）：membership / state / presence（上面三行）+
      // body 原地 unretire（清 retiredAt、重设 primary）+ 清 bindingHistory 里该 session。
      // 不清 retiredAt 的话后续 admit 会撞 `session is retired`，数据在但接不回去。
      this.registry.unretireBinding(target.id);
      // 刷新计时基准，否则下一个 tick 立刻再回收（判据读的就是这两个字段）。
      const revivedAt = this.now();
      target.lastSeen = revivedAt;
      if (target.binding !== undefined) target.binding.lastActiveAt = revivedAt;
      for (const entry of this.executionUnitRegistry.get(target.id)?.values() ?? []) {
        entry.closing = false;
        entry.retired = false;
        // 复活是原地 unretire：退役现场记录必须一起清，否则这具 body 下一轮收口
        // 会拿旧的 run id 去比对（`classifyRetiredTurn`）。
        entry.retirement = undefined;
        entry.state = 'idle';
        entry.lastActiveAt = revivedAt;
      }
    }

    // 0.51：绑定 / 换 Team 后重算成员 cwd 快照（锚点 Team 不写入）
    this.syncMemberCwd(target, teamId);
    this.emit('agent.rejoined', target, { state: target.state, presence: target.presence });
    // 0.52：加入 / 换 Team 同样是「基础信息变了」（team 行 + 权限档可能一起变），
    // 有活体时按同一条环境信息通道告知；复活路径没有活体，这里自然 no-op。
    this.syncSelfCardIdentity(target);
    this.scheduleSnapshot();
    return this.statusFor(target);
  }

  async list(filter: ListFilter = {}): Promise<MemberStatus[]> {
    await this.ready;
    // 只读：不在 list 里 sweep（隐式回收会改调用方正要读的快照语义）。
    return this.registry.list(filter).map((record) => this.statusFor(record));
  }

  /**
   * 成员树深度（depth-color D1）：parent 链单一事实源，与 `statusFor` 同口径。
   * 供装配层注入执行内核 self-card 的 `depthFor`（卡片颜色与 self-card 同值）；
   * 未知成员 → undefined（消费方回落 host 兜底）。同步只读，spawn 期调用（ready 之后）。
   */
  memberDepth(memberId: string): number | undefined {
    const record = this.registry.get(memberId) ?? this.registry.resolve(memberId);
    return record === undefined ? undefined : this.registry.depthOf(record.id);
  }

  /**
   * 历史视图（0.53）：只读列出已释放成员。
   *
   * 为什么单独立一个方法：`list` 的语义是「谁还在」（roster 只放 present），历史视图是
   * 「谁已经没了」，两者的筛选条件互斥。塞进 `list` 里迟早会被某个入口默认打开，
   * 那等于让已释放成员悄悄回到 roster。
   *
   * 只读铁律（本方法一行都不许破）：不改 `state` / `membership` / `presence`，
   * 不发任何生命周期事件，不 sweep，不 scheduleSnapshot —— 只是把记录读出来投影成视图。
   *
   * 数据来源是成员记录本身（`agents` 快照永不删记录）。`closed_at` / `close_reason` 是
   * 0.53 才落的 additive 字段：旧快照里没有就**不出现**，不补默认值。
   */
  async listReleasedMembers(query: ReleasedMembersQuery = {}): Promise<ReleasedMembersPage> {
    await this.ready;
    const fields = releasedFields(query.fields);
    const limit = releasedLimit(query.limit);
    const released = this.registry
      .all()
      .filter(
        (record) =>
          isReleased(record) &&
          (query.teamId === undefined || record.teamId === query.teamId) &&
          this.registry.canView(record, query.viewer),
      )
      .sort(compareReleased);
    const members = released.slice(0, limit).map((record) => releasedMemberView(record, fields));
    return {
      members,
      limit,
      total: released.length,
      returned: members.length,
      truncated: released.length > members.length,
      fields,
    };
  }

  /** 任一 live body session（或成员 id）→ 状态；退役 ExecutionUnit 不再命中 */
  async identify(sessionId: string): Promise<MemberStatus | undefined> {
    await this.ready;
    if (!nonEmpty(sessionId)) return undefined;
    const record = this.registry.resolve(sessionId);
    return record === undefined ? undefined : this.statusFor(record);
  }

  async reply(memberId: string, content: string): Promise<ReplyResult> {
    await this.ready;
    const text = readContent({ content }, 'content');
    const member = this.requireMember(memberId);
    if (member.membership === 'left' || member.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${memberId}`);
    }
    if (member.presence === 'gone') {
      throw new AgentError('member_stale', `member_stale: ${memberId}`);
    }
    if (!nonEmpty(member.parentId)) {
      throw new AgentError('no_parent', `member has no parent: ${memberId}`);
    }
    const parent = this.requireMember(member.parentId);
    if (parent.membership === 'left' || parent.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${parent.id}`);
    }
    if (parent.presence === 'gone') {
      throw new AgentError('member_stale', `member_stale: ${parent.id}`);
    }

    const activeEntry = this.liveEntries(member.id).find((entry) => entry.active !== undefined);
    const conversationId =
      activeEntry?.active?.conversationId ?? generateConversationId(this.newId);
    const result = await this.admit({
      content: text,
      agent_id: parent.id,
      from: member.id,
      channel: 'direct',
      conversation_id: conversationId,
      strict: true,
    });
    return {
      queued: true,
      message_id: result.message_id ?? result.run_id ?? '',
      to: parent.id,
    };
  }

  /** bridge 执行内核上报的等待/恢复；只接受对应 body 的当前 run */
  notePermissionState(memberId: string, sessionId: string, state: MemberPermissionState): void {
    const entry = this.findEntry(memberId, sessionId);
    if (entry === undefined || entry.retired || entry.closing) return;
    const member = this.registry.get(memberId);
    if (!member || member.state === 'closed' || member.presence === 'gone') return;
    if (entry.active === undefined) return;
    try {
      if (state === 'waiting') {
        if (entry.state !== 'running') return;
        entry.state = 'waiting_permission';
      } else {
        if (entry.state !== 'waiting_permission') return;
        entry.state = 'running';
      }
      this.updateAgentState(memberId);
    } catch (error) {
      this.logger.warn('agent.permission.state_failed', {
        member_id: memberId,
        session_id: sessionId,
        state,
        error: errorText(error),
      });
      return;
    }
    this.scheduleSnapshot();
  }

  /**
   * 成员引擎事件回流。0.32：`agent.limit.warning` 的第二条投递已删除 ——
   * core 已把 `vessel:limit` 注入本轮上下文，service 不再排第二条系统提示。
   * 保留入口只为兼容 runtime 回调（见 `src/agent-service-wiring.ts`）。
   */
  noteMemberEvent(_memberId: string, _sessionId: string, _event: RunEvent): void {
    return;
  }

  /**
   * 0.31：body 上下文水位（0–1），不落盘。
   * 0.52：取数链只有一条 —— 装配层的端口实现直接返回**界面那一份**读数
   * （`context.changed.token_count` = runtime 账本 `ExecutionUnit.currentContextTokens`，
   * 即下一次请求视图的上界估算 × 锚点校正、provider 地板，再 ÷ 窗口上限；0.55 P0 起
   * 不再是窗口 `ContextManager.tokenCount`），见 `src/context-ratio-source.ts`。
   * 这里不再有任何二次估算：两处各算一次，就是「界面 51%、
   * 提示 unknown」这种不一致的来源。
   *
   * 残留的 undefined 只有一种：这具 body 既没收到过该会话的上下文事件、宿主也没有它的
   * 历史读数（即本进程里根本没有这个会话的水位）—— 不是「算不出来」，是「没这个会话」。
   */
  contextRatio(sessionId: string): number | undefined {
    const ratio = this.runtime.contextRatio?.(sessionId);
    return ratio === undefined || !Number.isFinite(ratio) ? undefined : ratio;
  }

  /** 0.31：该 body 的交互请求是否有 bridge 到达人类；无 bridge 时 fail-closed。 */
  canConfirm(sessionId: string): boolean {
    return this.runtime.canConfirm?.(sessionId) === true;
  }

  /**
   * 0.31：工具侧可见事件出口。agent 工具在权限事件流之外没有父流句柄，
   * rotate 的批准 / 拒绝结果经这里与 `agent.*` 事件同一条流发出。
   */
  noteAgentEvent(type: string, sessionId: string, extra: Record<string, unknown> = {}): void {
    const record = this.registry.resolve(sessionId);
    if (record === undefined) return;
    this.emitForSession(type, record, sessionId, extra);
  }

  currentConversation(ref: string): string | undefined {
    // 0.41：TeamService 传调用者 session —— 按 session 精确定位，multi-live 时
    // 不回退到 agent 级（那会把两个 body 的会话串在一起）。post 仍传 agent id。
    const bySession = this.registry.getBySession(ref);
    if (bySession !== undefined) return this.conversationForSession(ref);
    const entries = this.liveEntries(ref);
    const active = entries.find((entry) => entry.active !== undefined);
    return active?.active?.conversationId;
  }

  async budget(input: BudgetStatusInput | BudgetOverrideInput): Promise<BudgetOverview> {
    await this.ready;
    if (!this.budgetPort) {
      throw new AgentError('budget_unavailable', 'budget_unavailable');
    }
    if ('dimension' in input) {
      const result = this.budgetPort.override(input);
      const released = this.budgetPort.release(input.conversation_id);
      this.blockedBudgetEvents.delete(input.conversation_id);
      for (const agentId of released) {
        const entries = this.liveEntries(agentId);
        for (const entry of entries) {
          entry.budgetHold.delete(input.conversation_id);
          this.retryHeldMessages(entry);
        }
      }
      this.publishTeamBudgetEvent(input.team_id, 'team.budget.override', {
        conversation_id: input.conversation_id,
        dimension: input.dimension,
        previous_max: result.previous_max,
        max: result.max,
        by: 'human',
        via: input.via ?? 'api',
      });
      return { action: 'override', team_id: input.team_id, ...result };
    }
    return {
      action: 'status',
      team_id: input.team_id,
      conversations: this.budgetPort.status(input),
    };
  }

  /** override / release 后重新准入 mailbox 里的消息 */
  private retryHeldMessages(entry: ExecutionUnitEntry): void {
    if (entry.pending.length === 0 || entry.retired || entry.closing) return;
    const record = this.registry.get(entry.agentId);
    if (record === undefined) return;
    // I3（审计点 6/6）：整批出队，收口 = 逐条重新 submit；submit 失败必须 unhold，
    // 否则它会永远停在 held+unread（既不重投也读不到），这是 D3 的「预算阻塞」分支。
    const held = entry.pending.splice(0);
    // 已在 scheduler 队列里的消息不得二次提交：`startExecutionUnitRun` 在
    // `ensureRuntime` 期间仍把消息留在 pending（I2/D1），这里必须跳过。
    const inFlight = new Set<string>();
    for (const runId of entry.queuedRuns) {
      const messageId = this.runMessageIds.get(runId);
      if (messageId !== undefined) inFlight.add(messageId);
    }
    void (async () => {
      for (const message of held) {
        if (inFlight.has(message.id)) continue;
        try {
          const submitted = await this.submitMessage(record, entry, message);
          this.runMessageIds.set(submitted.runId, message.id);
        } catch (error) {
          this.inbox?.unhold(record.id, [message.id]);
          this.logger.warn('agent.budget.retry_failed', {
            agent_id: record.id,
            session_id: entry.bindingId,
            error: errorText(error),
          });
        }
      }
    })();
  }

  /** 发送者所属 Team 优先；human / owner 无 Team 时退回目标 Team */
  private resolveOriginTeam(from: string, target: MemberRecord): string | undefined {
    return this.registry.resolve(from)?.teamId ?? target.teamId;
  }

  /**
   * 是否 human principal（直接对话免 conversation budget）。
   *
   * 判据是「这个 principal 有没有在本机登记成成员」：登记了就是 agent（`main` 也是
   * agent），没登记才是人类 / 系统语境。**不按 role 判定** —— `role` 描述的是成员
   * 归属（Team / 雇佣关系），不是「谁在说话」。
   */
  private isHumanPrincipal(id: string): boolean {
    if (isReservedPrincipal(id)) return true;
    if (id.startsWith('federation:')) return false;
    return this.registry.get(id) === undefined;
  }

  /**
   * 准入可见性：只按 sender 自身的可见性判定（private 成员的 owner 语义）。
   *
   * 0.28 删除了 `role === 'single'` 时「人类按 ADMIN_VIEWER 放行 private」这条特例：
   * 它的存在只是因为 `main` 曾是 private single，而人类入口的 `from` 是 `human`
   * 不是 `main`。现在 `main` 是 team 成员，人类新建的 temporary 缺省 owner 就是
   * `human`（`createOne`），所以按 owner 判定即可，不需要身份旁路。
   */
  private canAdmitView(record: MemberRecord, from: string): boolean {
    return this.registry.canView(record, from);
  }

  /** conversation 预算检查 + 通过后的告警收集 */
  private checkDelivery(
    target: MemberRecord,
    from: string,
    conversationId: string,
    teamId?: string,
    originExplicit = false,
    options?: { mode?: 'delivery' | 'read_only' | 'wake'; edge?: 'bump' | 'check' | 'skip' },
  ): BudgetCheckResult {
    if (this.budgetPort === undefined) return { ok: true };
    const resolvedTeamId = teamId ?? this.resolveOriginTeam(from, target);
    const check = this.budgetPort.checkDelivery({
      conversation_id: conversationId,
      ...(resolvedTeamId !== undefined ? { team_id: resolvedTeamId } : {}),
      ...(originExplicit ? { origin_explicit: true } : {}),
      from,
      to: target.id,
      ...(options?.mode !== undefined ? { mode: options.mode } : {}),
      ...(options?.edge !== undefined ? { edge: options.edge } : {}),
    });
    if (check.ok && (options?.mode === undefined || options.mode === 'delivery')) {
      this.emitBudgetWarnings(target, conversationId, 'enqueue', resolvedTeamId);
    }
    return check;
  }

  private emitBudgetWarnings(
    member: MemberRecord,
    conversationId: string,
    phase: 'enqueue' | 'turn_start',
    teamIdOverride?: string,
  ): void {
    const warnings = this.budgetPort?.takeWarnings?.(conversationId) ?? [];
    for (const warning of warnings) {
      const teamId = teamIdOverride ?? warning.team_id ?? member.teamId;
      if (teamId === undefined) continue;
      this.emit('team.budget.warning', member, {
        conversation_id: conversationId,
        team_id: teamId,
        dimension: warning.dimension,
        current: warning.current,
        max: warning.max,
        threshold: warning.threshold,
        phase,
      });
    }
  }

  private emitBudgetBlocked(
    member: MemberRecord,
    check: BudgetBlockedCheck,
    extra: {
      conversation_id: string;
      message_id?: string;
      from?: string;
      to?: string;
      phase: 'enqueue' | 'turn_start';
      teamId?: string;
    },
  ): void {
    const teamId = extra.teamId ?? member.teamId;
    if (teamId === undefined) return;
    this.emit('team.budget.blocked', member, {
      conversation_id: extra.conversation_id,
      team_id: teamId,
      dimension: check.dimension,
      current: check.current,
      max: check.max,
      reason: check.reason,
      phase: extra.phase,
      ...(extra.message_id !== undefined ? { message_id: extra.message_id } : {}),
      ...(extra.from !== undefined ? { from: extra.from } : {}),
      ...(extra.to !== undefined ? { to: extra.to } : {}),
      ...(check.retry_after_ts !== undefined ? { retry_after_ts: check.retry_after_ts } : {}),
    });
  }

  /** 无成员归属的团队级预算事件（override / team-level blocked） */
  private publishTeamBudgetEvent(
    teamId: string,
    type: string,
    data: Record<string, unknown>,
  ): void {
    if (this.eventStream === undefined) return;
    const payload: Record<string, unknown> = { team_id: teamId, ...data, ts: this.now() };
    try {
      this.eventStream.publish({
        type,
        run_id: `team:${teamId}`,
        data: payload,
        ts: payload.ts as number,
      });
    } catch (error) {
      this.logger.warn('agent.event.publish_failed', { team_id: teamId, error: errorText(error) });
    }
  }

  /** 预算 block reason -> 稳定错误码 */
  private budgetCode(
    reason: BudgetBlockReason,
  ): 'budget_exceeded' | 'budget_unavailable' | 'conversation_team_mismatch' {
    return reason === 'budget_unavailable' || reason === 'conversation_team_mismatch'
      ? reason
      : 'budget_exceeded';
  }

  /** 接收侧检查：无预算端口 / 消息无会话时视为可运行 */
  private checkTurnStart(
    member: MemberRecord,
    message: AgentMessage,
    sessionId: string,
  ): BudgetCheckResult {
    const conversationId = message.conversation_id;
    if (this.budgetPort === undefined || conversationId === undefined) return { ok: true };
    return this.budgetPort.canStartTurn({
      conversation_id: conversationId,
      ...(member.teamId !== undefined ? { team_id: member.teamId } : {}),
      agent_id: member.id,
      session_id: sessionId,
      message_id: message.id,
    });
  }

  /**
   * 关闭前中断并等待成员轮收口：此后不再从队列起新轮，只在跑轮结束（或超时）。
   * 不改 registry 状态 / membership；队列里的后续消息随进程退出丢弃。
   */
  async drain(options: AgentDrainOptions = {}): Promise<AgentDrainOutcome> {
    await this.ready;
    this.beginDrain();
    // 关闭窗口里不再发成员停下通知：进程正在收口，父级也读不到。
    for (const agentId of [...this.peerStopTimers.keys()]) this.cancelPeerStopTimer(agentId);
    const active = (): boolean => {
      for (const map of this.executionUnitRegistry.values()) {
        for (const entry of map.values()) {
          if (entry.active !== undefined) return true;
        }
      }
      return false;
    };
    if (!active()) return 'idle';

    for (const map of this.executionUnitRegistry.values()) {
      for (const entry of map.values()) {
        if (entry.active === undefined) continue;
        try {
          this.runtime.cancel(entry.runtimeMember);
        } catch (error) {
          this.logger.warn('agent.drain.cancel_failed', {
            member_id: entry.agentId,
            session_id: entry.bindingId,
            error: errorText(error),
          });
        }
      }
    }

    const timeoutMs = options.timeoutMs ?? 5000;
    const sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = options.now ?? Date.now;
    const deadline = now() + timeoutMs;
    while (active() && now() < deadline) {
      await sleep(25);
    }
    if (active()) {
      this.logger.warn('agent.drain.timeout', {});
      return 'timeout';
    }
    return 'interrupted';
  }

  /**
   * 0.52 S1a：node 优雅退出的**准入 fence**（drain-to-quiesce 第一段，先于 quiesce 等待）。
   *
   * 打开后：
   * - 所有来源的写（人类 runs.start / 直接投递 与 agents.dispatch / agents.send）⇒
   *   只落 durable inbox，返回 deferred(draining)（q-inbox-ux-fix：不再拒绝人类输入 ——
   *   拒绝会让 UI 显示「未发送」且刷新后正文丢失；排队则持久化，node 回来自动重投）。
   *   没有 durable inbox / 启动嘱托 ⇒ 仍抛 node_draining（RPC 侧映射成可重试的
   *   gateway_restarting）；
   * - 队列里不再起新轮（既有 draining 行为，见 submitMessage）。
   *
   * 幂等：重复调用只回报当前状态，不重复做任何事（退出期间连收信号是常态）。
   * 返回 true 表示**本次**真正打开了 fence。
   */
  beginDrain(): boolean {
    if (this.draining) return false;
    this.draining = true;
    return true;
  }

  /** 0.52 S1a：fence 是否已打开（退出序列 / runs.start 闸门用）。 */
  isDraining(): boolean {
    return this.draining;
  }

  /**
   * 0.52 S1a：按会话汇总 durable inbox 里尚未消费的条目 id（unread + held）。
   *
   * 只读列举：不 hold、不推进、不消费、不唤醒任何 body —— 退出路径只有 2s 预算。
   * 没有 durable inbox ⇒ 空 Map（标记里就是空数组，S1c 以 inbox 自身为准）。
   */
  pendingInboxIdsBySession(): Map<string, string[]> {
    const bySession = new Map<string, string[]>();
    if (this.inbox === undefined) return bySession;
    for (const record of this.registry.all()) {
      let listed: { messages: AgentInboxListEntry[] };
      try {
        listed = this.inbox.list(record.id, { includeHeld: true });
      } catch (error) {
        this.logger.warn('agent.drain.inbox_list_failed', {
          agent_id: record.id,
          error: errorText(error),
        });
        continue;
      }
      for (const entry of listed.messages) {
        const sessionId = entry.session_id;
        if (sessionId === undefined) continue;
        const bucket = bySession.get(sessionId);
        if (bucket === undefined) bySession.set(sessionId, [entry.id]);
        else bucket.push(entry.id);
      }
    }
    return bySession;
  }

  async flushSnapshot(): Promise<boolean> {
    await this.ready;
    // 0.32：inbox 写链一并落盘（store 自己记错误，不改变 snapshot 的返回值语义）。
    if (this.inbox !== undefined) await this.inbox.flush();
    if (!this.snapshot) return true;
    return this.snapshot.flush();
  }

  /**
   * auto-gc P1（D3）：从活 registry 摘除已关闭成员并同步落盘。
   *
   * 双保险：只接受 `closed + left`（扫描判据之外再加一道执行期校验）；任一 id 是
   * 活成员整批拒绝（不 partial —— 宁可留，不可错删）。已不存在的 id 幂等跳过。
   * 摘除后 `scheduleSnapshot + flushSnapshot`：快照是整份 registry 重写，不先
   * schedule 就 flush 会因「无待写」空转，摘除落不了盘。closed 成员的 body / EU
   * 清理在 close / reclaim 时已完成，这里只摘记录与残留的退役 EU 表项。
   */
  async removeClosedMembers(ids: readonly string[]): Promise<boolean> {
    await this.ready;
    if (ids.length === 0) return true;
    for (const id of ids) {
      const record = this.registry.get(id);
      if (record === undefined) continue;
      if (record.state !== 'closed' || record.membership !== 'left') return false;
    }
    for (const id of ids) {
      this.registry.remove(id);
      this.executionUnitRegistry.delete(id);
    }
    this.scheduleSnapshot();
    return this.flushSnapshot();
  }

  /** auto-gc P1：在线 prune 的快照事实源（与 scheduleSnapshot 同一份映射）。 */
  snapshotRecords(): PersistedAgentRecord[] {
    return this.registry.all().map(toPersistedRecord);
  }

  /**
   * CONTRACT-hot-apply §4：把权限规则热应用到所有 live ExecutionUnit。
   * 返回成功应用的 ExecutionUnit 数量；port 未实现时返回 0。
   */
  async applyPermissionRules(rules: RuntimePermissionConfig): Promise<number> {
    await this.ready;
    const apply = this.runtime.applyPermissionRules;
    if (typeof apply !== 'function') return 0;
    try {
      const count = await apply.call(this.runtime, rules);
      return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
    } catch (error) {
      this.logger.warn('agent.permission.apply_failed', { error: errorText(error) });
      return 0;
    }
  }

  /**
   * CONTRACT-hot-apply §4：把工具面热刷新到所有 live ExecutionUnit（additive）。
   * 返回成功刷新的 ExecutionUnit 数量；port 未实现时返回 0。刷新失败不得让 tools reload 失败。
   */
  async refreshTools(tools?: readonly ToolDefinition[]): Promise<number> {
    await this.ready;
    const apply = this.runtime.refreshTools;
    if (typeof apply !== 'function') return 0;
    try {
      const count = await apply.call(this.runtime, tools);
      return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
    } catch (error) {
      this.logger.warn('agent.tools.refresh_failed', { error: errorText(error) });
      return 0;
    }
  }

  /**
   * issue-0（additive）：running 成员当前广告的工具名并集（引擎 retain 计算用）。
   * port 未实现时返回空集（老执行内核没有这份实读面，按「无 retain」处理 = 现态）。
   */
  runningToolNames(): Set<string> {
    const read = this.runtime.runningToolNames;
    if (typeof read !== 'function') return new Set();
    return read.call(this.runtime);
  }

  /** issue-0（additive）：挂上轮边界工具刷新回调；port 未实现时 no-op。 */
  setToolsRefreshListener(listener: (() => void) | undefined): void {
    const set = this.runtime.setToolsRefreshListener;
    if (typeof set !== 'function') return;
    set.call(this.runtime, listener);
  }

  subscribe(listener: AgentEventListener): () => void {
    if (typeof listener !== 'function') {
      throw new AgentError('invalid_input', 'listener must be a function');
    }
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  /**
   * 收件箱投递事件的唯一出口：`agent.message.queued` 一条覆盖三种投递模式。
   *
   * `delivery: 'input'` 是唯一会被 body mailbox 接管的投递，只有它带 `state`（入队时成员
   * 状态）；`'wake'` / `'quiet'` 不进队列、不产生 run，**不带 `state`** —— 带上就是自相
   * 矛盾的记录，消费方（TUI / Web）会把「只唤醒 / 只落 inbox」当成一次入队。`to` / `wake`
   * 是旧 `agent.message.notified` 载荷的保留字段，只在 wake 投递上出现。
   *
   * 旧事件名 `agent.message.notified` 不再发布，落盘历史仍按旧名只读可读。
   */
  private emitMessageQueued(
    member: MemberRecord,
    sessionId: string,
    delivery: AgentInboxDelivery,
    payload: {
      message_id: string;
      from: string;
      conversation_id?: string;
      /** 仅 input 投递：本次入队时的成员状态 */
      state?: MemberState;
      /** 仅 wake 投递：收件成员 id / 是否真的排了摘要唤醒（旧 notified 载荷） */
      to?: string;
      wake?: boolean;
    },
  ): void {
    this.emitForSession('agent.message.queued', member, sessionId, { delivery, ...payload });
  }

  /** 发成员事件（默认用 primary ExecutionUnit 的 session）；监听器与 EventStream 异常都隔离 */
  private emit(type: string, member: MemberRecord, extra: AgentEventExtra = {}): void {
    const primary = primaryBinding(member);
    this.emitForSession(type, member, primary?.bindingId ?? member.sessionId, extra);
  }

  /**
   * 指定 ExecutionUnit 的事件出口：body 级事件必须带自己的 session_id；
   * `run_id` 始终是成员 id（run.* 由 runtime / scheduler 发布）。
   */
  /**
   * inbox 状态机变更 → `agent.inbox.changed` 帧（inbox 统一批 §6.2）。
   *
   * store 的 onChange 钩子是唯一来源：append / hold / unhold / release / consume /
   * claim / discard 全覆盖（模型工具 read/delete、RPC recall/claim、调度 hold/release
   * 都经 store 状态机口，一处钩子无遗漏）。`agent.message.queued` 保留不动。
   *
   * 会话归属：条目自带归属优先，缺省回落到成员当前 primary session（emitForSession
   * 恒带 session_id，出站补齐与可见性判定同源）。registry 查不到成员（纯 store /
   * 已删除）⇒ 不发帧，不猜归属。
   */
  private emitInboxChanged(agentId: string, change: AgentInboxChange): void {
    const member = this.registry.get(agentId);
    if (member === undefined) return;
    this.emitForSession(
      'agent.inbox.changed',
      member,
      change.sessionId ?? currentBindingSession(member),
      {
        reason: change.reason,
        message_ids: change.messageIds,
        ...(change.delivery !== undefined ? { delivery: change.delivery } : {}),
      },
    );
  }

  private emitForSession(
    type: string,
    member: MemberRecord,
    sessionId: string,
    extra: AgentEventExtra = {},
  ): void {
    if (this.listeners.size === 0 && this.eventStream === undefined) return;
    const data: Omit<AgentEvent, 'type'> & Record<string, unknown> = {
      agent_id: member.id,
      session_id: sessionId,
      ...(member.parentId !== undefined ? { parent_id: member.parentId } : {}),
      visibility: member.visibility,
      ...(member.name !== undefined ? { name: member.name } : {}),
      ...(member.teamId !== undefined ? { team_id: member.teamId } : {}),
      ...extra,
      ts: this.now(),
    };
    const event = { type, ...data } as AgentEvent;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn('agent.listener.failed', {
          agent_id: member.id,
          error: errorText(error),
        });
      }
    }
    if (this.eventStream) {
      try {
        this.eventStream.publish({
          type,
          run_id: member.id,
          data,
          ts: data.ts,
        });
      } catch (error) {
        this.logger.warn('agent.event.publish_failed', {
          agent_id: member.id,
          error: errorText(error),
        });
      }
    }
  }

  /** 对外状态：叠加 body 运行态 + 树深度（depth-color D1：parent 链服务端真值） */
  private statusFor(record: MemberRecord): MemberStatus {
    const status = { ...toMemberStatus(record), depth: this.registry.depthOf(record.id) };
    const entries = this.liveEntries(record.id);
    if (entries.length === 0) return status;
    return {
      ...status,
      bodies: entries
        .sort((left, right) => Number(right.primary) - Number(left.primary))
        .map(toExecutionUnitStatus),
    };
  }

  private requireAgent(agentId: string): MemberRecord {
    const record = this.registry.get(agentId) ?? this.registry.resolve(agentId);
    if (!record) throw new AgentError('unknown_member', `unknown_member: ${agentId}`);
    return record;
  }

  private requireMember(ref: string): MemberRecord {
    const member = this.registry.resolve(ref);
    if (!member) throw new AgentError('unknown_member', `unknown_member: ${ref}`);
    return member;
  }

  /** 显式 id 先校验；缺省由人类入口生成 `conv_<id>` */
  private resolveConversationId(value: unknown): string {
    if (value === undefined) return generateConversationId(this.newId);
    if (!isValidConversationId(value)) {
      throw new AgentError('invalid_input', 'invalid conversation_id');
    }
    return value;
  }

  /**
   * 0.41：显式 > 调用者 session 继承 > 新建。
   *
   * 继承只按调用者 session 在自己的 ZU entry 上定位 active turn，**绝不回退**
   * agent 级 `currentConversation`（multi-live 时那会把会话串到别的 body）。
   * 跨 team 不继承；无调用者 session（RPC）不继承。
   */
  private resolveConversationForDelivery(
    explicit: unknown,
    originSessionId: string | undefined,
    target: MemberRecord,
  ): string {
    if (explicit !== undefined) return this.resolveConversationId(explicit);
    if (originSessionId !== undefined) {
      const caller = this.registry.getBySession(originSessionId);
      if (caller !== undefined && caller.teamId === target.teamId) {
        const inherited = this.conversationForSession(originSessionId);
        if (inherited !== undefined) return inherited;
      }
    }
    return generateConversationId(this.newId);
  }

  /** 按 session 精确定位当前 turn 的 conversation；不跨 body 回退。 */
  private conversationForSession(sessionId: string): string | undefined {
    const owner = this.registry.getBySession(sessionId);
    if (owner === undefined) return undefined;
    return this.findEntry(owner.id, sessionId)?.active?.conversationId;
  }

  /** 按 session 定位调用者当前 active run；用于同 run edge 去重。 */
  private activeRunIdForSession(sessionId: string): string | undefined {
    const owner = this.registry.getBySession(sessionId);
    if (owner === undefined) return undefined;
    return this.findEntry(owner.id, sessionId)?.active?.runId;
  }

  /**
   * 同一 run 内 `(from,to)` 是否已计过 cycle 边；无 run id 时永远未计（按每条计）。
   *
   * peek 与 record 分离：只有预算检查通过后才真正记账，首次检查失败不占边，
   * 同一 run 再次投递会重新 bump / 检查，不会因为「先记后查」绕过冷却。
   */
  private hasRunCycleEdge(runKey: string | undefined, from: string, to: string): boolean {
    if (runKey === undefined) return false;
    return this.runCycleEdges.get(runKey)?.has(`${from}\u0000${to}`) ?? false;
  }

  /** 记一次同 run cycle 边；`hasRunCycleEdge` 为 false 时调用。 */
  private recordRunCycleEdge(runKey: string | undefined, from: string, to: string): void {
    if (runKey === undefined) return;
    const edgeKey = `${from}\u0000${to}`;
    let edges = this.runCycleEdges.get(runKey);
    if (edges === undefined) {
      edges = new Set();
      this.runCycleEdges.set(runKey, edges);
    }
    edges.add(edgeKey);
  }

  /**
   * 唤醒排程的边计数：同一次 send / messages 批最多 1 次。返回 true 表示本次可 bump。
   */
  private claimWakeEdge(batchKey: string | undefined, from: string, to: string): boolean {
    if (batchKey === undefined) return true;
    const edgeKey = `${from}\u0000${to}`;
    let edges = this.wakeBatchEdges.get(batchKey);
    if (edges === undefined) {
      edges = new Set();
      this.wakeBatchEdges.set(batchKey, edges);
    }
    if (edges.has(edgeKey)) return false;
    edges.add(edgeKey);
    return true;
  }

  /**
   * tool 路径一次 send / messages 调用结束后的 wake 边清理（内部、非 wire）。
   * TeamService.send 只透传 batch_key；同一次调用可能逐条进 dispatch，必须由
   * 调用方在整批 await 完后统一释放，否则 Map 残留。
   */
  releaseWakeBatch(batchKey: string): void {
    this.wakeBatchEdges.delete(batchKey);
  }

  /** 预算失败的稳定错误：带 conversation / dimension / retry_after / 恢复命令。 */
  private budgetFailureError(
    check: Extract<BudgetCheckResult, { ok: false }>,
    conversationId: string,
    teamId: string | undefined,
  ): AgentError {
    const retry =
      check.retry_after_ts !== undefined
        ? `; retry after ${new Date(check.retry_after_ts).toISOString()}`
        : '';
    // 两条修法都给：cycle 越界通常不是单条会话该 override，而是 Team policy 的
    // 阈值不适合当前协作形状（hub-and-spoke 每轮都会重复同一条有向边）。
    const temporary =
      teamId !== undefined
        ? `temporary: vessel team budget override ${teamId} --conversation ` +
          `${conversationId} --dimension ${check.dimension} --max unlimited`
        : 'this conversation has no team; cooldown only';
    const persistent =
      teamId !== undefined && check.dimension === 'cycle'
        ? `; persistent: raise teams[].policy.budget.cycle.maxRepeats for ${teamId} ` +
          `(vessel team update ${teamId} --policy ` +
          `'{"budget":{"cycle":{"maxRepeats":8}}}'; --policy 整体替换 policy)`
        : '';
    const recovery = `; recover — ${temporary}${persistent}`;
    return new AgentError(
      this.budgetCode(check.reason),
      `${check.reason}: ${check.dimension}: conversation ${conversationId}${retry}${recovery}`,
    );
  }

  /**
   * 入队时标注发送者类别（仅用于模型上下文，不参与权限判定）。
   *
   * 判据：固定 runtime 标签（`system` / `ask` / `bash`）归系统语境；其余看「这个
   * principal 是不是本机登记的成员」：登记了就是 agent（`main` 也是 agent），没登记
   * 才是人类 / 系统语境。这里**不看 role** —— 人类的缺省 `from` 是 `human`，与成员
   * 身份彻底分开。
   */
  private messageSource(from: string): AgentMessage['source'] {
    if (from === SYSTEM_PRINCIPAL) return 'system';
    // 固定 runtime 标签（ask 答复 / bash 作业结果）不是「谁说的话」：interrupt 的
    // message_id 分支从 inbox 条目重建消息时 from 就是这些标签，不认它们会因 registry
    // 查无此 id 而误判成 human（模型侧把作业结果标成人类输入）。
    if (from === ASK_ANSWER_INBOX_SOURCE || from === BASH_JOB_INBOX_SOURCE) return 'system';
    if (from.startsWith('federation:')) return 'agent';
    return this.registry.get(from) === undefined ? 'human' : 'agent';
  }

  /**
   * 发送者显示名：只对本机登记成员有值。人类 / 系统 / 联邦地址没有本机成员名，
   * 返回 undefined，渲染时退回短 id。
   */
  private senderName(from: string): string | undefined {
    const record = this.registry.get(from);
    return record === undefined ? undefined : record.name;
  }

  private scheduleSnapshot(): void {
    this.snapshot?.schedule(() => this.registry.all().map(toPersistedRecord));
  }
}

/** 工厂：保持入口层只依赖契约 */
export function createAgentService(options: AgentServiceOptions): AgentService {
  return new AgentServiceImpl(options);
}

/** 读必填字符串；缺失 / 空串抛 invalid_input */
function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (!nonEmpty(value)) {
    throw new AgentError('invalid_input', `${key} must be a non-empty string`);
  }
  return value;
}

/** 缺省 → false；存在但不是布尔 → invalid_input（不静默忽略）。 */
function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new AgentError('invalid_input', `${key} must be a boolean`);
  }
  return value;
}

/** 缺省 → undefined；存在但为空 / 非字符串 → invalid_input（不静默忽略）。 */
function readUpdateString(record: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(record, key) || record[key] === undefined) return undefined;
  return readRequiredString(record, key);
}

/** update 的 role：缺省或合法值；其它值拒绝 */
function readUpdateRole(record: Record<string, unknown>): AgentRole | undefined {
  if (!Object.hasOwn(record, 'role') || record.role === undefined) return undefined;
  return readAgentRole(record, 'role');
}

/** 严格的 role 字面量校验（0.28 只剩 member / temporary） */
function readAgentRole(record: Record<string, unknown>, key: string): AgentRole {
  const value = record[key];
  if (value !== 'member' && value !== 'temporary') {
    throw new AgentError('invalid_input', `${key} must be member or temporary`);
  }
  return value;
}

/** 消息体：非空且不超过上限 */
function readContent(record: Record<string, unknown>, key: string): string {
  const value = readRequiredString(record, key);
  if (Buffer.byteLength(value, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new AgentError('invalid_input', `content exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return nonEmpty(value) ? value : undefined;
}

/**
 * Additive: explicit session title (sessions.create / rotate / agents.create). Trimmed, must be
 * non-empty and at most MAX_SESSION_TITLE_LENGTH chars; nothing is silently
 * truncated, the caller gets invalid_input instead.
 */
function readSessionTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new AgentError('invalid_input', 'title must be a string');
  }
  const title = value.trim();
  if (title === '') {
    throw new AgentError('invalid_input', 'title must not be empty');
  }
  if (Array.from(title).length > MAX_SESSION_TITLE_LENGTH) {
    throw new AgentError('invalid_input', `title exceeds ${MAX_SESSION_TITLE_LENGTH} characters`);
  }
  return title;
}

/** CREATE-0.39：seed 缺省 copy；其它值 invalid_input。 */
function readCreateSeed(value: unknown): CreateSeed | undefined {
  if (value === undefined) return undefined;
  if (value !== 'copy' && value !== 'compact') {
    throw new AgentError('invalid_input', 'seed must be copy or compact');
  }
  return value;
}

/** CREATE-0.39：keep_messages 必须是 non-negative integer。 */
function readKeepMessages(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AgentError('invalid_input', 'keep_messages must be a non-negative integer');
  }
  return value;
}

/** CREATE-0.39：sessions.create 的 mode；缺省 conversation。 */
function readSessionMode(value: unknown): 'conversation' | 'both' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'conversation' && value !== 'both') {
    throw new AgentError('invalid_input', 'mode must be conversation or both');
  }
  return value;
}

/**
 * 0.53 U1（ADR-104）：从 `projection` 参数里取出请求的模式（只读，不校验词表 ——
 * 词表校验在 `declareSessionProjection` 里统一做，这里用于复用分支的幂等判断）。
 */
function requestedProjectionMode(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.mode === 'string') return value.mode;
  return undefined;
}

/**
 * 0.53 U1（ADR-104 §4.6）：投射声明的参数覆盖项。
 *
 * 只做形状校验（必须是对象、三项都是数字）；取值范围与默认值由
 * `declareProjection` / `normalizeProjectionParams` 收口，这里不重复一套口径。
 */
function readProjectionParams(value: unknown): Partial<ProjectionParams> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new AgentError('invalid_input', 'projection.params must be an object');
  }
  const ratio = readProjectionParam(value, 'keepRecentTokenRatio');
  const max = readProjectionParam(value, 'keepRecentMax');
  const volume = readProjectionParam(value, 'volumeRatio');
  return {
    ...(ratio !== undefined ? { keepRecentTokenRatio: ratio } : {}),
    ...(max !== undefined ? { keepRecentMax: max } : {}),
    ...(volume !== undefined ? { volumeRatio: volume } : {}),
  };
}

/** 单个投射参数：必须是数字（范围由 core 的 `normalizeProjectionParams` 判）。 */
function readProjectionParam(
  record: Record<string, unknown>,
  key: 'keepRecentTokenRatio' | 'keepRecentMax' | 'volumeRatio',
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') {
    throw new AgentError('invalid_input', `projection.params.${key} must be a number`);
  }
  return value;
}

/** CREATE-0.39：mode=both 时的文件回滚入口形状；agent 层只校验、不做 git。 */
function readSessionFiles(value: unknown): { ref: string; paths: string[] } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new AgentError('invalid_input', 'files must be an object');
  }
  const ref = readRequiredString(value, 'ref');
  const paths = value.paths;
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some((entry) => typeof entry !== 'string' || entry === '')
  ) {
    throw new AgentError('invalid_input', 'files.paths must be a non-empty string array');
  }
  return { ref, paths: [...(paths as string[])] };
}

/** 旧 session 的运行时提示：name 以 `vessel:` 开头，或 origin 为 runtime.context。 */
function isRuntimeSeedMessage(message: Message): boolean {
  if (message.name?.startsWith('vessel:')) return true;
  return (message as SeedMessage).origin === 'runtime.context';
}

/** 压缩摘要最多保留一条（最后一条）。 */
function keepLastCompactionSummary(messages: Message[]): Message[] {
  let last = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.compaction_summary === true) last = index;
  }
  if (last < 0) return messages;
  return messages.filter((message, index) => message.compaction_summary !== true || index === last);
}

/**
 * 修掉被切片边界切断的 tool 配对：
 * - 去掉没有对应 tool 结果（且在 assistant 之后）的 `tool_calls`；
 * - 去掉没有对应 assistant `tool_calls` 的孤立 `tool` 消息。
 */
function repairCutToolPairs(messages: Message[]): Message[] {
  const resultPositions = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === 'tool' && message.tool_call_id !== undefined) {
      resultPositions.set(message.tool_call_id, index);
    }
  });
  const validCallIds = new Set<string>();
  const repaired = messages.map((message, index) => {
    if (message.role !== 'assistant' || message.tool_calls === undefined) return message;
    const kept = message.tool_calls.filter((call) => {
      const position = resultPositions.get(call.id);
      return position !== undefined && position > index;
    });
    for (const call of kept) validCallIds.add(call.id);
    if (kept.length === message.tool_calls.length) return message;
    if (kept.length === 0) {
      const { tool_calls: _dropped, ...rest } = message;
      return rest as Message;
    }
    return { ...message, tool_calls: kept };
  });
  return repaired.filter(
    (message) =>
      message.role !== 'tool' ||
      (message.tool_call_id !== undefined && validCallIds.has(message.tool_call_id)),
  );
}

/** `vessel:created`：只含来源 / 计数元数据，不含源正文或任务指令。 */
function createdNotice(meta: {
  sourceSessionId: string;
  seed: CreateSeed;
  keepMessages?: number;
  keepProjected: number;
  copiedMessages: number;
  mode?: 'conversation' | 'both';
}): SeedMessage {
  const parts = [
    `created from session ${meta.sourceSessionId}`,
    `seed=${meta.seed}`,
    `keep_messages=${meta.keepMessages ?? 'all'}`,
    `keep_projected=${meta.keepProjected}`,
    `copied_messages=${meta.copiedMessages}`,
  ];
  if (meta.mode !== undefined) parts.push(`mode=${meta.mode}`);
  return {
    role: 'user',
    content: parts.join('; '),
    name: 'vessel:created',
    origin: 'runtime.context',
  };
}
