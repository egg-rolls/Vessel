/**
 * session rename / delete（0.5 E15 / A-3 §10.5、A-4 §11.3）
 *
 * - rename：load → 改 title → save；不改 session_id，不扩展 SessionStore 接口；
 * - delete：委托 core `deleteSessionData`（running/interrupted → conflict），
 *   进程内不实现第二套清理语义。
 *
 * @module vessel/session-control
 */

import {
  deleteSessionData as coreDeleteSessionData,
  type DeleteSessionDataResult,
  type EventStream,
  type RunRecordStore,
  type SessionEventLog,
  type SessionStore,
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
  opts: {
    session: SessionStore;
    paths: TenantPaths;
    runStore?: RunRecordStore;
    events?: EventStream;
    tenantId?: string;
    eventLog?: SessionEventLog;
  },
) => Promise<SessionDeleteResult>;

/** session 控制面 */
export interface SessionControl {
  rename(sessionId: string, title: string): Promise<void>;
  delete(sessionId: string): Promise<SessionDeleteResult>;
  /**
   * 0.34 Stage 3：AgentService 晚于 tenant bundle 构造，删除前钩子需要回填。
   * 未回填时 delete 行为与旧版一致。
   */
  setDetachSession(detach: ((sessionId: string) => Promise<void>) | undefined): void;
}

/** createSessionControl 选项 */
export interface CreateSessionControlOptions {
  session: SessionStore;
  paths: TenantPaths;
  runStore?: RunRecordStore;
  /** 传入后 core 会发 `session.deleted`（带计数） */
  events?: EventStream;
  /** 0.18：删除会话时同目录清理事件日志（events.ndjson + index.json） */
  eventLog?: SessionEventLog;
  /**
   * 0.34 Stage 3：删除前的权威钩子（`AgentService.detachSession`）。
   * 冲突（active run / 活 SessionLease）必须抛 `conflict`，且不得删除任何数据。
   */
  detachSession?: (sessionId: string) => Promise<void>;
  deleteSessionData?: DeleteSessionDataFn;
}

/** 默认委托 core；trace 目录 / events / tenant 均原样透传 */
function defaultDeleteSessionData(
  sessionId: string,
  opts: {
    session: SessionStore;
    paths: TenantPaths;
    runStore?: RunRecordStore;
    events?: EventStream;
    eventLog?: SessionEventLog;
  },
): Promise<DeleteSessionDataResult> {
  return coreDeleteSessionData(sessionId, {
    session: opts.session,
    traceDir: opts.paths.events_dir,
    ...(opts.runStore ? { runStore: opts.runStore } : {}),
    ...(opts.events ? { events: opts.events } : {}),
    ...(opts.eventLog ? { eventLog: opts.eventLog } : {}),
  });
}

/** 创建 session 控制面 */
export function createSessionControl(options: CreateSessionControlOptions): SessionControl {
  const deleteFn = options.deleteSessionData ?? defaultDeleteSessionData;
  let detachSession = options.detachSession;

  return {
    setDetachSession(detach: ((sessionId: string) => Promise<void>) | undefined): void {
      detachSession = detach;
    },

    async rename(sessionId: string, title: string): Promise<void> {
      const state = await options.session.load(sessionId);
      if (!state) throw new SessionNotFoundError(sessionId);
      state.title = title;
      state.updated_at = Date.now();
      await options.session.save(state);
    },

    async delete(sessionId: string): Promise<SessionDeleteResult> {
      // 先 detach（dispose EU / 释放租约 / 退役 binding），再走 core 数据删除。
      if (detachSession !== undefined) await detachSession(sessionId);
      return deleteFn(sessionId, {
        session: options.session,
        paths: options.paths,
        ...(options.runStore ? { runStore: options.runStore } : {}),
        ...(options.events ? { events: options.events } : {}),
        ...(options.eventLog ? { eventLog: options.eventLog } : {}),
      });
    },
  };
}
