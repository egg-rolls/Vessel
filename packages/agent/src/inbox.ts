/**
 * 按 agent_id 的持久化收件箱（0.32 切片 A，契约 v2）。
 *
 * 路径：`<dataDir>/inbox/<encodeURIComponent(agentId)>.json`（0.49 T2 根布局），
 * 形状为
 * `{ v: 1, messages: [{ id, ts, source, summary, text, status, consumed_by_session?,
 * session_id?, refs? }] }`。
 *
 * - 每 agent 懒加载；缺失 = 空，损坏 = available=false（只记日志，不覆盖文件，读返回 []）；
 * - 有界：最多 `maxMessages`（缺省 200）条，append / load 时裁掉最旧的（append 腾位置时
 *   两级淘汰：先裁非 human 源，再裁 human 源，见 `evictForWrite`）；
 * - `summary` 在写入时算好（trim、空白折叠、前 160 字），永不调用模型；
 * - 旧文件里多余的 `important` 字段解析时忽略，不迁移、不报错；
 * - `atomicWrite` 0600，单写者串行写链；append 立即入写链（写前日志，不 debounce）；
 * - `hold` 只存在内存（message id → 持有它的 body id），崩溃 / 重启后未读重新可读。
 *
 * **消息状态机（I1–I4，与 `AgentService` 共守）**：
 * `append(unread)` → `hold(被某个 body 的 mailbox 接管)` → `consumed + unhold`
 * （消费口两个，都走同一个 `consume`：`markConsumed` 在消息真正成为一轮 run input 时调用；
 * `claim` 是模型显式认领，见下）。
 * 侧出口只有两个：`unhold`（失败 / 退役 / 预算回退 → 回到 unread）与 `discard`（明确
 * 投递失败 → 移除）。`hold` 记录持有者 bodyId，`releaseHeldFor` 只放一个 body 的队列。
 *
 * 模型侧不再自动注入正文：`createInboxNoticeHook` 只发一条 `vessel:notice` 计数行
 * （无消息 / 计数没变就不发），正文由模型调用 `createInboxTool` 的 `inbox` 工具按需读取
 * （读即消费；`includeHeld:true` 只 peek held 的正文，不消费、不取消投递）。
 *
 * **`claim`（0.51，工具层的第二条消费口）**：`read includeHeld:true` 看过的正文之后还会
 * 作为 run input 再投一遍 —— 同一段内容进两次上下文、还多触发一次 run。所以给模型一个
 * 显式的口子：`inbox { action: 'claim', message_ids }` = 「这几条我已经拿到正文了，从队列
 * 里拿走、别再投给我」，把条目从任何 `unread`（**含 held**）标成 `consumed` + 解 hold，
 * 并立刻落盘（不可逆，没有 unclaim）。下发判定与 `markConsumed` 共用同一个 `consume`，
 * 只是入口不同：一个由「run 真的开始」触发，一个由模型明确要求触发。
 * `list` / `read` 仍是观测，不因为被看就消费。
 *
 * **本层只管状态，拦不住已排程的那次投递**：held 的条目已经排进了 scheduler 的一次 run，
 * 执行侧不看 inbox 状态 ⇒ 只在这里标 consumed，那次 run 照样把它当 run input 投出去。
 * 「拿了就真的不再投」靠 `AgentService.claim` 的前置收口（取消 queued run + 出队），
 * 与本层同一个 `consume` 落状态。`agents.claim` RPC 与 web 条带都走 service 那条路。
 *
 * **投递模式**（`AgentInboxDelivery`，模式属于 inbox 自己，不是入口开关）：
 * `input` = 本体作为下一轮 run input 送达；`wake` = 只唤醒 agent 自己去 read；
 * `quiet` = 只落 inbox，不唤醒也不进 run。状态机（I1–I4）只描述 `input` 那条路。
 *
 * **归属字段 `session_id`（0.53，additive）**：一句话 —— 「这条消息是哪个会话的下一轮
 * 输入」，**只在 `input` 投递上写**（唯一写入点 `AgentService.trackInbox`）。它一箭三雕：
 * 条带按会话过滤、进程重启后知道往哪个 session 重投、展示时可做身份前缀。
 *
 * `wake` / `quiet` 条目**不写** `session_id`：它们本来就不该变成 run input（`quiet` 的
 * 典型场景是「投递失败后只留档给模型 read」），写了会让恢复路径把它们重投一次。
 * 于是「投递意图」被编码进「字段是否存在」，不引入新的 enum / 不新增条目种类。
 * 缺字段 = 归属未知：条带永不显示、恢复永不碰、`session_id` 过滤永不命中（宁可隐藏
 * 也不串台），但 list / read / delete 一切照旧。
 *
 * **`refs`（附件引用，additive）**：只有路径与元信息，随 `input` 投递一并落盘，恢复重投
 * 时带上，附件不丢。旧文件缺该字段照常加载（按「无引用」降级）。
 *
 * @module @vessel-agent/agent
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicWrite,
  type Hook,
  HookType,
  type Logger,
  type Message,
  type MessageRef,
  noopLogger,
  type ToolContext,
  type ToolDefinition,
} from '@vessel-agent/core';
import { normalizeRefs } from './refs.js';
import { HUMAN_PRINCIPAL } from './team-address.js';

export const AGENT_INBOX_VERSION = 1;
export const DEFAULT_MAX_INBOX_MESSAGES = 200;
export const INBOX_READ_DEFAULT_LIMIT = 20;

/** summary 的最大字符数（截断时另加 `…`）。 */
const INBOX_SUMMARY_MAX = 160;

/**
 * inbox 的投递模式（一等概念，0.50 切片）：模式属于 **inbox**，不是某个入口的开关。
 *
 * - `input`（缺省）：消息进 inbox，且**其本体**作为下一轮 run input 送达（同时可被 read）；
 * - `wake`：消息进 inbox，只唤醒 agent 自己去 read —— run input 是固定摘要串，不带正文；
 * - `quiet`：只进 inbox：不唤醒、不作为 run input，等模型自己 read
 *   （自述 `insert` / rotate 窗口 / 投递失败后的恢复）。
 *
 * 只有 `input` 会被 body mailbox 接管（`hold`）并在开始执行时 consumed；
 * `wake` / `quiet` 落盘时不 hold。既有消息被显式升级成 input 投递（urgent 指定
 * `message_id`）时才由 `trackInbox` 接管 —— 模式是**本次投递**的意图，不是消息的永久属性。
 */
export type AgentInboxDelivery = 'input' | 'wake' | 'quiet';

/** 缺省投递模式：消息本体就是下一轮 run input。 */
export const DEFAULT_INBOX_DELIVERY: AgentInboxDelivery = 'input';

/**
 * wire → 投递模式：外部契约里的 `notify: true` 只是 **wake 模式**的别名（0.41 三档），
 * 内部一律用投递模式表达。`notify` 缺省 / false 即 `input`（消息本体作为 run input）。
 */
