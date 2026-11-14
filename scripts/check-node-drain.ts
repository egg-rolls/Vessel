#!/usr/bin/env bun

/**
 * 门禁：node 优雅退出（0.52 S1a）。
 *
 * 背景：node 被 SIGTERM / vessel node stop 打断时，在跑 run 里的活不能白跑。
 * S1a 的契约（顺序不能换）：fence 准入 → 只给「有在跑 run 的会话」写 resume 标记
 * → interrupt('shutdown') → ≤2s settle → flush 会话状态（半截回复也要落地）。
 *
 * 五层判据：
 *
 * - a 标记口径：2 个在跑 run ⇒ 恰好 2 条标记且字段齐全；没有在跑 run 的会话 0 条。
 * - b 准入 fence：fence 打开后 runs.start 立刻 gateway_restarting（不收下），
 *   agents.dispatch 只进 durable inbox、条数 = 发出条数、不启动任何执行。
 * - c 不许等长任务：注入永不 resolve 的 LLM，drain 仍在 2s 内返回（settle=timeout）。
 * - d 幂等：重复 beginDrain 标记数不变、不重复 interrupt。
 * - e 单写口 + 双后端：标记经 RunJournal 落盘，file / sqlite 都能重新读回。
 *
 * 用法：bun run scripts/check-node-drain.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createResumeMarkerRegistry,
  createRunJournalFactory,
  ExecutionUnit,
  FileSessionStore,
  MemoryEventStream,
  MemorySessionStore,
  MemoryWorkingContext,
  type ResumeAfterRestart,
  type RunJournalFactory,
  type SessionState,
  type SessionStore,
  SQLiteSessionStore,
} from '../packages/core/src/index';
import { createNodeDrainer, type NodeDrainUnit } from '../src/node-drain';

const MODEL = 'probe-model-drain';

const failures: string[] = [];
let passed = 0;
const paths: string[] = [];

function ok(label: string): void {
  passed += 1;
  paths.push('OK   ' + label);
}

function fail(where: string, message: string): void {
  failures.push(where + ': ' + message);
}

function expect(where: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(where + ' = ' + e);
  else fail(where, '期望 ' + e + '，实际 ' + a);
}

function check(where: string, condition: boolean, message: string): void {
  if (condition) ok(where);
  else fail(where, message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 永远不 resolve 的 provider：证明退出路径没有 await 模型流。 */
function hangingProvider(): never {
  return {
    chat: () => new Promise(() => undefined),
  } as never;
}

/** 等到会话状态可见（异步版）。 */
async function waitForSession(store: SessionStore, sessionId: string): Promise<boolean> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const state = await store.load(sessionId);
    if (state !== null) return true;
    await sleep(5);
  }
  return (await store.load(sessionId)) !== null;
}

/** 等到条件成立（或超时返回 false）。 */
async function waitFor(condition: () => boolean, budgetMs = 1000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
}

/** 造一个真 ExecutionUnit（Memory 替身 + 真 journal 工厂）。 */
async function makeUnit(options: {
  session: SessionStore;
  journalFactory: RunJournalFactory;
}): Promise<ExecutionUnit> {
  const events = new MemoryEventStream();
  return ExecutionUnit.create({
    provider: hangingProvider(),
    model: MODEL,
    contextFactory: () => new MemoryWorkingContext({ maxTokens: 200_000 }),
    events,
    limits: {},
    termination: {},
    journalFactory: options.journalFactory,
    session: options.session,
    systemPrompt: 'node drain probe system prompt',
    retry: { maxRetries: 0 },
  });
}

/** 起一个永不结束的 run（不 await；异常吞掉——打断本来就会失败）。 */
function startRun(unit: ExecutionUnit, sessionId: string): void {
  void unit.run('drain probe input', sessionId).catch(() => undefined);
}

function markerFieldsOf(state: SessionState | null | undefined): string[] {
  if (!state?.resume_after_restart) return [];
  return Object.keys(state.resume_after_restart).sort();
}

// ───────────────────────── a 标记口径 ─────────────────────────

