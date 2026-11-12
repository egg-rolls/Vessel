/**
 * `vessel prune` 的候选扫描与删除（0.51 待办 #1）。
 *
 * 只做三类，判据全部落在现成字段上（不新增数据字段）：
 *
 * - trace：`events/*.jsonl` 按 `config.trace` 的留存策略 —— 复用 `pruneTenantTrace`，
 *   装配层不重写挑选规则；
 * - runs：`RunRecord.status ∈ {completed, failed, cancelled}` 且 `updated_at` 早于阈值；
 * - sessions：`SessionState.updated_at`（与该会话 run 的 `updated_at` 取较大者）早于阈值，
 *   且不在活跃集合里。
 *
 * 三个桶**互斥**（同一个对象只有一个主人），所以 dry-run 报的数字就是 `--yes` 会删掉的
 * 数字，不会出现「预演 10 条、真删 7 条」：
 *
 * - trace 桶独占 `events/*.jsonl`，所以会话级联删除**不传** traceDir；
 * - runs 桶只收不属于「待删会话」的 run 记录 —— 被删会话的 run 归会话级联；
 * - sessions 桶用 core `deleteSessionData` 级联删掉会话壳、`sessions/<id>/` 事件日志目录
 *   和该会话的 run 记录。
 *
 * events/ 里唯一的例外是历史上以 `<sessionId>.jsonl` 落盘的会话 trace：它不是 run trace，
 * trace 桶按「没有终态事件 → 受保护」永远不会删它（会永久残留），因此由会话桶顺手清掉，
 * 计入 `events_deleted`。
 *
 * 活跃集合 = 会话写锁 live/unparseable ∪ 会话租约 live/unparseable ∪ 该会话还有
 * running/interrupted run。前两份是「写者还活着」的持久证据（与 session-liveness 同口径），
 * 后者是「还能 resume」的证据；任一成立都不删。
 *
 * 本单不做（不是 TODO，是口径）：`--archived` / `sessions.archive` / `agents.archived_at`。
 * sessions 目前没有归档概念 —— `SessionState` 只有 `created_at` / `updated_at`，没有 archived
 * 标记，`--archived` 在这份数据上定义不出「该删哪些」；等归档字段真正落盘，再按同样的
 * 「桶 + 判据」形状加一维，先不落半语义。
 *
 * @module vessel/prune-wiring
 */

import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { VesselConfig } from '../packages/config/src/index';
import {
  deleteSessionData as coreDeleteSessionData,
  encodeSessionDirName,
  noopLogger,
  type PruneTraceResult,
  type RunRecord,
  type RunRecordStore,
  removeLegacySessionTrace,
  SessionEventLog,
  type SessionStore,
  sessionDirPath,
  type TenantPaths,
} from '../packages/core/src/index';
import { inspectSessionLease } from './lease-service';
import {
  createRunRecordStore,
  resolveDurableOptions,
  resolveRunStorePath,
} from './run-record-store-factory';
import { createSessionStore } from './session-factory';
import { inspectSessionLock } from './session-lock';
import { pruneTenantTrace } from './trace-wiring';

/** 单页上限（与 `RunRecordStore.list` 实现的硬上限一致） */
const PAGE_LIMIT = 200;
/** 防御性页数上限：自定义 store 不推进 offset 时不死循环 */
const MAX_PAGES = 10_000;
/** 终态：只有这些状态的 run 记录会被 runs 桶删除 */
const TERMINAL_STATUSES: ReadonlySet<RunRecord['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
]);
/** 写者证据：这两种探针状态表示「可能还有进程在写」 */
const LIVE_STATES: ReadonlySet<string> = new Set(['live', 'unparseable']);
const DAY_MS = 86_400_000;

/** `--older-than` 缺省阈值：与 `trace.retentionDays` 的缺省 30 天同口径 */
export const DEFAULT_PRUNE_OLDER_THAN_MS = 30 * DAY_MS;

