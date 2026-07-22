/**
 * SQLite Session Backend 实现
 * @module @vessel/core/session
 */

import { Database } from 'bun:sqlite';
import type { RunState, SessionBackend } from '../types/session.js';

/**
 * SQLite Session Backend 实现
 * 将 Run 状态保存到 SQLite 数据库
 */
export class SQLiteSessionBackend implements SessionBackend {
  private db: Database;

  constructor(dbPath: string = './vessel.db') {
    this.db = new Database(dbPath);
    this.init();
  }

  /**
   * 初始化数据库表
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
        error TEXT
      )
    `);
  }

  /**
   * 加载 Run 状态
   * @param session_id 会话 ID
   * @returns Run 状态或 null
   */
  async load(session_id: string): Promise<RunState | null> {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?');
    const row = stmt.get(session_id) as any;
    
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
    };
  }

  /**
   * 保存 Run 状态
   * @param state Run 状态
   */
  async save(state: RunState): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (session_id, run_id, messages, started_at, completed_at, status, usage, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      state.session_id,
      state.run_id,
      JSON.stringify(state.messages),
      state.started_at,
      state.completed_at || null,
      state.status,
      state.usage ? JSON.stringify(state.usage) : null,
      state.error || null
    );
  }

  /**
   * 删除会话
   * @param session_id 会话 ID
   */
  async delete(session_id: string): Promise<void> {
    this.db.run('DELETE FROM sessions WHERE session_id = ?', session_id);
  }

  /**
   * 列出所有会话 ID
   * @returns 会话 ID 数组
   */
  async list(): Promise<string[]> {
    const stmt = this.db.prepare('SELECT session_id FROM sessions');
    const rows = stmt.all() as any[];
    return rows.map((row) => row.session_id);
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close();
  }
}

export type { RunState, SessionBackend };
