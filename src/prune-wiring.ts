/**
 * `vessel prune` 的候选扫描与删除（0.51 待办 #1；本版把判据从「时间」换成「状态」）。
 *
 * 三条口径来自 1 的裁定，本模块只按它判定：
 *
 * 1. 判据是**状态**，`--older-than` 只是可选叠加 —— 不传就完全不看时间；
 * 2. `prune` 就是「移除」：会话 / 数据清完后，归档 team 与停用 agent 的**记录本身**也删；
 * 3. **没有归档 / 没有停用的内容一律不删** —— 含它们的会话、runs 与记录，这是本模块最硬的
 *    不变量（见 `prune-status.test.ts`）。
 *
 * 目标 agent =（a）已归档 team（`team.json` 的 `archived_at` 非空）下的所有 agent
 *            ∪（b）已停用 agent（快照 `state === 'closed'`）。
 *
 * 一个目标 agent 要删的东西：它名下全部会话（级联会话壳、`sessions/<id>/` 事件目录、该会话的
 * run 记录与 `<run>.jsonl`、历史 `<sessionId>.jsonl`）、`inbox/<id>.json`，以及快照里的那条
 * 记录。归档 team 在它的 agent **全部清完**后，`teams/<tenant>/<team_id>/` 整个目录一并删掉
 * （只删 `team.json` 会留下 `log.ndjson` 空壳 = 用户说的存储泄漏）。
 *
 * 删除顺序 sessions → agent 记录 → team 记录 → trace，理由是：
 *
 * - 先会话后记录：记录是「这些会话数据属于谁」的唯一索引，先丢记录就再没人认得出这些孤儿；
 * - agent 记录只在它名下会话**全部**清掉后才删（有一个被守卫挡下就整天保留），否则换来的是一份
 *   没有主人、以后也扫不到的会话数据；
 * - team 记录放在 agent 之后：agent 还在就没有「空壳」可删，留到下一次。
 *
 * 仍然保留的两道守卫（宁可留，不可错删）：会话写锁 / 租约 live 或 unparseable、或该会话还有
 * 能 resume 的 running / interrupted run 时，这个会话不删，连带着它的 agent 记录也不删。
 *
 * 技术性说明：
 *
 * - 体积都是「删掉会释放多少」：会话壳 + 事件目录、run 记录文件、trace 文件、team 目录树。
 *   agent 记录嵌在共享的 `agents/<tenant>.json` 里、没有独立文件体积，按该记录序列化后的字节
 *   数记账，另加它的 inbox 文件。
 * - `categories` 五类互不重叠，只有一个例外：`trace.cascade_files` 是随会话级联删掉的 trace
 *   文件（run `<run>.jsonl` + 历史 `<sessionId>.jsonl`），与留存策略桶相加才是 trace 总数。
 * - trace 留存策略（`trace.retention_days` / `max_runs` / `max_bytes`）原样复用 core `pruneTrace`：
 *   它是容量上限，不看状态，与上面的状态判据正交。dry-run 在 events 目录的一份硬链副本上算，
 *   并**先排除**本次会级联删掉的文件 —— 真删时级联先跑，留存策略看到的就是「级联之后」的目录；
 *   不排除会让两个模式的数字对不上。
 *
 * @module vessel/prune-wiring
 */