export function deliveryFromNotify(notify: boolean | undefined): AgentInboxDelivery {
  return notify === true ? 'wake' : 'input';
}

export interface StoredInboxMessage {
  id: string;
  ts: number;
  source: string;
  summary: string;
  text: string;
  status: 'unread' | 'consumed';
  consumed_by_session?: string;
  /**
   * 归属：这条消息是哪个会话（body）的下一轮输入。**只有 `input` 投递会写**（见模块
   * 头注释）。缺省 = 归属未知（老文件 / 非 input 投递）⇒ 条带不显示、恢复不碰。
   */
  session_id?: string;
  /** 附件引用：只有路径 + 元信息，恢复重投时原样带回（不丢附件）。 */
  refs?: MessageRef[];
}

export interface AgentInboxEntryInput {
  id: string;
  ts: number;
  source: string;
  text: string;
  /** 归属会话；**只有 `input` 投递该传**（见模块头的 `session_id` 分界）。 */
  session_id?: string;
  /** 附件引用（可缺省）；写入前按 `normalizeRefs` 再归一一次。 */
  refs?: MessageRef[];
}

export interface AgentInboxListEntry {
  id: string;
  ts: number;
  source: string;
  summary: string;
  /** 当前被某个 body 的 mailbox 持有（尚未成为 run input）；read 需 `includeHeld`。 */
  held: boolean;
  /** 归属会话（只读视图透传，条带 / 恢复据此按会话定位）；缺省 = 归属未知。 */
  session_id?: string;
}

export interface AgentInboxReadSelection {
  /** read：指定 id（按给定顺序返回）；缺省时取最旧的 limit 条。 */
  ids?: readonly string[];
  /** read：未给 ids 时的条数上限，缺省 `INBOX_READ_DEFAULT_LIMIT`。 */
  limit?: number;
  /**
   * read：true 时连 held（已排进某次 run、尚未成为 run input）的消息一起取；
   * 缺省 false，与 `list` 同名同义。held 条目只读出正文，**不消费、不取消投递**。
   */
  includeHeld?: boolean;
}

/** read 的一条结果：正文 + 当前是否仍被某个 body 持有。 */
export interface AgentInboxReadEntry extends StoredInboxMessage {
  /** true：这条还没成为 run input，之后会自动到达；read 它不改变投递。 */
  held: boolean;
}

export interface AgentInboxAppendOptions {
  /**
   * 本次投递的模式（见 `AgentInboxDelivery`）；缺省 `input`。
   *
   * 只影响本次 append 的裁剪策略与调用方的后续动作（要不要 hold / 起 wake run）。
   *
   * **模式本身仍不落盘**，但 0.53 起有一个**受控的部分推翻**：`input` 投递的条目会带
   * `session_id`（归属 + 重启恢复的唯一判据），而 `wake` / `quiet` 条目**不带** —— 于是
   * 「这条消息该不该在重启后被重投成 run input」完全由「有没有 `session_id`」决定，
   * 不需要第二个字段。**不要**给 `wake` / `quiet` 传 `session_id`：那等于把「只留档」的
   * 消息交给启动恢复重新执行一次。
   */
  delivery?: AgentInboxDelivery;
  /**
   * true：先裁 consumed，仍满则返回 `full`（不裁 unread）。缺省按模式派生：
   * `wake` 缺省 true（它不产生 run input，无权驱逐将要送达的 unread），
   * `input` / `quiet` 缺省 false（先裁 consumed，仍满时继续裁最旧 unread）。
   */
  rejectWhenFull?: boolean;
}

export interface AgentInboxAppendResult {
  accepted: boolean;
  reason?: 'unavailable' | 'full';
}

export interface AgentInboxListOptions {
  /** true：messages 同时返回 held 的消息；unread 仍只计可读，pending 计 held ∩ unread。 */
  includeHeld?: boolean;
}

export interface AgentInboxDiscardOptions {
  /** true：只删 unread 且未被持有的消息；held / consumed / 未知 id 进 skipped。 */
  onlyUnheld?: boolean;
}

/**
 * `claim` 的单条跳过原因（与 `discard` 同形，但没有 `held` —— 认领**可以**作用在 held
 * 条目上，它本来就是「已经排进队列、别真的投给我」的那一步）。
 */
export interface AgentInboxClaimSkip {
  id: string;
  /** `not_found`：id 不在库里（含损坏的收件箱）；`consumed`：这条早就被拿走了。 */
  reason: 'not_found' | 'consumed';
}

/**
 * `claim` 的结果：这批正文。
 *
 * `messages` 只含**真的被拿走**的条目（与 `read` 同形，正文在 `text`）；跳过的永远在
 * `skipped` 里，不在 `messages` 里 —— 调用方不需要再按 id 反查一遍谁成谁败。
 *
 * 这里**不带计数**：`unread` / `pending` / `held` 只有一个口径源（`list()`），调用方在
 * 拿完之后读一次即可 —— 两处各算一遍迟早点出「claim 说 3、list 说 2」的账。
 */
export interface AgentInboxClaimResult {
  claimed: string[];
  skipped: AgentInboxClaimSkip[];
  messages: AgentInboxReadEntry[];
}

export interface AgentInboxDiscardSkip {
  id: string;
  reason: 'held' | 'not_found' | 'consumed';
}

export interface AgentInboxDiscardResult {
  deleted: string[];
  skipped: AgentInboxDiscardSkip[];
}

