/**
 * session liveness 对账（0.18）。
 *
 * 唯一持久归属证据是现有 session / run 写锁（pid + host + started_at）：
 * 进程被 SIGKILL / 断电 / 原生崩溃后，session 与 index 会永久停在 `running`。
 * 本模块在读完锁状态后，用同一把 session 写锁串行修复：
 * 追加一条 `run.failed`（`error_code: 'process_lost'`）、落 session / index 终态，
 * 并把仍为 running 的 durable checkpoint 标为 `interrupted`（保留可 resume）。
 *
 * 幂等 / 多实例安全：
 * - 锁 live 或 unparseable（宽限内）→ 保守跳过（resume 只持 run 锁，也要看 run 锁）；
 * - 抢不到 session 写锁 → 另一个实例正在处理 / 活着 → 跳过；
 * - 锁内重读 session，已非 running → no-op；
 * - 已有本 run 的终态事件 → 不重复追加，只补状态与游标。
 *
 * @module vessel/session-liveness
 */

import type {
  Logger,
  RunCheckpoint,
  RunState,
  RunStore,
  SessionBackend,
  SessionEventLog,
  SessionInfo,
} from '../packages/core/src/index';
import {
  acquireSessionLock,
  inspectSessionLock,
  SessionLockedError,
  type SessionLockInspection,
} from './session-lock';

/** 崩溃 run 的统一错误文本（与优雅 shutdown 的 interrupted checkpoint 语义对齐） */
const RUN_LOST_ERROR = 'run lost: owning process exited before completion';

/** 会话终态事件名（既有事件面，不新增） */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

export interface SessionLivenessContext {
  tenantDir: string;
  /** 原始 backend（与调用方暴露的是同一实例） */
  session: SessionBackend;
  eventLog?: SessionEventLog;
  runStore?: RunStore;
  logger: Logger;
  now?: () => number;
  hostname?: string;
  isPidAlive?: (pid: number) => boolean;
}

export type ReconcileOutcome = 'ok' | 'live' | 'repaired' | 'error';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 锁探针选项（注入 now / host / pid 存活，测试与多平台一致） */
function inspectOptions(ctx: SessionLivenessContext): {
  now?: () => number;
  hostname?: string;
  isPidAlive?: (pid: number) => boolean;
} {
  return {
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
    ...(ctx.hostname !== undefined ? { hostname: ctx.hostname } : {}),
    ...(ctx.isPidAlive !== undefined ? { isPidAlive: ctx.isPidAlive } : {}),
  };
}

/**
 * 对账单个 session；永不抛出。
 *
 * - `ok`：不是 running / 锁内发现已被别人修好
 * - `live`：session 锁或 run 锁显示仍有活着的写者（含宽限内的不可解析锁）
 * - `repaired`：本次写入了终态
 * - `error`：任何未预期错误（已记日志）
 */