/** 报告里的技术性提示（文案由命令层走 i18n） */
export type PruneNote = 'sessions_backend_not_readonly' | 'durable_disabled';

/** trace 桶计数（A-4 §11.3 冻结形状，原样透传 core） */
export type TraceBucketTally = PruneTraceResult;

/** runs 桶计数 */
export interface RunsBucketTally {
  /** 已删（dry-run：将删）的 run 记录条数 */
  deleted: number;
  bytes: number;
}

/** sessions 桶计数（含级联删掉的东西） */
export interface SessionsBucketTally {
  deleted: number;
  bytes: number;
  /** 级联删掉的 run 记录数 */
  runs_deleted: number;
  /** 级联删掉的历史 `<sessionId>.jsonl` 会话 trace 数 */
  events_deleted: number;
}

/** 一次 prune 的汇总（`--json` 直接序列化这个形状） */
export interface PruneReport {
  dry_run: boolean;
  data_dir: string;
  tenant_id: string;
  older_than_ms: number;
  categories: {
    trace: TraceBucketTally;
    runs: RunsBucketTally;
    sessions: SessionsBucketTally;
  };
  skipped: {
    /** 超出阈值但仍在活跃集合里（锁 / 租约 / running 或 interrupted run） */
    active_sessions: number;
    /** 扫描或删除被 core 守卫拒绝（不可读 / 冲突），零删除 */
    refused_sessions: number;
  };
  /** 三个桶合计：条目数 = trace 文件 + run 记录 + 会话 */
  totals: { deleted: number; bytes: number };
  notes: PruneNote[];
}

/** 扫描/执行上下文（时钟与 pid 存活判定可注入，便于测试与多平台一致） */
export interface PruneContext {
  config: VesselConfig;
  tenantPaths: TenantPaths;
  tenantId: string;
  /** 判老阈值（ms） */
  olderThanMs: number;
  /** 固定时钟：dry-run 与真删同一口径，且不做第二次 Date.now() */
  now: number;
  hostname?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
}

/** 待删 run 记录 */
interface RunCandidate {
  run_id: string;
  bytes: number;
}

/** 待删会话（含级联对象） */
interface SessionCandidate {
  session_id: string;
  bytes: number;
  /** 该会话的 run 记录：dry-run 用来预估级联计数，真删由 core 自行分页 */
  runs: RunRecord[];
}

interface SessionScan {
  candidates: SessionCandidate[];
  active: number;
  refused: number;
}

/** 锁 / 租约探针共用选项；`now` 是函数形态，用固定时钟包一层 */
function probeOptions(ctx: PruneContext): {
  now: () => number;
  hostname?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
} {
  return {
    now: () => ctx.now,
    hostname: ctx.hostname,
    pid: ctx.pid,
    isPidAlive: ctx.isPidAlive,
  };
}

/** 文件大小；不存在 / 不是普通文件按 0 */
async function fileSize(target: string): Promise<number> {
  try {
    const info = await stat(target);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

/** 是否是存在的文件（0 字节也算存在；报体积用不上这个区分，判存在用得上） */
async function fileExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/** 目录递归大小；不跟随 symlink，读不动就当 0（只用于报体积，不值得失败） */
async function treeSize(target: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const child = join(target, entry);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(child);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) {
      total += info.size;
    } else if (info.isDirectory()) {
      total += await treeSize(child);
    } else if (info.isFile()) {
      total += info.size;
    }
  }
  return total;
}

/** run 记录目录：与 `createRunRecordStore` 用同一份解析，避免报体积时看错目录 */
function resolveRunsDir(config: VesselConfig, tenantRunsDir: string): string | undefined {
  const durable = resolveDurableOptions(config, { tenantRunsDir });
  if (!durable.enabled || durable.backend !== 'file') return undefined;
  return resolveRunStorePath(durable.path);
}