export interface AgentInboxPort {
  /**
   * I1（唯一写入点）：落盘并计算 summary；重复 id 忽略。先裁 consumed，再按 options
   * 决定是否裁 unread。
   *
   * `options.delivery` 是 inbox 的投递模式（缺省 `input`）：`input` 由调用方随后
   * `hold` 并提交成 run input；`wake` / `quiet` 只落盘，等被唤醒的 agent 自己 read。
   *
   * `message.session_id` 是**归属会话**，只有 `input` 投递该传（见模块头的分界）；
   * `message.refs` 是附件引用，随条目落盘以便恢复重投时带上。
   *
   * 写前日志语义：append 先于 scheduler 接管，所以被接管但尚未成为 run input 的消息
   * 一定在库里；`consumed_by_session` 只在 `markConsumed` 时写。
   */
  append(
    agentId: string,
    message: AgentInboxEntryInput,
    options?: AgentInboxAppendOptions,
  ): AgentInboxAppendResult;
  /**
   * I4（held ⊆ 被引用）：标记该消息已被**某个 body 的 mailbox 接管**、尚未成为 run input。
   *
   * `bodyId`（= session id）是持有者身份：`releaseHeldFor` 只释放它自己持有的消息，
   * 多 live body 时不会误放别的 body 在途队列。`held` 只存在内存，崩溃即全部失效 →
   * 未消费消息回到 unread 可读。
   */
  hold(agentId: string, id: string, bodyId: string): void;
  /** 单条解除持有（投递因 rotate/close 失败时保留未读）。 */
  unhold(agentId: string, ids: readonly string[]): void;
  /** rotate / retire / close：只释放**这一个 body** 持有的消息，其队列重新可读。 */
  releaseHeldFor(agentId: string, bodyId: string): void;
  /**
   * unread 且未被持有，按插入顺序；不改状态。`includeHeld:true` 时 messages 同时
   * 包含 held 的消息（正文仍只有 160 字 summary），并返回 `pending`。
   *
   * `unread` / `pending` 由 `counts()` 统一派生，与 read / notice 同一口径：
   * `unread` 只计可读，`pending` 只计 `unread ∩ held`。
   */
  list(
    agentId: string,
    options?: AgentInboxListOptions,
  ): { unread: number; pending: number; messages: AgentInboxListEntry[] };
  /**
   * 取正文。缺省只取 `unread 且未被持有`；`includeHeld:true` 时连 held 一起取。
   *
   * 消费语义（I2）：只有**未被持有**的条目会被标 consumed —— held 的正文已经排进
   * 某次 run，read 不取消投递、不改变它的状态，只在结果里带 `held:true`。
   */
  read(
    agentId: string,
    selection: AgentInboxReadSelection,
    sessionId?: string,
  ): Promise<AgentInboxReadEntry[]>;
  /**
   * 显式认领（「这几条我已经看到正文了，从队列里拿走、别再投给我」）：
   * 任何 `unread`（**包括 held**）→ `consumed` + 解 hold，返回这批正文与新计数。
   *
   * **不可逆**：没有 unclaim。进了 consumed 就不再投递、也不再出现在 list / read 里，
   * 下一次 `append` 裁剪时清掉。**只对已经看到完整正文的条目用** —— 认领一条没读过的
   * 消息 = 主动放弃它。
   *
   * 为什么不是复用 `read`：`read` 是**观测**（顺带消费未被持有的条目，被持有的照旧投递），
   * `claim` 是**明确的「我处理完了」**，必须也能落在 held 上 —— 这正是它存在的理由：
   * `read includeHeld:true` 拿到的正文不该再作为 run input 进一次上下文。
   * 已经 consumed / 找不到的 id 进 `skipped`，不报错。
   *
   * **本方法只改 inbox 状态**：held 条目对应的那次 queued run 仍在 scheduler 里，要真的
   * 「不再投递」必须走 `AgentService.claim`（先取消 queued run 再调这里）。只做模型的
   * 工具面时调用方就是 service，所以工具侧不会漏掉这一步。
   */
  claim(
    agentId: string,
    ids: readonly string[],
    sessionId?: string,
  ): Promise<AgentInboxClaimResult>;
  /**
   * I2（run 侧的消费口）：已排程的 run 真正开始时，把消息标 consumed 并解 hold。
   * 这是「消息成为本轮 run input」的唯一收口；`claim`（模型显式认领）走同一段实现。
   */
  markConsumed(agentId: string, ids: readonly string[], sessionId: string): Promise<void>;
  /** 不做 status / hold 过滤、不改状态（0.32-D 打断按 id 定位）。 */
  findByIds(agentId: string, ids: readonly string[]): StoredInboxMessage[];
  /**
   * 显式投递失败：从队列移除。缺省删除所有命中 id（含 held / consumed）；
   * `onlyUnheld:true` 只删 unread 且未持有的消息，其余进 skipped。
   */
  discard(
    agentId: string,
    ids: readonly string[],
    options?: AgentInboxDiscardOptions,
  ): AgentInboxDiscardResult;
  /** 未消费且未被持有的条数（= `counts().unread`）。 */
  unreadCount(agentId: string): number;
  flush(): Promise<void>;
}

export interface AgentInboxStoreOptions {
  dataDir: string;
  tenantId: string;
  logger?: Logger;
  /** 消息条数上限；缺省 `DEFAULT_MAX_INBOX_MESSAGES`。 */
  maxMessages?: number;
  /**
   * `claim` 的**执行侧前置收口**（装配层注入）；缺省 = 没有执行侧（纯 store）。
   *
   * 为什么由外面注入：只有 service 知道 scheduler / body mailbox 的存在（`held` 的条目
   * 已经排进一次 run，光在 store 里标 consumed 拦不住那次投递）。store 只管状态机，
   * 这一步在 `consume` 之前执行，注入方负责「取消 queued run + 出队」。
   */
  beforeClaim?: (agentId: string, ids: readonly string[]) => Promise<void> | void;
}

interface InboxFile {
  v: 1;
  messages: StoredInboxMessage[];
}

interface AgentInboxState {
  path: string;
  messages: StoredInboxMessage[];
  /**
   * 仅内存：message id → 持有它的 body id（session id）。
   *
   * 记 body 而不是布尔，是为了 `releaseHeldFor(agentId, bodyId)` 能只释放一个 body
   * 的在途队列：多 live body 的成员里，A 退役不得放出 B 还在排队的消息。
   */
  held: Map<string, string>;
  loaded: boolean;
  /** 损坏 / 不可读时为 false：不覆盖文件，读返回 [] */
  available: boolean;
}

export function inboxPath(dataDir: string, _tenantId: string, agentId: string): string {
  // 0.49 T2（C13/R4）：单公司 inbox 位于数据根；只改路径推导，业务语义不变。
  return join(dataDir, 'inbox', `${encodeURIComponent(agentId)}.json`);
}

/** 写入时计算摘要：trim、空白折叠、前 160 字，截断加 `…`。 */
function summaryOf(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length > INBOX_SUMMARY_MAX
    ? `${collapsed.slice(0, INBOX_SUMMARY_MAX)}…`
    : collapsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 加载放宽：`summary` 可缺失（从 text 派生）；0.53 新增的 `session_id` / `refs` 也可缺失
 * （缺失 = 归属未知 / 无引用，老文件照常加载）。其余字段严格；任何类型不符都按损坏处理
 * （不覆盖、不做半新半旧的内存）。未知字段（如旧版 `important`）忽略。
 */
function isStoredInboxMessage(value: unknown): value is StoredInboxMessage {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id === '') return false;
  if (typeof value.ts !== 'number' || !Number.isFinite(value.ts)) return false;
  if (typeof value.source !== 'string') return false;
  if (typeof value.text !== 'string') return false;
  if (value.status !== 'unread' && value.status !== 'consumed') return false;
  if (value.consumed_by_session !== undefined && typeof value.consumed_by_session !== 'string') {
    return false;
  }
  // additive：缺省合法，存在则必须是 string（与其它字段同口径：类型不符按损坏处理）。
  if (value.session_id !== undefined && typeof value.session_id !== 'string') return false;
  // refs 只校验「是数组」，条目形状在 cloneMessage 里过 `normalizeRefs`（逐条丢弃坏条目，
  // 不因为一条坏引用把整个收件箱判成损坏）。
  if (value.refs !== undefined && !Array.isArray(value.refs)) return false;
  if (value.summary !== undefined && typeof value.summary !== 'string') return false;
  return true;
}

