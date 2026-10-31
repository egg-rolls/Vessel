/**
 * 按 agent_id 的持久化收件箱（0.32 切片 A，契约 v2）。
 *
 * 路径：`<dataDir>/tenants/<tenantId>/inbox/<encodeURIComponent(agentId)>.json`，
 * 形状为
 * `{ v: 1, messages: [{ id, ts, source, summary, text, status, consumed_by_session?, important? }] }`。
 *
 * - 每 agent 懒加载；缺失 = 空，损坏 = available=false（只记日志，不覆盖文件，读返回 []）；
 * - 有界：最多 `maxMessages`（缺省 200）条，append / load 时裁掉最旧的；
 * - `summary` 在写入时算好（trim、空白折叠、前 160 字），永不调用模型；
 * - `important` 缺省 false，加载时保留（0.32-D 预留，本切片不生产）；
 * - `atomicWrite` 0600，单写者串行写链；append 立即入写链（写前日志，不 debounce）；
 * - `hold` 只存在内存：pending / 已排程的 run 持有；崩溃 / 重启后未读重新可读。
 *
 * 模型侧不再自动注入正文：`createInboxNoticeHook` 只发一条 `vessel:notice`，
 * 正文由模型调用 `createInboxTool` 的 `inbox` 工具按需读取（读即消费）。
 *
 * @module @vessel-agent/agent
 */

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
  important?: boolean;
}

export interface AgentInboxEntryInput {
  id: string;
  ts: number;
  source: string;
  text: string;
  important?: boolean;
}

export interface AgentInboxListEntry {
  id: string;
  ts: number;
  source: string;
  summary: string;
  important: boolean;
}

export interface AgentInboxReadSelection {
  /** read：指定 id（按给定顺序返回）；缺省时取最旧的 limit 条。 */
  ids?: readonly string[];
  /** read：未给 ids 时的条数上限，缺省 `INBOX_READ_DEFAULT_LIMIT`。 */
  limit?: number;
}

export interface AgentInboxPort {
  /** 落盘并计算 summary；重复 id 忽略。 */
  append(agentId: string, message: AgentInboxEntryInput): void;
  /** 内存态：pending / 已排程的 run 持有，list / read 跳过。 */
  hold(agentId: string, id: string): void;
  /** 单条解除持有（投递因 rotate/close 失败时保留未读）。 */
  unhold(agentId: string, ids: readonly string[]): void;
  /** rotate / retire：旧持有一并释放，旧队列重新可读。 */
  releaseHeld(agentId: string): void;
  /** unread 且未被持有，按插入顺序；不改状态。 */
  list(agentId: string): { unread: number; messages: AgentInboxListEntry[] };
  /**
   * unread 且未被持有；给了 ids 按 ids 顺序，否则取最旧 limit 条；
   * 返回前把取到的消息标 consumed（`consumed_by_session=sessionId`）。
   */
  read(
    agentId: string,
    selection: AgentInboxReadSelection,
    sessionId?: string,
  ): Promise<StoredInboxMessage[]>;
  /** 已排程的 run 真正开始时的消费路径。 */
  markConsumed(agentId: string, ids: readonly string[], sessionId: string): Promise<void>;
  /** 不做 status / hold 过滤、不改状态（0.32-D 打断按 id 定位）。 */
  findByIds(agentId: string, ids: readonly string[]): StoredInboxMessage[];
  /** 显式投递失败：从队列移除。 */
  discard(agentId: string, ids: readonly string[]): void;
  /** 未消费且未被持有的条数。 */
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
  /** 仅内存：被 pending / 已排程 run 持有的消息 id */
  held: Set<string>;
  loaded: boolean;
  /** 损坏 / 不可读时为 false：不覆盖文件，读返回 [] */
  available: boolean;
}

export function inboxPath(dataDir: string, tenantId: string, agentId: string): string {
  return join(dataDir, 'tenants', tenantId, 'inbox', `${encodeURIComponent(agentId)}.json`);
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
 * 加载放宽：`summary` / `important` 可缺失（分别从 text 派生 / 取 false），
 * 其余字段严格；任何类型不符都按损坏处理（不覆盖、不做半新半旧的内存）。
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
  if (value.important !== undefined && typeof value.important !== 'boolean') return false;
  return true;
}

function isInboxFile(value: unknown): value is InboxFile {
  if (!isRecord(value)) return false;
  if (value.v !== AGENT_INBOX_VERSION) return false;
  if (!Array.isArray(value.messages)) return false;
  return value.messages.every(isStoredInboxMessage);
}

