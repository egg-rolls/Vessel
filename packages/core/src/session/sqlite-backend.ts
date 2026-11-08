/**
 * SQLite SessionStore 实现
 * @module @vessel-agent/core/session
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Message } from '../types/provider.js';
import type { RunUsage } from '../types/run-record-store.js';
import type {
  LegacyRunSnapshot,
  SessionInfo,
  SessionState,
  SessionStatus,
  SessionStore,
} from '../types/session.js';
import { deriveSessionMeta } from './session-store.js';

/** sessions 表完整行（SELECT * 的形状） */
interface SessionRow {
  session_id: string;
  run_id: string;
  messages: string;
  started_at: number;
  completed_at: number | null;
  status: SessionStatus;
  usage: string | null;
  error: string | null;
  title: string | null;
  preview: string | null;
  updated_at: number | null;
  branch: string | null;
  tenant_id: string | null;
  /** 0.18：messages 投影缓存覆盖到的事件 seq */
  derived_upto_seq: number | null;
}

/** listRich 查询行形状（含派生列 message_count） */
interface SessionListRow {
  session_id: string;
  title: string;
  preview: string;
  status: string;
  started_at: number;
  updated_at: number;
  message_count: number;
  branch: string | null;
  tenant_id: string | null;
}

/** 旧行顶层 run 字段 -> SessionState.legacy_run（一版兼容） */
function toLegacyRun(
  completedAt: number | null,
  usage: string | null,
  error: string | null,
): LegacyRunSnapshot | undefined {
  const completed_at = completedAt || undefined;
  const parsedUsage = usage ? (JSON.parse(usage) as RunUsage) : undefined;
  const message = error || undefined;
  if (completed_at === undefined && parsedUsage === undefined && message === undefined) {
    return undefined;
  }
  return {
    ...(completed_at !== undefined ? { completed_at } : {}),
    ...(parsedUsage !== undefined ? { usage: parsedUsage } : {}),
    ...(message !== undefined ? { error: message } : {}),
  };
}

/**
 * SQLite SessionStore 实现
 * 将会话壳（SessionState）保存到 SQLite 数据库；表/列保持旧 schema。
 */
export class SQLiteSessionStore implements SessionStore {
  private db: Database;

  /**
   * @param dbPath SQLite 数据库文件路径，默认 `.vessel/sessions.db`（与 FileSessionStore 的
   *   `.vessel/sessions` 同级）；传 `:memory:` 走内存库（测试用），不建目录。
   */
  constructor(dbPath = '.vessel/sessions.db') {
    // SQLite 只创建文件、不创建父目录——首次运行前先补目录（对标 FileSessionStore 的惰性 mkdir）
    if (dbPath !== ':memory:') {
      try {
        mkdirSync(dirname(dbPath), { recursive: true });
      } catch {
        // 目录已存在或不可创建——交给 new Database 抛出明确错误
      }
    }
    this.db = new Database(dbPath);
    this.init();
  }

