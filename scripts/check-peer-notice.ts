#!/usr/bin/env bun

/**
 * 「成员停下 → 父会话下一轮看到 vessel:notice」探针（0.53，notice-gap）。
 *
 * 用户报的是：fish 成员 tr-threshold / docs-tidy 从 running 变 completed 之后，父会话
 * （main）一条通知都没收到，只能自己 `agent list` + `agent read`。查下来是两个断点叠加：
 *
 * A. **生产端从不产出变更**：`peerStopChangeFor` 只认落盘的 `member.parentId`，而 peer 成员
 *    （`agent create` 出来的、role='member'）按设计没有 parentId —— 创建人只出现在
 *    `agent.spawned` 审计事件的 `spawnedBy` 里，而 types.ts 明确裁定它「不持久化」。
 *    于是 main 的成员一条都报不上来，`peerStops.report` 从未被调用。
 *    → 修法：进程内记 `peerOrigins`（agentId → 创建者成员 id），`peerStopChangeFor` 用它兜底；
 *      未命中就**静默不报**（不伪造父级、不遍历成员去猜）。§E 用源码契约钉住这一点。
 * B. **注入不留痕**：`runtime.notice` 是内存事件流（MemoryEventStream）上的广播，
 *    `events.ndjson` 只由 RunJournal（run 内、带 session_id）写入 —— run 之外的 notice
 *    从来不进盘，事后连「发过没有 / 注入了没有」都查不出来。
 *    → 修法：注入那一刻经 `SessionEventLogPort` 落一条 `runtime.notice.injected`。
 *
 * 覆盖：① 成员 completed → 父级下一轮拿到带名字的 notice；② 父级忙时不丢、延后到下一次 run；
 * ③ 两个成员连续停 → 合并成一条；④ 同一父 session 一轮最多 1 条；⑤ 落盘字段与边界
 * （缺 eventLog / 缺 meta / 空 session 不炸）；E 生产端源码契约（兜底 + 不落盘）。
 *
 * 全程假 timer（不真 sleep），跑完 < 1s。
 *
 * 用法：bun run scripts/check-peer-notice.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  EventHandler,
  EventStream,
  Hook,
  HookContext,
  RunEvent,
  SessionEventInput,
  SessionEventLogPort,
  SessionEventRecord,
} from '../packages/core/src/index';
import {
  createPeerNoticeRouter,
  PEER_NOTICE_WINDOW_MS,
  type PeerStopChange,
} from '../src/peer-notices';
import { createRuntimeNoticeBus } from '../src/runtime-notice';
import { createRuntimeNoticeHook, NOTICE_INJECTED_EVENT } from '../src/runtime-notice-hook';

const failures: string[] = [];
let checked = 0;

function expect(cond: boolean, message: string): void {
  checked += 1;
  if (!cond) failures.push(message);
}

const repoRoot = join(import.meta.dir, '..');

async function source(rel: string): Promise<string> {
  return readFile(join(repoRoot, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// 假件：事件流 / timer / 事件日志
// ---------------------------------------------------------------------------

interface FakeStream extends EventStream {
  /** 父 session 的一次 run 生命周期（`run.started` / `run.completed`） */
  runLifecycle(type: 'run.started' | 'run.completed' | 'run.failed', sessionId: string): void;
}

function fakeStream(): FakeStream {
  const handlers = new Set<EventHandler>();
  const history: RunEvent[] = [];
  const publish = (event: RunEvent): void => {
    history.push(event);
    for (const handler of handlers) void handler(event);
  };
  return {
    subscribe: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    publish,
    clear: () => {
      history.length = 0;
    },
    getHistory: (runId) =>
      runId === undefined ? [...history] : history.filter((event) => event.run_id === runId),
    waitFor: () => Promise.reject(new Error('probe: waitFor 未实现')),
    runLifecycle: (type, sessionId) => {
      const runId = `run-${type}-${sessionId}`;
      publish({ type, run_id: runId, data: { session_id: sessionId }, ts: 0 });
    },
  };
}

interface FakeTimers {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (handle: ReturnType<typeof setTimeout>) => void;
}

interface FakeClock {
  timers: FakeTimers;
  /** 推进假时钟：触发所有 deadline <= 已推进总量的回调 */
  tick: (ms: number) => void;
}

