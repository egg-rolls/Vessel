/**
 * Session 类型定义
 * @module @vessel-agent/core/session
 */

import type { ContextAnchor } from './context.js';
import type { Message } from './provider.js';
import type { RunUsage } from './run-record-store.js';

/** 会话状态（最近一次 RunRecord 的派生快照；真相源是 SessionEventLog） */
export type SessionStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/**
 * How the stored title came to be (additive; see docs/architecture/gateway-rpc.md).
 *
 * - manual: a human (or the rotate title parameter) named it on purpose;
 *   automatic naming must never overwrite it.
 * - generated: the AI titler wrote it; later automatic passes may still update it.
 * - missing: 0.x data with no marker. Falls back to the legacy heuristic
 *   ("title differs from deriveSessionMeta"), so old sessions never need a migration.
 */
export type SessionTitleSource = 'manual' | 'generated';

/** @internal 一版兼容：旧 session JSON/sqlite 顶层 run 字段的合成投影。 */
export interface LegacyRunSnapshot {
  completed_at?: number;
  usage?: RunUsage;
  error?: string;
}

/**
 * 会话壳（元数据 + messages 投影缓存）。
 *
 * `messages` / `derived_upto_seq` / `status` / `last_run_id` 都是派生数据，
 * 唯一真相源是 `SessionEventLog`；`legacy_run` 仅用于一版旧数据兼容。
 */
export interface SessionState {
  session_id: string;
  title?: string;
  /**
   * Source marker for title (additive; optional so old JSON / rows stay valid).
   * Missing = legacy session: readers keep the pre-0.x heuristic.
   */
  title_source?: SessionTitleSource;
  preview?: string;
  created_at: number;
  updated_at: number;
  created_on_branch?: string;
  /** Projection cache only; truth is SessionEventLog. */
  messages?: Message[];
  derived_upto_seq?: number;
  /** Derived snapshot of the latest RunRecord; NOT truth. */
  status?: SessionStatus;
  /** Derived pointer to the latest run; NOT truth. */
  last_run_id?: string;
  /** @internal one-release legacy compatibility snapshot (dual-write/read). */
  legacy_run?: LegacyRunSnapshot;
  /**
   * 真实 token 锚点（additive，0.52 C）。
   *
   * 缺省 = 旧会话 / 还没拿到过 provider 的 `prompt_tokens`，行为与 0.51 一致（裸估算）。
   * 它只校正**估算**（展示与阈值判断）；provider 的真实用量到达后仍然真实值优先。
   */
  context_anchor?: ContextAnchor;
}

/** 会话摘要（listRich 返回，照搬 Hermes list_sessions_rich 的字段集，简化） */
export interface SessionInfo {
  session_id: string;
  title: string;
  preview: string;
  status: string;
  started_at: number;
  updated_at: number;
  message_count: number;
  /** 会话创建时的 git branch */
  branch?: string;
  /**
   * Source marker for the stored title (additive). 缺失 = 旧数据 / AI 尚未命名，
   * 读取方按「无标记」处理，不做派生猜测。
   */
  title_source?: SessionTitleSource;
}

/** Session 元数据存储 port（只收发 SessionState；不含事件日志） */
export interface SessionStore {
  load(sessionId: string): Promise<SessionState | null>;
  save(state: SessionState): Promise<void>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<string[]>;
  /** 列出会话摘要（含 title/preview/updated_at/message_count），按 recency 倒序，过滤空会话 */
  listRich(): Promise<SessionInfo[]>;
  close?(): void;
}