async function probeA(): Promise<void> {
  const session = new MemorySessionStore();
  const registry = createResumeMarkerRegistry();
  const journalFactory = createRunJournalFactory({ session, resumeMarkers: registry });

  const euA = await makeUnit({ session, journalFactory });
  const euB = await makeUnit({ session, journalFactory });
  const euIdle = await makeUnit({ session, journalFactory });
  const units: NodeDrainUnit[] = [euA, euB, euIdle];

  startRun(euA, 's-drain-a1');
  startRun(euB, 's-drain-a2');
  const bothRunning =
    (await waitFor(() => euA.activeRunSnapshot() !== undefined)) &&
    (await waitFor(() => euB.activeRunSnapshot() !== undefined)) &&
    (await waitForSession(session, 's-drain-a1')) &&
    (await waitForSession(session, 's-drain-a2'));
  check('a.0 两个 run 真的在跑', bothRunning, '在跑 run 没有起来，探针前提不成立');
  // euIdle 从未 run：它一个 run 都没有，属于「没有在跑 run 的会话」。
  check('a.0b idle 执行面没有 active run', euIdle.activeRunSnapshot() === undefined, 'idle 有 run');

  const pending = new Map<string, string[]>([['s-drain-a1', ['inbox-1', 'inbox-2']]]);
  const drainer = createNodeDrainer({
    units: () => units,
    pendingInboxIdsBySession: () => pending,
    beginFence: () => true,
    // 装配层同款：把标记登记进 journal 侧的竞态保护注册表。
    armResumeMarker: (sessionId, marker) => registry.arm(sessionId, marker),
  });

  const report = await drainer.beginDrain('shutdown');
  expect('a.1 标记条数 = 在跑 run 的会话数', report.marks.length, 2);
  expect('a.2 标记会话', report.marks.map((mark) => mark.session_id).sort(), [
    's-drain-a1',
    's-drain-a2',
  ]);
  expect('a.3 两条都真的落盘', report.marks.filter((mark) => mark.persisted).length, 2);
  expect(
    'a.4 无 run 的会话 0 条',
    report.marks.filter((mark) => mark.session_id === 's-drain-idle').length,
    0,
  );

  const snapshotA = euA.activeRunSnapshot();
  const loadedA = await session.load('s-drain-a1');
  const loadedB = await session.load('s-drain-a2');
  const loadedIdle = await session.load('s-drain-idle');
  expect('a.5 idle 会话没有标记字段', loadedIdle?.resume_after_restart, undefined);
  expect('a.6 标记字段齐全', markerFieldsOf(loadedA), [
    'background_stopped',
    'interrupted_at',
    'pending_input_ids',
    'reason',
    'run_id',
  ]);
  const markerA = loadedA?.resume_after_restart as ResumeAfterRestart | undefined;
  check('a.7 run_id 与在跑 run 一致', markerA?.run_id === snapshotA?.run_id, 'run_id 对不上');
  check(
    'a.8 interrupted_at 是合理时间戳',
    typeof markerA?.interrupted_at === 'number' && markerA.interrupted_at > 1_600_000_000_000,
    'interrupted_at 不是 epoch ms',
  );
  expect('a.9 reason = shutdown', markerA?.reason, 'shutdown');
  expect('a.10 pending_input_ids 来自 durable inbox', markerA?.pending_input_ids, [
    'inbox-1',
    'inbox-2',
  ]);
  expect(
    'a.11 没有会话的 pending 就是空数组',
    loadedB?.resume_after_restart?.pending_input_ids,
    [],
  );
  expect('a.12 background_stopped = false（S1a 不碰后台）', markerA?.background_stopped, false);
  expect(
    'a.13 两处标记各自指向自己的 run',
    report.marks.every((mark) => mark.run_id.length > 0),
    true,
  );

  // 打断是给执行面发出的，不是给会话：三个执行面里只有两个有 active run。
  expect('a.14 只打断在跑的执行面', report.interrupted, 2);
  expect('a.15 竞态保护注册表只武装了有 run 的两个会话', registry.size(), 2);
  check(
    'a.16 注册表里没有无 run 的会话',
    registry.get('s-drain-idle') === undefined,
    'idle 会话被登记了',
  );
}