/**
 * 假 timer：handle 用真实 `setTimeout`（免得把 `TimerHandle` 强转出来），但真实回调是空函数；
 * 真正被调用的只有 `tick` 手动触发的那批 —— 探针就不会真的等 2s 合并窗口。
 */
function fakeClock(): FakeClock {
  const pending = new Map<ReturnType<typeof setTimeout>, { fn: () => void; deadline: number }>();
  let now = 0;
  return {
    timers: {
      set: (fn, ms) => {
        const handle = setTimeout(() => {}, 0);
        pending.set(handle, { fn, deadline: now + ms });
        return handle;
      },
      clear: (handle) => {
        pending.delete(handle);
        clearTimeout(handle);
      },
    },
    tick: (ms) => {
      now += ms;
      const due = [...pending.entries()].filter(([, entry]) => entry.deadline <= now);
      for (const [handle, entry] of due) {
        pending.delete(handle);
        clearTimeout(handle);
        entry.fn();
      }
    },
  };
}

function fakeEventLog(sink: SessionEventInput[]): SessionEventLogPort {
  let seq = 0;
  return {
    append: async (input) => {
      sink.push(input);
      seq += 1;
      const record: SessionEventRecord = { ...input, v: 1, seq };
      return record;
    },
    read: async () => [],
    lastPersistedSeq: () => (seq > 0 ? seq : undefined),
    flush: async () => {},
  };
}

// ---------------------------------------------------------------------------
// 环境：真 router + 真 hook + 假 timer / 假事件日志
// ---------------------------------------------------------------------------

interface Harness {
  bus: ReturnType<typeof createRuntimeNoticeBus>;
  stream: FakeStream;
  clock: FakeClock;
  logged: SessionEventInput[];
  hook: Hook;
  router: ReturnType<typeof createPeerNoticeRouter>;
  /** 模拟父 session 跑一轮 BeforeLlm，返回这一轮的上下文（看注入了什么） */
  inject: (sessionId: string, runId: string) => Promise<HookContext>;
}

interface HarnessOptions {
  /** 缺省带假事件日志；`eventLog: false` 用来测「端口缺失也不炸」 */
  eventLog?: boolean;
  /**
   * 0.53：父 session 重解析口（模拟装配层用 `currentBindingSession` 实现的那条链接）。
   * 缺省 = 旧装配（没有这个口），用来测向后兼容。
   */
  resolveParentSession?: (memberId: string) => string | undefined;
}

function harness(options: HarnessOptions = {}): Harness {
  const bus = createRuntimeNoticeBus();
  const stream = fakeStream();
  const clock = fakeClock();
  const logged: SessionEventInput[] = [];
  const hook = createRuntimeNoticeHook({
    bus,
    ...(options.eventLog === false ? {} : { eventLog: fakeEventLog(logged) }),
  });
  const router = createPeerNoticeRouter({
    bus,
    events: stream,
    timers: clock.timers,
    ...(options.resolveParentSession === undefined
      ? {}
      : { resolveParentSession: options.resolveParentSession }),
  });
  return {
    bus,
    stream,
    clock,
    logged,
    hook,
    router,
    inject: async (sessionId, runId) => {
      const ctx: HookContext = { run_id: runId, session_id: sessionId, messages: [] };
      await hook.run(ctx);
      return ctx;
    },
  };
}

function stopChange(
  name: string,
  kind: PeerStopChange['kind'],
  parentSessionId = 'sess-parent',
): PeerStopChange {
  return { parent_session_id: parentSessionId, agent_id: `agent-${name}`, name, kind };
}

function lastText(ctx: HookContext): string {
  const list = ctx.messages ?? [];
  const last = list[list.length - 1];
  if (last === undefined) return '';
  return typeof last.content === 'string' ? last.content : '';
}

function lastMessageName(ctx: HookContext): string {
  const list = ctx.messages ?? [];
  const last = list[list.length - 1];
  return last === undefined ? '' : (last.name ?? '');
}

/**
 * 事件 `data` 里读一个字段：`EventPayload` 是个具体 payload 的联合（不是索引类型），
 * 直接点属性取不到 `runtime.notice.injected` 的字段；`Reflect.get` 免掉 `as` 强转。
 */
function field(data: unknown, key: string): unknown {
  if (data === null || typeof data !== 'object') return undefined;
  return Reflect.get(data, key);
}

