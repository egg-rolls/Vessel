/**
 * rotate 收口记账（B'，0.52）窄属性探针：Team 侧记账与「真迟到旧轮」的 fence 分界。
 *
 * 背景：agent.retired 一到，TeamService 就把这个 Binding 记进 retiredBodies 并抑制它的
 * run.* 终态。0.51 事故里交棒轮自己的 run.completed 因此被一起吞掉：Team 日志、父级通知、
 * 正文采用全丢。B' 的判据不是「body 已退役」，而是「这一轮是不是自己交棒的那一轮」——
 * service 在 agent.retired 上带 retired_during_run_id（只在 reason 为 rotation 时），
 * TeamService 只 fence「run id 对不上」的旧轮。
 *
 * 形态沿用 src/rotate-handoff.test.ts（本仓没有 test gate；这类窄探针是允许的例外）。
 * 跑法：bun run scripts/check-rotate-accounting.ts，判定看输出文本
 * "OK check-rotate-accounting passed N / N"（本机 bun 是 Windows 版，退出码不可信）。
 * 文件名不在 *.test.ts 里，也不进任何 gate 链。
 *
 * 为什么 mock @vessel-agent/core：本 worktree 没有 node_modules，而 packages/agent/src/*
 * 都按 bare specifier 引 core。这里只替掉 core 的运行时出口，被测的是真实的 AgentService
 * 与真实的 DefaultTeamService；Team 侧的 store / 事件流用 Memory 替身
 * （MemoryTeamStore / MemoryEventStream）。
 *
 * 四条行为：
 * a. 交棒轮（completed + 有正文）⇒ Team 日志 1 条（正文被采用）、父级通知 1 条、
 *    agent 终态写进 completed（updateAgentState 真被调用）；
 * b. 真迟到旧轮（外部退役，agent.retired 不带 run id）⇒ 仍被 fence，不记账；
 * c. 交棒轮无正文 ⇒ 有明确 notice（agent.reply.stale / reason handoff_no_reply）且不崩；
 *    交棒轮 failed ⇒ Team 日志里看得见 turn failed；
 * d. 不产生「结束语投递」：新 body 首轮输入只有 startup_prompt，没有额外 inbox 投递。
 */

import { mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../packages/agent/src/types';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : name + ' | got: ' + got);
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** core 的运行时替身：只列 packages/agent/src 运行时真取用的出口，少一个就会在 import 时炸。 */
mock.module('@vessel-agent/core', () => ({
  assertTenantId: () => {},
  compactMessagesForSeed: () => [],
  LeaseExpiredError: class extends Error {},
  RunResumeError: class extends Error {},
  noopLogger: quietLogger,
  projectMessages: () => [],
  atomicWrite: async (path: string, data: string) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, 'utf8');
  },
  HookType: { BeforeLlm: 'before_llm', AfterLlm: 'after_llm' },
  MESSAGE_REFS_MAX: 8,
  MESSAGE_REF_PATH_MAX: 4096,
}));

const { createAgentService } = await import('../packages/agent/src/service');
const { createTeamService } = await import('../packages/agent/src/team-service');

type AnyRecord = Record<string, unknown>;

const STARTUP_PROMPT = 'HANDOFF-STARTUP-PROMPT';
const HANDOFF_REPLY = 'handoff turn closing reply';
const TEAM_ID = 'team-1';
const STALE_EVENT = 'agent.reply.stale';