import { copyFile, link, lstat, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { FileTeamStore, inboxPath, snapshotPath, teamDirPath } from '@vessel-agent/agent';
import type { VesselConfig } from '../packages/config/src/index';
import {
  atomicWrite,
  deleteSessionData as coreDeleteSessionData,
  encodeSessionDirName,
  noopLogger,
  type PruneTraceResult,
  pruneTrace,
  type RunRecord,
  type RunRecordStore,
  SessionEventLog,
  type SessionStore,
  sessionDirPath,
  sessionLogDirExists,
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
import { resolveTraceOptions } from './trace-wiring';

/** 单页上限（与 `RunRecordStore.list` 实现的硬上限一致） */
const PAGE_LIMIT = 200;
/** 防御性页数上限：自定义 store 不推进 offset 时不死循环 */
const MAX_PAGES = 10_000;
/** 写者证据：这两种探针状态表示「可能还有进程在写」 */
const LIVE_STATES: ReadonlySet<string> = new Set(['live', 'unparseable']);

/** 判老结论：过阈值（或本次不看时间）/ 不够老 / 查不到时刻 */
type AgeVerdict = 'ok' | 'too_new' | 'unknown';

/** 报告里的技术性提示（文案由命令层走 i18n） */
export type PruneNote =
  | 'sessions_backend_not_readonly'
  | 'durable_disabled'
  | 'agents_snapshot_unreadable'
  | 'agents_snapshot_write_failed';

/** 一类对象的汇总：删了多少条、释放多少字节 */
export interface ObjectTally {
  deleted: number;
  bytes: number;
}

/** trace 桶：留存策略（A-4 §11.3 冻结形状，原样透传 core）+ 本次级联删掉的 trace 文件 */
export type TraceBucketTally = PruneTraceResult & {
  /** 随目标会话级联删掉的 trace 文件数（run `<run>.jsonl` + 历史 `<sessionId>.jsonl`） */
  cascade_files: number;
  cascade_bytes: number;
};

/** 一次 prune 的汇总（`--json` 直接序列化这个形状） */
export interface PruneReport {
  dry_run: boolean;
  data_dir: string;
  tenant_id: string;
  /** 本次的判老阈值；字段缺省 = 不看时间（纯状态判据） */
  older_than_ms?: number;
  categories: {
    teams: ObjectTally;
    agents: ObjectTally;
    sessions: ObjectTally;
    runs: ObjectTally;
    trace: TraceBucketTally;
  };
  skipped: {
    /** 目标 agent 名下仍有活写者 / 可 resume run 的会话（整只 agent 都留着） */
    active_sessions: number;
    /** 会话不可读或被 core 删除守卫拒绝（该会话零删除） */
    refused_sessions: number;
    /** 目标 agent 里没能清干净的（记录保留，否则留下无主数据） */
    kept_agents: number;
    /** 归档 team 里还有 agent 没清掉（记录保留，等下一次） */
    kept_teams: number;
    /** 只因归档 / 停用时刻查不到才没清的（`--older-than` 下宁可留） */
    unknown_time: number;
  };
  totals: { deleted: number; bytes: number };
  notes: PruneNote[];
}

/** 扫描/执行上下文（时钟与 pid 存活判定可注入，便于测试与多平台一致） */
export interface PruneContext {
  config: VesselConfig;
  tenantPaths: TenantPaths;
  tenantId: string;
  /** 可选叠加阈值（ms）；缺省 = 不看时间 */
  olderThanMs?: number;
  /** 固定时钟：dry-run 与真删同一口径，且不做第二次 Date.now() */
  now: number;
  hostname?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
}

/** 快照里一条成员记录（只取判定要用的字段 + 原始条目） */
interface AgentFacts {
  id: string;
  /** 原始成员条目：删记录时按 id 过滤后原样回写，不猜字段 */
  raw: Record<string, unknown>;
  /** 状态：`'closed'` 即「已停用」（判据 b） */
  state: string | undefined;
  /** 所属 team（判据 a 靠它挂到归档 team 上） */
  team_id: string | undefined;
  /** 停用时刻：registry 在 `setState('closed')` 时写 `last_seen`；查不到 = undefined */
  closed_at: number | undefined;
  /** 记录里能看到的所有 body session（会话壳 / 事件目录 / run 记录各自独立存在） */
  sessions: string[];
}

/** 快照扫描结果：missing 与 unreadable 必须分开 —— 读不出来时一个记录都不许删 */
type SnapshotScan =
  | {
      kind: 'ok';
      path: string;
      /** 原始文件对象：回写时原样展开，未知顶层键不丢 */
      file: Record<string, unknown>;
      /** 原始成员条目（回写时按 id 过滤） */
      entries: unknown[];
      members: AgentFacts[];
    }
  | { kind: 'missing'; path: string }
  | { kind: 'unreadable'; path: string };

/** 一个归档 team 的判定事实 */
interface TeamFacts {
  team_id: string;
  archived_at: number | undefined;
  /** 目录树体积（`team.json` + `log.ndjson`） */
  bytes: number;
}

/** 级联会删掉的 trace 文件；`events/` 只有一层，所以只存文件名 */
interface TraceFileFact {
  name: string;
  bytes: number;
}

/** 待删会话（含级联对象） */
interface SessionCandidate {
  session_id: string;
  /** 会话壳 + `sessions/<id>/` 事件目录 */
  bytes: number;
  /** 该会话的 run 记录：dry-run 用来预估级联计数，真删由 core 自行分页 */
  runs: RunRecord[];
  /** 这些 run 记录文件的体积 */
  run_bytes: number;
  /** 该会话的 trace 文件（run `<run>.jsonl` + 历史 `<sessionId>.jsonl`） */
  trace_files: TraceFileFact[];
}

/** 单个会话的判定结果 */
type SessionVerdict =
  | { kind: 'candidate'; candidate: SessionCandidate }
  | { kind: 'absent' }
  | { kind: 'active' }
  | { kind: 'refused' };

/** 一个目标 agent 的执行计划 */
interface AgentPlan {
  facts: AgentFacts;
  /** 名下待删会话（按 session id 排序，两个模式同序） */
  sessions: SessionCandidate[];
  /** 有会话被守卫挡下 → 整只 agent 一个都不动（记录与数据一起留） */
  blocked: boolean;
  /** 记录 + inbox 的体积 */
  bytes: number;
}

/** 扫描出来的完整计划：dry-run 与 `--yes` 读同一份、按同一顺序执行 */
interface PrunePlan {
  snapshot: SnapshotScan;
  agents: AgentPlan[];
  /** 归档且判老通过的 team（还要等它的 agent 清完才真的删） */
  teams: TeamFacts[];
  skipped: PruneReport['skipped'];
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
 * 判老：`--older-than` 是可选叠加，没传就一律 'ok'（完全不看时间）。
 * 时刻查不到返回 'unknown' —— 调用方一律当「不清」（宁可留）。
 */
function judgeAge(ctx: PruneContext, at: number | undefined): AgeVerdict {
  if (ctx.olderThanMs === undefined) return 'ok';
  if (at === undefined || !Number.isFinite(at)) return 'unknown';
  return at >= ctx.now - ctx.olderThanMs ? 'too_new' : 'ok';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** 记录里所有可能落盘的会话 id（`bodies[]` 是 v4 真相，其余是兼容 / 迁移键） */
function sessionIdsOf(raw: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const add = (value: unknown): void => {
    if (nonEmptyString(value)) ids.add(value);
  };
  add(raw.session_id);
  add(raw.primary_body_id);
  if (isRecord(raw.current_body)) add(raw.current_body.session_id);
  if (Array.isArray(raw.bodies)) {
    for (const body of raw.bodies) {
      if (!isRecord(body)) continue;
      add(body.body_id);
      add(body.session_id);
    }
  }
  if (Array.isArray(raw.body_history)) {
    for (const entry of raw.body_history) {
      if (isRecord(entry)) add(entry.session_id);
    }
  }
  return [...ids].sort();
}

function agentFactsOf(raw: Record<string, unknown>): AgentFacts | undefined {
  if (!nonEmptyString(raw.id)) return undefined;
  const lastSeen =
    typeof raw.last_seen === 'number' && Number.isFinite(raw.last_seen) ? raw.last_seen : undefined;
  return {
    id: raw.id,
    raw,
    state: nonEmptyString(raw.state) ? raw.state : undefined,
    team_id: nonEmptyString(raw.team_id) ? raw.team_id : undefined,
    closed_at: lastSeen,
    sessions: sessionIdsOf(raw),
  };
}

/**
 * 只读快照。
 *
 * 不用 `AgentSnapshotStore.load()`：它会隔离损坏文件、给旧版本补 `.bak` 备份 —— dry-run 不该
 * 写盘，而 prune 正是「先预演再决定」的命令。
 */
async function readAgentSnapshot(ctx: PruneContext): Promise<SnapshotScan> {
  const path = snapshotPath(ctx.tenantPaths.root, ctx.tenantId);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { kind: 'missing', path }
      : { kind: 'unreadable', path };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', path };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.members)) return { kind: 'unreadable', path };
  const members: AgentFacts[] = [];
  for (const entry of parsed.members) {
    if (!isRecord(entry)) continue;
    const facts = agentFactsOf(entry);
    if (facts !== undefined) members.push(facts);
  }
  members.sort((left, right) => left.id.localeCompare(right.id));
  return { kind: 'ok', path, file: parsed, entries: parsed.members, members };
}

/**
 * 把 `removed` 里的成员条目从快照里摘掉，其余键与条目原样回写（原子、0600）。
 *
 * 只动 `members`：未知顶层键（版本、`updated_at`、将来新增的键）一律原样保留，避免 prune
 * 顺手改掉别人的数据。
 */
async function writeSnapshotWithout(
  scan: Extract<SnapshotScan, { kind: 'ok' }>,
  removed: ReadonlySet<string>,
): Promise<boolean> {
  if (removed.size === 0) return true;
  const members = scan.entries.filter((entry: unknown) => {
    const id = isRecord(entry) && nonEmptyString(entry.id) ? entry.id : undefined;
    return id === undefined || !removed.has(id);
  });
  try {
    await atomicWrite(scan.path, `${JSON.stringify({ ...scan.file, members }, null, 2)}\n`, {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

/** agent 的归属体积：`inbox/<id>.json` + 快照里这条记录序列化后的字节数 */
async function agentBytes(ctx: PruneContext, facts: AgentFacts): Promise<number> {
  const inbox = await fileSize(inboxPath(ctx.tenantPaths.root, ctx.tenantId, facts.id));
  return inbox + Buffer.byteLength(JSON.stringify(facts.raw), 'utf8');
}

/**
 * 列归档 team：复用 `FileTeamStore`（同一份 `team.json` 解析与「损坏就跳过」规则，不重写一遍）。
 *
 * 损坏的 `team.json` 不在 `list()` 里 → 永远不会被判成归档 → 绝不删（宁可留）。
 */
async function scanArchivedTeams(ctx: PruneContext): Promise<TeamFacts[]> {
  const store = new FileTeamStore({ dataDir: ctx.tenantPaths.root, tenantId: ctx.tenantId });
  await store.ready();
  const teams: TeamFacts[] = [];
  for (const record of store.list()) {
    if (record.archived_at === undefined) continue;
    teams.push({
      team_id: record.team_id,
      archived_at: record.archived_at,
      bytes: await treeSize(teamDirPath(ctx.tenantPaths.root, ctx.tenantId, record.team_id)),
    });
  }
  return teams;
}

/** 某个 trace 文件存在时的体积事实；不存在返回 undefined（级联计数只数真实存在的） */
async function traceFileFact(ctx: PruneContext, name: string): Promise<TraceFileFact | undefined> {
  try {
    const info = await stat(join(ctx.tenantPaths.events_dir, name));
    return info.isFile() ? { name, bytes: info.size } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 单个会话的判定。
 *
 * 三种「存在」都要看：会话壳可能已迁移走、事件目录与 run 记录各自独立存在。判定顺序是
 * 先 existence 再 guard —— 不存在的会话没什么可删，也不该占一条「活跃」记账。
 */
async function inspectSession(
  ctx: PruneContext,
  sessionStore: SessionStore,
  runStore: RunRecordStore | undefined,
  sessionId: string,
): Promise<SessionVerdict> {
  let state: Awaited<ReturnType<SessionStore['load']>>;
  try {
    state = await sessionStore.load(sessionId);
  } catch {
    // 损坏的会话文件：不猜、不删
    return { kind: 'refused' };
  }
  const runs = runStore === undefined ? [] : await listAllRuns(runStore, { session_id: sessionId });
  const shellPath = sessionShellPath(ctx, sessionId);
  const shellExists = shellPath !== undefined && (await fileExists(shellPath));
  const logDir = await sessionLogDirExists(ctx.tenantPaths.sessions_dir, sessionId);
  if (state === null && !shellExists && !logDir && runs.length === 0) return { kind: 'absent' };

  // 还能 resume 的 run / 活写者都算活跃：宁可留，不可错删。
  const resumable = runs.some((run) => run.status === 'running' || run.status === 'interrupted');
  if (resumable || (await sessionHasLiveWriter(ctx, sessionId))) return { kind: 'active' };

  const runsDir = resolveRunsDir(ctx.config, ctx.tenantPaths.runs_dir);
  let runBytes = 0;
  for (const run of runs) {
    const recordPath = runRecordPath(runsDir, run.run_id);
    if (recordPath !== undefined) runBytes += await fileSize(recordPath);
  }

  // trace 文件名与 core `deleteSessionData` 传 traceDir 时用的规则一致；不一致就会「报要删、
  // 实际没删」。
  const traceFiles: TraceFileFact[] = [];
  for (const run of runs) {
    const fact = await traceFileFact(ctx, `${encodeURIComponent(run.run_id)}.jsonl`);
    if (fact !== undefined) traceFiles.push(fact);
  }
  // 0.5 的 `session.deleted` 曾以 sessionId 当 run_id 落成 `<sessionId>.jsonl`：它不是 run trace，
  // 留存策略按「没有终态事件 → 受保护」永远不收，所以算进这份会话的级联。
  const legacy = await traceFileFact(ctx, `${encodeSessionDirName(sessionId)}.jsonl`);
  if (legacy !== undefined) traceFiles.push(legacy);

  let bytes = 0;
  if (shellPath !== undefined && shellExists) bytes = await fileSize(shellPath);
  bytes += await treeSize(sessionDirPath(ctx.tenantPaths.sessions_dir, sessionId));

  return {
    kind: 'candidate',
    candidate: { session_id: sessionId, bytes, runs, run_bytes: runBytes, trace_files: traceFiles },
  };
}

/**
 * 算出本次的目标集合（纯读，不删任何东西）。
 *
 * 快照读不出来时直接空手返回：连「哪些 agent 已停用」都不知道，就不敢删 agent / team 记录。
 */
async function buildPlan(
  ctx: PruneContext,
  sessionStore: SessionStore | undefined,
  runStore: RunRecordStore | undefined,
  notes: PruneNote[],
): Promise<PrunePlan> {
  const skipped: PruneReport['skipped'] = {
    active_sessions: 0,
    refused_sessions: 0,
    kept_agents: 0,
    kept_teams: 0,
    unknown_time: 0,
  };
  const snapshot = await readAgentSnapshot(ctx);
  if (snapshot.kind === 'unreadable') {
    notes.push('agents_snapshot_unreadable');
    return { snapshot, agents: [], teams: [], skipped };
  }
  const members = snapshot.kind === 'ok' ? snapshot.members : [];

  // 归档 team 先全读出来：判老只决定「这次删不删它」，不改变「它下面的 agent 是目标」。
  const archived = new Map<string, TeamFacts>();
  for (const team of await scanArchivedTeams(ctx)) archived.set(team.team_id, team);

  const teams: TeamFacts[] = [];
  for (const team of archived.values()) {
    const verdict = judgeAge(ctx, team.archived_at);
    if (verdict === 'ok') teams.push(team);
    else if (verdict === 'unknown') skipped.unknown_time += 1;
  }

  const agents: AgentPlan[] = [];
  for (const facts of members) {
    const team = facts.team_id === undefined ? undefined : archived.get(facts.team_id);
    const byTeam = team !== undefined;
    const byClosed = facts.state === 'closed';
    // 判据 a ∪ b；两条都不成立 = 既没归档也没停用 ⇒ 一个字节都不碰（硬不变量）。
    if (!byTeam && !byClosed) continue;

    // `--older-than` 只会缩窄：每个适用判据都「够老」才删；任一查不到或不够老就留。
    const times: (number | undefined)[] = [];
    if (team !== undefined) times.push(team.archived_at);
    if (byClosed) times.push(facts.closed_at);
    const verdicts = times.map((at) => judgeAge(ctx, at));
    if (verdicts.includes('too_new')) continue;
    if (verdicts.includes('unknown')) {
      skipped.unknown_time += 1;
      continue;
    }

    const plan: AgentPlan = {
      facts,
      sessions: [],
      blocked: false,
      bytes: await agentBytes(ctx, facts),
    };
    if (sessionStore === undefined) {
      // 枚举不出会话就不敢丢记录：丢完这些会话数据就再没人认得（sqlite 的 dry-run 走这里）
      plan.blocked = true;
    } else {
      for (const sessionId of facts.sessions) {
        const verdict = await inspectSession(ctx, sessionStore, runStore, sessionId);
        if (verdict.kind === 'active') {
          skipped.active_sessions += 1;
          plan.blocked = true;
        } else if (verdict.kind === 'refused') {
          skipped.refused_sessions += 1;
          plan.blocked = true;
        } else if (verdict.kind === 'candidate') {
          plan.sessions.push(verdict.candidate);
        }
      }
    }
    if (plan.blocked) {
      // 有会话没清掉 ⇒ 整只 agent 一个都不动（记录留着，数据也留着，两者不拆散）
      plan.sessions = [];
      skipped.kept_agents += 1;
    }
    agents.push(plan);
  }
  return { snapshot, agents, teams, skipped };
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
 * sqlite 后端的构造器会建库 / 建表（写盘），dry-run 必须保持只读，所以 dry-run 里不构造
 * store 并给一条 note；memory 后端没有持久会话，也不构造。
 *
 * 没有 store 就枚举不出会话 ⇒ 目标 agent 一律留（见 `buildPlan`）：宁可少删，不可丢记录。
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

/**
 * 删一个会话：core 负责冲突守卫与级联（会话壳、`sessions/<id>/` 事件目录、run 记录）。
 *
 * `traceDir` 一并传：该会话的 `<run>.jsonl` 与历史 `<sessionId>.jsonl` 也是这份会话数据 ——
 * 卷进同一次调用，才不会出现「会话删了、trace 留下」的半截状态。
 *
 * 返回 false = core 守卫拒绝（冲突 / 不可读）：该会话零删除，调用方记一次 refused。
 */
async function deleteSession(
  ctx: PruneContext,
  sessionStore: SessionStore,
  runStore: RunRecordStore | undefined,
  eventLog: SessionEventLog,
  sessionId: string,
): Promise<boolean> {
  try {
    await coreDeleteSessionData(sessionId, {
      session: sessionStore,
      ...(runStore !== undefined ? { runStore } : {}),
      traceDir: ctx.tenantPaths.events_dir,
      eventLog,
    });
    return true;
  } catch {
    return false;
  }
}

/** 删 agent 的 inbox 文件：记录都没了，这份队列再没有主人（失败只留下一个孤儿文件） */
async function removeInbox(ctx: PruneContext, agentId: string): Promise<void> {
  try {
    await rm(inboxPath(ctx.tenantPaths.root, ctx.tenantId, agentId), { force: true });
  } catch {
    // 记录已经删掉，这里失败不留数据损坏，只是多一个没有主人的文件
  }
}

/**
 * dry-run 的 trace 预演：把「级联之后仍会存在」的 `.jsonl` 硬链（跨卷回退复制）到临时目录，
 * 交给 core `pruneTrace` 算删除集合，原目录零改动。
 *
 * 为什么要先排除 `excluded`：真删时级联先跑，留存策略看到的就是「级联之后」的目录；不排除的话
 * dry-run 会把级联已删的文件也算进留存桶，两个模式的数字对不上。
 */
async function dryRunTraceBucket(
  eventsDir: string,
  excluded: ReadonlySet<string>,
  options: { retentionDays?: number; maxRuns?: number; maxBytes?: number; now?: number },
): Promise<PruneTraceResult> {
  const temp = await mkdtemp(join(os.tmpdir(), 'vessel-prune-trace-'));
  try {
    let entries: string[];
    try {
      entries = await readdir(eventsDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl') || entry.startsWith('.') || excluded.has(entry)) continue;
      const source = join(eventsDir, entry);
      const target = join(temp, entry);
      try {
        await link(source, target);
      } catch {
        await copyFile(source, target).catch(() => {});
      }
    }
    return await pruneTrace(temp, options);
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/** trace 留存桶：容量策略原样交给 core；dry-run 在「级联之后」的副本上算 */
async function pruneTraceBucket(
  ctx: PruneContext,
  dryRun: boolean,
  excluded: ReadonlySet<string>,
): Promise<PruneTraceResult> {
  const trace = resolveTraceOptions(ctx.config);
  const options = {
    retentionDays: trace.retentionDays,
    maxRuns: trace.maxRuns,
    maxBytes: trace.maxBytes,
    now: ctx.now,
  };
  return dryRun
    ? dryRunTraceBucket(ctx.tenantPaths.events_dir, excluded, options)
    : pruneTrace(ctx.tenantPaths.events_dir, options);
}

/**
 * 扫一遍、删一遍。
 *
 * 两个模式读同一份 `PrunePlan`、按同一顺序执行，报告按**扫描时测得的集合**记账 —— 所以
 * dry-run 的数字就是 `--yes` 会删掉的数字（`prune-status.test.ts` 直接比对两份报告）。
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

  const teams: ObjectTally = { deleted: 0, bytes: 0 };
  const agents: ObjectTally = { deleted: 0, bytes: 0 };
  const sessions: ObjectTally = { deleted: 0, bytes: 0 };
  const runs: ObjectTally = { deleted: 0, bytes: 0 };
  const trace: TraceBucketTally = {
    deleted_runs: 0,
    kept_runs: 0,
    deleted_bytes: 0,
    cascade_files: 0,
    cascade_bytes: 0,
  };

  try {
    // ── 扫描（两个模式共用；dry-run 只读） ──
    const plan = await buildPlan(ctx, sessionStore, runStore, notes);
    const skipped = plan.skipped;

    // ── 1. 会话（级联 runs 与这份会话的 trace） ──
    const eventLog = sessionStore === undefined || dryRun ? undefined : createEventLog(ctx);
    const cascadeFiles = new Set<string>();
    const cleared = new Set<string>();
    for (const agent of plan.agents) {
      // blocked 的 agent 已在扫描里记过 kept_agents；它的会话一个都不动
      if (agent.blocked) continue;
      let allCleared = true;
      for (const candidate of agent.sessions) {
        if (!dryRun && sessionStore !== undefined && eventLog !== undefined) {
          const deleted = await deleteSession(
            ctx,
            sessionStore,
            runStore,
            eventLog,
            candidate.session_id,
          );
          if (!deleted) {
            skipped.refused_sessions += 1;
            allCleared = false;
            continue;
          }
        }
        sessions.deleted += 1;
        sessions.bytes += candidate.bytes;
        runs.deleted += candidate.runs.length;
        runs.bytes += candidate.run_bytes;
        trace.cascade_files += candidate.trace_files.length;
        for (const file of candidate.trace_files) {
          trace.cascade_bytes += file.bytes;
          cascadeFiles.add(file.name);
        }
      }
      if (allCleared) cleared.add(agent.facts.id);
      else skipped.kept_agents += 1;
    }

    // ── 2. agent 记录（快照里那条 + inbox） ──
    if (cleared.size > 0 && plan.snapshot.kind === 'ok') {
      const written = dryRun ? true : await writeSnapshotWithout(plan.snapshot, cleared);
      if (!written) {
        // 记录没写掉就不算清完：不能报「已删」，也不能接着删 team（否则记的是没发生的事）
        notes.push('agents_snapshot_write_failed');
        skipped.kept_agents += cleared.size;
        cleared.clear();
      } else {
        for (const agent of plan.agents) {
          if (!cleared.has(agent.facts.id)) continue;
          agents.deleted += 1;
          agents.bytes += agent.bytes;
          if (!dryRun) await removeInbox(ctx, agent.facts.id);
        }
      }
    }

    // ── 3. 归档 team（agent 全清完才删，否则留到下一次） ──
    const survivors = new Set<string>();
    if (plan.snapshot.kind === 'ok') {
      for (const member of plan.snapshot.members) {
        if (cleared.has(member.id)) continue;
        if (member.team_id !== undefined) survivors.add(member.team_id);
      }
    }
    for (const team of plan.teams) {
      if (survivors.has(team.team_id)) {
        skipped.kept_teams += 1;
        continue;
      }
      if (!dryRun) {
        try {
          // 整个目录一起删：只删 team.json 会把 log.ndjson 留成空壳
          await rm(teamDirPath(ctx.tenantPaths.root, ctx.tenantId, team.team_id), {
            recursive: true,
            force: true,
          });
        } catch {
          skipped.kept_teams += 1;
          continue;
        }
      }
      teams.deleted += 1;
      teams.bytes += team.bytes;
    }

    // ── 4. trace 留存桶（容量策略；级联删掉的文件不再计入） ──
    const traceBucket = await pruneTraceBucket(ctx, dryRun, cascadeFiles);
    trace.deleted_runs = traceBucket.deleted_runs;
    trace.kept_runs = traceBucket.kept_runs;
    trace.deleted_bytes = traceBucket.deleted_bytes;

    return {
      dry_run: dryRun,
      data_dir: ctx.tenantPaths.root,
      tenant_id: ctx.tenantId,
      ...(ctx.olderThanMs !== undefined ? { older_than_ms: ctx.olderThanMs } : {}),
      categories: { teams, agents, sessions, runs, trace },
      skipped,
      totals: {
        deleted:
          teams.deleted +
          agents.deleted +
          sessions.deleted +
          runs.deleted +
          trace.deleted_runs +
          trace.cascade_files,
        bytes:
          teams.bytes +
          agents.bytes +
          sessions.bytes +
          runs.bytes +
          trace.deleted_bytes +
          trace.cascade_bytes,
      },
      notes,
    };
  } finally {
    sessionStore?.close?.();
    await runStore?.close?.();
  }
}