function memberName(value: unknown): string {
  const name = field(value, 'name');
  return typeof name === 'string' ? name : '';
}

function memberKind(value: unknown): string {
  const kind = field(value, 'kind');
  return typeof kind === 'string' ? kind : '';
}

// ---------------------------------------------------------------------------
// ① 成员 completed → 父级下一轮拿到 vessel:notice，且带成员名与结局
// ---------------------------------------------------------------------------

async function caseSingleStop(): Promise<void> {
  const h = harness();
  h.router.report(stopChange('tr-threshold', 'completed'));
  // 父级空闲：窗口一到就发。
  h.clock.tick(PEER_NOTICE_WINDOW_MS);
  h.router.stop();

  const ctx = await h.inject('sess-parent', 'run-1');
  const text = lastText(ctx);
  expect(lastMessageName(ctx) === 'vessel:notice', '① 父级下一轮应看到 vessel:notice 尾消息');
  expect(text.includes('tr-threshold'), '① notice 正文应含成员名 tr-threshold');
  expect(text.includes('completed'), '① notice 正文应含结局 completed');

  const entry = h.logged.at(-1);
  expect(entry?.type === NOTICE_INJECTED_EVENT, '① 注入时应落 runtime.notice.injected 事件');
  expect(entry?.session_id === 'sess-parent', '① 事件信封应带父 session id');
  expect(entry?.run_id === 'run-1', '① 事件信封应带这一轮的 run id');
  expect(field(entry?.data, 'scope') === 'peer', '① 事件 data.scope 应为 peer');
  expect(field(entry?.data, 'count') === 1, '① 事件 data.count 应为 1');
  const members = field(entry?.data, 'members');
  expect(Array.isArray(members) && members.length === 1, '① 事件 data.members 应列出 1 个成员');
  const first: unknown = Array.isArray(members) ? members[0] : undefined;
  expect(memberName(first) === 'tr-threshold', '① 事件里的成员名应为 tr-threshold');
  expect(memberKind(first) === 'completed', '① 事件里的成员结局应为 completed');
  const ids: unknown = field(entry?.data, 'notice_ids');
  expect(Array.isArray(ids) && typeof ids[0] === 'number', '① 事件应带 notice_ids');
}

// ---------------------------------------------------------------------------
// ② 父级正忙：这一轮不注入，但绝不丢 —— 延后到下一次 run 注入
// ---------------------------------------------------------------------------

async function caseBusyParentDefers(): Promise<void> {
  const h = harness();
  h.stream.runLifecycle('run.started', 'sess-parent');
  h.router.report(stopChange('docs-tidy', 'completed'));
  h.clock.tick(PEER_NOTICE_WINDOW_MS * 10);

  // 父级还在跑：不能发。
  expect(h.router.pendingCount() === 1, '② 父级忙时应把变更留在缓冲区（pendingCount=1）');
  const busyCtx = await h.inject('sess-parent', 'run-busy');
  expect(busyCtx.messages?.length === 0, '② 忙的时候这一轮不该被塞 notice');

  // 父级这一轮收口 → 下一轮开始前补发。
  h.stream.runLifecycle('run.completed', 'sess-parent');
  h.clock.tick(PEER_NOTICE_WINDOW_MS);
  const nextCtx = await h.inject('sess-parent', 'run-next');
  expect(lastText(nextCtx).includes('docs-tidy'), '② 父级忙完后的下一轮应看到 docs-tidy');
  expect(h.router.pendingCount() === 0, '② 补发后缓冲区应清空（没丢在窗口里）');
  h.router.stop();
}

// ---------------------------------------------------------------------------
// ③ 两个成员连续停 → 合并成一条（名字都在）
// ---------------------------------------------------------------------------

