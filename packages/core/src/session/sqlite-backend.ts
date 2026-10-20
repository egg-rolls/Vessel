/**
 * SQLite Session Backend 实现
 * @module @vessel-agent/core/session
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
  tenant_id: string | null;
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

/** SQLite backend 选项（与 FileSessionBackend 对齐） */
export interface SQLiteSessionBackendOptions {
  /** 配置后：写入补齐 tenant_id，读取/列表/删除过滤其它 tenant */
  tenantId?: string;
}

/**
 * SQLite Session Backend 实现
 * 将 Run 状态保存到 SQLite 数据库
 */
export class SQLiteSessionBackend implements SessionBackend {
  private db: Database;
  private readonly tenantId?: string;

  /**
   * @param dbPath SQLite 数据库文件路径，默认 `.vessel/sessions.db`（与 FileSessionBackend 的
   *   `.vessel/sessions` 同级）；传 `:memory:` 走内存库（测试用），不建目录。
   * @param options 可选 tenant 作用域；缺省不隔离（0.4 行为）
   */
  constructor(dbPath = '.vessel/sessions.db', options: SQLiteSessionBackendOptions = {}) {
    // SQLite 只创建文件、不创建父目录——首次运行前先补目录（对标 FileSessionBackend 的惰性 mkdir）
    if (dbPath !== ':memory:') {
      try {
        mkdirSync(dirname(dbPath), { recursive: true });
      } catch {
        // 目录已存在或不可创建——交给 new Database 抛出明确错误
      }
    }
    this.db = new Database(dbPath);
    this.tenantId = options.tenantId;
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
        tenant_id TEXT
      )
    `);
    // ALTER TABLE 无 IF NOT EXISTS，逐列 try/catch（已存在则静默）
    this.ensureColumn('title', 'TEXT');
    this.ensureColumn('preview', 'TEXT');
    this.ensureColumn('updated_at', 'INTEGER');
    this.ensureColumn('branch', 'TEXT');
    this.ensureColumn('tenant_id', 'TEXT');
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
    // 缺省 tenant_id 视为 default；跨 tenant 读不到（not_found 语义）
    if (this.tenantId !== undefined && (row.tenant_id ?? 'default') !== this.tenantId) {
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
      tenant_id: row.tenant_id || undefined,
    };
  }

  /**
   * 保存 Run 状态
   * 自动派生 title/preview（首条用户消息）并刷新 updated_at
   * @param state Run 状态
   */
  async save(state: RunState): Promise<void> {
    const effective = this.applyTenant(state);
    this.assertNoForeignRow(effective.session_id);
    const meta = deriveSessionMeta(effective.messages);
    const title = effective.title ?? meta.title;
    const preview = effective.preview ?? meta.preview;
    const updatedAt = effective.updated_at ?? Date.now();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions
        (session_id, run_id, messages, started_at, completed_at, status, usage, error, title, preview, updated_at, branch, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      effective.session_id,
      effective.run_id,
      JSON.stringify(effective.messages),
      effective.started_at,
      effective.completed_at || null,
      effective.status,
      effective.usage ? JSON.stringify(effective.usage) : null,
      effective.error || null,
      title,
      preview,
      updatedAt,
      effective.branch || null,
      effective.tenant_id || null,
    );
  }

  /** 写入前补齐/校验 tenant_id；跨 tenant 直接抛错 */
  private applyTenant(state: RunState): RunState {
    if (this.tenantId === undefined) return state;
    if (state.tenant_id !== undefined && state.tenant_id !== this.tenantId) {
      throw new Error(`tenant_mismatch: session ${state.session_id} belongs to ${state.tenant_id}`);
    }
    return state.tenant_id === this.tenantId ? state : { ...state, tenant_id: this.tenantId };
  }

  /** 同一 DB 中 session_id 是主键：禁止覆盖其它 tenant 的既有行 */
  private assertNoForeignRow(sessionId: string): void {
    if (this.tenantId === undefined) return;
    const row = this.db
      .prepare('SELECT tenant_id FROM sessions WHERE session_id = ?')
      .get(sessionId) as { tenant_id: string | null } | null;
    if (!row) return;
    const owner = row.tenant_id ?? 'default';
    if (owner !== this.tenantId) {
      throw new Error(`tenant_mismatch: session ${sessionId} belongs to ${owner}`);
    }
  }

  /**
   * 删除会话
   * @param session_id 会话 ID
   */
  async delete(sessionId: string): Promise<void> {
    if (this.tenantId === undefined) {
      this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
      return;
    }
    this.db
      .prepare("DELETE FROM sessions WHERE session_id = ? AND COALESCE(tenant_id, 'default') = ?")
      .run(sessionId, this.tenantId);
  }

  /**
   * 列出会话 ID（配置 tenant 时只返回本 tenant）
   * @returns 会话 ID 数组
   */
  async list(): Promise<string[]> {
    if (this.tenantId === undefined) {
      const rows = this.db.prepare('SELECT session_id FROM sessions').all() as Array<{
        session_id: string;
      }>;
      return rows.map((row) => row.session_id);
    }

    const rows = this.db
      .prepare("SELECT session_id FROM sessions WHERE COALESCE(tenant_id, 'default') = ?")
      .all(this.tenantId) as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  }

  /**
   * 列出会话摘要（含 title/preview/updated_at/message_count）
   * 过滤空会话（message_count > 0），按 updated_at 倒序
   * 单查询 + json_array_length，避免 N+1（照搬 Hermes list_sessions_rich 思路）
   */
  async listRich(): Promise<SessionInfo[]> {
    const tenantPredicate =
      this.tenantId === undefined ? '' : " AND COALESCE(tenant_id, 'default') = ?";
    const stmt = this.db.prepare(`
      SELECT session_id,
             COALESCE(title, '') AS title,
             COALESCE(preview, '') AS preview,
             status,
             started_at,
             COALESCE(updated_at, started_at) AS updated_at,
             json_array_length(messages) AS message_count,
             branch,
             tenant_id
      FROM sessions
      WHERE json_array_length(messages) > 0${tenantPredicate}
      ORDER BY updated_at DESC, session_id ASC
    `);
    const rows = (
      this.tenantId === undefined ? stmt.all() : stmt.all(this.tenantId)
    ) as SessionListRow[];
    return rows.map((row) => ({
      session_id: row.session_id,
      title: row.title,
      preview: row.preview,
      status: row.status,
      started_at: row.started_at,
      updated_at: row.updated_at,
      message_count: row.message_count,
      branch: row.branch ?? undefined,
      tenant_id: row.tenant_id ?? undefined,
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
