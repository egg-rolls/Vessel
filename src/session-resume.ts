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

import type { ConfigLoadOptions, VesselConfig } from '../packages/config/src/index';
import { loadConfig } from '../packages/config/src/index';
import type { SessionBackend, SessionInfo } from '../packages/core/src/index';
import { resolveDataDir, resolveTenantPaths } from './data-paths';
import { createSessionBackend } from './session-factory';

/** 列表展示上限 */
const LIST_LIMIT = 50;

export interface LocalSessionOptions extends ConfigLoadOptions {}

interface OpenedSession {
  backend: SessionBackend;
  config: VesselConfig;
  tenantId: string;
  close: () => void;
}

/** 打开当前配置/tenant 对应的会话后端 */
async function openLocalSession(options: LocalSessionOptions): Promise<OpenedSession> {
  const loaded = await loadConfig(options);
  if (loaded.validation.errors.length > 0) {
    const details = loaded.validation.errors.map((error) => error.message).join('; ');
    throw new Error(`invalid_config: ${details}`);
  }
  for (const warning of loaded.validation.warnings) {
    console.warn(`⚠ ${warning.message}`);
  }

  const dataDir = resolveDataDir(loaded.config);
  const paths = resolveTenantPaths(dataDir, loaded.tenantId);
  const backend = createSessionBackend(loaded.config.session, {
    tenantSessionsDir: paths.sessions_dir,
    tenantSessionsDbPath: `${paths.root}/sessions.db`,
    tenantId: loaded.tenantId,
  });

  return {
    backend,
    config: loaded.config,
    tenantId: loaded.tenantId,
    close: () => backend.close?.(),
  };
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

/** `-r <id>`：确认会话存在且有消息，避免静默新建空会话 */
export async function validateResumeSessionId(
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
    if (state.messages.length === 0) {
      return { ok: false, error: `session_empty: ${sessionId}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    opened?.close();
  }
}

/** `-r/--resume`（无 id）：列出当前 tenant 的会话 */
export async function runSessionList(options: LocalSessionOptions = {}): Promise<number> {
  let opened: OpenedSession | undefined;
  try {
    opened = await openLocalSession(options);
    if (opened.config.session?.backend === 'memory') {
      console.log('Memory session backend keeps no sessions across processes.');
      return 0;
    }
    const sessions = sortByRecency(await opened.backend.listRich());
    if (sessions.length === 0) {
      console.log(`No sessions for tenant "${opened.tenantId}".`);
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
  } finally {
    opened?.close();
  }
}
