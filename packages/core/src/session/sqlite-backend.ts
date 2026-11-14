/**
 * SQLite SessionStore 实现
 * @module @vessel-agent/core/session
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  normalizeClearedToolCallIds,
  normalizeContextAnchor,
  normalizeContextProjectionAudit,
  normalizeProjectionDeclaration,
  normalizePromptContextFingerprint,
} from '../context/index.js';
import type { Message } from '../types/provider.js';
import type { RunUsage } from '../types/run-record-store.js';
import type {
  LegacyRunSnapshot,
  SessionInfo,
  SessionState,
  SessionStatus,
  SessionStore,
} from '../types/session.js';
import {
  deriveSessionMeta,
  normalizeResumeAfterRestart,
  normalizeTitleSource,
  withTitleSource,
} from './session-store.js';

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
  title_source: string | null;
  preview: string | null;
  updated_at: number | null;
  branch: string | null;
  tenant_id: string | null;
  /** 0.18：messages 投影缓存覆盖到的事件 seq */
  derived_upto_seq: number | null;
  /** 0.52 C：真实用量锚点（JSON；NULL = 旧行 / 没拿到过 provider 用量） */
  context_anchor: string | null;
  /** 0.52：环境快照发布指纹（JSON；NULL = 旧行 / 还没发布过） */
  prompt_context: string | null;
  /** 0.52 S1a：续跑标记（JSON；NULL = 旧行 / 该会话没被进程退出打断过） */
  resume_after_restart: string | null;
  /** 0.52 V1：本段冻结的工具结果占位集合（JSON；NULL = 旧行 / 这一段还没做过决策） */
  cleared_tool_call_ids: string | null;
  /** 0.53 U1：会话级投射声明（JSON；NULL = 旧行 / 还没声明 ⇒ 读侧按 legacy 解析） */
  context_projection: string | null;
  /** 0.53 U1：最近一次投射决策审计（JSON；NULL = 还没有决策） */
  context_projection_audit: string | null;
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
  title_source: string | null;
}

/**
 * 解析可为 NULL 的 JSON 列；脏数据返回 undefined。
 *
 * 会话库是本地文件，可能被手改 / 版本回滚写坏；解析失败不该让整个会话加载失败
 * （调用方都按「没有这个字段」处理）。
 */
