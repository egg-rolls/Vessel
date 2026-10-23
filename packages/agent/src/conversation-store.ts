/**
 * Conversation 预算状态（`<dataDir>/conversations/<tenant>.json`，0.19 S4）。
 *
 * - 构造时同步加载；缺失 = 空，损坏 = unavailable（不覆盖文件）；
 * - 有界：最多 1000 条按 last_activity 淘汰，带 override / blocked 的额外保留 ≤ 50；
 * - `atomicWrite` + 0600；hop / activity 变更 debounce，turn 完成 / block / override 强制写；
 * - 单写者：一个 AgentService / 一个 dataDir；不做跨进程监听。
 *
 * @module @vessel-agent/agent
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, type Logger, noopLogger } from '@vessel-agent/core';
import type { BudgetBlockReason, BudgetDimension } from './types.js';

export const CONVERSATION_STORE_VERSION = 1;
export const MAX_CONVERSATIONS = 1000;
export const MAX_PROTECTED_CONVERSATIONS = 50;
export const MAX_CONVERSATION_EDGES = 32;
export const CONVERSATION_WRITE_DEBOUNCE_MS = 50;

const DIMENSIONS: readonly BudgetDimension[] = ['hops', 'turns', 'tokens', 'wall_clock', 'cycle'];
const BLOCK_REASONS: readonly BudgetBlockReason[] = [
  'budget_exceeded',
  'cycle_detected',
  'budget_unavailable',
];

export interface StoredConversationEdge {
  from: string;
  to: string;
  count: number;
  last_ts: number;
}

export interface StoredConversationOverride {
  max: number;
  by: 'human';
  via: 'cli' | 'api';
  at: number;
}

export interface StoredConversation {
  conversation_id: string;
  team_id?: string;
  created_at: number;
  last_activity: number;
  hops: number;
  turns: number;
  total_tokens: number;
  edges: StoredConversationEdge[];
  overrides: Partial<Record<BudgetDimension, StoredConversationOverride>>;
  blocked?: { dimension: BudgetDimension; reason: BudgetBlockReason; at: number };
}

export interface ConversationStoreFile {
  v: 1;
  tenant_id: string;
  conversations: StoredConversation[];
}

export interface ConversationStoreOptions {
  dataDir: string;
  tenantId: string;
  logger?: Logger;
  now?: () => number;
  /** 写入合并窗口；缺省 50ms */
  debounceMs?: number;
}

