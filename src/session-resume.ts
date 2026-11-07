/**
 * CLI 会话续接（0.6.1 E8）。
 *
 * - `-c/--continue`：选择当前 tenant 最近的非空会话；
 * - `-r/--resume <id>`：校验会话存在后交给 bootstrap（headless / REPL 均从该 id 载入历史）；
 * - `-r/--resume`（无 id）：列出现有会话并退出。
 *
 * 只加载配置与会话后端，不构造 runtime、不需要 API Key。
 * connect 模式的续接由 `bootstrapConnect` 经 RPC 处理，不走本模块。
 *
 * @module vessel/session-resume
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigLoadOptions, VesselConfig } from '../packages/config/src/index';
import { loadConfig } from '../packages/config/src/index';
import type { SessionInfo, SessionStore, TenantPaths } from '../packages/core/src/index';
import { ensureWriteTenantPaths, resolveDataDir, resolveReadonlyTenantPaths } from './data-paths';
import { createSessionStore } from './session-factory';

/** 列表展示上限 */
const LIST_LIMIT = 50;

export interface LocalSessionOptions extends ConfigLoadOptions {}

interface OpenedSession {
  backend: SessionStore;
  config: VesselConfig;
  tenantId: string;
  close: () => void;
}

interface LocalLayout {
  config: VesselConfig;
  tenantId: string;
  paths: TenantPaths;
}

interface SqliteSessionListRow {
  session_id: string;
  title: string | null;
  preview: string | null;
  status: string;
  started_at: number;
  updated_at: number;
  message_count: number;
  branch: string | null;
  tenant_id: string | null;
}

/** 读公共配置并选布局；`list` 只读选布局，`write` 先迁移。 */
async function resolveLocalLayout(
  options: LocalSessionOptions,
  mode: 'write' | 'list',
): Promise<LocalLayout> {
  const loaded = await loadConfig(options);
  if (loaded.validation.errors.length > 0) {
    const details = loaded.validation.errors.map((error) => error.message).join('; ');
    throw new Error(`invalid_config: ${details}`);
  }
  for (const warning of loaded.validation.warnings) {
    console.warn(`⚠ ${warning.message}`);
  }

  const dataDir = resolveDataDir(loaded.config);
  // 0.49 T2（C14 r7）：`-c` / `-r <id>` 是写意图续接，先迁移；`-r` 无 id 的纯列表
  // 只按布局选择读旧/根，不迁移、不建 marker/staging。
  const paths =
    mode === 'list'
      ? await resolveReadonlyTenantPaths(dataDir, loaded.tenantId)
      : await ensureWriteTenantPaths(dataDir, loaded.tenantId);
  return { config: loaded.config, tenantId: loaded.tenantId, paths };
}

/** 打开当前配置/tenant 对应的会话后端（写意图）。 */
async function openLocalSession(options: LocalSessionOptions): Promise<OpenedSession> {
  const layout = await resolveLocalLayout(options, 'write');
  const backend = createSessionStore(layout.config.session, {
    tenantSessionsDir: layout.paths.sessions_dir,
    tenantSessionsDbPath: `${layout.paths.root}/sessions.db`,
    tenantId: layout.tenantId,
  });

  return {
    backend,
    config: layout.config,
    tenantId: layout.tenantId,
    close: () => backend.close?.(),
  };
}

/**
 * 0.49 T2（F1）：只读列表不构造 `SQLiteSessionStore`。sqlite 用 readonly 连接
 * 直接查 `sessions` 表；文件不存在/无表返回空，不创建 DB/WAL/shm。
 */
function listSqliteSessionsReadonly(layout: LocalLayout): SessionInfo[] {
  const explicit = layout.config.session?.storagePath;
  const dbPath =
    explicit !== undefined && explicit.trim() !== ''
      ? explicit
      : join(layout.paths.root, 'sessions.db');
  if (dbPath === ':memory:' || !existsSync(dbPath)) return [];

  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
      .get() as { name?: string } | null;
    if (table?.name !== 'sessions') return [];

    const query = `
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
      WHERE json_array_length(messages) > 0
        AND COALESCE(tenant_id, 'default') = ?
      ORDER BY updated_at DESC, session_id ASC
    `;
    const rows = db.prepare(query).all(layout.tenantId) as SqliteSessionListRow[];
    return rows.map((row) => ({
      session_id: row.session_id,
      title: row.title ?? '',
      preview: row.preview ?? '',
      status: row.status,
      started_at: row.started_at,
      updated_at: row.updated_at,
      message_count: row.message_count,
      ...(row.branch !== null ? { branch: row.branch } : {}),
      ...(row.tenant_id !== null ? { tenant_id: row.tenant_id } : {}),
    }));
  } finally {
    db.close();
  }
}