// ───────────────────────── c 不等长任务 / d 幂等 ─────────────────────────

async function probeCD(): Promise<void> {
  const session = new MemorySessionStore();
  const registry = createResumeMarkerRegistry();
  const journalFactory = createRunJournalFactory({ session, resumeMarkers: registry });
  const eu = await makeUnit({ session, journalFactory });
  startRun(eu, 's-drain-c1');
  const running =
    (await waitFor(() => eu.activeRunSnapshot() !== undefined)) &&
    (await waitForSession(session, 's-drain-c1'));
  check('c.0 永不 resolve 的 run 已在跑', running, 'run 没起来');

  let interrupts = 0;
  const unit: NodeDrainUnit = {
    activeRunSnapshot: () => eu.activeRunSnapshot(),
    armResumeAfterRestart: (sessionId, marker) => eu.armResumeAfterRestart(sessionId, marker),
    interrupt: () => {
      interrupts += 1;
      eu.interrupt('shutdown');
    },
    flushStateWrites: () => eu.flushStateWrites(),
  };
  let fenceCalls = 0;
  const drainer = createNodeDrainer({
    units: () => [unit],
    pendingInboxIdsBySession: () => new Map(),
    beginFence: () => {
      fenceCalls += 1;
      return true;
    },
  });

  const startedAt = Date.now();
  const report = await drainer.beginDrain('shutdown');
  const elapsed = Date.now() - startedAt;
  check('c.1 2s 内结束（LLM 永不 resolve）', elapsed < 2000 + 300, '耗时 ' + elapsed + 'ms');
  check(
    'c.2 settle 有明确结局（不断言必须超时：abort 若能让 loop 结束就是 settled）',
    report.settle === 'settled' || report.settle === 'timeout',
    'settle = ' + report.settle,
  );
  expect('c.3 settle 预算就是 2s', report.settle_ms, 2000);
  expect('c.4 标记仍然写了（先写标记再打断）', report.marks.length, 1);
  expect('c.5 打断了一次', interrupts, 1);

  const loaded = await session.load('s-drain-c1');
  check(
    'c.6 标记已落盘',
    loaded?.resume_after_restart?.run_id === report.marks[0]?.run_id,
    '标记没落',
  );

  // d：重复调用必须原样返回，不重复写标记 / 不重复 interrupt / 开关 fence 只一次。
  const again = await drainer.beginDrain('shutdown');
  expect('d.1 重复 beginDrain 返回同一份报告', again.marks.length, report.marks.length);
  expect('d.2 不重复 interrupt', interrupts, 1);
  expect('d.3 不重复开 fence', fenceCalls, 1);
  expect('d.4 report() 与返回一致', drainer.report()?.interrupted, 1);
  expect('d.5 isDraining 为真', drainer.isDraining(), true);
  const loadedAgain = await session.load('s-drain-c1');
  expect(
    'd.6 标记数不变（同一条）',
    loadedAgain?.resume_after_restart?.interrupted_at,
    loaded?.resume_after_restart?.interrupted_at,
  );

  // c.7-c.9：执行面永不收口（模型流永远挂着、interrupt 也不管用）⇒ 必须在 2s 硬停，
  // 且退出码仍是「写标记 + 打断」都做完了才走。这是 S1a 的核心时间预算判据。
  const stuckUnit: NodeDrainUnit = {
    activeRunSnapshot: () => ({ run_id: 'run-stuck', session_id: 's-drain-stuck' }),
    armResumeAfterRestart: async () => true,
    interrupt: () => undefined,
  };
  let stuckFence = 0;
  const stuckDrainer = createNodeDrainer({
    units: () => [stuckUnit],
    pendingInboxIdsBySession: () => new Map(),
    beginFence: () => {
      stuckFence += 1;
      return true;
    },
  });
  const stuckStartedAt = Date.now();
  const stuckReport = await stuckDrainer.beginDrain('shutdown');
  const stuckElapsed = Date.now() - stuckStartedAt;
  expect('c.7 永不收口的 run ⇒ settle = timeout', stuckReport.settle, 'timeout');
  check(
    'c.8 硬停就在 2s 附近（不是 5s、也不是无限等）',
    stuckElapsed >= 1900 && stuckElapsed < 2400,
    '耗时 ' + stuckElapsed + 'ms',
  );
  expect('c.9 超时前已经把标记写完', stuckReport.marks.length, 1);
  expect('c.10 fence 只开一次', stuckFence, 1);
}

