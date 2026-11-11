/**
 * session liveness 对账（0.18）。
 *
 * 「写者是否还活着」有三份持久证据，按时代叠加：
 *   1) session 写锁（0.15）：进程级长锁 / 旧版运行时；
 *   2) run 写锁（`resumeRun()` 路径，见 session-lock-runtime）；
 *   3) **SessionLease**（0.34 Stage 3 起 session 级排他的持有物）：
 *      `<tenantDir>/.locks/leases/sessions/<sha16(session_id)>.lease`，
 *      ExecutionUnit 在首个 run 前 acquire、run 落终态后才 release。
 * 任何一份显示活写者 → `live`，什么都不写。三份都失效才认定写者已死：
 * 进程被 SIGKILL / 断电 / 原生崩溃后，session 与 index 会永久停在 `running`。
 * 本模块在读完证据后，用同一把 session 写锁串行修复：
 * 追加一条 `run.failed`（`error_code: 'process_lost'`）、落 session / index 终态，
 * 并把仍为 running 的 durable checkpoint 标为 `interrupted`（保留可 resume）。
 *
 * 只看 (1)(2) 会漏判：0.34 Stage 3 之后正常运行的 session **不持文件锁**，
 * 于是「status === 'running' + 两把文件锁 absent」并不等于写者已死。
 * 判活口径（TTL / pid / 主机）不在本模块复制，全部来自 lease-service 的
 * `isRecordHeld` 与 session-lock 的 `isStale`。
 *
 * 幂等 / 多实例安全：
 * - 任一份证据 live 或不可解析（宽限内）→ 保守跳过；
 * - 抢不到 session 写锁 → 另一个实例正在处理 / 活着 → 跳过；
 * - 锁内重读 session，已非 running → no-op；
 * - 已有本 run 的终态事件 → 不重复追加，只补状态与游标。
 *
 * @module vessel/session-liveness
 */

import {
  type Logger,
  type RunRecord,
  type RunRecordStore,
  type SessionEventLog,
  type SessionInfo,
  type SessionState,
  type SessionStore,
  toSessionInfo,
} from '../packages/core/src/index';
import { inspectSessionLease } from './lease-service';
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
  session: SessionStore;
  eventLog?: SessionEventLog;
  runStore?: RunRecordStore;
  logger: Logger;
  now?: () => number;
  hostname?: string;
  /**
   * pid 存活探测；文件锁（`session-lock.isStale`）与 SessionLease（`lease-service.isRecordHeld`）
   * 共用同一份，别让两条判活路径对同一个 pid 得出不同结论。
   */
  isPidAlive?: (pid: number) => boolean;
}

