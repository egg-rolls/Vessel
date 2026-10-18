/**
 * 删除 session 及其 runs/events（0.5 F1 / DECISION-010 §10.5、Addendum A-4 §11.3）
 *
 * - 有 running / interrupted run → `conflict`，零删除
 * - 否则删快照 + 按 session_id 清理 runs/events，返回计数
 * - 不新增 `SessionBackend` 方法；并发由上层单写者锁保证
 *
 * @module @vessel/core/session
 */

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventStream } from '../types/event.js';
import type { RunStore } from '../types/run-store.js';
import type { SessionBackend } from '../types/session.js';

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

  const { session, runStore, traceDir, events, tenantId } = options;

  // 冲突前置检查：不删除任何东西
  if (runStore) {
    const page = await runStore.list({ session_id: sessionId, limit: PAGE_LIMIT });
    const running = page.filter((c) => c.status === 'running').map((c) => c.run_id);
    const interrupted = page.filter((c) => c.status === 'interrupted').map((c) => c.run_id);
    if (running.length > 0 || interrupted.length > 0) {
      throw new SessionDeleteConflictError(sessionId, running, interrupted);
    }
  }

  await session.delete(sessionId);
  const sessionsDeleted = 1;

  let runsDeleted = 0;
  let eventsDeleted = 0;

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
