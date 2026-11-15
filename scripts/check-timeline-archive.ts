#!/usr/bin/env bun

/**
 * 0.54 归档接线门禁：`TimelineWriter.archive()` 真的被调度 ⇒ `timeline_head` 真的推进
 * （ADR-105 §3 I3 / §11；双写观察期的前置条件）。
 *
 * 双写只写 `wal.log` + 块；`timeline_head` 要等**归档**才前进。没接线时观察期只会看到
 * `timeline_head` 恒为 0、`wal_head` 一直涨 —— 那不是「还没写」，是「没归档」。
 *
 * | # | 断言 | 为什么必须这样 |
 * | --- | --- | --- |
 * | ① | 开关开 + 合成 run + 触发归档 ⇒ `timeline_head > 0`、`≤ wal_head`、`published_head` 不变；`journal.close()` 也真的触发一次 | 归档只搬空间，不改发布游标 |
 * | ② | 重启后 `timeline_head` ≥ 重启前（磁盘恢复，不回退） | 回退会让读侧看到已归档的位点倒退 |
 * | ③ | 注入归档失败 ⇒ `timeline_head` 冻结、`wal_head` 照常、`tainted=true`、**不产生 hole**；恢复 ⇒ `tainted` 清除、`timeline_head` 推进；连续 3 次失败进 100/500/2000ms 退避 | 这就是 I3 的全部内容：失败只影响空间回收 |
 * | ④ | 同一会话在飞归档数峰值 = 1 | 并发归档会互相覆盖段文件 / manifest 指针 |
 * | ⑤ | 开关关 ⇒ 一次归档都不发生 | 与「开关关零写入」同一条纪律 |
 * | ⑥ | 慢归档（200ms）期间 publish 继续推进（`wal_head` 增长），且归档当时仍在飞 | 归档不得落在 publish 路径上被 await |
 *
 * ## 注入手段（全部用**既有测试缝**，不改写入侧）
 *
 * - 归档失败：`TimelineWriterOptions.beforeSync`（`kind === 'timeline'` 就是归档段写前的
 *   fsync）—— 这是写入侧自己的缝，门禁在 `openWriter` 里把它接上；
 * - 慢归档：门禁在 `openWriter` 缝上包一层 `archive()`，sleep 发生在写入侧队列**之外**
 *   （所以它证明的是「调度侧不 await」，不是「写入侧队列不排队」）；
 * - 时钟：管理器的 `now` 缝 —— 退避/节流窗口内不必真的等，断言不依赖机器速度。
 *
 * ## 为什么单独一个脚本
 *
 * `check-timeline-dualwrite`（34 条）判的是「双写接线没有副作用」；归档调度是另一条链
 * （run 终态 / 周期保底 / 显式），红的原因和修的地方都不同，混进同一个脚本只会让 34 条
 * 的基线失去意义。`package.json` 的 `check:timeline-archive` 一行留给主干接（本单禁改
 * `package.json`）；直接 `bun run scripts/check-timeline-archive.ts` 也能跑。
 *
 * 用法：`bun run scripts/check-timeline-archive.ts`
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRunJournalFactory,
  type Logger,
  MemoryEventStream,
  type RunJournal,
  SessionEventLog,
  sessionDirPath,
} from '../packages/core/src/index';
import type { TimelineSyncKind } from '../packages/core/src/timeline/types';
import { readHoles } from '../packages/core/src/timeline/wal';
import { TimelineWriter } from '../packages/core/src/timeline/writer';
import { createTimelineDualWrite, type TimelineDualWrite } from '../src/timeline-dual-write';

let checks = 0;
let failures = 0;

function pass(name: string, detail = ''): void {
  checks += 1;
  console.log(`[PASS] ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string): void {
  checks += 1;
  failures += 1;
  console.log(`[FAIL] ${name} — ${detail}`);
}

function assertTrue(name: string, condition: boolean, detail = ''): void {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  assertTrue(name, actual === expected, `actual=${String(actual)} expected=${String(expected)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待（归档是 fire-and-forget：等它「真的发生」不能用固定 sleep）。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

const NOW = 1_760_000_000_000;
const SESSION = 'archive-probe';

const quietLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 与 `check-timeline-dualwrite` 同一份定长脚本（10 条，含 2 条 chunk）。 */
const SCRIPT: ReadonlyArray<{ type: string; data: Record<string, unknown> }> = [
  {
    type: 'run.started',
    data: { run_id: 'run-archive-1', session_id: SESSION, input: 'hello archive' },
  },
  { type: 'user.message', data: { text: 'hello archive' } },
  {
    type: 'llm.request',
    data: { model: 'probe-model', messages: [{ role: 'user', content: 'hello archive' }] },
  },
  { type: 'llm.stream.chunk', data: { delta: 'ar' } },
  { type: 'llm.stream.chunk', data: { delta: 'chive' } },
  { type: 'llm.response', data: { content: 'hello archive', usage: { total_tokens: 7 } } },
  { type: 'tool.call.started', data: { tool_call_id: 'call-1', name: 'bash' } },
  { type: 'tool.call.completed', data: { tool_call_id: 'call-1', output: 'ok' } },
  { type: 'assistant.message', data: { text: 'done' } },
  { type: 'run.completed', data: { run_id: 'run-archive-1', status: 'completed' } },
];

