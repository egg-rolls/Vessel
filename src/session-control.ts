/**
 * session rename / delete（0.5 E15 / A-3 §10.5、A-4 §11.3）
 *
 * - rename：load → 改 title → save；不改 session_id，不扩展 SessionBackend 接口；
 * - delete：委托 core `deleteSessionData`（running/interrupted → conflict），
 *   进程内不实现第二套清理语义。
 *
 * @module vessel/session-control
 */

import {
  deleteSessionData as coreDeleteSessionData,
  type DeleteSessionDataResult,
  type RunStore,
  type SessionBackend,
  type TenantPaths,
} from '../packages/core/src/index';

/** session 不存在 */
export class SessionNotFoundError extends Error {
  readonly code = 'not_found' as const;
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`not_found: session "${sessionId}"`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

/** 冻结的删除计数 */
export interface SessionDeleteResult {
  sessions_deleted: number;
  runs_deleted: number;
  events_deleted: number;
}

/** 注入的删除实现（测试 / core 尚未提供时的适配） */
export type DeleteSessionDataFn = (
  sessionId: string,
  opts: { session: SessionBackend; paths: TenantPaths; runStore?: RunStore },
) => Promise<SessionDeleteResult>;

/** session 控制面 */
export interface SessionControl {
  rename(sessionId: string, title: string): Promise<void>;
  delete(sessionId: string): Promise<SessionDeleteResult>;
}

/** createSessionControl 选项 */
export interface CreateSessionControlOptions {
  session: SessionBackend;
  paths: TenantPaths;
  runStore?: RunStore;
  deleteSessionData?: DeleteSessionDataFn;
}

/** 默认委托 core；trace 目录来自 TenantPaths */
function defaultDeleteSessionData(
  sessionId: string,
  opts: { session: SessionBackend; paths: TenantPaths; runStore?: RunStore },
): Promise<DeleteSessionDataResult> {
  return coreDeleteSessionData(sessionId, {
    session: opts.session,
    traceDir: opts.paths.events_dir,
    ...(opts.runStore ? { runStore: opts.runStore } : {}),
  });
}

/** 创建 session 控制面 */
export function createSessionControl(options: CreateSessionControlOptions): SessionControl {
  const deleteFn = options.deleteSessionData ?? defaultDeleteSessionData;

  return {
    async rename(sessionId: string, title: string): Promise<void> {
      const state = await options.session.load(sessionId);
      if (!state) throw new SessionNotFoundError(sessionId);
      state.title = title;
      state.updated_at = Date.now();
      await options.session.save(state);
    },

    async delete(sessionId: string): Promise<SessionDeleteResult> {
      return deleteFn(sessionId, {
        session: options.session,
        paths: options.paths,
        ...(options.runStore ? { runStore: options.runStore } : {}),
      });
    },
  };
}