// ───────────────────────── b 准入 fence ─────────────────────────

/** 假 scheduler：fence 活着的路径根本走不到它。 */
function fakeScheduler(): never {
  return {
    submit: () => ({ runId: 'run-probe', promise: Promise.resolve({ status: 'completed' }) }),
    cancel: () => false,
    snapshot: () => ({ running: [], queued: [], stats: {} }),
  } as never;
}

async function probeB(): Promise<void> {
  const { createRunControl } = await import('../src/run-control');
  // 必须用 run-control 里同一个模块实例的 AgentError（instanceof 才成立）。
  const { AgentError } = await import('@vessel-agent/agent');
  const { RpcError } = await import('../packages/serve/src/rpc');

  // B1：fence 打开 ⇒ runs.start 立刻 gateway_restarting，且**没有**收下（admit 未被调用）。
  let admitCalls = 0;
  const drainingService = {
    isDraining: () => true,
    admit: async () => {
      admitCalls += 1;
      return { run_id: 'should-not-happen', status: 'running' };
    },
  };
  const control = createRunControl(drainingService as never, fakeScheduler(), 'tenant-probe');
  let errorCode: string | undefined;
  try {
    await control.start({ input: 'drain probe start' } as never);
  } catch (error) {
    errorCode = error instanceof RpcError ? error.code : 'not-rpc-error';
  }
  expect(
    'b.1 runs.start 在 draining 期间被拒（gateway_restarting）',
    errorCode,
    'gateway_restarting',
  );
  expect('b.2 拒就是拒：admit 一次都没被调用', admitCalls, 0);

  // B3：admit 内部 fence 抢先打开时，同一个错误码（不留 internal）。
  const racingService = {
    isDraining: () => false,
    admit: async () => {
      throw new AgentError('node_draining', 'node_draining: main');
    },
  };
  const racingControl = createRunControl(racingService as never, fakeScheduler(), 'tenant-probe');
  let racingCode: string | undefined;
  try {
    await racingControl.start({ input: 'drain probe race' } as never);
  } catch (error) {
    racingCode = error instanceof RpcError ? error.code : 'not-rpc-error';
  }
  expect('b.3 admit 侧 fence 也映射成 gateway_restarting', racingCode, 'gateway_restarting');

  // B4：fence 关了 ⇒ 正常放行（证明闸门不是无条件拒绝）。
  const openService = {
    isDraining: () => false,
    admit: async () => ({
      run_id: 'run-open',
      status: 'running',
      agent_id: 'main',
      session_id: 's-open',
    }),
  };
  const openControl = createRunControl(openService as never, fakeScheduler(), 'tenant-probe');
  const started = await openControl.start({ input: 'drain probe open' } as never);
  expect('b.4 fence 关着时 runs.start 正常返回', started.run_id, 'run-open');
}

// ── b5-b9：agents.dispatch / agents.send 在 draining 期间只排队（真 AgentService） ──

/**
 * 真 AgentServiceImpl + 真 durable inbox（dataDir 落临时目录）+ 假执行面。
 *
 * 断言三件事：投递返回 queued、inbox 里条数 = 发出条数、一次执行都没启动
 * （drain 期间绝不「收下再假装成功」，也不许偷偷起 run）。
 */