export async function reconcileSession(
  sessionId: string,
  ctx: SessionLivenessContext,
): Promise<ReconcileOutcome> {
  const now = ctx.now ?? Date.now;
  const opts = inspectOptions(ctx);

  try {
    const initial = await ctx.session.load(sessionId);
    if (initial === null || initial.status !== 'running') return 'ok';

    // 1) 只读探针：session 写锁活着 → 跳过。
    const sessionLock: SessionLockInspection = await inspectSessionLock(
      ctx.tenantDir,
      'session',
      sessionId,
      opts,
    );
    if (sessionLock.state === 'live' || sessionLock.state === 'unparseable') return 'live';

    // 2) resume 只持 run 锁 → run 锁活着同样跳过。
    const runLock: SessionLockInspection = await inspectSessionLock(
      ctx.tenantDir,
      'run',
      initial.run_id,
      opts,
    );
    if (runLock.state === 'live' || runLock.state === 'unparseable') return 'live';

    // 3) 抢占 session 写锁；冲突说明别的实例正在处理。
    let lock: Awaited<ReturnType<typeof acquireSessionLock>>;
    try {
      lock = await acquireSessionLock({
        tenantDir: ctx.tenantDir,
        kind: 'session',
        id: sessionId,
        ...opts,
      });
    } catch (error) {
      if (error instanceof SessionLockedError) return 'live';
      throw error;
    }

    try {
      // 4) 锁内重读：并发修复 / 正常结束已抢先。
      const state = await ctx.session.load(sessionId);
      if (state === null || state.status !== 'running') return 'ok';

      // 5) 游标：已有本 run 的终态事件 → 不追加，只同步；否则追加一条 process_lost。
      let cursor: number | undefined;
      if (ctx.eventLog !== undefined) {
        const records = await ctx.eventLog.read(sessionId);
        const hasTerminal = records.some(
          (record) => record.run_id === state.run_id && TERMINAL_EVENT_TYPES.has(record.type),
        );
        if (hasTerminal) {
          cursor = records.reduce((max, record) => Math.max(max, record.seq), 0);
        } else {
          const ts = now();
          const appended = await ctx.eventLog.append({
            session_id: sessionId,
            run_id: state.run_id,
            ts,
            type: 'run.failed',
            data: {
              run_id: state.run_id,
              session_id: sessionId,
              error: RUN_LOST_ERROR,
              duration_ms: Math.max(0, ts - state.started_at),
              error_code: 'process_lost',
              category: 'internal',
              phase: 'run',
              retryable: false,
            },
          });
          cursor = appended.seq;
        }
      } else {
        cursor = state.derived_upto_seq;
      }

      // 6) session 终态；updated_at 必须显式写（FileSessionBackend 会复用已加载值）。
      const completedAt = now();
      const failed: RunState = {
        ...state,
        status: 'failed',
        completed_at: completedAt,
        updated_at: completedAt,
        error: RUN_LOST_ERROR,
        ...(cursor !== undefined ? { derived_upto_seq: cursor } : {}),
      };
      await ctx.session.save(failed);

      // 7) index 同步（best-effort 语义由调用方决定；这里失败即上报 error）。
      if (ctx.eventLog !== undefined) {
        await ctx.eventLog.updateIndex(sessionId, {
          status: 'failed',
          updated_at: completedAt,
          ...(cursor !== undefined ? { event_count: cursor, derived_upto_seq: cursor } : {}),
        });
      }

      // 8) durable checkpoint：running → interrupted，保留 resume 能力（best-effort）。
      if (ctx.runStore !== undefined) {
        try {
          const checkpoint = await ctx.runStore.load(state.run_id);
          if (checkpoint !== null && checkpoint.status === 'running') {
            const interrupted: RunCheckpoint = {
              ...checkpoint,
              status: 'interrupted',
              error: RUN_LOST_ERROR,
              error_envelope: {
                error_code: 'process_lost',
                category: 'internal',
                phase: 'run',
                retryable: false,
              },
              updated_at: completedAt,
              event_cursor: cursor ?? checkpoint.event_cursor,
            };
            await ctx.runStore.save(interrupted);
          }
        } catch (error) {
          ctx.logger.warn(`session liveness: checkpoint update failed: ${errorText(error)}`, {
            session_id: sessionId,
            run_id: state.run_id,
            error: errorText(error),
          });
        }
      }

      return 'repaired';
    } finally {
      await lock.release();
    }
  } catch (error) {
    ctx.logger.warn(`session liveness: reconcile failed: ${errorText(error)}`, {
      session_id: sessionId,
      error: errorText(error),
    });
    return 'error';
  }
}

/**
 * 启动 / 读时 sweep：只处理 `status === 'running'` 的 session。
 * 单个 session 失败只记日志，绝不阻断启动。
 */
export async function reconcileStaleSessions(
  ctx: SessionLivenessContext,
): Promise<{ checked: number; repaired: string[]; errors: string[] }> {
  let infos: SessionInfo[];
  try {
    infos = await ctx.session.listRich();
  } catch (error) {
    ctx.logger.warn(`session liveness: listRich failed: ${errorText(error)}`, {
      error: errorText(error),
    });
    return { checked: 0, repaired: [], errors: [] };
  }

  const repaired: string[] = [];
  const errors: string[] = [];
  let checked = 0;
  for (const info of infos) {
    if (info.status !== 'running') continue;
    checked += 1;
    try {
      const outcome = await reconcileSession(info.session_id, ctx);
      if (outcome === 'repaired') repaired.push(info.session_id);
      else if (outcome === 'error') errors.push(info.session_id);
    } catch (error) {
      errors.push(info.session_id);
      ctx.logger.warn(`session liveness: sweep failed: ${errorText(error)}`, {
        session_id: info.session_id,
        error: errorText(error),
      });
    }
  }
  return { checked, repaired, errors };
}

/**
 * 包装 backend：`load` / `listRich` 读时兜底修复。
 * 修复失败不影响读（上层已把错误收进 `reconcileSession`）。
 */
export function withLivenessRepair(
  backend: SessionBackend,
  ctx: SessionLivenessContext,
): SessionBackend {
  return {
    async load(sessionId: string): Promise<RunState | null> {
      await reconcileSession(sessionId, ctx);
      return backend.load(sessionId);
    },
    save(state: RunState): Promise<void> {
      return backend.save(state);
    },
    delete(sessionId: string): Promise<void> {
      return backend.delete(sessionId);
    },
    list(): Promise<string[]> {
      return backend.list();
    },
    async listRich(): Promise<SessionInfo[]> {
      const infos = await backend.listRich();
      for (const info of infos) {
        if (info.status !== 'running') continue;
        try {
          await reconcileSession(info.session_id, ctx);
        } catch (error) {
          ctx.logger.warn(`session liveness: list repair failed: ${errorText(error)}`, {
            session_id: info.session_id,
            error: errorText(error),
          });
        }
      }
      // 第二次读取拿到修复后的 status（backend 是唯一存储面）。
      return backend.listRich();
    },
    close(): void {
      backend.close?.();
    },
  };
}