export type ReconcileOutcome = 'ok' | 'live' | 'repaired' | 'error';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 锁 / 租约探针共用选项（注入 now / host / pid 存活，测试与多平台一致） */
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
 * - `live`：仍有活着的写者（session 锁 / run 锁 / SessionLease 任一 live，或宽限内的
 *   不可解析锁 / 租约文件）
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
    const runId = initial.last_run_id;
    if (runId !== undefined) {
      const runLock: SessionLockInspection = await inspectSessionLock(
        ctx.tenantDir,
        'run',
        runId,
        opts,
      );
      if (runLock.state === 'live' || runLock.state === 'unparseable') return 'live';
    }

    // 3) 0.34 Stage 3 起 session 级排他由 SessionLease 承担：正常运行的 run 不持文件锁，
    //    只持 `<tenantDir>/.locks/leases/sessions/<sha16(session_id)>.lease`（EU 在
    //    run.started / 首次 SessionState 落盘之前 acquire，run 终态之后 release）。
    //    漏掉这一步，文件锁 absent 就会被当成写者已死 → 给活 run 追加假 run.failed。
    //    判活口径（held / TTL / pid / 主机）全部来自 lease-service，这里不做第二套时间判断；
    //    排在文件锁之后只是顺序，三者都是 live 短路，结论相同。
    const lease = await inspectSessionLease(ctx.tenantDir, sessionId, opts);
    if (lease.state === 'live' || lease.state === 'unparseable') return 'live';

    // 4) 抢占 session 写锁；冲突说明别的实例正在处理。
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
      // 5) 锁内重读：并发修复 / 正常结束已抢先。
      const state = await ctx.session.load(sessionId);
      if (state === null || state.status !== 'running') return 'ok';

      // 5b) 锁内复查租约：探针到抢锁之间可能来了新 run（它只取租约，不挡文件锁），
      //     此时下面读到的 last_run_id 属于一个活 run —— 再探一次就不必靠时序运气。
      const recheck = await inspectSessionLease(ctx.tenantDir, sessionId, opts);
      if (recheck.state === 'live' || recheck.state === 'unparseable') return 'live';

      // 6) 最近 RunRecord：run 级进度只读这里，不回溯到 SessionState。
      const runId = state.last_run_id;
      let record: RunRecord | null = null;
      if (ctx.runStore !== undefined && runId !== undefined) {
        try {
          record = await ctx.runStore.load(runId);
        } catch (error) {
          ctx.logger.warn(`session liveness: RunRecord load failed: ${errorText(error)}`, {
            session_id: sessionId,
            run_id: runId,
            error: errorText(error),
          });
        }
      }

      // 7) 游标：已有本 run 的终态事件 → 不追加，只同步；否则追加一条 process_lost。
      let cursor: number | undefined;
      if (ctx.eventLog !== undefined && runId !== undefined) {
        const records = await ctx.eventLog.read(sessionId);
        const hasTerminal = records.some(
          (entry) => entry.run_id === runId && TERMINAL_EVENT_TYPES.has(entry.type),
        );
        if (hasTerminal) {
          cursor = records.reduce((max, entry) => Math.max(max, entry.seq), 0);
        } else {
          const ts = now();
          const appended = await ctx.eventLog.append({
            session_id: sessionId,
            run_id: runId,
            ts,
            type: 'run.failed',
            data: {
              run_id: runId,
              session_id: sessionId,
              error: RUN_LOST_ERROR,
              duration_ms: Math.max(0, ts - (record?.created_at ?? state.created_at)),
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

      // 8) SessionState 终态：只写派生字段 status / updated_at / derived_upto_seq。
      //    updated_at 必须显式写（FileSessionStore 会复用已加载值）。
      const completedAt = now();
      const failed: SessionState = {
        ...state,
        status: 'interrupted',
        updated_at: completedAt,
        ...(cursor !== undefined ? { derived_upto_seq: cursor } : {}),
      };
      await ctx.session.save(failed);

      // 9) index 同步（best-effort 语义由调用方决定；这里失败即上报 error）。
      if (ctx.eventLog !== undefined) {
        await ctx.eventLog.updateIndex(sessionId, {
          status: 'interrupted',
          updated_at: completedAt,
          ...(cursor !== undefined ? { event_count: cursor, derived_upto_seq: cursor } : {}),
        });
      }

      // 10) RunRecord 受控例外（Q1）：仅 running → interrupted。
      //    只改 status / error / error_envelope / updated_at / event_cursor；
      //    不写 usage / iteration / branch / agent_id。
      if (ctx.runStore !== undefined && record !== null && record.status === 'running') {
        try {
          const interrupted: RunRecord = {
            ...record,
            status: 'interrupted',
            error: RUN_LOST_ERROR,
            error_envelope: {
              error_code: 'process_lost',
              category: 'internal',
              phase: 'run',
              retryable: false,
            },
            updated_at: completedAt,
            event_cursor: cursor ?? record.event_cursor,
          };
          await ctx.runStore.save(interrupted);
        } catch (error) {
          ctx.logger.warn(`session liveness: RunRecord update failed: ${errorText(error)}`, {
            session_id: sessionId,
            ...(runId !== undefined ? { run_id: runId } : {}),
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
  backend: SessionStore,
  ctx: SessionLivenessContext,
): SessionStore {
  return {
    async load(sessionId: string): Promise<SessionState | null> {
      await reconcileSession(sessionId, ctx);
      return backend.load(sessionId);
    },
    save(state: SessionState): Promise<void> {
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
      // 只为「本次真的改了状态」的会话重读，不再整表二次 listRich()。
      // running 是对话进行中的常态（正是最需要低延迟的时刻），旧实现会把
      // Σ会话字节 的 parse 翻倍；现在稳态下第二遍是 0 次。
      const repaired = new Set<string>();
      for (const info of infos) {
        if (info.status !== 'running') continue;
        try {
          if ((await reconcileSession(info.session_id, ctx)) === 'repaired') {
            repaired.add(info.session_id);
          }
        } catch (error) {
          ctx.logger.warn(`session liveness: list repair failed: ${errorText(error)}`, {
            session_id: info.session_id,
            error: errorText(error),
          });
        }
      }
      if (repaired.size === 0) return infos;

      // 修复后的 status/timestamps 以 backend 为准（它是唯一存储面）；
      // 保持原顺序：修复只会把 updated_at 推到 now，重排会让列表在这一次读里跳动。
      const patched: SessionInfo[] = [];
      for (const info of infos) {
        if (!repaired.has(info.session_id)) {
          patched.push(info);
          continue;
        }
        try {
          const state = await backend.load(info.session_id);
          patched.push(state !== null ? toSessionInfo(state) : info);
        } catch {
          patched.push(info);
        }
      }
      return patched;
    },
    close(): void {
      backend.close?.();
    },
  };
}