function parseJsonColumn(value: string | null): unknown {
  if (value === null || value === '') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
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
        title_source TEXT,
        preview TEXT,
        updated_at INTEGER,
        branch TEXT,
        tenant_id TEXT,
        derived_upto_seq INTEGER,
        context_anchor TEXT,
        prompt_context TEXT,
        resume_after_restart TEXT,
        cleared_tool_call_ids TEXT,
        context_projection TEXT,
        context_projection_audit TEXT
      )
    `);
    // ALTER TABLE 无 IF NOT EXISTS，逐列 try/catch（已存在则静默）
    this.ensureColumn('title', 'TEXT');
    // Additive (title_source): old rows keep NULL = no marker = legacy heuristic.
    this.ensureColumn('title_source', 'TEXT');
    this.ensureColumn('preview', 'TEXT');
    this.ensureColumn('updated_at', 'INTEGER');
    this.ensureColumn('branch', 'TEXT');
    this.ensureColumn('tenant_id', 'TEXT');
    // 0.18：旧库补列；NULL 表示该行没有派生游标（resume 走全量投影去重回退）
    this.ensureColumn('derived_upto_seq', 'INTEGER');
    // 0.52 C：旧库补列；NULL 表示没有真实锚点（tokenCount 退回裸估算 = 0.51 行为）
    this.ensureColumn('context_anchor', 'TEXT');
    // 0.52：旧库补列；NULL = 没有发布过指纹（首次运行会发一张全量卡，符合预期）
    this.ensureColumn('prompt_context', 'TEXT');
    // 0.52 S1a：旧库补列；NULL = 没有续跑标记（启动不续跑任何东西 = 0.51 行为）
    this.ensureColumn('resume_after_restart', 'TEXT');
    // 0.52 V1：旧库补列；NULL = 这一段还没做过占位决策（请求视图与落盘逐字一致）
    this.ensureColumn('cleared_tool_call_ids', 'TEXT');
    // 0.53 U1（ADR-104 §5.1）：旧库补列；NULL = 旧会话，读侧按 placeholder + legacy 解析
    this.ensureColumn('context_projection', 'TEXT');
    // 0.53 U1：旧库补列；NULL = 还没有任何投射决策审计（U2 才写）
    this.ensureColumn('context_projection_audit', 'TEXT');
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
      title_source: normalizeTitleSource(row.title_source),
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
      // 0.52 C：旧行 NULL / 脏 JSON ⇒ undefined ⇒ 行为与 0.51 一致。
      context_anchor: normalizeContextAnchor(parseJsonColumn(row.context_anchor)),
      // 0.52：旧行 NULL / 脏 JSON ⇒ undefined。
      prompt_context: normalizePromptContextFingerprint(parseJsonColumn(row.prompt_context)),
      // 0.52 S1a：旧行 NULL / 脏 JSON / 缺字段 ⇒ undefined（启动不续跑任何东西）。
      resume_after_restart: normalizeResumeAfterRestart(parseJsonColumn(row.resume_after_restart)),
      // 0.52 V1：旧行 NULL / 脏 JSON / 空数组 ⇒ undefined（请求视图不改写 = 0.51 行为）。
      cleared_tool_call_ids: normalizeClearedToolCallIds(
        parseJsonColumn(row.cleared_tool_call_ids),
      ),
      // 0.53 U1：旧行 NULL / 脏 JSON ⇒ undefined ⇒ resolveProjection 走 legacy（placeholder）。
      context_projection: normalizeProjectionDeclaration(parseJsonColumn(row.context_projection)),
      // 0.53 U1：审计行（U2 才写；旧行 / 脏 JSON ⇒ undefined）。
      context_projection_audit: normalizeContextProjectionAudit(
        parseJsonColumn(row.context_projection_audit),
      ),
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
        (session_id, run_id, messages, started_at, completed_at, status, usage, error, title, title_source, preview, updated_at, branch, tenant_id, derived_upto_seq, context_anchor, prompt_context, resume_after_restart, cleared_tool_call_ids, context_projection, context_projection_audit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      state.title_source ?? null,
      preview,
      updatedAt,
      state.created_on_branch ?? null,
      null,
      typeof state.derived_upto_seq === 'number' ? state.derived_upto_seq : null,
      // 0.52 C：真实锚点整体存 JSON —— 形状会随实现演进，列不再拆字段。
      state.context_anchor !== undefined ? JSON.stringify(state.context_anchor) : null,
      state.prompt_context !== undefined ? JSON.stringify(state.prompt_context) : null,
      // 0.52 S1a：续跑标记整体存 JSON（NULL = 没有标记）。
      state.resume_after_restart !== undefined ? JSON.stringify(state.resume_after_restart) : null,
      // 0.52 V1：本段冻结的占位集合（NULL = 这一段还没做过决策）。
      state.cleared_tool_call_ids !== undefined
        ? JSON.stringify(state.cleared_tool_call_ids)
        : null,
      // 0.53 U1：投射声明整体存 JSON（NULL = 旧会话 / 还没声明）。
      state.context_projection !== undefined ? JSON.stringify(state.context_projection) : null,
      // 0.53 U1：审计行（NULL = 还没有任何决策）。
      state.context_projection_audit !== undefined && state.context_projection_audit !== null
        ? JSON.stringify(state.context_projection_audit)
        : null,
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
             branch,
             title_source
      FROM sessions
      WHERE json_array_length(messages) > 0
      ORDER BY updated_at DESC, session_id ASC
    `);
    const rows = stmt.all() as SessionListRow[];
    // 唯一的 title_source 出口是 withTitleSource（与 toSessionInfo 共用）。
    return rows.map((row) =>
      withTitleSource(
        {
          session_id: row.session_id,
          title: row.title,
          preview: row.preview,
          status: row.status,
          started_at: row.started_at,
          updated_at: row.updated_at,
          message_count: row.message_count,
          branch: row.branch ?? undefined,
        },
        row.title_source,
      ),
    );
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close();
  }
}

export type { SessionInfo, SessionState, SessionStore };