/** 门禁自己的 writer 缝状态（计数 + 注入）。 */
interface SeamState {
  /** `archive()` 被调用次数（退避断言只看这个）。 */
  calls: number;
  /** 当前在飞 `archive()` 数（④ 的计数器）。 */
  inFlight: number;
  /** 在飞峰值（④ 断言 == 1）。 */
  peak: number;
  /** 慢归档注入（ms；0 = 不注入）。 */
  slowMs: number;
  /** 命中该 kind 的 `beforeSync` 抛错（`undefined` = 不注入失败）。 */
  failKind?: TimelineSyncKind;
  /** 门禁自己开出来的 writer（读 `publishedHead()` 用）。 */
  writer?: TimelineWriter;
}

interface Scenario {
  root: string;
  sessionsDir: string;
  sessionDir: string;
  manager: TimelineDualWrite;
  seam: SeamState;
  /** 假时钟（管理器的 `now` 缝）：退避/节流窗口内不用真的等。 */
  clock: { value: number };
  log: SessionEventLog;
  close(): Promise<void>;
}

const roots: string[] = [];

async function createScenario(options: {
  name: string;
  dualWrite: boolean;
  /** 周期保底间隔（ms）；`0` ⇒ 关掉周期保底，门禁自己控制触发点。 */
  archiveIntervalMs?: number;
  slowMs?: number;
  /** 复用已有 root（② 的重启用）。 */
  root?: string;
}): Promise<Scenario> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), `vessel-archive-${options.name}-`)));
  if (options.root === undefined) roots.push(root);
  const sessionsDir = join(root, 'sessions');
  const sessionDir = sessionDirPath(sessionsDir, SESSION);
  const seam: SeamState = { calls: 0, inFlight: 0, peak: 0, slowMs: options.slowMs ?? 0 };
  const clock = { value: NOW };
  const log = new SessionEventLog({ dir: sessionsDir, durable: false, logger: quietLogger });
  const manager = createTimelineDualWrite({
    dataDir: root,
    sessionsDir,
    dualWrite: options.dualWrite,
    verifySampleRate: 0,
    ...(options.archiveIntervalMs !== undefined
      ? { archiveIntervalMs: options.archiveIntervalMs }
      : {}),
    logger: quietLogger,
    now: () => clock.value,
    // writer 缝：注入 fsync 失败 + 数在飞归档数 + 注入慢归档。
    openWriter: async (input) => {
      const writer = await TimelineWriter.open({
        sessionId: input.sessionId,
        sessionDir: input.sessionDir,
        chunkFlushMs: input.chunkFlushMs,
        // 自定义 openWriter 缝**必须原样转发 publish**，否则 I2「发布只能发生在 WAL 之后」会被静默绕过
        // （pub-i2 实测发现：本门禁只验归档调度，漏转发也不会红 —— 正是最容易被后人复制走的那种隐患）。
        ...(input.publish !== undefined ? { publish: input.publish } : {}),
        // 同一条纪律：显式 adopt 断言也必须原样转发，否则缝会变成「绕过 freeze 闸门」的旁路。
        ...(input.adoptLegacyShapedSession !== undefined
          ? { adoptLegacyShapedSession: input.adoptLegacyShapedSession }
          : {}),
        beforeSync: (kind) => {
          if (seam.failKind === kind) throw new Error(`injected_fsync_failure: ${kind}`);
        },
      });
      seam.writer = writer;
      const real = writer.archive.bind(writer);
      writer.archive = async () => {
        seam.calls += 1;
        seam.inFlight += 1;
        seam.peak = Math.max(seam.peak, seam.inFlight);
        try {
          // sleep 在写入侧队列之外：它只证明调度侧没 await 归档。
          if (seam.slowMs > 0) await sleep(seam.slowMs);
          return await real();
        } finally {
          seam.inFlight -= 1;
        }
      };
      return writer;
    },
  });
  return {
    root,
    sessionsDir,
    sessionDir,
    manager,
    seam,
    clock,
    log,
    close: async () => {
      await manager.closeAll().catch(() => {});
      await log.close().catch(() => {});
    },
  };
}