async function caseMerged(): Promise<void> {
  const h = harness();
  h.router.report(stopChange('tr-threshold', 'completed'));
  h.router.report(stopChange('docs-tidy', 'completed'));
  expect(h.router.pendingCount() === 2, '③ 窗口内两条变更都应缓冲');
  h.clock.tick(PEER_NOTICE_WINDOW_MS);
  h.router.stop();

  const ctx = await h.inject('sess-parent', 'run-1');
  const text = lastText(ctx);
  expect(h.logged.length === 1, '③ 合并后只应注入一条 notice（落一条事件）');
  expect(text.includes('tr-threshold'), '③ 合并后的正文应含 tr-threshold');
  expect(text.includes('docs-tidy'), '③ 合并后的正文应含 docs-tidy');

  const entry = h.logged.at(-1);
  expect(field(entry?.data, 'count') === 1, '③ 事件 data.count 应为 1（一条合并通知）');
  const members = field(entry?.data, 'members');
  expect(Array.isArray(members) && members.length === 2, '③ 事件 data.members 应列出两个成员');
  const names = Array.isArray(members) ? members.map((member) => memberName(member)) : [];
  expect(names.includes('tr-threshold') && names.includes('docs-tidy'), '③ 事件里的两个名字都要在');
}

// ---------------------------------------------------------------------------
// ④ 同一父 session 一轮最多 1 条（同轮内后来的变更留到下一轮）
// ---------------------------------------------------------------------------

async function caseOnePerRound(): Promise<void> {
  const h = harness();
  h.stream.runLifecycle('run.started', 'sess-parent');
  h.router.report(stopChange('tr-threshold', 'completed'));
  h.stream.runLifecycle('run.completed', 'sess-parent');
  h.clock.tick(PEER_NOTICE_WINDOW_MS);

  // 同一轮里又停了一个：本轮已经发过一条，必须压到下一轮。
  h.router.report(stopChange('docs-tidy', 'completed'));
  h.clock.tick(PEER_NOTICE_WINDOW_MS * 5);
  const sameRoundCtx = await h.inject('sess-parent', 'run-round-1');
  const sameRoundText = lastText(sameRoundCtx);
  expect(sameRoundText.includes('tr-threshold'), '④ 第一轮应看到先停的 tr-threshold');
  expect(!sameRoundText.includes('docs-tidy'), '④ 第一轮不该带上同一轮后来的 docs-tidy');

  h.stream.runLifecycle('run.started', 'sess-parent');
  h.stream.runLifecycle('run.completed', 'sess-parent');
  h.clock.tick(PEER_NOTICE_WINDOW_MS);
  const nextRoundCtx = await h.inject('sess-parent', 'run-round-2');
  expect(lastText(nextRoundCtx).includes('docs-tidy'), '④ 下一轮应补上 docs-tidy');
  expect(h.logged.length === 2, '④ 两轮各一条：共两条注入事件');
  h.router.stop();
}

// ---------------------------------------------------------------------------
// ⑤ 边界：缺 eventLog / 缺 meta / 空 session 都不炸
// ---------------------------------------------------------------------------

async function caseDegrades(): Promise<void> {
  // 端口缺失：照样注入，不抛。
  const noLog = harness({ eventLog: false });
  noLog.router.report(stopChange('orphan', 'cancelled'));
  noLog.clock.tick(PEER_NOTICE_WINDOW_MS);
  noLog.router.stop();
  const ctx = await noLog.inject('sess-parent', 'run-1');
  expect(lastText(ctx).includes('orphan'), '⑤ 没有 eventLog 端口时仍应正常注入');
  expect(noLog.logged.length === 0, '⑤ 没有 eventLog 端口时不该有落盘记录');

  // 没有 meta 的广播 notice（非 peer-stop 来源）：注入照常，事件的 members 为空数组。
  const bare = harness();
  bare.bus.publish({ scope: 'hot-apply', summary: 'hot-apply 完成', ok: true });
  const bareCtx = await bare.inject('sess-parent', 'run-2');
  expect(lastText(bareCtx).includes('hot-apply'), '⑤ 无 meta 的 notice 也应正常注入');
  const entry = bare.logged.at(-1);
  const members = field(entry?.data, 'members');
  expect(
    Array.isArray(members) && members.length === 0,
    '⑤ 无 meta 时事件 data.members 应为空数组',
  );

  // 空 session：总线按匿名游标（`_`）兜底（这是 `take` 的既有语义，本次不动），
  // 但**不落事件**——没有 session id 的事件写不了日志，也不该编一个。
  const empty = harness();
  empty.bus.publish({ scope: 'hot-apply', summary: 'x', ok: true });
  const emptyCtx = await empty.inject('', 'run-3');
  expect(emptyCtx.messages?.length === 1, '⑤ 空 session 按匿名游标注入（既有语义不变）');
  expect(empty.logged.length === 0, '⑤ 空 session 不该落事件（没有 session id 可写）');
}

