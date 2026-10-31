/**
 * 按 agent_id 的持久化收件箱（0.32 切片 A）。
 *
 * 路径：`<dataDir>/tenants/<tenantId>/inbox/<encodeURIComponent(agentId)>.json`，
 * 形状 v1 为 `{ v: 1, messages: [{ id, ts, source, text, status, consumed_by_session? }] }`。
 *
 * - 每 agent 懒加载；缺失 = 空，损坏 = available=false（只记日志，不覆盖文件，读返回 []）；
 * - 有界：最多 200 条，append / load 时裁掉最旧的；
 * - `atomicWrite` 0600，单写者串行写链；append 立即入写链（写前日志，不 debounce）；
 * - `hold` 只存在内存：pending / 已排程的 run 持有，release 后重新可注入。
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
} from '@vessel-agent/core';

export const AGENT_INBOX_VERSION = 1;
export const MAX_INBOX_MESSAGES = 200;
export const INBOX_INJECT_LIMIT = 5;

export interface StoredInboxMessage {
  id: string;
  ts: number;
  source: string;
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

export interface AgentInboxPort {
  append(agentId: string, message: AgentInboxEntryInput): void;
  /** 内存态：pending / 已排程的 run 持有，注入时跳过 */
  hold(agentId: string, id: string): void;
  /** rotate / retire：旧持有一并释放，旧队列重新可注入 */
  releaseHeld(agentId: string): void;
  /** 单条解除持有（投递因 rotate/close 失败时保留未读，交给新 body 注入） */
  unhold(agentId: string, ids: readonly string[]): void;
  /** unread 且未被持有，按插入顺序；不改状态 */
  take(agentId: string, limit: number): StoredInboxMessage[];
  markConsumed(agentId: string, ids: readonly string[], sessionId: string): Promise<void>;
  /** 显式投递失败：从队列移除，不再注入 */
  discard(agentId: string, ids: readonly string[]): void;
  /** 未消费且未被持有的条数 */
  unreadCount(agentId: string): number;
  flush(): Promise<void>;
}

export interface AgentInboxStoreOptions {
  dataDir: string;
  tenantId: string;
  logger?: Logger;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  return true;
}

function isInboxFile(value: unknown): value is InboxFile {
  if (!isRecord(value)) return false;
  if (value.v !== AGENT_INBOX_VERSION) return false;
  if (!Array.isArray(value.messages)) return false;
  return value.messages.every(isStoredInboxMessage);
}

function cloneMessage(message: StoredInboxMessage): StoredInboxMessage {
  return {
    id: message.id,
    ts: message.ts,
    source: message.source,
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
  }

  append(agentId: string, message: AgentInboxEntryInput): void {
    const state = this.stateFor(agentId);
    if (!state.available) return;
    // 同一 id 只保留一条（重试 / 重复准入不制造重复注入）。
    if (state.messages.some((existing) => existing.id === message.id)) return;
    state.messages.push({
      id: message.id,
      ts: message.ts,
      source: message.source,
      text: message.text,
      status: 'unread',
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

  take(agentId: string, limit: number): StoredInboxMessage[] {
    if (limit <= 0) return [];
    const state = this.stateFor(agentId);
    if (!state.available) return [];
    const taken: StoredInboxMessage[] = [];
    for (const message of state.messages) {
      if (message.status !== 'unread' || state.held.has(message.id)) continue;
      taken.push(cloneMessage(message));
      if (taken.length >= limit) break;
    }
    return taken;
  }

  async markConsumed(agentId: string, ids: readonly string[], sessionId: string): Promise<void> {
    const state = this.stateFor(agentId);
    if (!state.available) return;
    const wanted = new Set(ids);
    if (wanted.size === 0) return;
    let changed = false;
    for (const message of state.messages) {
      if (!wanted.has(message.id)) continue;
      if (message.status !== 'consumed') changed = true;
      message.status = 'consumed';
      message.consumed_by_session = sessionId;
      state.held.delete(message.id);
    }
    // startup prompt 不在 inbox 里：未知 id 不触发空写。
    if (changed) await this.enqueueWrite(state);
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
    let count = 0;
    for (const message of state.messages) {
      if (message.status === 'unread' && !state.held.has(message.id)) count += 1;
    }
    return count;
  }

  async flush(): Promise<void> {
    await this.writeChain;
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

  /** 有界：保留最新 MAX_INBOX_MESSAGES 条 */
  private prune(state: AgentInboxState): void {
    if (state.messages.length <= MAX_INBOX_MESSAGES) return;
    state.messages.splice(0, state.messages.length - MAX_INBOX_MESSAGES);
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

/** 一条注入消息的稳定文本：`[inbox]` 开头，oldest-first，含 source / ts / text。 */
function formatInboxContent(messages: readonly StoredInboxMessage[]): string {
  const lines = [
    `[inbox] ${messages.length} queued message(s) delivered oldest-first while this body was unavailable.`,
  ];
  for (const message of messages) {
    lines.push(`- source: ${message.source} | ts: ${message.ts}`);
    lines.push(`  ${message.text}`);
  }
  return lines.join('\n');
}

/**
 * 成员 BeforeLlm 注入 hook（0.32）。
 *
 * 取走即消费：先 `take`（不改状态），拼一条 `vessel:inbox` 尾消息，再在返回前
 * `await markConsumed`（按消息 id 至多注入一次）。never 启动 turn / 写 system。
 */
export function createInboxHook(options: {
  inbox: AgentInboxPort;
  agentId: string;
  isEnabled?: () => boolean;
  onDelivered?: (data: {
    runId: string;
    sessionId?: string;
    messages: readonly StoredInboxMessage[];
  }) => void;
}): Hook {
  return {
    name: 'vessel:inbox',
    type: HookType.BeforeLlm,
    async run(ctx) {
      if (options.isEnabled?.() === false) return;
      const messages = options.inbox.take(options.agentId, INBOX_INJECT_LIMIT);
      if (messages.length === 0) return;
      const injected: Message = {
        role: 'user',
        name: 'vessel:inbox',
        content: formatInboxContent(messages),
        timestamp: Date.now(),
      };
      ctx.messages = [...(ctx.messages ?? []), injected];
      await options.inbox.markConsumed(
        options.agentId,
        messages.map((message) => message.id),
        ctx.session_id ?? 'unknown',
      );
      try {
        options.onDelivered?.({
          runId: ctx.run_id,
          ...(ctx.session_id !== undefined ? { sessionId: ctx.session_id } : {}),
          messages,
        });
      } catch {
        // 观测回调不得影响注入；错误由调用方自己的事件链路负责可见性。
      }
    },
  };
}
