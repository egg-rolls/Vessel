/**
 * 删除 session 及其 runs/events（0.5 F1 / DECISION-010 §10.5、Addendum A-4 §11.3）
 *
 * - 有 running / interrupted run → `conflict`，零删除
 * - 否则删快照 + 按 session_id 清理 runs/events，返回计数
 * - 不新增 `SessionBackend` 方法；并发由上层单写者锁保证
 *
 * @module @vessel-agent/core/session
 */

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventStream } from '../types/event.js';
import type { RunStore } from '../types/run-store.js';
import type { SessionBackend } from '../types/session.js';
import { removeLegacySessionTrace, type SessionEventLog } from './session-event-log.js';

const PAGE_LIMIT = 200;
const MAX_PAGES = 10_000;

/** 删除 session 时存在活动 run */
export class SessionDeleteConflictError extends Error {
  readonly code = 'conflict' as const;
  readonly sessionId: string;
  readonly running: string[];
  readonly interrupted: string[];

  constructor(sessionId: string, running: string[], interrupted: string[]) {
    super(
      `conflict: session ${sessionId} has running/interrupted run(s) ` +
        `(running=${running.length}, interrupted=${interrupted.length})`,
    );
    this.name = 'SessionDeleteConflictError';
    this.sessionId = sessionId;
    this.running = running;
    this.interrupted = interrupted;
  }
}

/** 删除选项 */
export interface DeleteSessionDataOptions {
  session: SessionBackend;
  /** 有 durable 时必须传入，才能判定 running/interrupted 并清理 runs */
  runStore?: RunStore;
  /** tenant 的 events/ 目录；提供时同步删除 `<run>.jsonl` */
  traceDir?: string;
  events?: EventStream;
  tenantId?: string;
  /**
   * 0.18：会话事件日志。提供时删除 `sessions/<id>/` 整个目录
   * （events.ndjson + index.json），并先关闭写句柄（Windows 必需）。
   */
  eventLog?: SessionEventLog;
}

/** 删除计数（A-4 §11.3 + 1 追加：sessions_deleted 为 0/1） */
export interface DeleteSessionDataResult {
  sessions_deleted: number;
  runs_deleted: number;
  events_deleted: number;
}

/** 删除 session 快照与关联的 run/event 文件 */
export async function deleteSessionData(
  sessionId: string,
  options: DeleteSessionDataOptions,
): Promise<DeleteSessionDataResult> {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('invalid_session_id: session_id must be a non-empty string');
  }

  const { session, runStore, traceDir, events, tenantId, eventLog } = options;

  // 0.18：先读一次会话（损坏时抛 SessionCorruptError，不静默删除），
  // 用于区分「真正存在」与「不存在」——后者 sessions_deleted 必须为 0。
  const existingSession = await session.load(sessionId);

  // 冲突前置检查：分页遍历该 session 的全部 run，不只看第一页（0.8.1）。
  // 不删除任何东西。
  let hasRuns = false;
  if (runStore) {
    const running: string[] = [];
    const interrupted: string[] = [];
    let offset = 0;

    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const page = await runStore.list({ session_id: sessionId, limit: PAGE_LIMIT, offset });
      if (page.length > 0) hasRuns = true;
      for (const checkpoint of page) {
        if (checkpoint.status === 'running') running.push(checkpoint.run_id);
        else if (checkpoint.status === 'interrupted') interrupted.push(checkpoint.run_id);
      }
      if (page.length < PAGE_LIMIT) break;
      offset += page.length;
    }

    if (running.length > 0 || interrupted.length > 0) {
      throw new SessionDeleteConflictError(sessionId, running, interrupted);
    }
  }

  // 0.18：事件日志目录也是「会话存在」的一部分（可能 session 文件已迁移/缺失）。
  const hasEventLog = eventLog !== undefined ? await eventLog.hasSession(sessionId) : false;
  const existed = existingSession !== null || hasRuns || hasEventLog;

  await session.delete(sessionId);
  const sessionsDeleted = existed ? 1 : 0;

  let runsDeleted = 0;
  let eventsDeleted = 0;

  // 0.18：删除整个会话目录（先关句柄）。不存在时 no-op。
  if (eventLog !== undefined) {
    await eventLog.deleteSession(sessionId);
  }

  if (runStore) {
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const page = await runStore.list({ session_id: sessionId, limit: PAGE_LIMIT });
      if (page.length === 0) break;

      for (const checkpoint of page) {
        await runStore.delete(checkpoint.run_id);
        runsDeleted += 1;

        if (traceDir !== undefined) {
          try {
            await unlink(join(traceDir, `${encodeURIComponent(checkpoint.run_id)}.jsonl`));
            eventsDeleted += 1;
          } catch {
            // 文件不存在则不计入
          }
        }
      }
    }
  }

  // 0.5 的 session.deleted 曾以 sessionId 当 run_id 落成 `<sessionId>.jsonl`；
  // 这里顺手清掉，避免「删除反而留下孤儿文件」。
  if (traceDir !== undefined) {
    if (await removeLegacySessionTrace(traceDir, sessionId)) eventsDeleted += 1;
  }

  if (events) {
    try {
      events.publish({
        type: 'session.deleted',
        run_id: sessionId,
        data: {
          session_id: sessionId,
          sessions_deleted: sessionsDeleted,
          runs_deleted: runsDeleted,
          events_deleted: eventsDeleted,
        },
        ts: Date.now(),
        ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
      });
    } catch {
      // 事件投递失败不改变删除结果
    }
  }

  return {
    sessions_deleted: sessionsDeleted,
    runs_deleted: runsDeleted,
    events_deleted: eventsDeleted,
  };
}