export function conversationsPath(dataDir: string, tenantId: string): string {
  return join(dataDir, 'conversations', `${tenantId}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isEdge(value: unknown): value is StoredConversationEdge {
  if (!isRecord(value)) return false;
  return (
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    isFiniteNumber(value.count) &&
    isFiniteNumber(value.last_ts)
  );
}

function isOverride(value: unknown): value is StoredConversationOverride {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.max) &&
    value.by === 'human' &&
    (value.via === 'cli' || value.via === 'api') &&
    isFiniteNumber(value.at)
  );
}

function isBlocked(value: unknown): value is NonNullable<StoredConversation['blocked']> {
  if (!isRecord(value)) return false;
  return (
    DIMENSIONS.includes(value.dimension as BudgetDimension) &&
    BLOCK_REASONS.includes(value.reason as BudgetBlockReason) &&
    isFiniteNumber(value.at)
  );
}

/** 严格校验：任何一条非法都按损坏处理（fail-closed，不静默重置） */
function isStoredConversation(value: unknown): value is StoredConversation {
  if (!isRecord(value)) return false;
  if (typeof value.conversation_id !== 'string' || value.conversation_id === '') return false;
  if (value.team_id !== undefined && typeof value.team_id !== 'string') return false;
  if (
    !isFiniteNumber(value.created_at) ||
    !isFiniteNumber(value.last_activity) ||
    !isFiniteNumber(value.hops) ||
    !isFiniteNumber(value.turns) ||
    !isFiniteNumber(value.total_tokens)
  ) {
    return false;
  }
  if (!Array.isArray(value.edges) || !value.edges.every(isEdge)) return false;
  if (value.overrides === undefined) return false;
  if (!isRecord(value.overrides)) return false;
  for (const [key, override] of Object.entries(value.overrides)) {
    if (!DIMENSIONS.includes(key as BudgetDimension) || !isOverride(override)) return false;
  }
  if (value.blocked !== undefined && !isBlocked(value.blocked)) return false;
  return true;
}

function isStoreFile(value: unknown, tenantId: string): value is ConversationStoreFile {
  if (!isRecord(value)) return false;
  if (value.v !== CONVERSATION_STORE_VERSION) return false;
  if (value.tenant_id !== tenantId) return false;
  if (!Array.isArray(value.conversations)) return false;
  return value.conversations.every(isStoredConversation);
}

function hasProtection(conversation: StoredConversation): boolean {
  return conversation.blocked !== undefined || Object.keys(conversation.overrides).length > 0;
}

function cloneConversation(conversation: StoredConversation): StoredConversation {
  return {
    conversation_id: conversation.conversation_id,
    ...(conversation.team_id !== undefined ? { team_id: conversation.team_id } : {}),
    created_at: conversation.created_at,
    last_activity: conversation.last_activity,
    hops: conversation.hops,
    turns: conversation.turns,
    total_tokens: conversation.total_tokens,
    edges: conversation.edges.map((edge) => ({ ...edge })),
    overrides: Object.fromEntries(
      Object.entries(conversation.overrides).map(([key, value]) => [key, { ...value }]),
    ) as StoredConversation['overrides'],
    ...(conversation.blocked !== undefined ? { blocked: { ...conversation.blocked } } : {}),
  };
}

export class ConversationStore {
  readonly path: string;
  /** 损坏或不可读时为 false；此后不写文件，判定返回 budget_unavailable */
  readonly available: boolean;

  private readonly tenantId: string;
  private readonly logger: Logger;
  private readonly debounceMs: number;
  private readonly conversations = new Map<string, StoredConversation>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 永不 reject 的串行写链 */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: ConversationStoreOptions) {
    if (typeof options.dataDir !== 'string' || options.dataDir === '') {
      throw new Error('ConversationStore requires a non-empty dataDir');
    }
    if (typeof options.tenantId !== 'string' || options.tenantId === '') {
      throw new Error('ConversationStore requires a non-empty tenantId');
    }
    this.tenantId = options.tenantId;
    this.logger = options.logger ?? noopLogger;
    this.debounceMs = options.debounceMs ?? CONVERSATION_WRITE_DEBOUNCE_MS;
    this.path = conversationsPath(options.dataDir, options.tenantId);
    this.available = this.loadSync();
  }

  get(conversationId: string): StoredConversation | undefined {
    return this.conversations.get(conversationId);
  }

  /**
   * 取或创建一条 conversation。`team_id` 只在缺失时写入（origin team 不可改写）。
   */
  ensure(conversationId: string, teamId: string | undefined, now: number): StoredConversation {
    let conversation = this.conversations.get(conversationId);
    if (conversation === undefined) {
      conversation = {
        conversation_id: conversationId,
        created_at: now,
        last_activity: now,
        hops: 0,
        turns: 0,
        total_tokens: 0,
        edges: [],
        overrides: {},
        ...(teamId !== undefined ? { team_id: teamId } : {}),
      };
      this.conversations.set(conversationId, conversation);
    } else if (teamId !== undefined && conversation.team_id === undefined) {
      conversation.team_id = teamId;
    }
    return conversation;
  }

  all(): StoredConversation[] {
    return [...this.conversations.values()];
  }

  /** 合并写入：defer 到下一个窗口；同一窗口内多次调用只写一次 */
  markDirty(): void {
    if (!this.available) return;
    this.dirty = true;
    if (this.timer !== undefined) return;
    const timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.available || !this.dirty) return;
      this.dirty = false;
      void this.enqueueWrite();
    }, this.debounceMs);
    timer.unref?.();
    this.timer = timer;
  }

  /** 立即落盘（turn 完成 / block / override） */
  force(): Promise<void> {
    if (!this.available) return Promise.resolve();
    this.clearTimer();
    this.dirty = false;
    return this.enqueueWrite();
  }

  /** 等待已入队写入（含尚未触发的 debounce） */
  async flush(): Promise<void> {
    if (!this.available) return;
    if (this.timer !== undefined || this.dirty) {
      this.clearTimer();
      this.dirty = false;
      void this.enqueueWrite();
    }
    await this.writeChain;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private enqueueWrite(): Promise<void> {
    if (!this.available) return Promise.resolve();
    // 序列化在入队时同步完成，避免异步窗口里继续改 Map 导致半新半旧。
    let data: string;
    try {
      this.prune();
      data = JSON.stringify(this.snapshotFile());
    } catch (error) {
      this.logger.error('conversation_budget.serialize_failed', {
        path: this.path,
        error: errorText(error),
      });
      return Promise.resolve();
    }
    const run = async (): Promise<void> => {
      try {
        await atomicWrite(this.path, data, { mode: 0o600, ensureDir: true });
      } catch (error) {
        this.logger.error('conversation_budget.write_failed', {
          path: this.path,
          error: errorText(error),
        });
      }
    };
    const task = this.writeChain.then(run, run);
    this.writeChain = task;
    return task;
  }

  private snapshotFile(): ConversationStoreFile {
    return {
      v: CONVERSATION_STORE_VERSION,
      tenant_id: this.tenantId,
      conversations: [...this.conversations.values()].map(cloneConversation),
    };
  }

  /** LRU 淘汰：先淘汰无 override / blocked 的最旧条目，受保护条目最多额外保留 50 条 */
  private prune(): void {
    if (this.conversations.size <= MAX_CONVERSATIONS) return;
    const oldest = [...this.conversations.values()].sort(
      (left, right) => left.last_activity - right.last_activity,
    );
    let total = oldest.length;
    for (const conversation of oldest) {
      if (total <= MAX_CONVERSATIONS) break;
      if (hasProtection(conversation)) continue;
      if (this.conversations.delete(conversation.conversation_id)) total -= 1;
    }
    for (const conversation of oldest) {
      if (total <= MAX_CONVERSATIONS + MAX_PROTECTED_CONVERSATIONS) break;
      if (this.conversations.delete(conversation.conversation_id)) total -= 1;
    }
  }

  /** 同步加载；返回 available */
  private loadSync(): boolean {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      this.logger.error('conversation_budget.load_failed', {
        path: this.path,
        error: errorText(error),
      });
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.logger.error('conversation_budget.corrupt', {
        path: this.path,
        error: errorText(error),
      });
      return false;
    }
    if (!isStoreFile(parsed, this.tenantId)) {
      this.logger.error('conversation_budget.corrupt', { path: this.path });
      return false;
    }
    for (const conversation of parsed.conversations) {
      // 文件内重复 id：后者覆盖，保持加载而不是因重复拒绝整个文件。
      this.conversations.set(conversation.conversation_id, cloneConversation(conversation));
    }
    this.prune();
    return true;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