// ---------------------------------------------------------------------------
// F rotate 同步链接（0.53）：父在 report 后、flush 前 rotate → 通知要投给新 body
// ---------------------------------------------------------------------------

/**
 * ⑥ 窗口内父级 rotate：`parent_session_id` 指向的是旧 body，真正投递那一刻必须重解析到
 * 新 body 的 session —— 否则新 body 永远拉不到这条 notice（等于丢给旧 body）。
 */
async function caseRotateBeforeFlush(): Promise<void> {
  // 父级当前 session 的假表（装配层那条链接：memberId → 父级现在的 primary body）。
  const parents = new Map<string, string | undefined>();
  const h = harness({ resolveParentSession: (memberId) => parents.get(memberId) });
  parents.set('agent-tr-threshold', 'sess-parent');
  h.router.report(stopChange('tr-threshold', 'completed'));
  parents.set('agent-tr-threshold', 'sess-parent-v2'); // 窗口内 rotate：body 换新
  h.clock.tick(PEER_NOTICE_WINDOW_MS);
  h.router.stop();

  const oldCtx = await h.inject('sess-parent', 'run-old');
  expect(lastText(oldCtx) === '', '⑥ rotate 后旧 body 的下一轮不该再拿到这条 notice');
  const newCtx = await h.inject('sess-parent-v2', 'run-new');
  expect(lastText(newCtx).includes('tr-threshold'), '⑥ 通知应落在 rotate 后的新 session');
  const entry = h.logged.at(-1);
  expect(entry?.session_id === 'sess-parent-v2', '⑥ 事件信封应带新 body 的 session id');
  expect(entry?.run_id === 'run-new', '⑥ 事件应记在新 body 这一轮上');
  expect(h.router.pendingCount() === 0, '⑥ 投到新 session 后缓冲区应清空');
}

/** ⑦ 窗口内 rotate 且新 body 正在跑：判忙必须看**新** session，延后到它收口后的下一轮。 */
async function caseRotateWhileNewSessionRunning(): Promise<void> {
  const parents = new Map<string, string | undefined>();
  const h = harness({ resolveParentSession: (memberId) => parents.get(memberId) });
  parents.set('agent-docs-tidy', 'sess-parent');
  h.router.report(stopChange('docs-tidy', 'completed'));
  parents.set('agent-docs-tidy', 'sess-parent-v2'); // 窗口内 rotate
  h.stream.runLifecycle('run.started', 'sess-parent-v2'); // 新 body 已经在跑
  h.clock.tick(PEER_NOTICE_WINDOW_MS * 5);

  // 旧 session 空闲 ≠ 新 body 空闲：按旧 session 判忙就会把 notice 塞进正在跑的这轮。
  expect(h.router.pendingCount() === 1, '⑦ 新 body 正忙时通知应留在缓冲区（pendingCount=1）');
  const busyCtx = await h.inject('sess-parent-v2', 'run-busy');
  expect(busyCtx.messages?.length === 0, '⑦ 新 body 忙的这一轮不该被塞 notice');

  h.stream.runLifecycle('run.completed', 'sess-parent-v2');
  h.clock.tick(PEER_NOTICE_WINDOW_MS);
  const nextCtx = await h.inject('sess-parent-v2', 'run-next');
  expect(lastText(nextCtx).includes('docs-tidy'), '⑦ 新 body 收口后的下一轮应看到 docs-tidy');
  expect(h.router.pendingCount() === 0, '⑦ 补发后缓冲区应清空（没丢在 rotate 窗口里）');
  h.router.stop();
}

/** ⑧ 没有注入解析口（旧装配）：退回报告时刻的 session，行为不变、不丢通知。 */
async function caseNoResolverFallback(): Promise<void> {
  const h = harness(); // 旧装配：没有 resolveParentSession
  h.router.report(stopChange('legacy-stop', 'failed'));
  h.clock.tick(PEER_NOTICE_WINDOW_MS);
  h.router.stop();

  const ctx = await h.inject('sess-parent', 'run-1');
  expect(lastText(ctx).includes('legacy-stop'), '⑧ 没有 resolver 时退回报告时刻的 session（不丢）');
  expect(h.logged.length === 1, '⑧ 没有 resolver 时仍落一条注入事件');
  expect(h.logged.at(-1)?.session_id === 'sess-parent', '⑧ 退回时信封仍是报告时刻的 session id');
}

