/**
 * SQLite Session Backend 实现
 * @module @vessel/core/session
 */

import { Database } from 'bun:sqlite';
import type { RunState, SessionBackend, SessionInfo } from '../types/session.js';
import { deriveSessionMeta } from './session-backend.js';

/** sessions 表完整行（SELECT * 的形状） */
interface SessionRow {
  session_id: string;
  run_id: string;
  messages: string;
  started_at: number;
  completed_at: number | null;
  status: RunState['status'];
  usage: string | null;
  error: string | null;
  title: string | null;
  preview: string | null;
  updated_at: number | null;
  branch: string | null;
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
}

/**
 * SQLite Session Backend 实现
 * 将 Run 状态保存到 SQLite 数据库
 */
export class SQLiteSessionBackend implements SessionBackend {
  private db: Database;

  constructor(dbPath = './vessel.db') {
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
        branch TEXT
      )
    `);
    // ALTER TABLE 无 IF NOT EXISTS，逐列 try/catch（已存在则静默）
    this.ensureColumn('title', 'TEXT');
    this.ensureColumn('preview', 'TEXT');
    this.ensureColumn('updated_at', 'INTEGER');
    this.ensureColumn('branch', 'TEXT');
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
   * 加载 Run 状态
   * @param session_id 会话 ID
   * @returns Run 状态或 null
   */
  async load(sessionId: string): Promise<RunState | null> {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?');
    const row = stmt.get(sessionId) as SessionRow | null;

    if (!row) {
      return null;
    }

    return {
      run_id: row.run_id,
      session_id: row.session_id,
      messages: JSON.parse(row.messages),
      started_at: row.started_at,
      completed_at: row.completed_at || undefined,
      status: row.status,
      usage: row.usage ? JSON.parse(row.usage) : undefined,
      error: row.error || undefined,
      title: row.title || undefined,
      preview: row.preview || undefined,
      updated_at: row.updated_at || undefined,
      branch: row.branch || undefined,
    };
  }

  /**
   * 保存 Run 状态
   * 自动派生 title/preview（首条用户消息）并刷新 updated_at
   * @param state Run 状态
   */
  async save(state: RunState): Promise<void> {
    const meta = deriveSessionMeta(state.messages);
    const title = state.title ?? meta.title;
    const preview = state.preview ?? meta.preview;
    const updatedAt = state.updated_at ?? Date.now();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions
        (session_id, run_id, messages, started_at, completed_at, status, usage, error, title, preview, updated_at, branch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      state.session_id,
      state.run_id,
      JSON.stringify(state.messages),
      state.started_at,
      state.completed_at || null,
      state.status,
      state.usage ? JSON.stringify(state.usage) : null,
      state.error || null,
      title,
      preview,
      updatedAt,
      state.branch || null,
    );
  }

  /**
   * 删除会话
   * @param session_id 会话 ID
   */
  async delete(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
  }

  /**
   * 列出所有会话 ID
   * @returns 会话 ID 数组
   */
  async list(): Promise<string[]> {
    const stmt = this.db.prepare('SELECT session_id FROM sessions');
    const rows = stmt.all() as Array<{ session_id: string }>;
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
      ORDER BY updated_at DESC
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

export type { RunState, SessionBackend, SessionInfo };