/** 起一个合成 run 并落盘脚本；返回 journal（`close()` = run 终态）。 */
async function publishRun(
  scenario: Scenario,
  runId: string,
  items: ReadonlyArray<{ type: string; data: Record<string, unknown> }> = SCRIPT,
): Promise<RunJournal> {
  const events = new MemoryEventStream();
  const journal = createRunJournalFactory({
    eventLog: scenario.log,
    logger: quietLogger,
    timelineDualWrite: scenario.manager,
  }).begin({ runId, sessionId: SESSION, events });
  for (const [index, item] of items.entries()) {
    journal.appendFact({ type: item.type, run_id: runId, ts: NOW + index, data: item.data });
  }
  await journal.flush();
  // 让双写的 fire-and-forget append 落定（不归档：归档由调用方显式/终态触发）。
  await scenario.manager.flushSession(SESSION);
  return journal;
}

/** 再追加几条已持久事件（不关 journal：用于「归档期间 publish 继续推进」）。 */
async function appendFacts(scenario: Scenario, runId: string, count: number): Promise<void> {
  const events = new MemoryEventStream();
  const journal = createRunJournalFactory({
    eventLog: scenario.log,
    logger: quietLogger,
    timelineDualWrite: scenario.manager,
  }).begin({ runId, sessionId: SESSION, events });
  for (let index = 0; index < count; index += 1) {
    journal.appendFact({
      type: 'assistant.message',
      run_id: runId,
      ts: NOW + 100 + index,
      data: { text: `tick ${String(index)}` },
    });
  }
  await journal.flush();
}

/** 会话目录里的 timeline 痕迹（只看文件名）。 */
async function timelineArtifacts(sessionDir: string): Promise<string[]> {
  const entries = await readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'events.ndjson' || entry.name === 'index.json') continue;
    names.push(entry.name);
  }
  return names.sort();
}