async function settleTicks(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 调度器替身：真的排队，并把 executor 返回的真实 RunHandle 收下来（要它的 runId）。 */
class FakeScheduler {
  readonly queue: { task: AnyRecord; state: string }[] = [];
  readonly handles: { runId: string; handle: { status(): string; result: Promise<string> } }[] = [];

  async submit(task: AnyRecord): Promise<AnyRecord> {
    this.queue.push({ task, state: 'queued' });
    return {
      id: task.runId as string,
      status: () => 'queued',
      onEvent: () => () => {},
      cancel: () => true,
      wait: async () => ({ status: 'queued' }),
    };
  }

  cancel(): boolean {
    return true;
  }

  stats() {
    return { queued: this.queue.length, running: 0, completed: 0, failed: 0, cancelled: 0 };
  }

  async close(): Promise<void> {}

  async drainOne(): Promise<boolean> {
    const next = this.queue.shift();
    if (next === undefined) return false;
    next.state = 'running';
    const runId = next.task.runId as string;
    const executor = next.task.executor as (id: string) => Promise<unknown>;
    const handle = (await executor(runId)) as
      | { status(): string; result: Promise<string> }
      | undefined;
    if (handle !== undefined) this.handles.push({ runId, handle });
    await settleTicks();
    return true;
  }

  async drainAll(): Promise<void> {
    for (let guard = 0; guard < 40; guard += 1) {
      const ran = await this.drainOne();
      if (ran) continue;
      await settleTicks();
      if (this.queue.length === 0) return;
    }
  }
}

/** Team 日志替身：只记账（被测的两条路径 TeamService 只调 appendLog）。 */
class MemoryTeamStore {
  readonly logs: AnyRecord[] = [];
  async appendLog(entry: AnyRecord): Promise<AnyRecord> {
    this.logs.push(entry);
    return entry;
  }
  async list(): Promise<AnyRecord[]> {
    return [];
  }
  async get(): Promise<undefined> {
    return undefined;
  }
  async readLog(): Promise<AnyRecord[]> {
    return this.logs;
  }
  async flush(): Promise<void> {}
}

interface MemoryRunEvent {
  type: string;
  ts: number;
  run_id: string;
  data: AnyRecord;
}

/** run.* 事件流替身（EventStream 的最小面）。 */
class MemoryEventStream {
  readonly published: MemoryRunEvent[] = [];
  private readonly handlers = new Set<(event: MemoryRunEvent) => void>();

  subscribe(handler: (event: MemoryRunEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  publish(event: MemoryRunEvent): void {
    this.published.push(event);
    for (const handler of [...this.handlers]) handler(event);
  }

  clear(): void {}

  getHistory(runId?: string): MemoryRunEvent[] {
    return runId === undefined
      ? [...this.published]
      : this.published.filter((event) => event.run_id === runId);
  }
}

/** service 上被测判据要用、但对外不暴露的内部结构（只为构造退役现场）。 */
interface ServiceInternals {
  registry: { get(agentId: string): unknown };
  findEntry(agentId: string, bindingId: string): { retired: boolean } | undefined;
  retireExecutionUnitEntry(record: unknown, entry: unknown, reason: string): Promise<void>;
}

type TurnResult = { content: string; outcome: 'completed' | 'failed' | 'cancelled' };
type TurnHandler = (message: { id: string; content: string }) => Promise<TurnResult>;

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'vessel-rotate-accounting-'));
  const events: AgentEvent[] = [];
  const turns: { content: string }[] = [];
  let onTurn: TurnHandler = async () => ({ content: '', outcome: 'completed' });
  const runtime = {
    async spawn() {},
    async runTurn(_member: AnyRecord, message: AnyRecord) {
      turns.push({ content: message.content as string });
      return onTurn({ id: message.id as string, content: message.content as string });
    },
    cancel() {},
    async dispose() {},
  };
  const scheduler = new FakeScheduler();
  let idSeq = 0;
  const service = createAgentService({
    tenantId: 't1',
    dataDir,
    runtime: runtime as never,
    scheduler: scheduler as never,
    now: () => 1000,
    newId: () => 'id-' + String(++idSeq),
    logger: quietLogger as never,
  });
  service.subscribe((event) => events.push(event));
  const worker = await service.create({
    name: 'worker',
    kind: 'contractor',
    owner: 'human',
    visibility: 'team',
  });

  // Team 层：真实 DefaultTeamService + Memory 替身
  const store = new MemoryTeamStore();
  const stream = new MemoryEventStream();
  const teamEmits: AnyRecord[] = [];
  let teamListener: ((event: AgentEvent) => void) | undefined;
  const teamAgent = {
    subscribe(handler: (event: AgentEvent) => void): () => void {
      teamListener = handler;
      return () => {
        teamListener = undefined;
      };
    },
  };
  let teamIdSeq = 0;
  const team = createTeamService({
    tenantId: 't1',
    agent: teamAgent as never,
    store: store as never,
    events: stream as never,
    now: () => 1000,
    newId: () => 'log-' + String(++teamIdSeq),
    logger: quietLogger as never,
  });
  team.subscribe((event) => teamEmits.push(event as unknown as AnyRecord));

  const internals = service as unknown as ServiceInternals;

  return {
    service,
    scheduler,
    events,
    store,
    stream,
    teamEmits,
    workerId: worker.id,
    setTurn: (handler: TurnHandler) => {
      onTurn = handler;
    },
    /** 模型真正收到的输入正文，按轮序。 */
    inputs: () => turns.map((turn) => turn.content),
    rotate: () =>
      service.createSession(
        { agent_id: worker.id, startup_prompt: STARTUP_PROMPT },
        { allowActiveRun: true },
      ),
    externalRetire: async (reason: string): Promise<void> => {
      const entry = internals.findEntry(worker.id, worker.session_id);
      if (entry === undefined) throw new Error('externalRetire: no live entry');
      await internals.retireExecutionUnitEntry(internals.registry.get(worker.id), entry, reason);
    },
    /** 把真实 agent.* 事件灌进 TeamService（生产里由 wire 层转发，同一条路）。 */
    pumpAgentEvents: (): void => {
      const pending = events.splice(0, events.length);
      for (const event of pending) {
        events.push(event);
        teamListener?.(event);
      }
    },
    /** 发布一条 run.* 终态：归属字段照 runtime 方的形状给（data 里带四个字段）。 */
    pushRunTerminal: (type: string, runId: string, output: string | undefined): void => {
      stream.publish({
        type,
        ts: 1000,
        run_id: runId,
        data: {
          session_id: worker.session_id,
          visibility: 'team',
          team_id: TEAM_ID,
          agent_id: worker.id,
          output,
        },
      });
    },
    staleEvents: () => events.filter((event) => event.type === STALE_EVENT),
    queuedEvents: () => events.filter((event) => event.type === 'agent.message.queued'),
    state: async () => (await service.identify(worker.id))?.state,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

async function main(): Promise<void> {
  // a. 交棒轮 ⇒ Team 日志 1 条 / 父级通知 1 条 / 正文被采用 / updateAgentState 被调
  {
    const h = await harness();
    h.setTurn(async (message) => {
      if (message.content === 'ROTATE') {
        await h.rotate();
        return { content: HANDOFF_REPLY, outcome: 'completed' };
      }
      return { content: 'new body first turn', outcome: 'completed' };
    });
    await h.service.dispatch({ to: h.workerId, from: 'human', content: 'ROTATE' });
    await h.scheduler.drainOne();
    const handoffRunId = h.scheduler.handles[0]?.runId ?? '';
    const adopted = await (h.scheduler.handles[0]?.handle.result ?? Promise.resolve(''));
    h.pumpAgentEvents();

    const retired = h.events.find((event) => event.type === 'agent.retired');
    check(
      'a. agent.retired 带 retired_during_run_id（= 交棒轮 run id）',
      retired?.retired_during_run_id === handoffRunId,
      String(retired?.retired_during_run_id),
    );
    check(
      'a. agent.retired reason=rotation',
      retired?.reason === 'rotation',
      String(retired?.reason),
    );

    h.pushRunTerminal('run.completed', handoffRunId, HANDOFF_REPLY);
    await settleTicks();
    await h.scheduler.drainAll();

    check('a. Team 日志恰好 1 条', h.store.logs.length === 1, String(h.store.logs.length));
    check('a. handle 带正文 settle（正文被采用）', adopted === HANDOFF_REPLY, String(adopted));
    check(
      'a. 正文被采用（日志正文 === 交棒轮正文）',
      h.store.logs[0]?.content === HANDOFF_REPLY,
      String(h.store.logs[0]?.content),
    );
    check(
      'a. 父级通知恰好 1 条（kind=reply，指向那条日志）',
      h.teamEmits.length === 1 &&
        h.teamEmits[0]?.kind === 'reply' &&
        h.teamEmits[0]?.message_id === h.store.logs[0]?.message_id,
      JSON.stringify(h.teamEmits) + ' logs=' + JSON.stringify(h.store.logs.length),
    );
    check(
      'a. updateAgentState 生效（终态 completed）',
      (await h.state()) === 'completed',
      String(await h.state()),
    );

    // d. 不产生「结束语投递」
    const inputs = h.inputs();
    check(
      'd. 新 body 首轮输入里有 startup_prompt',
      inputs.includes(STARTUP_PROMPT),
      JSON.stringify(inputs),
    );
    check(
      'd. 没有任何一轮输入携带收尾正文（不投递结束语）',
      inputs.every((content) => !content.includes(HANDOFF_REPLY)),
      JSON.stringify(inputs),
    );
    check(
      'd. 没有额外 inbox 投递（ROTATE + startup_prompt 两条，止于此）',
      h.queuedEvents().length === 2,
      String(h.queuedEvents().length),
    );
    check('d. 交棒轮不发 stale', h.staleEvents().length === 0, String(h.staleEvents().length));
    await h.cleanup();
  }

  // b. 真迟到旧轮（外部退役）⇒ 仍被 fence，不记账
  {
    const h = await harness();
    h.setTurn(async (message) => {
      if (message.content === 'ROTATE') {
        await h.externalRetire('idle_ttl');
        return { content: HANDOFF_REPLY, outcome: 'completed' };
      }
      return { content: 'new body first turn', outcome: 'completed' };
    });
    await h.service.dispatch({ to: h.workerId, from: 'human', content: 'ROTATE' });
    await h.scheduler.drainOne();
    const runId = h.scheduler.handles[0]?.runId ?? '';
    h.pumpAgentEvents();

    const retired = h.events.find((event) => event.type === 'agent.retired');
    check(
      'b. 外部退役不带 retired_during_run_id',
      retired?.retired_during_run_id === undefined,
      String(retired?.retired_during_run_id),
    );

    h.pushRunTerminal('run.completed', runId, HANDOFF_REPLY);
    await settleTicks();

    check(
      'b. 真迟到旧轮仍被 fence：Team 日志 0 条',
      h.store.logs.length === 0,
      String(h.store.logs.length),
    );
    check('b. 真迟到旧轮不产生父级通知', h.teamEmits.length === 0, JSON.stringify(h.teamEmits));

    h.pushRunTerminal('run.completed', 'run-late-old', HANDOFF_REPLY);
    await settleTicks();
    check(
      'b. run id 对不上的旧轮仍被 fence',
      h.store.logs.length === 0,
      String(h.store.logs.length),
    );
    await h.cleanup();
  }

  // c1. 交棒轮无正文 ⇒ 有 notice 且不崩
  {
    const h = await harness();
    h.setTurn(async (message) => {
      if (message.content === 'ROTATE') {
        await h.rotate();
        return { content: '', outcome: 'completed' };
      }
      return { content: 'new body first turn', outcome: 'completed' };
    });
    await h.service.dispatch({ to: h.workerId, from: 'human', content: 'ROTATE' });
    await h.scheduler.drainOne();
    const runId = h.scheduler.handles[0]?.runId ?? '';
    h.pumpAgentEvents();

    check('c. 空正文交棒轮不崩（走到这里就是没抛）', true);

    const stale = h.staleEvents()[0];
    check(
      'c. 空正文交棒轮有明确 notice（handoff_no_reply）',
      stale?.reason === 'handoff_no_reply',
      String(stale?.reason),
    );

    h.pushRunTerminal('run.completed', runId, undefined);
    await settleTicks();
    check('c. 空正文不写 reply 日志', h.store.logs.length === 0, String(h.store.logs.length));
    await h.cleanup();
  }

  // c2. 交棒轮 failed ⇒ Team 日志里看得见
  {
    const h = await harness();
    h.setTurn(async (message) => {
      if (message.content === 'ROTATE') {
        await h.rotate();
        return { content: '', outcome: 'failed' };
      }
      return { content: 'new body first turn', outcome: 'completed' };
    });
    await h.service.dispatch({ to: h.workerId, from: 'human', content: 'ROTATE' });
    await h.scheduler.drainOne();
    const runId = h.scheduler.handles[0]?.runId ?? '';
    h.pumpAgentEvents();

    h.pushRunTerminal('run.failed', runId, undefined);
    await settleTicks();

    check(
      'c. 交棒轮 failed 在 Team 日志里看得见（1 条）',
      h.store.logs.length === 1,
      String(h.store.logs.length),
    );
    check(
      'c. 失败日志内容提到 turn failed',
      typeof h.store.logs[0]?.content === 'string' &&
        (h.store.logs[0]?.content as string).includes('turn failed'),
      String(h.store.logs[0]?.content),
    );
    await h.cleanup();
  }

  if (failures.length > 0) {
    for (const failure of failures) console.log('FAIL ' + failure);
    console.log('FAILED ' + String(failures.length) + ' / ' + String(passed + failures.length));
    process.exitCode = 1;
    return;
  }
  console.log('OK check-rotate-accounting passed ' + String(passed) + ' / ' + String(passed));
}

await main();