function isInboxFile(value: unknown): value is InboxFile {
  if (!isRecord(value)) return false;
  if (value.v !== AGENT_INBOX_VERSION) return false;
  if (!Array.isArray(value.messages)) return false;
  return value.messages.every(isStoredInboxMessage);
}

/** 规范化为内存形状：summary 缺失时派生。 */
function cloneMessage(message: StoredInboxMessage): StoredInboxMessage {
  // refs 逐条归一（写入侧已经归一过；这层只防手改文件带进半成品形状）。
  const refs = message.refs === undefined ? [] : normalizeRefs(message.refs);
  return {
    id: message.id,
    ts: message.ts,
    source: message.source,
    summary: typeof message.summary === 'string' ? message.summary : summaryOf(message.text),
    text: message.text,
    status: message.status,
    ...(message.consumed_by_session !== undefined
      ? { consumed_by_session: message.consumed_by_session }
      : {}),
    ...(message.session_id !== undefined ? { session_id: message.session_id } : {}),
    ...(refs.length > 0 ? { refs } : {}),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentInboxStore implements AgentInboxPort {
  private readonly dataDir: string;
  private readonly tenantId: string;
  private readonly logger: Logger;
  private readonly maxMessages: number;
  private readonly agents = new Map<string, AgentInboxState>();
  /** 见 `AgentInboxStoreOptions.beforeClaim`；缺省 = 没有执行侧可收口。 */
  private readonly beforeClaim?: (agentId: string, ids: readonly string[]) => Promise<void> | void;
  /** 永不 reject 的串行写链（单写者） */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: AgentInboxStoreOptions) {
    if (typeof options.dataDir !== 'string' || options.dataDir === '') {
      throw new Error('AgentInboxStore requires a non-empty dataDir');
    }
    if (typeof options.tenantId !== 'string' || options.tenantId === '') {
      throw new Error('AgentInboxStore requires a non-empty tenantId');
    }
    this.dataDir = options.dataDir;
    this.tenantId = options.tenantId;
    this.logger = options.logger ?? noopLogger;
    // 直接 API 调用也做一次防御：非法上限退回默认值，避免 0 条静默吞掉所有消息。
    const max = options.maxMessages;
    this.maxMessages =
      typeof max === 'number' && Number.isInteger(max) && max > 0
        ? max
        : DEFAULT_MAX_INBOX_MESSAGES;
    this.beforeClaim = options.beforeClaim;
  }

  append(
    agentId: string,
    message: AgentInboxEntryInput,
    options?: AgentInboxAppendOptions,
  ): AgentInboxAppendResult {
    const state = this.stateFor(agentId);
    if (!state.available) return { accepted: false, reason: 'unavailable' };
    // 投递模式：只有 input 会被随后的 hold / submit 变成 run input；wake 只唤醒，
    // quiet 连唤醒都没有。模式不落盘，只决定本次写入的裁剪口径。
    const delivery = options?.delivery ?? DEFAULT_INBOX_DELIVERY;
    const rejectWhenFull = options?.rejectWhenFull ?? delivery === 'wake';
    // 所有路径先裁 consumed；consumed 不占 cap。拒绝 / 重复 id 路径也要把裁剪落盘。
    const prunedConsumed = this.pruneConsumed(state);
    // 同一 id 只保留一条（重试 / 重复准入不制造重复消息）；裁剪仍需落盘。
    if (state.messages.some((existing) => existing.id === message.id)) {
      if (prunedConsumed) void this.enqueueWrite(state);
      return { accepted: true };
    }
    if (state.messages.length >= this.maxMessages) {
      if (rejectWhenFull) {
        // 不裁 unread：显式拒绝，调用方返回 inbox_full 而不是静默丢消息。
        if (prunedConsumed) void this.enqueueWrite(state);
        return { accepted: false, reason: 'full' };
      }
      // input / quiet 的既有行为：consumed 裁完仍满时继续裁最旧 —— 0.53 起分两级：
      // 先裁「非 human 源」最旧条目，再裁 human 源。一条人写的待处理输入不该被成员之间
      // 的投递挤掉（`splice` 无差别裁头是最容易踩到这个的地方）。
      this.evictForWrite(state, state.messages.length - this.maxMessages + 1);
    }
    const sessionId = message.session_id;
    const refs = message.refs === undefined ? [] : normalizeRefs(message.refs);
    state.messages.push({
      id: message.id,
      ts: message.ts,
      source: message.source,
      summary: summaryOf(message.text),
      text: message.text,
      status: 'unread',
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      ...(refs.length > 0 ? { refs } : {}),
    });
    this.prune(state);
    void this.enqueueWrite(state);
    return { accepted: true };
  }

  hold(agentId: string, id: string, bodyId: string): void {
    this.stateFor(agentId).held.set(id, bodyId);
  }

  /** I4：只释放 `bodyId` 自己持有的消息；其它 live body 的在途队列不受影响。 */
  releaseHeldFor(agentId: string, bodyId: string): void {
    const state = this.stateFor(agentId);
    for (const [id, owner] of state.held) {
      if (owner === bodyId) state.held.delete(id);
    }
  }

  unhold(agentId: string, ids: readonly string[]): void {
    const state = this.stateFor(agentId);
    for (const id of ids) state.held.delete(id);
  }

  list(
    agentId: string,
    options?: AgentInboxListOptions,
  ): { unread: number; pending: number; messages: AgentInboxListEntry[] } {
    const state = this.stateFor(agentId);
    if (!state.available) return { unread: 0, pending: 0, messages: [] };
    const readable = this.readable(state);
    const includeHeld = options?.includeHeld === true;
    const selected = includeHeld
      ? state.messages.filter((message) => message.status === 'unread')
      : readable;
    const messages = selected.map((message) => ({
      id: message.id,
      ts: message.ts,
      source: message.source,
      summary: message.summary,
      held: state.held.has(message.id),
      // 归属只读透传：条带按会话过滤、启动恢复按会话重投都要它。
      ...(message.session_id !== undefined ? { session_id: message.session_id } : {}),
    }));
    return { ...this.counts(state), messages };
  }

  async read(
    agentId: string,
    selection: AgentInboxReadSelection,
    sessionId?: string,
  ): Promise<AgentInboxReadEntry[]> {
    const state = this.stateFor(agentId);
    if (!state.available) return [];
    // 缺省只取可读；includeHeld 时连 held 一起取（见下面的消费语义）。
    const candidates = this.visible(state, selection.includeHeld === true);
    let picked: StoredInboxMessage[];
    if (selection.ids !== undefined) {
      const byId = new Map(candidates.map((message) => [message.id, message]));
      const seen = new Set<string>();
      picked = [];
      for (const id of selection.ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const message = byId.get(id);
        if (message !== undefined) picked.push(message);
      }
    } else {
      const limit = selection.limit ?? INBOX_READ_DEFAULT_LIMIT;
      picked = limit > 0 ? candidates.slice(0, limit) : [];
    }
    if (picked.length === 0) return [];
    // I2：只消费未被持有的条目。held 的正文已经排进某次 run —— read 不取消投递、
    // 不改变它的状态，否则「读过的正文」与「稍后到达的 run input」会变成两次执行。
    const consumable = picked
      .filter((message) => !state.held.has(message.id))
      .map((message) => message.id);
    if (consumable.length > 0) {
      // 先标 consumed 并落盘，再返回：at-most-once 对工具结果成立。
      await this.consume(agentId, consumable, sessionId);
    }
    return picked.map((message) => ({
      ...cloneMessage(message),
      held: state.held.has(message.id),
    }));
  }

  async markConsumed(agentId: string, ids: readonly string[], sessionId: string): Promise<void> {
    await this.consume(agentId, ids, sessionId);
  }

  /**
   * 显式认领（见 `AgentInboxPort.claim`）：`unread`（含 held）→ `consumed` + 解 hold。
   *
   * 判定与写入都在这一个函数里完成：先按**同一份快照**分出「能拿的」与「跳过的」，再走
   * 现有的 `consume`（唯一消费点的同一套实现：标 consumed、删 hold、入写链），不为认领
   * 另开一条写路径。跳过判定在 consume 之前取快照，所以「本来就是 consumed」与「这条被
   * 自己拿走了」不会混在同一个 reason 里。
   */
  async claim(
    agentId: string,
    ids: readonly string[],
    sessionId?: string,
  ): Promise<AgentInboxClaimResult> {
    const state = this.stateFor(agentId);
    const byId = new Map(state.messages.map((message) => [message.id, message]));
    const claimed: string[] = [];
    const skipped: AgentInboxClaimSkip[] = [];
    for (const id of new Set(ids)) {
      const message = byId.get(id);
      if (message === undefined) {
        skipped.push({ id, reason: 'not_found' });
        continue;
      }
      if (message.status === 'consumed') {
        skipped.push({ id, reason: 'consumed' });
        continue;
      }
      claimed.push(id);
    }
    if (claimed.length > 0) {
      // 执行侧收口必须在标 consumed **之前**：held 的条目已经排进了 scheduler 的一次
      // run，先消费再撤 run 会留一个「消息已不在队列、run 却还在跑」的窗口。
      await this.beforeClaim?.(agentId, claimed);
      // `sessionId` 缺省（`agents.claim` RPC 那条路）= 没有任何 body 把它当 run input
      // 消费过，`consumed_by_session` 就不写：那个字段的含义是「哪具 body 执行的」，
      // 认领不是执行。模型侧工具会传自己的 session（它就是那个想「收下」的 body）。
      await this.consume(agentId, claimed, sessionId);
    }
    return {
      claimed,
      skipped,
      // 正文取自上面那份快照：`consume` 只改 status / 删 hold，不碰 text。
      messages: claimed.map((id) => ({
        ...cloneMessage(byId.get(id) as StoredInboxMessage),
        held: false,
      })),
    };
  }

  findByIds(agentId: string, ids: readonly string[]): StoredInboxMessage[] {
    const state = this.stateFor(agentId);
    if (!state.available) return [];
    const byId = new Map(state.messages.map((message) => [message.id, message]));
    const found: StoredInboxMessage[] = [];
    for (const id of ids) {
      const message = byId.get(id);
      if (message !== undefined) found.push(cloneMessage(message));
    }
    return found;
  }

  discard(
    agentId: string,
    ids: readonly string[],
    options?: AgentInboxDiscardOptions,
  ): AgentInboxDiscardResult {
    const state = this.stateFor(agentId);
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { deleted: [], skipped: [] };
    if (!state.available) {
      return {
        deleted: [],
        skipped: unique.map((id) => ({ id, reason: 'not_found' as const })),
      };
    }
    const wanted = new Set(unique);
    const matched = new Map<string, StoredInboxMessage>();
    for (const message of state.messages) {
      if (wanted.has(message.id)) matched.set(message.id, message);
    }
    const onlyUnheld = options?.onlyUnheld === true;
    const deleted: string[] = [];
    const skipped: AgentInboxDiscardSkip[] = [];
    for (const id of unique) {
      const message = matched.get(id);
      if (message === undefined) {
        skipped.push({ id, reason: 'not_found' });
        continue;
      }
      if (onlyUnheld) {
        if (message.status === 'consumed') {
          skipped.push({ id, reason: 'consumed' });
          continue;
        }
        if (state.held.has(id)) {
          skipped.push({ id, reason: 'held' });
          continue;
        }
      }
      deleted.push(id);
      state.held.delete(id);
    }
    if (deleted.length > 0) {
      const removed = new Set(deleted);
      state.messages = state.messages.filter((message) => !removed.has(message.id));
      void this.enqueueWrite(state);
    }
    return { deleted, skipped };
  }

  unreadCount(agentId: string): number {
    const state = this.stateFor(agentId);
    if (!state.available) return 0;
    return this.counts(state).unread;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * list / read / notice 共用的唯一计数口径（§0.5.6：`pending` 是派生数字，不是第二套状态）。
   *
   * `unread` 只计可读（模型该自己读的），`pending` 只计 `unread ∩ held`（已被某个 body
   * 接管、会自动作为 run input 到达的）。两者互斥且 `unread + pending = unread 总数`。
   */
  private counts(state: AgentInboxState): { unread: number; pending: number } {
    let unread = 0;
    let pending = 0;
    for (const message of state.messages) {
      if (message.status !== 'unread') continue;
      if (state.held.has(message.id)) pending += 1;
      else unread += 1;
    }
    return { unread, pending };
  }

  /** unread 且未被持有，保持插入顺序。 */
  private readable(state: AgentInboxState): StoredInboxMessage[] {
    return state.messages.filter(
      (message) => message.status === 'unread' && !state.held.has(message.id),
    );
  }

  /** unread 全集；`includeHeld` 时连 held 一起（read 的 includeHeld 用它）。 */
  private visible(state: AgentInboxState, includeHeld: boolean): StoredInboxMessage[] {
    if (!includeHeld) return this.readable(state);
    return state.messages.filter((message) => message.status === 'unread');
  }

  private async consume(
    agentId: string,
    ids: readonly string[],
    sessionId?: string,
  ): Promise<void> {
    const state = this.stateFor(agentId);
    if (!state.available) return;
    const wanted = new Set(ids);
    if (wanted.size === 0) return;
    let changed = false;
    for (const message of state.messages) {
      if (!wanted.has(message.id)) continue;
      if (message.status !== 'consumed') changed = true;
      message.status = 'consumed';
      if (sessionId !== undefined) message.consumed_by_session = sessionId;
      state.held.delete(message.id);
    }
    // startup prompt 不在 inbox 里：未知 id 不触发空写。
    if (changed) await this.enqueueWrite(state);
  }

  private stateFor(agentId: string): AgentInboxState {
    let state = this.agents.get(agentId);
    if (state === undefined) {
      state = {
        path: inboxPath(this.dataDir, this.tenantId, agentId),
        messages: [],
        held: new Map(),
        loaded: false,
        available: true,
      };
      this.agents.set(agentId, state);
    }
    if (!state.loaded) this.loadSync(state);
    return state;
  }

  /** 同步懒加载；返回 available */
  private loadSync(state: AgentInboxState): void {
    state.loaded = true;
    let raw: string;
    try {
      raw = readFileSync(state.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      state.available = false;
      this.logger.error('agent.inbox.load_failed', {
        path: state.path,
        error: errorText(error),
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      state.available = false;
      this.logger.error('agent.inbox.corrupt', {
        path: state.path,
        error: errorText(error),
      });
      return;
    }
    if (!isInboxFile(parsed)) {
      state.available = false;
      this.logger.error('agent.inbox.corrupt', { path: state.path });
      return;
    }
    state.messages = parsed.messages.map(cloneMessage);
    this.prune(state);
  }

  /**
   * 有界：保留最新 maxMessages 条。
   *
   * 顺带清掉被裁消息的 hold —— `held` 现在按 body 释放（不再有 agent 级 `clear()`），
   * 残留 id 会永久累积并违反 I4（held 必须仍被某条现存消息引用）。
   */
  private prune(state: AgentInboxState): void {
    if (state.messages.length <= this.maxMessages) return;
    state.messages.splice(0, state.messages.length - this.maxMessages);
    const alive = new Set(state.messages.map((message) => message.id));
    for (const id of state.held.keys()) {
      if (!alive.has(id)) state.held.delete(id);
    }
  }

  /** 所有 append 路径的第一步：先裁 consumed（不占 cap，也不保留 hold）。返回是否有变化。 */
  private pruneConsumed(state: AgentInboxState): boolean {
    if (!state.messages.some((message) => message.status === 'consumed')) return false;
    state.messages = state.messages.filter((message) => {
      if (message.status !== 'consumed') return true;
      state.held.delete(message.id);
      return false;
    });
    return true;
  }

  /**
   * 两级淘汰（0.53）：为「再写一条」腾位置时，**先裁非 human 源的最旧条目，再裁 human 源**。
   *
   * 理由：一条人写的待处理输入（`input` 投递、带 `session_id`、重启后要被执行）不该被
   * 成员之间的投递挤掉。被裁掉的 **human 源**条目记 `agent.inbox.evicted`（warn，带
   * `id` / `session_id` / `ts`）—— 这是用户消息真的丢了，必须能在日志里查到；非 human 源
   * 属常规轮换，不刷日志。**不发事件**（不为纯诊断新增事件类型）。
   */
  private evictForWrite(state: AgentInboxState, count: number): void {
    for (let removed = 0; removed < count; removed += 1) {
      if (state.messages.length === 0) return;
      const victim = state.messages.findIndex((message) => message.source !== HUMAN_PRINCIPAL);
      const index = victim >= 0 ? victim : 0;
      const [dropped] = state.messages.splice(index, 1);
      if (dropped === undefined) return;
      state.held.delete(dropped.id);
      if (dropped.source !== HUMAN_PRINCIPAL) continue;
      this.logger.warn('agent.inbox.evicted', {
        path: state.path,
        id: dropped.id,
        ts: dropped.ts,
        ...(dropped.session_id !== undefined ? { session_id: dropped.session_id } : {}),
      });
    }
  }

  private enqueueWrite(state: AgentInboxState): Promise<void> {
    if (!state.available) return Promise.resolve();
    let data: string;
    try {
      // 序列化在入队时同步完成，避免异步窗口里继续改数组导致半新半旧。
      const file: InboxFile = {
        v: AGENT_INBOX_VERSION,
        messages: state.messages.map(cloneMessage),
      };
      data = JSON.stringify(file);
    } catch (error) {
      this.logger.error('agent.inbox.serialize_failed', {
        path: state.path,
        error: errorText(error),
      });
      return Promise.resolve();
    }
    const run = async (): Promise<void> => {
      try {
        await atomicWrite(state.path, data, { mode: 0o600, ensureDir: true });
      } catch (error) {
        this.logger.error('agent.inbox.write_failed', {
          path: state.path,
          error: errorText(error),
        });
      }
    };
    const task = this.writeChain.then(run, run);
    this.writeChain = task;
    return task;
  }
}

/**
 * notice 的模型可见文本：**只有条数，一行，≤ 60 字符**（不含正文）。
 *
 * 「`unread` 该自己读、`pending` 会自动作为下一轮输入到达（别重发 / 别重做）、用
 * `inbox` 工具 list / read 去看」这套用法已经常驻在 `inbox` 工具的 description 里；
 * 这条尾消息每一轮都在上下文里，只报**计数**，不复述用法（API surface = prompt surface）。
 *
 * `pending` 就是「已被某具 body 接管、会自动作为下一轮 run input 到达」的条数，
 * 与 held 是同一集合（I1–I4：`hold` 只作用于未消费消息），所以不另写 `(N held)`。
 */
function noticeContent(unread: number, pending: number): string {
  if (pending > 0 && unread > 0) return `[inbox] ${pending} pending · ${unread} unread`;
  if (pending > 0) return `[inbox] ${pending} pending`;
  return `[inbox] ${unread} unread`;
}

/**
 * 成员 BeforeLlm notice hook（0.32 v2；0.51 起按计数去重、无消息不注入）。
 *
 * 只发一条 `vessel:notice` 尾消息提示未读条数；**不注入正文、不标 consumed**。
 * 「要不要提示」只看 `(unread, pending, held)` 三个计数：与上次注入时相同就不再注入
 * （旧口径把可读消息 id 也编进签名，于是「消费一条 + 进来一条、计数不变」也会多刷一行）。
 * 三个计数全为 0 时**完全不注入**，不留 `0 unread` 占位。
 */
export function createInboxNoticeHook(options: {
  inbox: AgentInboxPort;
  agentId: string;
  isEnabled?: () => boolean;
  onNotified?: (data: {
    runId: string;
    sessionId?: string;
    unread: number;
    pending: number;
  }) => void;
}): Hook {
  /** 每个 hook（= 每个 body）独立；body 重建时重新开始提示。 */
  // `undefined` = 这具 body 还没注入过（或计数已归零），下次非零计数必注入。
  let lastCounts: string | undefined;
  return {
    name: 'vessel:inbox-notice',
    type: HookType.BeforeLlm,
    async run(ctx): Promise<void> {
      if (options.isEnabled?.() === false) return;
      const { unread, pending, messages } = options.inbox.list(options.agentId, {
        includeHeld: true,
      });
      // held 与 pending 是同集合：`includeHeld:true` 只返回未消费消息，而 `hold` 也只
      // 作用于未消费消息 ⇒ 两者恒等。签名仍按三元组写：哪天 `held` 不再等于「会自动送达」
      // 时不会漏提示，代价只是几个数字的字符串比较。
      let held = 0;
      for (const entry of messages) if (entry.held) held += 1;
      // 一条消息都没有（unread / pending / held 全 0）：不注入，也不留 `0 unread` 占位。
      if (unread === 0 && pending === 0 && held === 0) {
        lastCounts = undefined;
        return;
      }
      const counts = `${unread}:${pending}:${held}`;
      if (counts === lastCounts) return;
      const message: Message = {
        role: 'user',
        name: 'vessel:notice',
        content: noticeContent(unread, pending),
        timestamp: Date.now(),
      };
      ctx.messages = [...(ctx.messages ?? []), message];
      lastCounts = counts;
      try {
        options.onNotified?.({
          runId: ctx.run_id,
          ...(ctx.session_id !== undefined ? { sessionId: ctx.session_id } : {}),
          unread,
          pending,
        });
      } catch {
        // 观测回调不得影响提示；事件链路的错误由调用方自己负责可见性。
      }
    },
  };
}

/** `inbox` 工具的 description（模型按需读取收件箱）。 */
const INBOX_TOOL_DESCRIPTION =
  'inspect messages queued while this agent was busy/rotating. ' +
  'every reply carries three counts: unread = yours to read now, pending = unread messages ' +
  'already held as your next run input(s) (they arrive on their own — do not resend or redo them), ' +
  'held = every message currently held (pending is its unread part; today the two numbers are equal). ' +
  'list returns the three counts + a one-line summary of every unread message, held ones included ' +
  '(summary only, no text). ' +
  'read returns full text and marks what it returns as consumed. it only sees readable messages by ' +
  'default: held (pending) ones are excluded, so read can legitimately return 0 messages while pending ' +
  'is above 0 — pass includeHeld:true to also get their text. reading held messages does NOT cancel ' +
  'their delivery and does NOT mark them consumed, so never act twice on one message. ' +
  'claim takes message_ids whose FULL TEXT you have already seen (peek them with ' +
  'read includeHeld:true first), returns that text and takes them out of the queue for good — ' +
  'pending ones included, their queued run is cancelled. it is irreversible: there is no unclaim, ' +
  'and claimed messages are never delivered and never listed again — so never claim on a summary alone. ' +
  'delete removes unread, non-held messages by id (held/consumed are skipped); ' +
  'insert appends a message to your own inbox; it does not start a run or wake you.';

/**
 * read 里有消息在队列上等着（unread 0 / pending > 0）时的那句提示。
 *
 * 为什么要有这句话：`read` 缺省只看可读（不吐 held 正文，那是调度的不变量 —— held 的正文
 * 已经排进某次 run，再吐一遍就成了「读一次 + 到一次」两次执行）。于是「3 条在等我」与
 * 「read 返回 0 条」可以同时成立，模型看到的 `{"read":0,"messages":[]}` 会被读成「什么都没有」。
 * 计数与提示都是**报告层**，不放松可见范围：要正文仍然得显式给 `includeHeld:true`。
 *
 * 措辞跟工具面其它文案一致（英文、单复数用 `message(s)`、只引模型看得见的字段名）。
 */
function heldOnlyHint(pending: number): string {
  return (
    `${pending} message(s) are already queued as your next input(s) (held), so their text is not in this read. ` +
    'Use read with includeHeld:true to see it. ' +
    'Reading them does not cancel delivery and does not mark them consumed — never act twice on one message.'
  );
}

function invalidInput(message: string): string {
  return JSON.stringify({ error: `invalid_input: ${message}` });
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 成员可见的 `inbox` 工具：`list` 看摘要与 pending，`read` 取原文并消费，
 * `claim` 把**已经看到正文**的条目从队列里拿走（不可逆，held 也能拿），`delete` 删除未持有
 * 的未读，`insert` 给自己追加一条消息。
 *
 * **每个动作都报 `unread` / `pending` / `held` 三个计数**（口径见 `snapshot`）：只报一个数字
 * 会让「3 条在队列里等我」和「read 返回 0 条」看起来互相矛盾 —— 那是同一件事的两面
 * （held 的正文不进 read 的缺省可见范围）。read 报出「0 条可读、held 非空」时再补一句
 * `hint` 说明正文从哪里读；三个计数只改报告，不改可见范围。
 *
 * 只读本地队列，不触达工作区；`checkPermission` 恒 `allow`（deny 模式也注册）。
 * 返回 JSON 字符串；非法参数返回 `{ error: 'invalid_input: ...' }`，不抛错。
 */
export function createInboxTool(options: {
  inbox: AgentInboxPort;
  agentId: string;
}): ToolDefinition {
  /**
   * 三个计数 + 摘要列表的**唯一读取口**（read / list / insert 共用一份，免得三个动作各报
   * 一套数）。一次读盘同时给出计数与列表，不想用列表的动作解构掉即可。
   *
   * `unread` / `pending` 直接取 `inbox.list` 的 `counts()` 口径（与 notice 那条计数行同源）；
   * `held` 在工具层由同一份 `includeHeld:true` 的列表数出来 —— 它多出来的信息只有一个：
   * 「held 里有多少条不是 unread」。今天恒等于 `pending`（`hold` 只作用于未消费消息，
   * 消费即解 hold），但这两个数字在**报告**里分开摆，才会在口径哪天变了时自己露馅，
   * 而不是让模型以为 `pending` 就是全部 held。
   */
  const snapshot = () => {
    const { unread, pending, messages } = options.inbox.list(options.agentId, {
      includeHeld: true,
    });
    let held = 0;
    for (const message of messages) if (message.held) held += 1;
    return { unread, pending, held, messages };
  };

  return {
    name: 'inbox',
    description: INBOX_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'delete', 'claim', 'insert'] },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'read/delete: ids returned by list',
        },
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'claim: ids whose full text you have ALREADY seen (claim is irreversible: they are ' +
            'consumed, never delivered and never listed again)',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'read: max messages when ids omitted (default 20)',
        },
        includeHeld: {
          type: 'boolean',
          description:
            'read only: by default read skips held messages (unread, but already queued as your next ' +
            'input), so it can return 0 messages while pending > 0; set true to also get their text. ' +
            'reading them does not cancel delivery and does not mark them consumed — never act twice ' +
            'on one message. list always includes held entries (summary only) and rejects this flag',
        },
        content: {
          type: 'string',
          description: 'insert: message text (non-empty)',
        },
      },
      required: ['action'],
    },
    async handler(args, ctx: ToolContext): Promise<string> {
      const input = isRecordValue(args) ? args : {};
      const action = input.action;
      if (
        action !== 'list' &&
        action !== 'read' &&
        action !== 'delete' &&
        action !== 'claim' &&
        action !== 'insert'
      ) {
        return invalidInput('action must be "list", "read", "delete", "claim", or "insert"');
      }
      const contentDefined = input.content !== undefined;
      const idsDefined = input.ids !== undefined;
      const messageIdsDefined = input.message_ids !== undefined;
      const limitDefined = input.limit !== undefined;
      const includeHeldDefined = input.includeHeld !== undefined;

      if (action === 'list') {
        if (idsDefined || limitDefined || contentDefined) {
          return invalidInput('list does not accept ids, limit, or content');
        }
        if (messageIdsDefined) return invalidInput('list does not accept message_ids');
        // list 恒含 held（只有摘要）；includeHeld 是 read 的选项，显式传入按非法输入拒绝。
        if (includeHeldDefined) {
          return invalidInput('list always includes held; includeHeld is a read-only option');
        }
        const { unread, pending, held, messages } = snapshot();
        return JSON.stringify({
          unread,
          pending,
          held,
          messages: messages.map((message) => ({
            id: message.id,
            ts: message.ts,
            source: message.source,
            summary: message.summary,
            held: message.held,
          })),
        });
      }

      if (action === 'insert') {
        if (idsDefined) return invalidInput('insert does not accept ids');
        if (messageIdsDefined) return invalidInput('insert does not accept message_ids');
        if (limitDefined) return invalidInput('insert does not accept limit');
        if (includeHeldDefined) return invalidInput('insert does not accept includeHeld');
        if (input.id !== undefined || input.source !== undefined || input.ts !== undefined) {
          return invalidInput('insert does not accept id, source, or ts');
        }
        if (typeof input.content !== 'string' || input.content === '') {
          return invalidInput('insert requires non-empty content');
        }
        const id = randomUUID();
        const ts = Date.now();
        const appended = options.inbox.append(
          options.agentId,
          { id, ts, source: options.agentId, text: input.content },
          // quiet：自述只落自己的 inbox —— 不唤醒、不成为 run input；全满时显式拒绝。
          { delivery: 'quiet', rejectWhenFull: true },
        );
        await options.inbox.flush();
        if (!appended.accepted) {
          return JSON.stringify({
            inserted: false,
            error: appended.reason === 'unavailable' ? 'inbox_unavailable' : 'inbox_full',
          });
        }
        const { unread, pending, held } = snapshot();
        return JSON.stringify({ inserted: true, id, ts, unread, pending, held });
      }

      let ids: readonly string[] | undefined;
      if (idsDefined) {
        if (
          !Array.isArray(input.ids) ||
          !input.ids.every((id): id is string => typeof id === 'string' && id !== '')
        ) {
          return invalidInput('ids must be an array of non-empty strings');
        }
        ids = input.ids;
      }
      let messageIds: readonly string[] | undefined;
      if (messageIdsDefined) {
        if (
          !Array.isArray(input.message_ids) ||
          !input.message_ids.every((id): id is string => typeof id === 'string' && id !== '')
        ) {
          return invalidInput('message_ids must be an array of non-empty strings');
        }
        messageIds = input.message_ids;
      }
      let limit: number | undefined;
      if (limitDefined) {
        if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1) {
          return invalidInput('limit must be a positive integer');
        }
        limit = input.limit;
      }

      if (action === 'claim') {
        // claim 只认 `message_ids`：`ids` 是 read / delete 的形状，两种写法同时存在时
        // 谁都不该猜「以哪个为准」，直接拒绝并把正确字段名说出来。
        if (idsDefined) return invalidInput('claim takes message_ids, not ids');
        if (limitDefined) return invalidInput('claim does not accept limit');
        if (contentDefined) return invalidInput('claim does not accept content');
        if (includeHeldDefined) return invalidInput('claim does not accept includeHeld');
        if (messageIds === undefined || messageIds.length === 0) {
          return invalidInput('claim requires a non-empty message_ids array');
        }
        const result = await options.inbox.claim(options.agentId, messageIds, ctx.session_id);
        // 认领是**不可逆**的写：先落盘再回话。留在写链里就返回等于「嘴上说拿走了，
        // 磁盘上还是 unread」——崩溃 / 重启后它照样会投递一次。
        await options.inbox.flush();
        // 计数与 list 同一个口径源（`snapshot`），且必须在 claim **之后**读：
        // 先数再拿会把刚拿走的那几条还算在 unread / pending 里。
        const { unread, pending, held } = snapshot();
        return JSON.stringify({
          claimed: result.claimed.length,
          // 只有真拿走的才带正文；跳过的只报 id + reason，调用方不必再反查。
          messages: result.messages.map((message) => ({
            id: message.id,
            ts: message.ts,
            source: message.source,
            text: message.text,
          })),
          skipped: result.skipped,
          unread,
          pending,
          held,
        });
      }

      if (action === 'delete') {
        if (limitDefined) return invalidInput('delete does not accept limit');
        if (contentDefined) return invalidInput('delete does not accept content');
        if (messageIdsDefined) return invalidInput('delete takes ids, not message_ids');
        if (includeHeldDefined) return invalidInput('delete does not accept includeHeld');
        if (ids === undefined || ids.length === 0) {
          return invalidInput('delete requires a non-empty ids array');
        }
        const { deleted, skipped } = options.inbox.discard(options.agentId, ids, {
          onlyUnheld: true,
        });
        return JSON.stringify({ deleted: deleted.length, skipped });
      }

      if (contentDefined) return invalidInput('read does not accept content');
      if (messageIdsDefined) return invalidInput('read takes ids, not message_ids');
      let includeHeld: boolean | undefined;
      if (includeHeldDefined) {
        if (typeof input.includeHeld !== 'boolean') {
          return invalidInput('includeHeld must be a boolean');
        }
        includeHeld = input.includeHeld;
      }
      const messages = await options.inbox.read(
        options.agentId,
        {
          ...(ids !== undefined ? { ids } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(includeHeld !== undefined ? { includeHeld } : {}),
        },
        ctx.session_id,
      );
      // 计数必须在 read **之后**读：read 会把它返回的条目标 consumed，先数再读就会把刚读掉
      // 的那些还算在 unread / pending 里，模型看到的是上一秒的世界。
      const { unread, pending, held } = snapshot();
      // 一句话解释「为什么 read 是 0 条」：只有在这次没要 held 正文（没给 includeHeld:true）
      // 而队列里确实有东西在等时才提示 —— 要了正文还提示「去要正文」就是纯噪音。
      const hint =
        unread === 0 && pending > 0 && includeHeld !== true ? heldOnlyHint(pending) : undefined;
      return JSON.stringify({
        read: messages.length,
        unread,
        pending,
        held,
        messages: messages.map((message) => ({
          id: message.id,
          ts: message.ts,
          source: message.source,
          text: message.text,
          // held:true = 还没成为 run input，稍后会自动到达；read 没有取消投递，别重复执行。
          ...(message.held ? { held: true } : {}),
        })),
        ...(hint !== undefined ? { hint } : {}),
      });
    },
    async checkPermission(): Promise<'allow'> {
      return 'allow';
    },
  };
}
