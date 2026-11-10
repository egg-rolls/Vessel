/**
 * 按 agent_id 的持久化收件箱（0.32 切片 A，契约 v2）。
 *
 * 路径：`<dataDir>/inbox/<encodeURIComponent(agentId)>.json`（0.49 T2 根布局），
 * 形状为
 * `{ v: 1, messages: [{ id, ts, source, summary, text, status, consumed_by_session? }] }`。
 *
 * - 每 agent 懒加载；缺失 = 空，损坏 = available=false（只记日志，不覆盖文件，读返回 []）；
 * - 有界：最多 `maxMessages`（缺省 200）条，append / load 时裁掉最旧的；
 * - `summary` 在写入时算好（trim、空白折叠、前 160 字），永不调用模型；
 * - 旧文件里多余的 `important` 字段解析时忽略，不迁移、不报错；
 * - `atomicWrite` 0600，单写者串行写链；append 立即入写链（写前日志，不 debounce）；
 * - `hold` 只存在内存（message id → 持有它的 body id），崩溃 / 重启后未读重新可读。
 *
 * **消息状态机（I1–I4，与 `AgentService` 共守）**：
 * `append(unread)` → `hold(被某个 body 的 mailbox 接管)` → `consumed + unhold`
 * （唯一消费点是 `markConsumed`，在消息真正成为一轮 run input 时调用）。
 * 侧出口只有两个：`unhold`（失败 / 退役 / 预算回退 → 回到 unread）与 `discard`（明确
 * 投递失败 → 移除）。`hold` 记录持有者 bodyId，`releaseHeldFor` 只放一个 body 的队列。
 *
 * 模型侧不再自动注入正文：`createInboxNoticeHook` 只发一条 `vessel:notice`，
 * 正文由模型调用 `createInboxTool` 的 `inbox` 工具按需读取（读即消费；
 * `includeHeld:true` 只 peek held 的正文，不消费、不取消投递）。
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
  noopLogger,
  type ToolContext,
  type ToolDefinition,
} from '@vessel-agent/core';

export const AGENT_INBOX_VERSION = 1;
export const DEFAULT_MAX_INBOX_MESSAGES = 200;
export const INBOX_READ_DEFAULT_LIMIT = 20;

/** summary 的最大字符数（截断时另加 `…`）。 */
const INBOX_SUMMARY_MAX = 160;

export interface StoredInboxMessage {
  id: string;
  ts: number;
  source: string;
  summary: string;
  text: string;
  status: 'unread' | 'consumed';
  consumed_by_session?: string;
}

export interface AgentInboxEntryInput {
  id: string;
  ts: number;
  source: string;
  text: string;
}