  /**
   * 初始化数据库表
   * 含旧库迁移：title/preview/updated_at 对已存在的库用 ALTER TABLE 补列
   */
  private init(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        messages TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL,
        usage TEXT,
        error TEXT,
        title TEXT,
        preview TEXT,
        updated_at INTEGER,
        branch TEXT,
        tenant_id TEXT,
        derived_upto_seq INTEGER
      )
    `);
    // ALTER TABLE 无 IF NOT EXISTS，逐列 try/catch（已存在则静默）
    this.ensureColumn('title', 'TEXT');
    this.ensureColumn('preview', 'TEXT');
    this.ensureColumn('updated_at', 'INTEGER');
    this.ensureColumn('branch', 'TEXT');
    this.ensureColumn('tenant_id', 'TEXT');
    // 0.18：旧库补列；NULL 表示该行没有派生游标（resume 走全量投影去重回退）
    this.ensureColumn('derived_upto_seq', 'INTEGER');
  }

  /** 为旧库补列（列已存在时静默忽略） */
  private ensureColumn(col: string, type: string): void {
    try {
      this.db.run(`ALTER TABLE sessions ADD COLUMN ${col} ${type}`);
    } catch {
      // 列已存在
    }
  }

  /**
   * 加载会话状态
   * @param sessionId 会话 ID
   * @returns 会话状态或 null
   */
  async load(sessionId: string): Promise<SessionState | null> {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?');
    const row = stmt.get(sessionId) as SessionRow | null;

    if (!row) {
      return null;
    }

    return {
      session_id: row.session_id,
      created_at: row.started_at,
      updated_at: row.updated_at || row.started_at,
      title: row.title || undefined,
      preview: row.preview || undefined,
      created_on_branch: row.branch || undefined,
      messages: JSON.parse(row.messages) as Message[],
      derived_upto_seq:
        typeof row.derived_upto_seq === 'number' && Number.isFinite(row.derived_upto_seq)
          ? row.derived_upto_seq
          : undefined,
      status: row.status,
      last_run_id: row.run_id || undefined,
      legacy_run: toLegacyRun(row.completed_at, row.usage, row.error),
    };
  }

  /**
   * 保存会话状态
   * 自动派生 title/preview（首条用户消息）并刷新 updated_at
   * 磁盘列沿用旧 schema：run_id/started_at/completed_at/usage/error/branch 为镜像。
   * @param state 会话状态
   */
  async save(state: SessionState): Promise<void> {
    const messages = state.messages ?? [];
    const meta = deriveSessionMeta(messages);
    const title = state.title ?? meta.title;
    const preview = state.preview ?? meta.preview;
    const updatedAt = state.updated_at ?? Date.now();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions
        (session_id, run_id, messages, started_at, completed_at, status, usage, error, title, preview, updated_at, branch, tenant_id, derived_upto_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      state.session_id,
      state.last_run_id ?? '',
      JSON.stringify(messages),
      state.created_at,
      state.legacy_run?.completed_at ?? null,
      state.status ?? 'running',
      state.legacy_run?.usage ? JSON.stringify(state.legacy_run.usage) : null,
      state.legacy_run?.error ?? null,
      title,
      preview,
      updatedAt,
      state.created_on_branch ?? null,
      null,
      typeof state.derived_upto_seq === 'number' ? state.derived_upto_seq : null,
    );
  }

  /**
   * 删除会话
   * @param sessionId 会话 ID
   */
  async delete(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
  }

  /**
   * 列出会话 ID
   * @returns 会话 ID 数组
   */
  async list(): Promise<string[]> {
    const rows = this.db.prepare('SELECT session_id FROM sessions').all() as Array<{
      session_id: string;
    }>;
    return rows.map((row) => row.session_id);
  }

  /**
   * 列出会话摘要（含 title/preview/updated_at/message_count）
   * 过滤空会话（message_count > 0），按 updated_at 倒序
   * 单查询 + json_array_length，避免 N+1（照搬 Hermes list_sessions_rich 思路）
   */
  async listRich(): Promise<SessionInfo[]> {
    const stmt = this.db.prepare(`
      SELECT session_id,
             COALESCE(title, '') AS title,
             COALESCE(preview, '') AS preview,
             status,
             started_at,
             COALESCE(updated_at, started_at) AS updated_at,
             json_array_length(messages) AS message_count,
             branch
      FROM sessions
      WHERE json_array_length(messages) > 0
      ORDER BY updated_at DESC, session_id ASC
    `);
    const rows = stmt.all() as SessionListRow[];
    return rows.map((row) => ({
      session_id: row.session_id,
      title: row.title,
      preview: row.preview,
      status: row.status,
      started_at: row.started_at,
      updated_at: row.updated_at,
      message_count: row.message_count,
      branch: row.branch ?? undefined,
    }));
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close();
  }
}

export type { SessionInfo, SessionState, SessionStore };