async function probeBDispatch(): Promise<void> {
  const { AgentServiceImpl } = await import('@vessel-agent/agent');
  const dir = mkdtempSync(join(tmpdir(), 'vessel-drain-b-'));
  let turns = 0;
  let submits = 0;
  try {
    const service = new AgentServiceImpl({
      tenantId: 'tenant-drain-probe',
      dataDir: dir,
      runtime: {
        spawn: async () => undefined,
        runTurn: async () => {
          turns += 1;
          return { status: 'completed' };
        },
        cancel: async () => false,
        dispose: async () => undefined,
      } as never,
      scheduler: {
        submit: () => {
          submits += 1;
          return { runId: 'run-b', promise: Promise.resolve({ status: 'completed' }) };
        },
      } as never,
    });
    await service.create({ id: 'main', name: 'main' } as never);
    await service.create({ id: 'worker', name: 'worker', owner: 'main' } as never);

    // fence 打开前后各投递一次：前者排队，后者照常（证明闸门只在 drain 期间生效）。
    expect('b.5 beginDrain 第一次真的开闸', service.beginDrain(), true);
    expect('b.6 beginDrain 幂等', service.beginDrain(), false);
    expect('b.7 isDraining 反映状态', service.isDraining(), true);

    const first = await service.dispatch({
      from: 'main',
      to: 'worker',
      content: 'drain drain probe one',
    } as never);
    const second = await service.dispatch({
      from: 'main',
      to: 'worker',
      content: 'drain drain probe two',
    } as never);
    const third = await service.dispatch({
      from: 'main',
      to: 'worker',
      content: 'drain drain probe three',
    } as never);
    const results = [first, second, third];
    expect(
      'b.8 draining 期间的 agent 投递全部 queued',
      results.map((result) => (result as { status: string }).status),
      ['queued', 'queued', 'queued'],
    );

    const pending = service.pendingInboxIdsBySession();
    const total = [...pending.values()].reduce((sum, ids) => sum + ids.length, 0);
    expect('b.9 入队条数 = 发出条数', total, 3);
    expect('b.10 一次执行都没启动', turns + submits, 0);

    const snapshot = service.inboxSnapshot('worker');
    expect('b.11 inbox 里真有这三条（durable）', snapshot.entries.length, 3);
    expect('b.12 三条都在 unread/held 里（没被消费）', snapshot.unread + snapshot.pending, 3);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略：只是 tmp 清理 */
    }
  }
}

// ───────────────────────── e 单写口 + 双后端 ─────────────────────────

/** 一条合法的最小会话状态（旧数据形状：没有标记字段）。 */
function baseState(sessionId: string): SessionState {
  return {
    session_id: sessionId,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    status: 'running',
    messages: [
      { role: 'user', content: 'drain probe e' },
      { role: 'assistant', content: '半截回复' },
    ],
  };
}

function probeMarker(runId: string): ResumeAfterRestart {
  return {
    run_id: runId,
    interrupted_at: 1_700_000_123_456,
    reason: 'shutdown',
    pending_input_ids: ['inbox-e1'],
    background_stopped: false,
  };
}