/** ⑨ 解析不到（成员已关 / 空串 / 抛错）：一律退回旧 session，不丢、不炸。 */
async function caseResolvedGoneFallback(): Promise<void> {
  // 成员已关：记录不在，解析口返回 undefined。
  const closed = harness({ resolveParentSession: () => undefined });
  closed.router.report(stopChange('gone-peer', 'completed'));
  closed.clock.tick(PEER_NOTICE_WINDOW_MS);
  closed.router.stop();
  const closedCtx = await closed.inject('sess-parent', 'run-1');
  expect(
    lastText(closedCtx).includes('gone-peer'),
    '⑨ resolver 返回 undefined（成员已关）时应退回旧 session，不丢',
  );
  expect(closed.logged.length === 1, '⑨ resolver 返回 undefined 时仍落一条注入事件');

  // 空串等价于解析不到（有的装配用空串表示「没有」）。
  const blank = harness({ resolveParentSession: () => '' });
  blank.router.report(stopChange('blank-peer', 'completed'));
  blank.clock.tick(PEER_NOTICE_WINDOW_MS);
  blank.router.stop();
  const blankCtx = await blank.inject('sess-parent', 'run-1');
  expect(
    lastText(blankCtx).includes('blank-peer'),
    '⑨ resolver 返回空串时应退回旧 session（不丢）',
  );

  // 解析口抛错：定时器里的异常不许冒出去，通知也不许丢。
  const throwing = harness({
    resolveParentSession: () => {
      throw new Error('registry gone');
    },
  });
  throwing.router.report(stopChange('boom-peer', 'completed'));
  throwing.clock.tick(PEER_NOTICE_WINDOW_MS);
  throwing.router.stop();
  const boomCtx = await throwing.inject('sess-parent', 'run-1');
  expect(lastText(boomCtx).includes('boom-peer'), '⑨ resolver 抛错时应退回旧 session，不炸不丢');
}

// ---------------------------------------------------------------------------
// E 生产端源码契约：peer 成员必须能被报上来，且这条链接不落盘
// ---------------------------------------------------------------------------

async function caseProducerSource(): Promise<void> {
  const service = await source('packages/agent/src/service.ts');
  const registry = await source('packages/agent/src/registry.ts');

  expect(
    !/if \(!nonEmpty\(member\.parentId\)\) return undefined;/u.test(service),
    'E 生产端不该再用「没有 parentId 就丢弃」的硬闸',
  );
  expect(/this\.peerOrigins\.get\(member\.id\)/u.test(service), 'E 应回退到进程内创建者链接');
  expect(
    /private peerParentIdFor\(member: MemberRecord\)/u.test(service),
    'E 应有 peerParentIdFor 统一取父成员',
  );
  const rememberCalls = service.split('this.rememberPeerOrigin(record, spawnedBy)').length - 1;
  expect(rememberCalls >= 2, 'E create 与 createFromSource 都应记创建者');
  expect(
    /this\.peerOrigins\.set\(record\.id, spawnedBy\)/u.test(service),
    'E 应在 spawn 成功时记录创建者',
  );
  // 只在进程内：registry（快照落盘的那层）不该知道 peerOrigins。
  expect(!registry.includes('peerOrigins'), 'E peerOrigins 不该进 registry 快照（不落盘）');
  expect(!/persistPeerOrigins|peer_origins/u.test(service), 'E 不该出现落盘字段 peer_origins');

  const bootstrap = await source('src/bootstrap.ts');
  expect(
    /registerRuntimeNoticeHook\(finalPluginHost, noticeBus, eventLog\)/u.test(bootstrap),
    'E bootstrap 应把 SessionEventLogPort 交给注入 hook',
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

await caseSingleStop();
await caseBusyParentDefers();
await caseMerged();
await caseOnePerRound();
await caseDegrades();
await caseRotateBeforeFlush();
await caseRotateWhileNewSessionRunning();
await caseNoResolverFallback();
await caseResolvedGoneFallback();
await caseProducerSource();

if (failures.length === 0) {
  console.log(`check-peer-notice: OK（${String(checked)} 条断言全过）`);
} else {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  console.error(`check-peer-notice: ${String(failures.length)}/${String(checked)} 条断言失败`);
  process.exit(1);
}