try {
  // ── ① 归档真的推进 timeline_head，且不动 published_head ──────────────────
  const advance = await createScenario({
    name: 'advance',
    dualWrite: true,
    archiveIntervalMs: 0,
  });
  // journal 不关闭：run 终态触发的归档放在 ①b 单独验，这里用显式触发保证确定性。
  await publishRun(advance, 'run-archive-1');
  const before = await advance.manager.heads(SESSION);
  assertEqual('① 归档前 timeline_head=0（双写只进 WAL，不归档）', before?.timeline_head, 0);
  assertTrue(
    '① 归档前 wal_head 已经前进',
    (before?.wal_head ?? 0) > 0,
    `wal_head=${String(before?.wal_head)}`,
  );

  const publishedBefore = advance.seam.writer?.publishedHead() ?? -1;
  await advance.manager.archiveSession(SESSION);
  const after = await advance.manager.heads(SESSION);
  assertTrue(
    '① 归档后 timeline_head > 0',
    (after?.timeline_head ?? 0) > 0,
    `timeline_head=${String(after?.timeline_head)} wal_head=${String(after?.wal_head)}`,
  );
  assertTrue(
    '① timeline_head ≤ wal_head',
    (after?.timeline_head ?? 0) <= (after?.wal_head ?? 0),
    `timeline_head=${String(after?.timeline_head)} wal_head=${String(after?.wal_head)}`,
  );
  assertEqual(
    '① 归档把 timeline_head 追平到 wal_head（这一段全部固化）',
    after?.timeline_head,
    after?.wal_head,
  );
  assertEqual(
    '① published_head 不变（归档不改发布游标）',
    advance.seam.writer?.publishedHead(),
    publishedBefore,
  );
  const advanceStats = advance.manager.stats();
  assertTrue(
    '① 指标：archiveCount ≥ 1 且 lastArchiveAt > 0',
    advanceStats.archiveCount >= 1 && advanceStats.lastArchiveAt > 0,
    JSON.stringify({
      archiveCount: advanceStats.archiveCount,
      lastArchiveAt: advanceStats.lastArchiveAt,
    }),
  );
  assertEqual('① 归档成功时 tainted=false', after?.tainted, false);

  // ①b：run 终态（`journal.close()` → `endRun`）本身就触发一次归档。
  const runEnd = await createScenario({
    name: 'run-end',
    dualWrite: true,
    archiveIntervalMs: 0,
  });
  const runEndJournal = await publishRun(runEnd, 'run-archive-end');
  await runEndJournal.close();
  const runEndAdvanced = await waitUntil(
    () => runEnd.seam.calls > 0,
    // 归档内部 3 次重试不涉及这里（成功路径很快），5s 足够。
    5_000,
  );
  await runEnd.manager.drainArchives();
  const runEndHeads = await runEnd.manager.heads(SESSION);
  assertTrue(
    '① run 终态（journal.close）触发了归档',
    runEndAdvanced && (runEndHeads?.timeline_head ?? 0) > 0,
    `calls=${String(runEnd.seam.calls)} timeline_head=${String(runEndHeads?.timeline_head)}`,
  );

  // ── ② 重启后 timeline_head 从磁盘恢复、不回退 ─────────────────────────────
  const headBeforeRestart = after?.timeline_head ?? 0;
  await advance.manager.closeAll();
  const restarted = await createScenario({
    name: 'restart',
    dualWrite: true,
    archiveIntervalMs: 0,
    root: advance.root,
  });
  // 新进程还没有 writer ⇒ 只能从磁盘（manifest archive 行 + 索引 + 洞）算。
  const diskHeads = await restarted.manager.heads(SESSION);
  assertTrue(
    '② 重启后（无 writer，纯磁盘口径）timeline_head 不回退',
    (diskHeads?.timeline_head ?? -1) >= headBeforeRestart,
    `before=${String(headBeforeRestart)} after=${String(diskHeads?.timeline_head)}`,
  );
  assertEqual('② 重启后 wal_head 也不回退', diskHeads?.wal_head, after?.wal_head);

  // 再开一个 run ⇒ writer 重新打开并从 manifest 恢复 archivedTo。
  await publishRun(restarted, 'run-archive-2', SCRIPT.slice(0, 3));
  const reopened = await restarted.manager.heads(SESSION);
  assertTrue(
    '② 重开 writer 后 timeline_head 仍不回退（恢复 archivedTo）',
    (reopened?.timeline_head ?? -1) >= headBeforeRestart,
    `before=${String(headBeforeRestart)} after=${String(reopened?.timeline_head)}`,
  );

  // ── ③ 归档失败：I3 的每一条 ───────────────────────────────────────────────
  const failure = await createScenario({
    name: 'failure',
    dualWrite: true,
    archiveIntervalMs: 10,
  });
  // 注入：归档段写前的 fsync 必失败（写入侧会自己重试 3 次，100/500/2000ms）。
  // 在**发布之前**就打开，这样第一次自动归档（周期保底）落在失败路径上 ——
  // 与线上「磁盘坏了但 run 还在写」同形；它不影响 append（append 走的是 wal/block 同步）。
  failure.seam.failKind = 'timeline';
  await publishRun(failure, 'run-archive-1');
  // publishRun 里 `flushSession` 会排在失败的归档后面，所以返回时第 1 次失败已经落定。
  await failure.manager.drainArchives();
  const walBeforeFailure = (await failure.manager.heads(SESSION))?.wal_head ?? 0;
  const failedHeads = await failure.manager.heads(SESSION);
  assertEqual('③ 失败：timeline_head 冻结（不推进）', failedHeads?.timeline_head, 0);
  assertEqual('③ 失败：wal_head 照常', failedHeads?.wal_head, walBeforeFailure);
  assertEqual('③ 失败：tainted=true', failedHeads?.tainted, true);
  assertEqual('③ 失败：不产生 hole（洞只属于真丢失）', (failedHeads?.holes ?? []).length, 0);
  const diskHoles = await readHoles(failure.sessionDir).catch(() => []);
  assertEqual('③ 失败：磁盘上也没有洞', diskHoles.length, 0);
  assertTrue(
    '③ 失败：指标 archiveFailed ≥ 1',
    failure.manager.stats().archiveFailed >= 1,
    JSON.stringify({
      archiveFailed: failure.manager.stats().archiveFailed,
      archiveCount: failure.manager.stats().archiveCount,
    }),
  );

  // 连续 3 次失败后进退避（100/500/2000ms）：自动归档在窗口内必须被挡住。
  await failure.manager.archiveSession(SESSION); // 第 2 次
  await failure.manager.archiveSession(SESSION); // 第 3 次
  const callsAfterThree = failure.seam.calls;
  assertTrue(
    '③ 退避：连续 3 次失败确实发生了（每次都是写入侧 3 次重试后）',
    failure.manager.stats().archiveFailed >= 3,
    JSON.stringify({ archiveFailed: failure.manager.stats().archiveFailed }),
  );
  failure.clock.value += 10; // 退避窗口（第 3 次失败后 100ms）之内
  await appendFacts(failure, 'run-archive-backoff', 1);
  await sleep(30);
  assertEqual(
    '③ 退避：失败 3 次后 100ms 窗口内的自动归档被挡住',
    failure.seam.calls,
    callsAfterThree,
  );

  // 恢复：让 fsync 正常 + 让退避窗口过去 ⇒ 自动归档成功、污点清除、指针推进。
  failure.seam.failKind = undefined;
  failure.clock.value += 300;
  await appendFacts(failure, 'run-archive-recover', 1);
  const recoveredInTime = await waitUntil(() => failure.seam.calls > callsAfterThree, 5_000);
  await failure.manager.drainArchives();
  const recoveredHeads = await failure.manager.heads(SESSION);
  assertTrue(
    '③ 恢复：退避窗口过去后自动归档真的又跑了',
    recoveredInTime,
    `calls=${String(failure.seam.calls)}`,
  );
  assertEqual('③ 恢复：tainted 清除', recoveredHeads?.tainted, false);
  assertEqual(
    '③ 恢复：timeline_head 推进到 wal_head',
    recoveredHeads?.timeline_head,
    recoveredHeads?.wal_head,
  );
  assertTrue(
    '③ 恢复：timeline_head > 0',
    (recoveredHeads?.timeline_head ?? 0) > 0,
    `timeline_head=${String(recoveredHeads?.timeline_head)}`,
  );

  // ── ④ 并发保护：同一会话同一时刻归档数 ≤ 1 ────────────────────────────────
  const concurrency = await createScenario({
    name: 'concurrency',
    dualWrite: true,
    archiveIntervalMs: 0,
    slowMs: 50,
  });
  await publishRun(concurrency, 'run-archive-1');
  await Promise.all([
    concurrency.manager.archiveSession(SESSION),
    concurrency.manager.archiveSession(SESSION),
    concurrency.manager.archiveSession(SESSION),
    concurrency.manager.archiveSession(SESSION),
    concurrency.manager.archiveSession(SESSION),
  ]);
  assertEqual('④ 同一会话在飞归档数峰值 = 1', concurrency.seam.peak, 1);
  assertTrue(
    '④ 5 次显式归档都真的跑过（没有互相吞掉）',
    concurrency.seam.calls >= 5,
    `calls=${String(concurrency.seam.calls)}`,
  );

  // ── ⑤ 开关关：一次归档都不发生 ────────────────────────────────────────────
  const off = await createScenario({ name: 'off', dualWrite: false, archiveIntervalMs: 10 });
  await publishRun(off, 'run-archive-1');
  await off.manager.archiveSession(SESSION); // 空操作
  await sleep(120); // 周期计时器即使装了也给足机会
  const offStats = off.manager.stats();
  assertEqual('⑤ 开关关：archiveCount=0', offStats.archiveCount, 0);
  assertEqual('⑤ 开关关：archiveFailed=0', offStats.archiveFailed, 0);
  assertEqual('⑤ 开关关：没有打开任何 writer（sessions=0）', offStats.sessions, 0);
  assertEqual('⑤ 开关关：archive() 一次都没被调用', off.seam.calls, 0);
  assertEqual(
    '⑤ 开关关：会话目录里没有 timeline 文件',
    (await timelineArtifacts(off.sessionDir)).join(','),
    '',
  );

  // ── ⑥ 归档不阻塞 publish ─────────────────────────────────────────────────
  const nonBlocking = await createScenario({
    name: 'nonblocking',
    dualWrite: true,
    archiveIntervalMs: 0,
    slowMs: 200,
  });
  const nbJournal = await publishRun(nonBlocking, 'run-archive-1', SCRIPT.slice(0, 3));
  const walAtStart = (await nonBlocking.manager.heads(SESSION))?.wal_head ?? 0;
  // 慢归档在飞（不 await！）
  const archiving = nonBlocking.manager.archiveSession(SESSION);
  await waitUntil(() => nonBlocking.seam.inFlight === 1, 1_000);
  // 归档在飞期间继续 publish（journal 是同步 fire-and-forget 落盘）
  await appendFacts(nonBlocking, 'run-archive-2', 5);
  await nonBlocking.manager.flushSession(SESSION);
  const duringHeads = await nonBlocking.manager.heads(SESSION);
  const stillInFlight = nonBlocking.seam.inFlight;
  assertEqual('⑥ 归档在飞（真的慢）', stillInFlight, 1);
  assertTrue(
    '⑥ 归档期间 publish 继续推进（wal_head 增长，无等待）',
    (duringHeads?.wal_head ?? 0) > walAtStart,
    `before=${String(walAtStart)} during=${String(duringHeads?.wal_head)}`,
  );
  assertTrue(
    '⑥ 归档期间 timeline_head ≤ wal_head（没有越过未固化区间）',
    (duringHeads?.timeline_head ?? 0) <= (duringHeads?.wal_head ?? 0),
    `timeline_head=${String(duringHeads?.timeline_head)} wal_head=${String(duringHeads?.wal_head)}`,
  );
  await archiving;
  await nonBlocking.manager.drainArchives();
  const afterSlow = await nonBlocking.manager.heads(SESSION);
  assertEqual(
    '⑥ 慢归档结束后把期间 publish 的尾巴也固化了（timeline_head 追平 wal_head）',
    afterSlow?.timeline_head,
    afterSlow?.wal_head,
  );
  await nbJournal.close();

  for (const scenario of [advance, runEnd, restarted, failure, concurrency, off, nonBlocking]) {
    await scenario.close();
  }
} finally {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

console.log('');
console.log(`检查项 ${String(checks)} 条，失败 ${String(failures)} 条`);
if (failures > 0) {
  console.log(
    '结论：FAIL（归档调度没接对：指针没推进 / 失败影响了空间之外的东西 / 阻塞了 publish）',
  );
  process.exit(1);
}
console.log(
  '结论：PASS（归档推进 timeline_head / 重启不回退 / 失败只冻结指针且无洞 / 并发 ≤1 / 开关关零归档 / 不阻塞 publish）',
);