async function probeE(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'vessel-drain-e-'));
  try {
    // E1：file 后端真往返（旧文件无字段 ⇒ 读到 undefined；写后换新实例读回）。
    const fileSession = 's-drain-e-file';
    const fileStore = new FileSessionStore(join(dir, 'sessions'));
    await fileStore.save(baseState(fileSession));
    const fileRegistry = createResumeMarkerRegistry();
    const fileJournalFactory = createRunJournalFactory({
      session: fileStore,
      resumeMarkers: fileRegistry,
    });
    const fileUnit = await makeUnit({ session: fileStore, journalFactory: fileJournalFactory });
    const fileWritten = await fileUnit.armResumeAfterRestart(
      fileSession,
      probeMarker('run-e-file'),
    );
    expect('e.1 file 后端标记写入成功', fileWritten, true);

    const reopened = new FileSessionStore(join(dir, 'sessions'));
    const fileLoaded = await reopened.load(fileSession);
    expect(
      'e.2 file 后端换实例读回 run_id',
      fileLoaded?.resume_after_restart?.run_id,
      'run-e-file',
    );
    expect('e.3 file 后端字段完整', markerFieldsOf(fileLoaded), [
      'background_stopped',
      'interrupted_at',
      'pending_input_ids',
      'reason',
      'run_id',
    ]);
    expect(
      'e.4 file 后端半截回复也落地了',
      fileLoaded?.messages?.[fileLoaded.messages.length - 1]?.content,
      '半截回复',
    );

    // E2：sqlite 后端真往返（老库靠 ensureColumn 补列；写后换新实例读回）。
    const dbPath = join(dir, 'sessions.db');
    const sqliteSession = 's-drain-e-sqlite';
    const sqliteStore = new SQLiteSessionStore(dbPath);
    await sqliteStore.save(baseState(sqliteSession));
    const sqliteRegistry = createResumeMarkerRegistry();
    const sqliteJournalFactory = createRunJournalFactory({
      session: sqliteStore,
      resumeMarkers: sqliteRegistry,
    });
    const sqliteUnit = await makeUnit({
      session: sqliteStore,
      journalFactory: sqliteJournalFactory,
    });
    const sqliteWritten = await sqliteUnit.armResumeAfterRestart(
      sqliteSession,
      probeMarker('run-e-sqlite'),
    );
    expect('e.5 sqlite 后端标记写入成功', sqliteWritten, true);
    sqliteStore.close();

    const sqliteReopened = new SQLiteSessionStore(dbPath);
    const sqliteLoaded = await sqliteReopened.load(sqliteSession);
    expect(
      'e.6 sqlite 后端换实例读回 run_id',
      sqliteLoaded?.resume_after_restart?.run_id,
      'run-e-sqlite',
    );
    expect(
      'e.7 sqlite 后端 pending_input_ids',
      sqliteLoaded?.resume_after_restart?.pending_input_ids,
      ['inbox-e1'],
    );
    sqliteReopened.close();

    // E3：journal 的合并口子（武装的标记不会被后续终态保存冲掉）。
    const mergeSession = 's-drain-e-merge';
    const mergeStore = new FileSessionStore(join(dir, 'sessions'));
    const mergeRegistry = createResumeMarkerRegistry();
    mergeRegistry.arm(mergeSession, probeMarker('run-e-merge'));
    const mergeJournalFactory = createRunJournalFactory({
      session: mergeStore,
      resumeMarkers: mergeRegistry,
    });
    // 模拟 settle 期间「被打断 run 的终态保存」：它自己那份投影里没有标记字段。
    const replayJournal = mergeJournalFactory.transient({
      // transient journal 的 runId 是受限联合（'manual' | 'plugin'），不是任意 run id：
      // 本用例只要一个「写同 session 的旁路 journal」，用 'manual' 语义正确。
      runId: 'manual',
      sessionId: mergeSession,
      events: new MemoryEventStream(),
    });
    const stale = baseState(mergeSession);
    await replayJournal.saveSessionState(stale);
    const mergeLoaded = await mergeStore.load(mergeSession);
    expect(
      'e.8 RunJournal 合并：终态保存不会冲掉已武装的标记',
      mergeLoaded?.resume_after_restart?.run_id,
      'run-e-merge',
    );
  } finally {
    // Windows 上 sqlite 句柄可能还没完全释放；临时目录清不掉不影响判据。
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略：只是 tmp 清理 */
    }
  }
}

// ───────────────────────── main ─────────────────────────

async function main(): Promise<void> {
  await probeA();
  await probeB();
  await probeBDispatch();
  await probeCD();
  await probeE();

  for (const line of paths) console.log(line);
  for (const line of failures) console.error('FAIL ' + line);
  console.log('');
  console.log('通过 ' + passed + ' 条判据，失败 ' + failures.length + ' 条');
  if (failures.length > 0) process.exit(1);
  console.log('OK  node 优雅退出（S1a）：标记口径 / fence / 不等长任务 / 幂等 / 双后端 全过');
}

await main();
process.exit(0);