/** run 记录文件（编码规则与 FileRunRecordStore 一致）；目录未知时 undefined */
function runRecordPath(runsDir: string | undefined, runId: string): string | undefined {
  if (runsDir === undefined) return undefined;
  try {
    return join(runsDir, `${encodeURIComponent(runId)}.json`);
  } catch {
    return undefined;
  }
}

/** 会话壳文件（file 后端布局；其它后端没有这个文件） */
function sessionShellPath(ctx: PruneContext, sessionId: string): string | undefined {
  try {
    return join(ctx.tenantPaths.sessions_dir, `${encodeSessionDirName(sessionId)}.json`);
  } catch {
    return undefined;
  }
}

/** 分页列出全部 run 记录（单页上限 200；`list` 每次全表扫描后切片） */
async function listAllRuns(
  store: RunRecordStore,
  filter: { session_id?: string } = {},
): Promise<RunRecord[]> {
  const all: RunRecord[] = [];
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const page = await store.list({ ...filter, limit: PAGE_LIMIT, offset: all.length });
    all.push(...page);
    if (page.length < PAGE_LIMIT) break;
  }
  return all;
}

/** 会话还活着吗：写锁 / 租约任一显示 live 或宽限内不可解析即算活 */
async function sessionHasLiveWriter(ctx: PruneContext, sessionId: string): Promise<boolean> {
  const options = probeOptions(ctx);
  const lock = await inspectSessionLock(ctx.tenantPaths.root, 'session', sessionId, options);
  if (LIVE_STATES.has(lock.state)) return true;
  const lease = await inspectSessionLease(ctx.tenantPaths.root, sessionId, options);
  return LIVE_STATES.has(lease.state);
}

/**
 * 待删会话扫描。
 *
 * `sessionStore` 为 undefined 时（memory 后端 / dry-run 的 sqlite 后端）该桶为空。
 */
async function scanStaleSessions(
  ctx: PruneContext,
  sessionStore: SessionStore | undefined,
  runStore: RunRecordStore | undefined,
): Promise<SessionScan> {
  const scan: SessionScan = { candidates: [], active: 0, refused: 0 };
  if (sessionStore === undefined) return scan;

  let sessionIds: string[];
  try {
    sessionIds = await sessionStore.list();
  } catch {
    return scan;
  }

  const cutoff = ctx.now - ctx.olderThanMs;
  for (const sessionId of sessionIds) {
    let state: Awaited<ReturnType<SessionStore['load']>>;
    try {
      state = await sessionStore.load(sessionId);
    } catch {
      // 损坏的会话文件：不猜、不删，报成「被守卫拒绝」
      scan.refused += 1;
      continue;
    }
    if (state === null) continue;

    const runs =
      runStore === undefined ? [] : await listAllRuns(runStore, { session_id: sessionId });
    // 最后活动：会话壳的 updated_at 与其 run 的 updated_at 取较大者（都取现成字段）。
    const lastActivity = runs.reduce(
      (latest, run) => Math.max(latest, run.updated_at),
      state.updated_at,
    );
    if (lastActivity >= cutoff) continue;

    // 还能 resume 的 run / 活写者都算活跃：宁可留，不可错删。
    const resumable = runs.some((run) => run.status === 'running' || run.status === 'interrupted');
    if (resumable || (await sessionHasLiveWriter(ctx, sessionId))) {
      scan.active += 1;
      continue;
    }

    const shellPath = sessionShellPath(ctx, sessionId);
    const runsDir = resolveRunsDir(ctx.config, ctx.tenantPaths.runs_dir);
    let bytes = shellPath === undefined ? 0 : await fileSize(shellPath);
    bytes += await treeSize(sessionDirPath(ctx.tenantPaths.sessions_dir, sessionId));
    for (const run of runs) {
      const path = runRecordPath(runsDir, run.run_id);
      if (path !== undefined) bytes += await fileSize(path);
    }
    scan.candidates.push({ session_id: sessionId, bytes, runs });
  }
  return scan;
}