/** 只读列表：memory 空；sqlite readonly；file 走现有 FileSessionStore 列表。 */
async function listSessionsForLayout(layout: LocalLayout): Promise<SessionInfo[]> {
  const backend = layout.config.session?.backend ?? 'file';
  if (backend === 'memory') return [];
  if (backend === 'sqlite') return listSqliteSessionsReadonly(layout);

  const store = createSessionStore(layout.config.session, {
    tenantSessionsDir: layout.paths.sessions_dir,
    tenantSessionsDbPath: `${layout.paths.root}/sessions.db`,
    tenantId: layout.tenantId,
  });
  try {
    return await store.listRich();
  } finally {
    store.close?.();
  }
}

/** updated_at 倒序、同值 session_id 升序 */
function sortByRecency(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
    return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
  });
}

/** ISO 时间（测试可断言）；无效值原样返回 */
function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** 截断列宽，避免超长 id/preview 打乱表格 */
function clip(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 3))}...`;
}

/** `-c/--continue`：返回最近的非空会话 id */
export async function resolveContinueSessionId(
  options: LocalSessionOptions = {},
): Promise<{ ok: true; sessionId: string; tenantId: string } | { ok: false; error: string }> {
  let opened: OpenedSession | undefined;
  try {
    opened = await openLocalSession(options);
    if (opened.config.session?.backend === 'memory') {
      return { ok: false, error: 'session_backend_memory: memory backend keeps no sessions' };
    }
    const sessions = sortByRecency(await opened.backend.listRich());
    const latest = sessions[0];
    if (!latest) {
      return { ok: false, error: 'no_sessions: no non-empty session to continue' };
    }
    return { ok: true, sessionId: latest.session_id, tenantId: opened.tenantId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    opened?.close();
  }
}

/**
 * `-r/--resume <id>` 的 CLI wrapper（Q5）：确认会话存在且有消息，
 * 避免静默新建空会话。只读会话存储，不发 RPC；续聊的 run 由后续
 * `ExecutionUnit.resumeSession(sessionId)` / `run()` 新建。
 */
export async function resumeSession(
  sessionId: string,
  options: LocalSessionOptions = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  let opened: OpenedSession | undefined;
  try {
    opened = await openLocalSession(options);
    if (opened.config.session?.backend === 'memory') {
      return { ok: false, error: 'session_backend_memory: memory backend keeps no sessions' };
    }
    const state = await opened.backend.load(sessionId);
    if (!state) {
      return { ok: false, error: `session_not_found: ${sessionId}` };
    }
    if ((state.messages?.length ?? 0) === 0) {
      return { ok: false, error: `session_empty: ${sessionId}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    opened?.close();
  }
}

/** `-r/--resume`（无 id）：只读列出当前 tenant 的会话 */
export async function runSessionList(options: LocalSessionOptions = {}): Promise<number> {
  try {
    const layout = await resolveLocalLayout(options, 'list');
    if ((layout.config.session?.backend ?? 'file') === 'memory') {
      console.log('Memory session backend keeps no sessions across processes.');
      return 0;
    }
    const sessions = sortByRecency(await listSessionsForLayout(layout));
    if (sessions.length === 0) {
      console.log(`No sessions for tenant "${layout.tenantId}".`);
      return 0;
    }

    const shown = sessions.slice(0, LIST_LIMIT);
    console.log(`Sessions (${sessions.length}, newest first):`);
    console.log('  SESSION ID                        MESSAGES  UPDATED                  TITLE');
    for (const session of shown) {
      console.log(
        [
          '  ',
          clip(session.session_id, 32).padEnd(32),
          '  ',
          String(session.message_count).padEnd(8),
          '  ',
          formatTimestamp(session.updated_at).padEnd(24),
          '  ',
          clip(session.title || session.preview || '', 60),
        ].join(''),
      );
    }
    if (sessions.length > shown.length) {
      console.log(`  ... ${sessions.length - shown.length} more (use the REPL /resume picker).`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