/** 规范化为内存形状：summary 缺失时派生，important 缺失时为 false。 */
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
    important: message.important === true,
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

  append(agentId: string, message: AgentInboxEntryInput): void {
    const state = this.stateFor(agentId);
    if (!state.available) return;
    // 同一 id 只保留一条（重试 / 重复准入不制造重复消息）。
    if (state.messages.some((existing) => existing.id === message.id)) return;
    state.messages.push({
      id: message.id,
      ts: message.ts,
      source: message.source,
      summary: summaryOf(message.text),
      text: message.text,
      status: 'unread',
      important: message.important === true,
    });
    this.prune(state);
    void this.enqueueWrite(state);
  }

  hold(agentId: string, id: string): void {
    this.stateFor(agentId).held.add(id);
  }

  releaseHeld(agentId: string): void {
    this.stateFor(agentId).held.clear();
  }

  unhold(agentId: string, ids: readonly string[]): void {
    const state = this.stateFor(agentId);
    for (const id of ids) state.held.delete(id);
  }

  list(agentId: string): { unread: number; messages: AgentInboxListEntry[] } {
    const state = this.stateFor(agentId);
    if (!state.available) return { unread: 0, messages: [] };
    const messages = this.readable(state).map((message) => ({
      id: message.id,
      ts: message.ts,
      source: message.source,
      summary: message.summary,
      important: message.important === true,
    }));
    return { unread: messages.length, messages };
  }

  async read(
    agentId: string,
    selection: AgentInboxReadSelection,
    sessionId?: string,
  ): Promise<StoredInboxMessage[]> {
    const state = this.stateFor(agentId);
    if (!state.available) return [];
    const unread = this.readable(state);
    let picked: StoredInboxMessage[];
    if (selection.ids !== undefined) {
      const byId = new Map(unread.map((message) => [message.id, message]));
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
      picked = limit > 0 ? unread.slice(0, limit) : [];
    }
    if (picked.length === 0) return [];
    // 先标 consumed 并落盘，再返回：at-most-once 对工具结果成立。
    await this.consume(
      agentId,
      picked.map((message) => message.id),
      sessionId,
    );
    return picked.map(cloneMessage);
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

  discard(agentId: string, ids: readonly string[]): void {
    const state = this.stateFor(agentId);
    if (!state.available) return;
    const wanted = new Set(ids);
    if (wanted.size === 0) return;
    state.messages = state.messages.filter((message) => !wanted.has(message.id));
    for (const id of wanted) state.held.delete(id);
    void this.enqueueWrite(state);
  }

  unreadCount(agentId: string): number {
    const state = this.stateFor(agentId);
    if (!state.available) return 0;
    return this.readable(state).length;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** unread 且未被持有，保持插入顺序。 */
  private readable(state: AgentInboxState): StoredInboxMessage[] {
    return state.messages.filter(
      (message) => message.status === 'unread' && !state.held.has(message.id),
    );
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
        held: new Set(),
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

  /** 有界：保留最新 maxMessages 条 */
  private prune(state: AgentInboxState): void {
    if (state.messages.length <= this.maxMessages) return;
    state.messages.splice(0, state.messages.length - this.maxMessages);
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

/** notice 的模型可见文本（只含条数与工具指引，不含正文）。 */
function noticeContent(unread: number): string {
  return `[inbox] ${unread} unread message(s); use the inbox tool (action="list") to view them.`;
}

/**
 * 成员 BeforeLlm notice hook（0.32 v2）。
 *
 * 只发一条 `vessel:notice` 尾消息提示未读条数；**不注入正文、不标 consumed**。
 * 未读 id 全部已提示过则不再重复；新消息到达（id 集合变化）时再提示一次。
 */
export function createInboxNoticeHook(options: {
  inbox: AgentInboxPort;
  agentId: string;
  isEnabled?: () => boolean;
  onNotified?: (data: { runId: string; sessionId?: string; unread: number }) => void;
}): Hook {
  /** 每个 hook（= 每个 body）独立；body 重建时重新开始提示。 */
  const notifiedIds = new Set<string>();
  return {
    name: 'vessel:inbox-notice',
    type: HookType.BeforeLlm,
    async run(ctx): Promise<void> {
      if (options.isEnabled?.() === false) return;
      const unread = options.inbox.list(options.agentId).messages;
      if (unread.length === 0) {
        notifiedIds.clear();
        return;
      }
      if (unread.every((message) => notifiedIds.has(message.id))) return;
      const message: Message = {
        role: 'user',
        name: 'vessel:notice',
        content: noticeContent(unread.length),
        timestamp: Date.now(),
      };
      ctx.messages = [...(ctx.messages ?? []), message];
      notifiedIds.clear();
      for (const entry of unread) notifiedIds.add(entry.id);
      try {
        options.onNotified?.({
          runId: ctx.run_id,
          ...(ctx.session_id !== undefined ? { sessionId: ctx.session_id } : {}),
          unread: unread.length,
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
  'list returns unread count + summaries; read returns full text and marks them consumed.';

function invalidInput(message: string): string {
  return JSON.stringify({ error: `invalid_input: ${message}` });
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 成员可见的 `inbox` 工具：`list` 只看未读摘要，`read` 取原文并消费。
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
        action: { type: 'string', enum: ['list', 'read'] },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'read: ids returned by list',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'read: max messages when ids omitted (default 20)',
        },
      },
      required: ['action'],
    },
    async handler(args, ctx: ToolContext): Promise<string> {
      const input = isRecordValue(args) ? args : {};
      const action = input.action;
      if (action !== 'list' && action !== 'read') {
        return invalidInput('action must be "list" or "read"');
      }
      if (action === 'list') {
        const { unread, messages } = options.inbox.list(options.agentId);
        return JSON.stringify({ unread, messages });
      }

      let ids: readonly string[] | undefined;
      if (input.ids !== undefined) {
        if (
          !Array.isArray(input.ids) ||
          !input.ids.every((id): id is string => typeof id === 'string' && id !== '')
        ) {
          return invalidInput('ids must be an array of non-empty strings');
        }
        ids = input.ids;
      }
      let limit: number | undefined;
      if (input.limit !== undefined) {
        if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1) {
          return invalidInput('limit must be a positive integer');
        }
        limit = input.limit;
      }

      const messages = await options.inbox.read(
        options.agentId,
        {
          ...(ids !== undefined ? { ids } : {}),
          ...(limit !== undefined ? { limit } : {}),
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
          important: message.important === true,
        })),
      });
    },
    async checkPermission(): Promise<'allow'> {
      return 'allow';
    },
  };
}