/** 待删 run 记录扫描：终态 + 早于阈值 + 不属于待删会话 */
async function scanTerminalRuns(
  ctx: PruneContext,
  runStore: RunRecordStore | undefined,
  excludedSessions: ReadonlySet<string>,
): Promise<RunCandidate[]> {
  if (runStore === undefined) return [];
  const runsDir = resolveRunsDir(ctx.config, ctx.tenantPaths.runs_dir);
  const cutoff = ctx.now - ctx.olderThanMs;
  const candidates: RunCandidate[] = [];
  for (const record of await listAllRuns(runStore)) {
    if (!TERMINAL_STATUSES.has(record.status)) continue;
    if (record.updated_at >= cutoff) continue;
    if (excludedSessions.has(record.session_id)) continue;
    const path = runRecordPath(runsDir, record.run_id);
    candidates.push({
      run_id: record.run_id,
      bytes: path === undefined ? 0 : await fileSize(path),
    });
  }
  return candidates;
}

/** 会话事件日志目录的删除句柄（真删才需要；构造本身不写盘） */
function createEventLog(ctx: PruneContext): SessionEventLog {
  return new SessionEventLog({
    dir: ctx.tenantPaths.sessions_dir,
    tenantId: ctx.tenantId,
    logger: noopLogger,
  });
}

/**
 * sqlite 后端的构造器会建库 / 建表（写盘），dry-run 必须保持只读，所以这一桶在 dry-run
 * 里跳过并给一条 note；memory 后端没有持久会话，直接空桶。
 */
function openSessionStore(
  ctx: PruneContext,
  dryRun: boolean,
): { store?: SessionStore; notReadonly: boolean } {
  const backend = ctx.config.session?.backend ?? 'file';
  if (backend === 'memory') return { notReadonly: false };
  if (backend === 'sqlite' && dryRun) return { notReadonly: true };
  return {
    store: createSessionStore(ctx.config.session, {
      tenantSessionsDir: ctx.tenantPaths.sessions_dir,
      tenantSessionsDbPath: join(ctx.tenantPaths.root, 'sessions.db'),
      tenantId: ctx.tenantId,
    }),
    notReadonly: false,
  };
}

/** 会话级联删除的计数（体积由调用方按扫描时测得的字节数记账） */
interface SessionCascadeCount {
  sessions_deleted: number;
  runs_deleted: number;
  events_deleted: number;
}

/**
 * 删一个会话：core 负责冲突守卫与级联计数；`traceDir` 不传（见模块头注释）。
 * 返回 undefined 表示 core 拒绝（冲突 / 不可读）：该会话零删除，调用方只记一次 refused。
 */
async function deleteSession(
  ctx: PruneContext,
  sessionStore: SessionStore,
  runStore: RunRecordStore | undefined,
  eventLog: SessionEventLog,
  sessionId: string,
): Promise<SessionCascadeCount | undefined> {
  try {
    const result = await coreDeleteSessionData(sessionId, {
      session: sessionStore,
      ...(runStore !== undefined ? { runStore } : {}),
      eventLog,
    });
    // 历史 `<sessionId>.jsonl`：不是 run trace，trace 桶永远不收，所以在这里清。
    const legacy = await removeLegacySessionTrace(ctx.tenantPaths.events_dir, sessionId);
    return {
      sessions_deleted: result.sessions_deleted,
      runs_deleted: result.runs_deleted,
      events_deleted: result.events_deleted + (legacy ? 1 : 0),
    };
  } catch {
    return undefined;
  }
}

/**
 * dry-run 的会话级联预演：按 core 同一口径数一遍（会话壳已读到 → 1；run 逐条；
 * 历史 `<sessionId>.jsonl` 存在 → 1）。不读内容、不碰文件。
 */
