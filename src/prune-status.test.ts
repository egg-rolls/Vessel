/**
 * `vessel prune` 状态判据的窄属性测试（0.51 #1：判据从「时间」改成「状态」）。
 *
 * 仓库没有 test gate（见 AGENTS.md「验证纪律」），纯函数的窄属性测试是被允许的例外。
 * 文件形态沿用 `src/refs-notice-hook.test.ts`（`check()` + 计数 + 汇总），直接跑：
 *
 *   bun run src/prune-status.test.ts
 *
 * 判定看**输出文本**（`OK ... passed N / N` 或 `FAIL ...`）：本机 bun 是 Windows 版，
 * 退出码不可信。命名带 `.test.ts` 是为了 package.json 的 `files` 排除规则把它挡在发布包外，
 * 同时让 `tsc`（tsconfig 的 `src/` 范围）继续覆盖它。
 *
 * 这里摆的是**真文件**（临时 data-dir）：这条命令会真删数据，只有把会话壳、事件目录、run 记录、
 * 快照、team 目录都放到位，才测得出「该删的删了、不该删的一个字节都没动」。
 *
 * 守住的不变量：
 * - 未归档 team / 未停用 agent 的会话、runs、记录一律不删（本文件最重要的一条）；
 * - `--older-than` 只叠加缩窄：比归档 / 停用时刻更新的对象一条都不清，查不到时刻的宁可留；
 * - dry-run 与 `--yes` 同序同集合（两份报告逐字段相等），且 dry-run 零写盘；
 * - 归档 team 要等它的 agent 全清完才删，守卫挡下的 agent 与它的 team 一起留。
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inboxPath, snapshotPath, teamDirPath } from '@vessel-agent/agent';
import type { VesselConfig } from '../packages/config/src/index';
import {
  type RunRecordStore,
  resolveSingleTenantPaths,
  type SessionStore,
  sessionDirPath,
} from '../packages/core/src/index';
import { type PruneContext, type PruneReport, pruneTenantData } from './prune-wiring';
import { createRunRecordStore } from './run-record-store-factory';
import { createSessionStore } from './session-factory';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name} | got: ${got}`);
}

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const TENANT = 'default';

/**
 * 测试配置：file 会话后端 + durable run；trace 留存放到极宽 —— 留存策略是容量策略，
 * 与这里要验的状态判据正交，别让它掺进数字。
 */
const CONFIG = {
  session: { backend: 'file' },
  durable: { enabled: true, backend: 'file' },
  trace: { enabled: false, retentionDays: 36_500 },
} as unknown as VesselConfig;