export interface AgentInboxListEntry {
  id: string;
  ts: number;
  source: string;
  summary: string;
  /** 当前被某个 body 的 mailbox 持有（尚未成为 run input）；read 需 `includeHeld`。 */
  held: boolean;
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
   * true：先裁 consumed，仍满则返回 `full`（不裁 unread）；insert / notify 用。
   * false（缺省）：先裁 consumed，仍满时继续裁最旧 unread（既有行为）。
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
   * I2（唯一消费点）：已排程的 run 真正开始时，把消息标 consumed 并解 hold。
   * 这是「消息成为本轮 run input」的唯一收口。
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
 * 加载放宽：`summary` 可缺失（从 text 派生），其余字段严格；任何类型不符都按
 * 损坏处理（不覆盖、不做半新半旧的内存）。未知字段（如旧版 `important`）忽略。
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
  }

  append(
    agentId: string,
    message: AgentInboxEntryInput,
    options?: AgentInboxAppendOptions,
  ): AgentInboxAppendResult {
    const state = this.stateFor(agentId);
    if (!state.available) return { accepted: false, reason: 'unavailable' };
    // 所有路径先裁 consumed；consumed 不占 cap。拒绝 / 重复 id 路径也要把裁剪落盘。
    const prunedConsumed = this.pruneConsumed(state);
    // 同一 id 只保留一条（重试 / 重复准入不制造重复消息）；裁剪仍需落盘。
    if (state.messages.some((existing) => existing.id === message.id)) {
      if (prunedConsumed) void this.enqueueWrite(state);
      return { accepted: true };
    }
    if (state.messages.length >= this.maxMessages) {
      if (options?.rejectWhenFull === true) {
        // 不裁 unread：显式拒绝，调用方返回 inbox_full 而不是静默丢消息。
        if (prunedConsumed) void this.enqueueWrite(state);
        return { accepted: false, reason: 'full' };
      }
      // 既有行为：consumed 裁完仍满时继续裁最旧（可能丢 unread）。
      state.messages.splice(0, state.messages.length - this.maxMessages + 1);
    }
    state.messages.push({
      id: message.id,
      ts: message.ts,
      source: message.source,
      summary: summaryOf(message.text),
      text: message.text,
      status: 'unread',
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
 * notice 的模型可见文本（只含条数与工具指引，不含正文）。
 *
 * 两个数字必须解释清楚，否则模型会把 pending 当成「读不到的消息」而重发（见 §1.4）：
 * `unread` 是模型该自己读的，`pending` 是已经排好队、会自动作为下一轮输入送达的。
 */
function noticeContent(unread: number, pending: number): string {
  return (
    `[inbox] ${unread} unread (yours to read), ${pending} pending ` +
    '(already queued as your next input(s) — they arrive on their own; do not resend or redo). ' +
    'inbox action="list" for summaries; action="read" with includeHeld:true to peek at pending ones.'
  );
}

/**
 * 成员 BeforeLlm notice hook（0.32 v2）。
 *
 * 只发一条 `vessel:notice` 尾消息提示未读条数；**不注入正文、不标 consumed**。
 * 按 `unread:pending:可读 id` 签名去重；签名变化（新消息、held 释放等）时再提示一次。
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
  // 按状态签名去重：unread/pending 变化或可读 id 集合变化都要重新提示。
  // held 的 id 只参与 pending 计数，不单独视为“已提示正文”（held → unhold 后要再提示）。
  let lastSignature: string | undefined;
  return {
    name: 'vessel:inbox-notice',
    type: HookType.BeforeLlm,
    async run(ctx): Promise<void> {
      if (options.isEnabled?.() === false) return;
      const { unread, pending, messages } = options.inbox.list(options.agentId, {
        includeHeld: true,
      });
      if (messages.length === 0) {
        lastSignature = undefined;
        return;
      }
      const readableIds = messages
        .filter((entry) => !entry.held)
        .map((entry) => entry.id)
        .join(',');
      const signature = `${unread}:${pending}:${readableIds}`;
      if (signature === lastSignature) return;
      const message: Message = {
        role: 'user',
        name: 'vessel:notice',
        content: noticeContent(unread, pending),
        timestamp: Date.now(),
      };
      ctx.messages = [...(ctx.messages ?? []), message];
      lastSignature = signature;
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
  'inspect messages queued while this agent was busy/rotating; ' +
  'list returns unread/pending counts + summaries (held included); ' +
  'unread = yours to read, pending = already queued as your next input(s), ' +
  'they arrive on their own (do not resend or redo); ' +
  'read returns full text and marks it consumed; read includeHeld:true also returns pending ' +
  'messages — that does NOT cancel their delivery, so never act twice on one message; ' +
  'delete removes unread, non-held messages by id (held/consumed are skipped); ' +
  'insert appends a message to your own inbox; it does not start a run or wake you.';

function invalidInput(message: string): string {
  return JSON.stringify({ error: `invalid_input: ${message}` });
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 成员可见的 `inbox` 工具：`list` 看摘要与 pending，`read` 取原文并消费，
 * `delete` 删除未持有的未读，`insert` 给自己追加一条消息。
 *
 * 只读本地队列，不触达工作区；`checkPermission` 恒 `allow`（deny 模式也注册）。
 * 返回 JSON 字符串；非法参数返回 `{ error: 'invalid_input: ...' }`，不抛错。
 */
export function createInboxTool(options: {
  inbox: AgentInboxPort;
  agentId: string;
}): ToolDefinition {
  return {
    name: 'inbox',
    description: INBOX_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'delete', 'insert'] },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'read/delete: ids returned by list',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'read: max messages when ids omitted (default 20)',
        },
        includeHeld: {
          type: 'boolean',
          description:
            'read: also return held messages (already queued as your next input); ' +
            'reading them does not cancel delivery and does not mark them consumed',
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
      if (action !== 'list' && action !== 'read' && action !== 'delete' && action !== 'insert') {
        return invalidInput('action must be "list", "read", "delete", or "insert"');
      }
      const contentDefined = input.content !== undefined;
      const idsDefined = input.ids !== undefined;
      const limitDefined = input.limit !== undefined;
      const includeHeldDefined = input.includeHeld !== undefined;

      if (action === 'list') {
        if (idsDefined || limitDefined || contentDefined) {
          return invalidInput('list does not accept ids, limit, or content');
        }
        // list 恒含 held（只有摘要）；includeHeld 是 read 的选项，显式传入按非法输入拒绝。
        if (includeHeldDefined) {
          return invalidInput('list always includes held; includeHeld is a read-only option');
        }
        const { unread, pending, messages } = options.inbox.list(options.agentId, {
          includeHeld: true,
        });
        return JSON.stringify({
          unread,
          pending,
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
          { rejectWhenFull: true },
        );
        await options.inbox.flush();
        if (!appended.accepted) {
          return JSON.stringify({
            inserted: false,
            error: appended.reason === 'unavailable' ? 'inbox_unavailable' : 'inbox_full',
          });
        }
        const { unread, pending } = options.inbox.list(options.agentId, { includeHeld: true });
        return JSON.stringify({ inserted: true, id, ts, unread, pending });
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
      let limit: number | undefined;
      if (limitDefined) {
        if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1) {
          return invalidInput('limit must be a positive integer');
        }
        limit = input.limit;
      }

      if (action === 'delete') {
        if (limitDefined) return invalidInput('delete does not accept limit');
        if (contentDefined) return invalidInput('delete does not accept content');
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
      return JSON.stringify({
        read: messages.length,
        messages: messages.map((message) => ({
          id: message.id,
          ts: message.ts,
          source: message.source,
          text: message.text,
          // held:true = 还没成为 run input，稍后会自动到达；read 没有取消投递，别重复执行。
          ...(message.held ? { held: true } : {}),
        })),
      });
    },
    async checkPermission(): Promise<'allow'> {
      return 'allow';
    },
  };
}