async function dryRunCascade(
  ctx: PruneContext,
  candidate: SessionCandidate,
): Promise<SessionCascadeCount> {
  let legacyPath: string;
  try {
    legacyPath = join(
      ctx.tenantPaths.events_dir,
      `${encodeSessionDirName(candidate.session_id)}.jsonl`,
    );
  } catch {
    legacyPath = '';
  }
  return {
    sessions_deleted: 1,
    runs_deleted: candidate.runs.length,
    events_deleted: legacyPath !== '' && (await fileExists(legacyPath)) ? 1 : 0,
  };
}

/**
 * 扫一遍、删一遍。
 *
 * 删除顺序 sessions → runs → trace：桶互斥，顺序只影响「谁先看到空目录」，
 * 不影响总数（dry-run 与真删同序，因此数字一致）。
 */
export async function pruneTenantData(
  ctx: PruneContext,
  options: { dryRun: boolean },
): Promise<PruneReport> {
  const dryRun = options.dryRun;
  const notes: PruneNote[] = [];

  const opened = openSessionStore(ctx, dryRun);
  const sessionStore = opened.store;
  if (opened.notReadonly) notes.push('sessions_backend_not_readonly');

  const runStore = createRunRecordStore(ctx.config, {
    tenantRunsDir: ctx.tenantPaths.runs_dir,
    tenantId: ctx.tenantId,
  });
  if (runStore === undefined) notes.push('durable_disabled');

  const sessions: SessionsBucketTally = {
    deleted: 0,
    bytes: 0,
    runs_deleted: 0,
    events_deleted: 0,
  };
  const runs: RunsBucketTally = { deleted: 0, bytes: 0 };
  let trace: PruneTraceResult = { deleted_runs: 0, kept_runs: 0, deleted_bytes: 0 };
  const skipped = { active_sessions: 0, refused_sessions: 0 };

  try {
    // ── 扫描（两个模式共用；dry-run 只读） ──
    const sessionScan = await scanStaleSessions(ctx, sessionStore, runStore);
    skipped.active_sessions = sessionScan.active;
    skipped.refused_sessions = sessionScan.refused;
    const candidates = sessionScan.candidates;
    const runCandidates = await scanTerminalRuns(
      ctx,
      runStore,
      new Set(candidates.map((candidate) => candidate.session_id)),
    );

    // ── sessions 桶 ──
    const eventLog = sessionStore === undefined || dryRun ? undefined : createEventLog(ctx);
    for (const candidate of candidates) {
      if (sessionStore === undefined) break;
      const cascade =
        eventLog === undefined
          ? await dryRunCascade(ctx, candidate)
          : await deleteSession(ctx, sessionStore, runStore, eventLog, candidate.session_id);
      if (cascade === undefined) {
        skipped.refused_sessions += 1;
        continue;
      }
      sessions.deleted += cascade.sessions_deleted;
      sessions.runs_deleted += cascade.runs_deleted;
      sessions.events_deleted += cascade.events_deleted;
      sessions.bytes += candidate.bytes;
    }

    // ── runs 桶 ──
    for (const candidate of runCandidates) {
      if (!dryRun && runStore !== undefined) await runStore.delete(candidate.run_id);
      runs.deleted += 1;
      runs.bytes += candidate.bytes;
    }

    // ── trace 桶（留存策略原样交给 core） ──
    trace = await pruneTenantTrace({
      config: ctx.config,
      tenantPaths: ctx.tenantPaths,
      dryRun,
    });

    return {
      dry_run: dryRun,
      data_dir: ctx.tenantPaths.root,
      tenant_id: ctx.tenantId,
      older_than_ms: ctx.olderThanMs,
      categories: { trace, runs, sessions },
      skipped,
      totals: {
        deleted: trace.deleted_runs + runs.deleted + sessions.deleted,
        bytes: trace.deleted_bytes + runs.bytes + sessions.bytes,
      },
      notes,
    };
  } finally {
    sessionStore?.close?.();
    await runStore?.close?.();
  }
}