interface Fixture {
  root: string;
  paths: ReturnType<typeof resolveSingleTenantPaths>;
  sessions: SessionStore;
  runs: RunRecordStore;
  members: Record<string, unknown>[];
  /** 把成员列表落到 `agents/<tenant>.json`（等价于 registry 的一次快照写） */
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'vessel-prune-'));
  const paths = resolveSingleTenantPaths(root, TENANT);
  await mkdir(paths.sessions_dir, { recursive: true });
  await mkdir(paths.events_dir, { recursive: true });
  await mkdir(paths.runs_dir, { recursive: true });
  const sessions = createSessionStore(CONFIG.session, {
    tenantSessionsDir: paths.sessions_dir,
    tenantSessionsDbPath: join(root, 'sessions.db'),
    tenantId: TENANT,
  });
  const runs = createRunRecordStore(CONFIG, { tenantRunsDir: paths.runs_dir, tenantId: TENANT });
  if (runs === undefined) throw new Error('fixture: durable run store 未创建');
  const members: Record<string, unknown>[] = [];
  return {
    root,
    paths,
    sessions,
    runs,
    members,
    flush: async (): Promise<void> => {
      await mkdir(join(root, 'agents'), { recursive: true });
      const file = { version: 4, updated_at: NOW, members };
      await writeFile(snapshotPath(root, TENANT), `${JSON.stringify(file, null, 2)}\n`);
    },
    dispose: async (): Promise<void> => {
      sessions.close?.();
      await runs.close?.();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 归档 team：`archivedAt` 缺省 = 未归档 */
async function addTeam(fixture: Fixture, teamId: string, archivedAt?: number): Promise<void> {
  const dir = teamDirPath(fixture.root, TENANT, teamId);
  await mkdir(dir, { recursive: true });
  const record = {
    v: 1,
    team_id: teamId,
    name: teamId,
    workspace: `/ws/${teamId}`,
    policy: {},
    created_at: NOW - 90 * DAY,
    ...(archivedAt !== undefined ? { archived_at: archivedAt } : {}),
  };
  await writeFile(join(dir, 'team.json'), `${JSON.stringify(record, null, 2)}\n`);
  // 空 log.ndjson 也要在：删记录时只删 team.json 会把它留成空壳
  await writeFile(join(dir, 'log.ndjson'), '');
}

interface AgentSpec {
  id: string;
  sessionId: string;
  state: string;
  teamId?: string;
  /** 停用时刻（registry 在 setState('closed') 写 `last_seen`）；缺省 = 查不到 */
  lastSeen?: number;
}

function addAgentRecord(fixture: Fixture, spec: AgentSpec): void {
  fixture.members.push({
    id: spec.id,
    session_id: spec.sessionId,
    owner: spec.id,
    role: 'member',
    visibility: 'team',
    state: spec.state,
    membership: spec.state === 'closed' ? 'left' : 'present',
    ...(spec.teamId !== undefined ? { team_id: spec.teamId } : {}),
    ...(spec.lastSeen !== undefined ? { last_seen: spec.lastSeen } : {}),
    bodies: [
      {
        body_id: spec.sessionId,
        epoch: 0,
        created_at: NOW - 40 * DAY,
        last_active_at: NOW - 40 * DAY,
      },
    ],
    primary_body_id: spec.sessionId,
  });
}

/** 会话壳（真实 FileSessionStore 写的形状）+ `sessions/<id>/` 事件目录 */
async function addSession(fixture: Fixture, sessionId: string): Promise<void> {
  await fixture.sessions.save({
    session_id: sessionId,
    created_at: NOW - 40 * DAY,
    updated_at: NOW - 40 * DAY,
  });
  const dir = sessionDirPath(fixture.paths.sessions_dir, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'events.ndjson'), '');
}

async function addRun(
  fixture: Fixture,
  runId: string,
  sessionId: string,
  status: 'completed' | 'running',
): Promise<void> {
  await fixture.runs.save({
    run_id: runId,
    session_id: sessionId,
    status,
    created_at: NOW - 40 * DAY,
    updated_at: NOW - 40 * DAY,
  });
}

/** 落一份空 trace 文件（名字按生产规则编码） */
async function addTrace(fixture: Fixture, name: string): Promise<void> {
  await writeFile(join(fixture.paths.events_dir, `${encodeURIComponent(name)}.jsonl`), '');
}

async function addInbox(fixture: Fixture, agentId: string): Promise<void> {
  await mkdir(join(fixture.root, 'inbox'), { recursive: true });
  await writeFile(inboxPath(fixture.root, TENANT, agentId), `${JSON.stringify({ v: 1 })}\n`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sessionShell(fixture: Fixture, sessionId: string): string {
  return join(fixture.paths.sessions_dir, `${encodeURIComponent(sessionId)}.json`);
}

function runRecordPath(fixture: Fixture, runId: string): string {
  return join(fixture.paths.runs_dir, `${encodeURIComponent(runId)}.json`);
}

function tracePath(fixture: Fixture, name: string): string {
  return join(fixture.paths.events_dir, `${encodeURIComponent(name)}.jsonl`);
}

async function remainingAgents(fixture: Fixture): Promise<string[]> {
  const raw = JSON.parse(await readFile(snapshotPath(fixture.root, TENANT), 'utf8')) as {
    members: { id?: string }[];
  };
  return raw.members.map((member) => member.id ?? '').sort();
}

function makeCtx(fixture: Fixture, olderThanMs?: number): PruneContext {
  return {
    config: CONFIG,
    tenantPaths: fixture.paths,
    tenantId: TENANT,
    now: NOW,
    ...(olderThanMs !== undefined ? { olderThanMs } : {}),
  };
}

/** 只比对「删了什么」，不含 data_dir（每个 fixture 各是一个临时目录）与 dry_run */
function signature(report: PruneReport): string {
  return JSON.stringify({
    categories: report.categories,
    skipped: report.skipped,
    totals: report.totals,
    older_than_ms: report.older_than_ms ?? null,
  });
}

const ALL_AGENTS = ['a-arch', 'a-busy', 'a-closed', 'a-idle', 'a-live', 'a-nodate'];

/**
 * 建一套「该删的」与「不该删的」都在场的数据。
 *
 * - `t-arch` 已归档（10 天前），agent `a-arch` 还只是 idle —— 只靠归档这一条就该删；
 * - `t-live` 未归档 + `a-live`（idle）：整条链都不该动（硬不变量）；
 * - `t-mixed` 未归档 + `a-closed`（closed，20 天前停用）：只删 agent 与它的会话，team 不删；
 * - `a-nodate`（closed，但没有停用时刻）：不看时间时删，`--older-than` 下宁可留；
 * - `a-idle`（idle、无 team）：不该动；
 * - `t-busy` 已归档 + `a-busy` 名下会话还有 running run：守卫挡下，agent 与 team 一起留。
 */
async function seedWorld(): Promise<Fixture> {
  const fixture = await createFixture();
  await addTeam(fixture, 't-arch', NOW - 10 * DAY);
  await addTeam(fixture, 't-live');
  await addTeam(fixture, 't-mixed');
  await addTeam(fixture, 't-busy', NOW - 10 * DAY);

  await addSession(fixture, 's-arch');
  await addRun(fixture, 'r-arch', 's-arch', 'completed');
  await addTrace(fixture, 'r-arch');
  await addTrace(fixture, 's-arch'); // 历史 <sessionId>.jsonl
  await addInbox(fixture, 'a-arch');
  addAgentRecord(fixture, {
    id: 'a-arch',
    sessionId: 's-arch',
    state: 'idle',
    teamId: 't-arch',
  });

  await addSession(fixture, 's-closed');
  await addRun(fixture, 'r-closed', 's-closed', 'completed');
  await addTrace(fixture, 'r-closed');
  await addInbox(fixture, 'a-closed');
  addAgentRecord(fixture, {
    id: 'a-closed',
    sessionId: 's-closed',
    state: 'closed',
    teamId: 't-mixed',
    lastSeen: NOW - 20 * DAY,
  });

  await addSession(fixture, 's-nodate');
  await addInbox(fixture, 'a-nodate');
  addAgentRecord(fixture, { id: 'a-nodate', sessionId: 's-nodate', state: 'closed' });

  await addSession(fixture, 's-live');
  await addRun(fixture, 'r-live', 's-live', 'completed');
  await addTrace(fixture, 'r-live');
  await addInbox(fixture, 'a-live');
  addAgentRecord(fixture, {
    id: 'a-live',
    sessionId: 's-live',
    state: 'idle',
    teamId: 't-live',
  });

  await addSession(fixture, 's-idle');
  await addInbox(fixture, 'a-idle');
  addAgentRecord(fixture, { id: 'a-idle', sessionId: 's-idle', state: 'idle' });

  await addSession(fixture, 's-busy');
  await addRun(fixture, 'r-busy', 's-busy', 'running');
  await addInbox(fixture, 'a-busy');
  addAgentRecord(fixture, {
    id: 'a-busy',
    sessionId: 's-busy',
    state: 'closed',
    teamId: 't-busy',
    lastSeen: NOW - 10 * DAY,
  });

  await fixture.flush();
  return fixture;
}

/** 真删一轮里「该删的」必须消失 */
async function checkDeleted(fixture: Fixture, label: string): Promise<void> {
  check(
    `${label} 归档 team 目录整删`,
    !(await exists(teamDirPath(fixture.root, TENANT, 't-arch'))),
  );
  check(`${label} 归档 team 下的 agent 会话壳`, !(await exists(sessionShell(fixture, 's-arch'))));
  check(
    `${label} 归档 team 下的 agent 事件目录`,
    !(await exists(sessionDirPath(fixture.paths.sessions_dir, 's-arch'))),
  );
  check(
    `${label} 归档 team 下的 agent run 记录`,
    !(await exists(runRecordPath(fixture, 'r-arch'))),
  );
  check(`${label} run trace`, !(await exists(tracePath(fixture, 'r-arch'))));
  check(`${label} 历史会话 trace`, !(await exists(tracePath(fixture, 's-arch'))));
  check(
    `${label} 归档 team 下的 agent inbox`,
    !(await exists(inboxPath(fixture.root, TENANT, 'a-arch'))),
  );
  check(`${label} 停用 agent 会话壳`, !(await exists(sessionShell(fixture, 's-closed'))));
  check(`${label} 停用 agent run 记录`, !(await exists(runRecordPath(fixture, 'r-closed'))));
  check(`${label} 无停用时刻的 agent`, !(await exists(sessionShell(fixture, 's-nodate'))));
}

/** 「不该删的」必须一个字节都没动（本文件最重要的一组断言） */
async function checkUntouched(fixture: Fixture, label: string): Promise<void> {
  check(`${label} 未归档 team 目录还在`, await exists(teamDirPath(fixture.root, TENANT, 't-live')));
  check(`${label} 非归档 team 下的 agent 会话壳`, await exists(sessionShell(fixture, 's-live')));
  check(
    `${label} 非归档 team 下的 agent 事件目录`,
    await exists(sessionDirPath(fixture.paths.sessions_dir, 's-live')),
  );
  check(`${label} 非归档 team 下的 agent run 记录`, await exists(runRecordPath(fixture, 'r-live')));
  check(`${label} 非归档 team 下的 agent trace`, await exists(tracePath(fixture, 'r-live')));
  check(
    `${label} 非归档 team 下的 agent inbox`,
    await exists(inboxPath(fixture.root, TENANT, 'a-live')),
  );
  check(`${label} 未停用 agent 会话壳`, await exists(sessionShell(fixture, 's-idle')));
  check(`${label} 未停用 agent inbox`, await exists(inboxPath(fixture.root, TENANT, 'a-idle')));
  check(
    `${label} 停用但未归档 team 的 team 目录`,
    await exists(teamDirPath(fixture.root, TENANT, 't-mixed')),
  );
}

async function main(): Promise<void> {
  // ── 1. 真删（不传 --older-than）：状态判据自己就够 ──
  const real = await seedWorld();
  try {
    const report = await pruneTenantData(makeCtx(real), { dryRun: false });
    const { teams, agents, sessions, runs, trace } = report.categories;

    check('① 归档 team 下的 agent 被列进目标', agents.deleted === 3, String(agents.deleted));
    check('① 归档 team 记录删掉 1 个', teams.deleted === 1, String(teams.deleted));
    check('① 归档 team 体积非零', teams.bytes > 0, String(teams.bytes));
    check('② 停用 agent 会话级联', sessions.deleted === 3, String(sessions.deleted));
    check('② 级联删掉的 run 记录', runs.deleted === 2, String(runs.deleted));
    check('② 级联删掉的 trace 文件', trace.cascade_files === 3, String(trace.cascade_files));
    check('② 留存策略桶没跟着乱删', trace.deleted_runs === 0, String(trace.deleted_runs));
    check(
      '不传 --older-than 就不写阈值',
      report.older_than_ms === undefined,
      String(report.older_than_ms),
    );

    // ③ 未归档 / 未停用：一条都不动
    const remaining = await remainingAgents(real);
    check(
      '③ 未归档/未停用的 agent 记录全留',
      remaining.join(',') === 'a-busy,a-idle,a-live',
      remaining.join(','),
    );
    check('③ 没有任何记录被误删', ALL_AGENTS.length - remaining.length === 3, remaining.join(','));
    await checkUntouched(real, '③');

    // 该删的都真的没了（含 inbox / 事件目录 / trace）
    await checkDeleted(real, '①');
    check(
      '① team 目录连 log.ndjson 一起删',
      !(await exists(join(teamDirPath(real.root, TENANT, 't-arch'), 'log.ndjson'))),
    );

    // ⑦ 守卫：还有 running run 的 agent（及其归档 team）一起留
    check(
      '⑦ 活会话记一次 active',
      report.skipped.active_sessions === 1,
      String(report.skipped.active_sessions),
    );
    check('⑦ 守卫挡下的 agent 记录保留', remaining.includes('a-busy'), remaining.join(','));
    check(
      '⑦ 没清完的 team 保留',
      report.skipped.kept_teams === 1,
      String(report.skipped.kept_teams),
    );
    check('⑦ 被挡下的 agent 会话还在', await exists(sessionShell(real, 's-busy')));
    check('⑦ 被挡下的 agent run 记录还在', await exists(runRecordPath(real, 'r-busy')));
    check('⑦ 被挡下的归档 team 目录还在', await exists(teamDirPath(real.root, TENANT, 't-busy')));
    check(
      '⑦ 目标也没清干净就记账',
      report.skipped.kept_agents === 1,
      String(report.skipped.kept_agents),
    );
  } finally {
    await real.dispose();
  }

  // ── 2. dry-run 与 --yes 同集合（⑥）；dry-run 零写盘 ──
  const dryFixture = await seedWorld();
  const wetFixture = await seedWorld();
  try {
    const dryReport = await pruneTenantData(makeCtx(dryFixture), { dryRun: true });
    check(
      '⑥ dry-run 报了要删的东西',
      dryReport.categories.agents.deleted === 3,
      String(dryReport.categories.agents.deleted),
    );
    // dry-run 什么都不许动
    check('⑥ dry-run 会话壳还在', await exists(sessionShell(dryFixture, 's-arch')));
    check('⑥ dry-run run 记录还在', await exists(runRecordPath(dryFixture, 'r-arch')));
    check('⑥ dry-run trace 还在', await exists(tracePath(dryFixture, 'r-arch')));
    check('⑥ dry-run team 目录还在', await exists(teamDirPath(dryFixture.root, TENANT, 't-arch')));
    check(
      '⑥ dry-run 快照没少人',
      (await remainingAgents(dryFixture)).length === ALL_AGENTS.length,
      String((await remainingAgents(dryFixture)).length),
    );

    const wetReport = await pruneTenantData(makeCtx(wetFixture), { dryRun: false });
    check(
      '⑥ 两个模式同集合',
      signature(dryReport) === signature(wetReport),
      `${signature(dryReport)} vs ${signature(wetReport)}`,
    );
    check('⑥ dry-run 标记', dryReport.dry_run && !wetReport.dry_run);
  } finally {
    await dryFixture.dispose();
    await wetFixture.dispose();
  }

  // ── 3. --older-than 只叠加缩窄；查不到时刻的宁可留 ──
  const aged = await seedWorld();
  try {
    // 15 天阈值：t-arch 归档才 10 天（不够老）、a-closed 停用已 20 天（够老）
    const report = await pruneTenantData(makeCtx(aged, 15 * DAY), { dryRun: false });
    const remaining = await remainingAgents(aged);
    check(
      '④ 只删够老的停用 agent',
      remaining.join(',') === 'a-arch,a-busy,a-idle,a-live,a-nodate',
      remaining.join(','),
    );
    check(
      '④ 目标集合只缩窄不扩大',
      report.categories.agents.deleted === 1,
      String(report.categories.agents.deleted),
    );
    check(
      '④ 不够老的归档 team 不删',
      report.categories.teams.deleted === 0,
      String(report.categories.teams.deleted),
    );
    check('④ 不够老的归档 team 目录还在', await exists(teamDirPath(aged.root, TENANT, 't-arch')));
    check('④ 不够老的 agent 会话还在', await exists(sessionShell(aged, 's-arch')));
    check('⑤ 查不到停用时刻的默认不清', await exists(sessionShell(aged, 's-nodate')));
    check(
      '⑤ 记一次 unknown_time',
      report.skipped.unknown_time === 1,
      String(report.skipped.unknown_time),
    );
    check('④ 阈值写进报告', report.older_than_ms === 15 * DAY, String(report.older_than_ms));
    // 同一份阈值下 dry-run 也对得上
    const dryAged = await seedWorld();
    try {
      const dryReport = await pruneTenantData(makeCtx(dryAged, 15 * DAY), { dryRun: true });
      check(
        '④ 带阈值时两模式仍同集合',
        signature(dryReport) === signature(report),
        signature(dryReport),
      );
    } finally {
      await dryAged.dispose();
    }
  } finally {
    await aged.dispose();
  }

  // ── 4. 快照读不出来：一个记录都不删（宁可留） ──
  const broken = await seedWorld();
  try {
    await writeFile(snapshotPath(broken.root, TENANT), '{ not json');
    const report = await pruneTenantData(makeCtx(broken), { dryRun: false });
    check('⑧ 快照坏了给 note', report.notes.includes('agents_snapshot_unreadable'));
    check(
      '⑧ 快照坏了零删 team',
      report.categories.teams.deleted === 0,
      String(report.categories.teams.deleted),
    );
    check(
      '⑧ 快照坏了零删 agent',
      report.categories.agents.deleted === 0,
      String(report.categories.agents.deleted),
    );
    check(
      '⑧ 快照坏了零删会话',
      report.categories.sessions.deleted === 0,
      String(report.categories.sessions.deleted),
    );
    check('⑧ 归档 team 目录还在', await exists(teamDirPath(broken.root, TENANT, 't-arch')));
    check('⑧ 会话壳还在', await exists(sessionShell(broken, 's-arch')));
    const raw = await readFile(snapshotPath(broken.root, TENANT), 'utf8');
    check('⑧ 快照没被改写', raw === '{ not json', raw.slice(0, 20));
  } finally {
    await broken.dispose();
  }

  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(`OK prune-status: passed ${String(passed)} / ${String(total)} checks`);
    return;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED prune-status: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}

await main();
