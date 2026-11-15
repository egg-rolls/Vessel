#!/usr/bin/env bun
/**
 * check-replay-apply.ts — A4 落库门（离线，无真服务）：`recoverReplay` + `EventStore`
 * 的**合并不变量**。
 *
 * 与 `check-replay-merge.ts`（主线的 A2/A3：对**参考适配器**做断言）分工：
 * 那个门禁证明「契约写得对」，本门禁证明「**接进 Web 的这份实现**真的按契约落地了」——
 * 夹具喂的是真实的 `apps/web/src` 代码（`recoverReplay` + `EventStore#applyReplaySegment`），
 * 只有 RPC 是假的。
 *
 * 断言：
 *   A4 并集无洞：磁盘段（session 日志）+ 环段（已收到）+ trace 段 ⇒ 覆盖 == 并集；
 *   A5 顺序无关：「先磁盘后 live」与「先 live 后磁盘」折出来的 item 流**逐字相等**；
 *   A6 跨源去重：同一事件同时出现在磁盘段与环段 ⇒ 只出现一次（内容 id）；
 *   A7 幂等：同一段重复回填 ⇒ 第二次一条也不并入；
 *   A8 押后：磁盘段里 `ts` 晚于环里最新一条的事件**不并入**（它归实时流，不是丢）；
 *   A9 fail-open：`sessions.get` 报错 ⇒ store 一个字都不动 + 有可观测警告 + 不抛；
 *   A10 页数上限：session 段超过 20 页 ⇒ 停手、`truncated`、有警告（不无限翻页）；
 *   A11 归属：trace 只按「本会话 session 日志里出现过的 run_id」拉（最多 3 个 run）；
 *   A12 提示语：降级/截断时给出一句可读提示（不静默少补）。
 *   A13 内容 id 必须 payload 感知（R2）：同 run/type/**毫秒**但 payload 不同 ⇒ 两条都在；
 *       完全相同的两份 ⇒ 仍然只留一条（三段口径会把前者并掉 = 吞内容）。
 *
 * 外部审查补的四组（同一次提交）：
 *   E6 竞态：实时增量先到、磁盘快照后到 ⇒ 并集、无重复、无洞、**旧条目不消失**；
 *   E2 覆盖反例：live 工具卡再走一次「归档 / 回填」⇒ 卡片数量 / key / 状态都不变；
 *   D1..D3 押后：① 不进 ledger（下一次回填会重试）；② 实时帧晚到后正常合并、不是永久
 *        挂账；③ 刷新后再回填能补上（边界见 D3 注释与回报）；
 *   R1 阶段一触顶可见：`stage1Pages` / `stage1HitCap` / `stage2Runs*` 进观测面，且
 *        「触顶 + 本会话 run 数 > 3」时打一条明确的 warn（+ toast 文案）。
 *
 * 用法：`bun run scripts/check-replay-apply.ts`（退出码在本环境不可信，看 stdout 的
 * `result: PASS/FAIL`）。
 */
import {
  newestRunIds,
  REPLAY_MAX_SESSION_PAGES,
  REPLAY_MAX_TRACE_RUNS,
  type RecoverResult,
  type ReplayCursor,
  type ReplayEvent,
  type ReplaySink,
  type ReplaySource,
  recoverReplay,
  stableEventId,
} from '../apps/web/src/gateway/replay-source';
import type { RunEvent } from '../apps/web/src/gateway/types';
import { t } from '../apps/web/src/i18n';
import { EventStore, STAGE1_CAP_WARNING } from '../apps/web/src/state/event-store';
import type { RunGroup } from '../apps/web/src/state/events';

// ─────────────────────────────── 夹具 ───────────────────────────────

const SESSION = 'sess-1';
const RUN1 = 'run-1';
const RUN2 = 'run-2';

/** 单调时间（同一逻辑事件在三源里的 `ts` **必须相同**，内容 id 才接得上）。 */
const ts = (step: number): number => 1_700_000_000_000 + step;

/**
 * 阶段一夹具：**会话事件日志**（session 全局 seq，跨 run）。
 *
 * run-1 完整（含终点），run-2 还在跑（没有 `run.completed`）—— 与真机事故形态一致。
 */
const SESSION_LOG: ReplayEvent[] = [
  { seq: 1, type: 'session.created', ts: ts(1) },
  { seq: 2, type: 'run.started', run_id: RUN1, ts: ts(2) },
  { seq: 3, type: 'user.message', run_id: RUN1, ts: ts(3), data: { text: 'hi' } },
  {
    seq: 4,
    type: 'tool.call.started',
    run_id: RUN1,
    ts: ts(4),
    data: { tool_call_id: 'c1', tool_name: 'bash' },
  },
  {
    seq: 5,
    type: 'tool.call.completed',
    run_id: RUN1,
    ts: ts(5),
    data: { tool_call_id: 'c1', tool_name: 'bash', output: 'ok' },
  },
  { seq: 6, type: 'run.completed', run_id: RUN1, ts: ts(6), data: { status: 'completed' } },
  { seq: 7, type: 'run.started', run_id: RUN2, ts: ts(7) },
  { seq: 8, type: 'user.message', run_id: RUN2, ts: ts(8), data: { text: 'again' } },
];

/**
 * 环段夹具：客户端**已经收到**的 hub 事件（hub seq 是进程全局的，与上面两套无关）。
 *
 * - hub seq 1 与磁盘 seq 5 是**同一条**逻辑事件（`run-1|tool.call.completed|ts(5)`）⇒
 *   A6 的去重对象；
 * - 两条 `llm.stream.chunk` 磁盘两处都没有（chunk 不落盘）⇒ 必须留下来；
 * - 它的 `ts` 是全场最大的，所以磁盘段里 `ts` 更晚的条目按 A8 **押后**。
 */
const RING: { seq: number; event: RunEvent }[] = [
  {
    seq: 1,
    event: {
      type: 'tool.call.completed',
      run_id: RUN1,
      ts: ts(5),
      data: { tool_call_id: 'c1', tool_name: 'bash', output: 'ok' },
    },
  },
  {
    seq: 2,
    event: {
      type: 'llm.stream.chunk',
      run_id: RUN2,
      ts: ts(20),
      data: { chunk: { type: 'text_delta', delta: 'wor' } },
    },
  },
  {
    seq: 3,
    event: {
      type: 'llm.stream.chunk',
      run_id: RUN2,
      ts: ts(21),
      data: { chunk: { type: 'text_delta', delta: 'ld' } },
    },
  },
];

/** 阶段二夹具：run trace（**per-run** seq）。`context.changed` / `hook.started` 是 trace-only。 */
const TRACE_RUN2: ReplayEvent[] = [
  { seq: 1, type: 'run.started', run_id: RUN2, ts: ts(7) },
  { seq: 2, type: 'context.changed', run_id: RUN2, ts: ts(9), data: { message_count: 2 } },
  { seq: 3, type: 'hook.started', run_id: RUN2, ts: ts(10), data: { hook: 'guard' } },
];

// ─────────────────────────────── 假 RPC ───────────────────────────────

class FakeSource implements ReplaySource {
  sessionCalls = 0;
  traceCalls = 0;
  traceRunIds: string[] = [];
  ringCalls = 0;
  readonly warnings: string[] = [];
  constructor(
    private readonly log: ReplayEvent[],
    private readonly cursor: ReplayCursor,
    readonly _ring: { seq: number; event: RunEvent }[] = [],
    private readonly trace: Map<string, ReplayEvent[]> = new Map(),
    private readonly fail: { cursor?: boolean; session?: boolean; trace?: boolean } = {},
  ) {}
  async getCursor(): Promise<ReplayCursor> {
    if (this.fail.cursor === true) throw new Error('simulated sessions.get failure');
    return this.cursor;
  }
  async fetchSessionLogSegment(sinceSeq: number, limit: number): Promise<ReplayEvent[]> {
    this.sessionCalls += 1;
    if (this.fail.session === true) throw new Error('simulated sessions.events timeout');
    return this.log.filter((event) => event.seq > sinceSeq).slice(0, limit);
  }
  async fetchTraceSegment(
    runId: string,
    sinceRunSeq: number,
    limit: number,
  ): Promise<ReplayEvent[]> {
    this.traceCalls += 1;
    this.traceRunIds.push(runId);
    if (this.fail.trace === true) throw new Error('simulated events.list failure');
    const rows = this.trace.get(runId) ?? [];
    return rows.filter((event) => event.seq > sinceRunSeq).slice(0, limit);
  }
  async fetchRingSegment(): Promise<ReplayEvent[]> {
    this.ringCalls += 1;
    return [];
  }
}

/** 只收集事件、不落库的 sink（用来断言编排层的行为，与 EventStore 无关）。 */
class CountingSink implements ReplaySink {
  readonly ids = new Set<string>();
  readonly warnings: string[] = [];
  applied = 0;
  apply(events: readonly ReplayEvent[]): number {
    for (const event of events) {
      this.applied += 1;
      this.ids.add(stableEventId(event));
    }
    return this.ids.size;
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
}

/**
 * 生产同构的 sink：按段缓冲，段尾一次性 `applyReplaySegment`（与
 * `SubscriptionController#runReplayBackfill` 同一套语义，省掉作用域守卫）。
 */
class StoreSink implements ReplaySink {
  readonly warnings: string[] = [];
  private segment: 'session-log' | 'trace' | null = 'session-log';
  private pending: ReplayEvent[] = [];
  constructor(
    private readonly store: EventStore,
    private readonly sessionId = SESSION,
  ) {}
  private flush(): void {
    if (this.pending.length === 0 || this.segment === null) return;
    this.store.applyReplaySegment(this.segment, this.pending.splice(0), {
      sessionId: this.sessionId,
    });
  }
  apply(events: readonly ReplayEvent[]): number {
    if (this.segment === null) return this.pending.length;
    this.pending.push(...events);
    return this.pending.length;
  }
  warn(message: string): void {
    this.warnings.push(message);
    this.store.noteDiskBackfill({ error: message });
  }
  beginSegment(segment: 'session-log' | 'trace' | 'ring'): void {
    this.flush();
    this.segment = segment === 'ring' ? null : segment;
  }
  finish(): void {
    this.flush();
  }
}

// ─────────────────────────────── 断言框架 ───────────────────────────────

let checks = 0;
const failures: string[] = [];
function expect(condition: boolean, name: string, detail: string): void {
  checks += 1;
  if (!condition) failures.push(`${name}: ${detail}`);
}

/** 两个 item 快照的结构比较（去掉与身份无关的计数 stats / version）。 */
function slim(group: readonly RunGroup[]): string {
  return JSON.stringify(group);
}

/** 一组条目的内容 id（跨源可比的那把尺子）。 */
function contentIds(events: readonly ReplayEvent[]): string[] {
  return events.map((event) => stableEventId(event));
}

/** `EventStore` 里条目的内容 id（不带 `seq` 空间信息）。 */
function storeContentIds(store: EventStore): string[] {
  return store.getSnapshot().entries.map((entry) =>
    stableEventId({
      seq: entry.seq,
      type: entry.event.type,
      ts: entry.event.ts,
      run_id: entry.event.run_id,
      // payload 摘要也是内容 id 的一部分（见 `replay-source.ts#stableEventId`）：
      // 少了它这里算出来的 id 与 `disk-replay.ts` 里的对不上，断言会假红/假绿。
      data: entry.event.data,
    }),
  );
}

/** 某个 callId 的工具卡（item 侧身份；E2 用它证明「卡片没被替换」）。 */
function toolCards(store: EventStore, callId: string): { key: string; status: string }[] {
  const out: { key: string; status: string }[] = [];
  for (const group of store.items.getSnapshot().groups) {
    for (const item of group.items) {
      if (item.kind !== 'tool') continue;
      if (item.callId !== callId) continue;
      out.push({ key: item.key, status: String(item.status) });
    }
  }
  return out;
}

/** item 侧的全部 key（顺序敏感：E2 用它证明「卡片集合与次序都没变」）。 */
function itemKeys(store: EventStore): string[] {
  return store.items.getSnapshot().groups.flatMap((group) => group.items.map((item) => item.key));
}

function newStore(): EventStore {
  return new EventStore(0);
}

/** 一次完整的三段回填（生产顺序：环已收到 → 磁盘段 → trace 段）。 */
async function runFullRecover(
  store: EventStore,
  opts: { fail?: FakeSource['fail']; trace?: Map<string, ReplayEvent[]> } = {},
): Promise<{ source: FakeSource; sink: StoreSink; result: RecoverResult }> {
  const source = new FakeSource(
    SESSION_LOG,
    { last_seq: 8, derived_upto_seq: 0 },
    RING,
    opts.trace ?? new Map([[RUN2, TRACE_RUN2]]),
    opts.fail ?? {},
  );
  const sink = new StoreSink(store);
  const result = await recoverReplay(source, sink, { runs: (events) => newestRunIds(events) });
  sink.finish();
  return { source, sink, result };
}

/**
 * 用自定义磁盘段跑一次回填（环段照旧由调用方先 `push` 进 store —— 生产的顺序也是
 * 「实时帧先到，磁盘段后到」）。
 */
async function runRecoverWith(
  store: EventStore,
  log: ReplayEvent[],
  trace: Map<string, ReplayEvent[]> = new Map(),
): Promise<RecoverResult> {
  const last = log.reduce((top, event) => Math.max(top, event.seq), 0);
  const source = new FakeSource(log, { last_seq: last, derived_upto_seq: 0 }, [], trace);
  const sink = new StoreSink(store);
  const result = await recoverReplay(source, sink, { runs: (events) => newestRunIds(events) });
  sink.finish();
  return result;
}

async function main(): Promise<void> {
  const lines: string[] = [];
  lines.push(
    '================ check-replay-apply (A4..A13 + E2/E6 + D1..D3 + R1) ================',
  );

  // A4 + A5 + A6：三段合并 = 并集，无重复、无洞；且与「先 live 后磁盘」等价。
  {
    const incremental = newStore();
    for (const item of RING) incremental.push(item.event, { seq: item.seq });
    const a = await runFullRecover(incremental);
    incremental.flush();

    const rebuilt = newStore();
    const b = await runFullRecover(rebuilt);
    // rebuilt 再喂一遍环（模拟「实时帧晚到」）：结果必须与 A 等价。
    for (const item of RING) rebuilt.push(item.event, { seq: item.seq });
    rebuilt.flush();

    // 并集（内容 id）
    const union = new Set<string>([
      ...contentIds(SESSION_LOG),
      ...contentIds(RING.map((item) => ({ seq: item.seq, ...item.event }) as ReplayEvent)),
      ...contentIds(TRACE_RUN2),
    ]);
    const merged = storeContentIds(incremental);
    const mergedSet = new Set(merged);
    const holes = [...union].filter((id) => !mergedSet.has(id));
    const dups = merged.filter((id, index) => merged.indexOf(id) !== index);
    expect(holes.length === 0, 'A4-union', `missing ids: ${JSON.stringify(holes.slice(0, 5))}`);
    expect(dups.length === 0, 'A4-nodup', `duplicate ids: ${JSON.stringify(dups.slice(0, 5))}`);
    expect(
      incremental.getSnapshot().entries.length === union.size,
      'A4-size',
      `entries=${incremental.getSnapshot().entries.length} union=${union.size}`,
    );
    // A5：先 live 后磁盘 == 先磁盘后 live（item 流逐字相等）。
    const left = slim(incremental.items.getSnapshot().groups);
    const right = slim(rebuilt.items.getSnapshot().groups);
    expect(left === right, 'A5-order', 'item streams differ between merge orders');
    // A6：环里那条与磁盘重复的工具卡只出现一次。
    const toolCards = incremental.items
      .getSnapshot()
      .groups.flatMap((group) =>
        group.items.filter((item) => item.kind === 'tool' && item.callId === 'c1'),
      );
    expect(toolCards.length === 1, 'A6-tool-dedup', `callId=c1 cards=${toolCards.length}`);
    // 判据：阶段一确实被调过（不是「只靠环」）。
    expect(a.source.sessionCalls > 0, 'A4-session-called', `calls=${a.source.sessionCalls}`);
    expect(
      b.result.sessionEvents === SESSION_LOG.length,
      'A4-session-events',
      String(b.result.sessionEvents),
    );
    lines.push(
      '[A4/A5/A6] union=' +
        union.size +
        ' entries=' +
        incremental.getSnapshot().entries.length +
        ' holes=' +
        holes.length +
        ' dups=' +
        dups.length +
        ' order-equal=' +
        String(left === right) +
        ' toolCards=' +
        toolCards.length,
    );
  }

  // A7 幂等：同一段重复回填，第二次一条也不并入。
  {
    const store = newStore();
    for (const item of RING) store.push(item.event, { seq: item.seq });
    await runFullRecover(store);
    store.flush();
    const before = store.getSnapshot().entries.length;
    const second = await runFullRecover(store);
    store.flush();
    const after = store.getSnapshot().entries.length;
    expect(after === before, 'A7-idempotent', `entries ${before} -> ${after}`);
    expect(second.result.sessionEvents > 0, 'A7-rpc-rerun', 'second pass should still call RPC');
    lines.push(`[A7 idempotent] entries stay ${after} (second pass merged 0)`);
  }

  // A8 押后：`ts` 晚于环里最新一条的磁盘事件**不并入**（归实时流）。
  {
    const store = newStore();
    for (const item of RING) store.push(item.event, { seq: item.seq });
    const inFlight: ReplayEvent = {
      seq: 9,
      type: 'llm.response',
      run_id: RUN2,
      ts: ts(99),
      data: { text: 'in flight' },
    };
    const source = new FakeSource(
      [...SESSION_LOG, inFlight],
      { last_seq: 9, derived_upto_seq: 0 },
      RING,
    );
    const sink = new StoreSink(store);
    await recoverReplay(source, sink, { runs: () => [] });
    sink.finish();
    store.flush();
    const ids = storeContentIds(store);
    expect(
      !ids.includes(stableEventId(inFlight)),
      'A8-deferred',
      'in-flight disk event must not be merged before the live frame',
    );
    expect(
      store.diskBackfill.deferred >= 1,
      'A8-deferred-stat',
      `deferred=${store.diskBackfill.deferred}`,
    );
    lines.push(`[A8 deferred] deferred=${store.diskBackfill.deferred} (event still absent)`);
  }

  // A9 fail-open：`sessions.get` 报错 => store 一个字都不动 + 有警告 + 不抛。
  {
    const store = newStore();
    for (const item of RING) store.push(item.event, { seq: item.seq });
    store.flush();
    const before = store.getSnapshot().entries.length;
    const beforeItems = slim(store.items.getSnapshot().groups);
    store.beginDiskBackfillAttempt();
    let threw = false;
    let result: RecoverResult | undefined;
    try {
      result = await runFullRecover(store, { fail: { cursor: true } }).then(
        (value) => value.result,
      );
    } catch {
      threw = true;
    }
    const after = store.getSnapshot().entries.length;
    expect(threw === false, 'A9-no-throw', 'recover must not throw');
    expect(after === before, 'A9-preserve', `entries ${before} -> ${after}`);
    expect(
      slim(store.items.getSnapshot().groups) === beforeItems,
      'A9-preserve-items',
      'items changed',
    );
    expect(store.diskBackfill.lastError !== undefined, 'A9-warn', 'lastError must be set');
    expect((result?.sessionEvents ?? 0) === 0, 'A9-no-partial', 'nothing merged on failure');
    lines.push(
      '[A9 fail-open] entries preserved=' +
        after +
        ' lastError=' +
        JSON.stringify(store.diskBackfill.lastError),
    );
  }

  // A10 页数上限：session 段永远拿不完 => 停在上限、有警告、不无限翻页。
  {
    const endless: ReplayEvent[] = Array.from({ length: 50_000 }, (_, index) => ({
      seq: index + 1,
      type: 'llm.response',
      run_id: RUN1,
      ts: ts(index + 1),
    }));
    const source = new FakeSource(endless, { last_seq: 50_000, derived_upto_seq: 0 });
    const sink = new CountingSink();
    const result = await recoverReplay(source, sink, { runs: () => [] });
    expect(
      source.sessionCalls === REPLAY_MAX_SESSION_PAGES,
      'A10-page-cap',
      `calls=${source.sessionCalls} want ${REPLAY_MAX_SESSION_PAGES}`,
    );
    expect(result.truncated === true, 'A10-truncated', 'truncated flag missing');
    expect(result.sessionOk === false, 'A10-session-ok', 'sessionOk must be false');
    expect(sink.warnings.length > 0, 'A10-warn', 'page cap must warn');
    lines.push(
      '[A10 page cap] calls=' +
        source.sessionCalls +
        ' applied=' +
        sink.applied +
        ' truncated=' +
        String(result.truncated) +
        ' warnings=' +
        sink.warnings.length,
    );
  }

  // A11 归属 + run 数上限：trace 只按「本会话日志里出现过的 run_id」拉，最多 3 个。
  {
    const manyRuns: ReplayEvent[] = [];
    for (let index = 0; index < 6; index += 1) {
      manyRuns.push({
        seq: index * 2 + 1,
        type: 'run.started',
        run_id: `run-${index}`,
        ts: ts(index * 2 + 1),
      });
      manyRuns.push({
        seq: index * 2 + 2,
        type: 'user.message',
        run_id: `run-${index}`,
        ts: ts(index * 2 + 2),
      });
    }
    const trace = new Map<string, ReplayEvent[]>(
      Array.from({ length: 6 }, (_, index) => [
        `run-${index}`,
        [{ seq: 1, type: 'context.changed', run_id: `run-${index}`, ts: ts(index * 2 + 2) + 1 }],
      ]),
    );
    const source = new FakeSource(manyRuns, { last_seq: 12, derived_upto_seq: 0 }, [], trace);
    const sink = new CountingSink();
    const result = await recoverReplay(source, sink, { runs: (events) => newestRunIds(events) });
    const sessionRunIds = new Set(manyRuns.map((event) => event.run_id ?? ''));
    const foreign = source.traceRunIds.filter((runId) => !sessionRunIds.has(runId));
    expect(
      foreign.length === 0,
      'A11-ownership',
      `foreign runs fetched: ${JSON.stringify(foreign)}`,
    );
    expect(
      source.traceRunIds.length <= REPLAY_MAX_TRACE_RUNS,
      'A11-run-cap',
      `trace calls=${source.traceRunIds.length}`,
    );
    expect(
      result.traceRunsRequested === REPLAY_MAX_TRACE_RUNS,
      'A11-requested',
      `requested=${result.traceRunsRequested}`,
    );
    expect(
      source.traceRunIds.every(
        (runId) => runId === 'run-5' || runId === 'run-4' || runId === 'run-3',
      ),
      'A11-newest-first',
      `fetched: ${JSON.stringify(source.traceRunIds)}`,
    );
    lines.push(
      '[A11 ownership] traceRuns=' +
        JSON.stringify(source.traceRunIds) +
        ' foreign=' +
        foreign.length +
        ' requested=' +
        result.traceRunsRequested,
    );
  }

  // A12 提示语：降级 / 截断必须有一句人话（i18n key 真的存在，不是回落到 key 本身）。
  {
    const partial = t('replay.notice.partial', { runs: 1, total: 3 });
    const failed = t('replay.notice.failed');
    const stage1 = t('replay.notice.stage1cap', { runs: REPLAY_MAX_TRACE_RUNS });
    expect(partial !== 'replay.notice.partial' && !partial.includes('{'), 'A12-partial', partial);
    expect(failed !== 'replay.notice.failed', 'A12-failed', failed);
    expect(stage1 !== 'replay.notice.stage1cap' && !stage1.includes('{'), 'A12-stage1cap', stage1);
    lines.push(
      `[A12 notice] partial=${JSON.stringify(partial)} failed=${JSON.stringify(failed)} stage1cap=${JSON.stringify(stage1)}`,
    );
  }

  // A13（R2）内容 id 必须 payload 感知：同 run / type / **毫秒**但 payload 不同 ⇒ 两条都在；
  // 完全相同的两份 ⇒ 仍然只留一条。三段口径（`run_id|type|ts`）在这里会**吞内容**。
  {
    const sameMs = ts(30);
    const left: ReplayEvent = {
      seq: 1,
      type: 'hook.started',
      run_id: RUN1,
      ts: sameMs,
      data: { hook: 'guard' },
    };
    const right: ReplayEvent = {
      seq: 2,
      type: 'hook.started',
      run_id: RUN1,
      ts: sameMs,
      data: { hook: 'policy' },
    };
    const store = newStore();
    const outcome = store.applyReplaySegment('session-log', [left, right], { sessionId: SESSION });
    const ids = storeContentIds(store);
    const distinct = new Set(ids).size;
    expect(
      stableEventId(left) !== stableEventId(right),
      'A13-id-payload-aware',
      '同 run/type/ts 不同 payload 必须得到不同内容 id',
    );
    expect(outcome.merged === 2, 'A13-merged', `merged=${outcome.merged}`);
    expect(outcome.duplicates === 0, 'A13-no-duplicate', `duplicates=${outcome.duplicates}`);
    expect(distinct === 2, 'A13-distinct', `distinct=${distinct}`);
    expect(
      store.getSnapshot().entries.length === 2,
      'A13-entries',
      `entries=${store.getSnapshot().entries.length}`,
    );
    // 完全相同的两份（payload 也同）：仍然去重（只留一条、duplicates=1）。
    const twin = newStore();
    twin.applyReplaySegment('session-log', [left], { sessionId: SESSION });
    const dup = twin.applyReplaySegment('trace', [{ ...left }], { sessionId: SESSION });
    const twinIds = storeContentIds(twin);
    expect(dup.duplicates === 1, 'A13-identical-dup', `duplicates=${dup.duplicates}`);
    expect(dup.merged === 0, 'A13-identical-merged', `merged=${dup.merged}`);
    expect(
      new Set(twinIds).size === 1,
      'A13-identical-distinct',
      `distinct=${new Set(twinIds).size}`,
    );
    expect(twin.getSnapshot().entries.length === 1, 'A13-identical-entries', 'entries != 1');
    // 传输层会在**出站副本**的 `data` 里补 `session_id`（`gateway.ts#withSessionAttribution`），
    // 磁盘副本是原始事件、没有这个键。内容 id 必须把它抹平，否则「磁盘 vs 已收到」永远配
    // 不上对 —— 回填会把每条工具 / LLM 事件再并一遍（制造重复）。
    const diskCopy: ReplayEvent = {
      seq: 5,
      type: 'tool.call.completed',
      run_id: RUN1,
      ts: ts(5),
      data: { tool_call_id: 'c1', tool_name: 'bash', output: 'ok' },
    };
    const stamped = newStore();
    stamped.push(
      {
        type: 'tool.call.completed',
        run_id: RUN1,
        ts: ts(5),
        data: { tool_call_id: 'c1', tool_name: 'bash', output: 'ok', session_id: SESSION },
      },
      { seq: 1 },
    );
    stamped.flush();
    const attribution = stamped.applyReplaySegment('session-log', [diskCopy], {
      sessionId: SESSION,
    });
    expect(
      attribution.duplicates === 1 && attribution.merged === 0,
      'A13-attribution-not-identity',
      `merged=${attribution.merged} duplicates=${attribution.duplicates}（出站副本多出的 session_id 不该让去重失效）`,
    );
    // 反面：没有 run 可言的事件（`session.created`）里 `session_id` **是**身份的一部分，
    // 抹掉就会把两个会话的事件并成一条（吞内容）—— 这一侧绝不许松懈。
    const sessionA: ReplayEvent = {
      seq: 1,
      type: 'session.created',
      ts: sameMs,
      data: { session_id: 'sess-a' },
    };
    const sessionB: ReplayEvent = {
      seq: 2,
      type: 'session.created',
      ts: sameMs,
      data: { session_id: 'sess-b' },
    };
    expect(
      stableEventId(sessionA) !== stableEventId(sessionB),
      'A13-session-id-kept',
      '没有 run 的事件必须把 data.session_id 算进身份',
    );
    lines.push(
      `[A13 payload-aware id] distinct=${distinct} dups=${outcome.duplicates} entries=${store.getSnapshot().entries.length} identical: distinct=${new Set(twinIds).size} dups=${dup.duplicates} attribution-dups=${attribution.duplicates}`,
    );
  }

  // E6（R4）竞态：**实时增量先到**（hub seq 高），**磁盘快照后到**（含更早的 seq）。最终必须
  // 是并集：无重复、无洞、且**旧条目一条都不消失**（这条路径上没有任何 replace 动作）。
  {
    const RUN3 = 'run-3';
    const store = newStore();
    const liveStarted: RunEvent = {
      type: 'tool.call.started',
      run_id: RUN3,
      ts: ts(40),
      data: { tool_call_id: 'c9', tool_name: 'bash' },
    };
    const liveDone: RunEvent = {
      type: 'tool.call.completed',
      run_id: RUN3,
      ts: ts(41),
      data: { tool_call_id: 'c9', tool_name: 'bash', output: 'ok' },
    };
    store.push(liveStarted, { seq: 7 });
    store.push(liveDone, { seq: 8 });
    store.flush();
    const beforeIds = storeContentIds(store);
    const beforeCards = toolCards(store, 'c9');
    // 磁盘快照后到：更早的 seq（会话日志 1..8）+ 与 liveDone **完全相同**的那一条
    // （跨源重复，必须只留一份）。
    const snapshot: ReplayEvent[] = [
      ...SESSION_LOG,
      {
        seq: 9,
        type: 'tool.call.completed',
        run_id: RUN3,
        ts: ts(41),
        data: { tool_call_id: 'c9', tool_name: 'bash', output: 'ok' },
      },
    ];
    const outcome = store.applyReplaySegment('session-log', snapshot, { sessionId: SESSION });
    store.flush();
    const afterIds = storeContentIds(store);
    const union = new Set<string>([...contentIds(snapshot), ...beforeIds]);
    const holes = [...union].filter((id) => !afterIds.includes(id));
    const dups = afterIds.filter((id, index) => afterIds.indexOf(id) !== index);
    const lost = beforeIds.filter((id) => !afterIds.includes(id));
    const afterCards = toolCards(store, 'c9');
    expect(holes.length === 0, 'E6-union', `missing ids: ${JSON.stringify(holes.slice(0, 5))}`);
    expect(dups.length === 0, 'E6-nodup', `duplicate ids: ${JSON.stringify(dups.slice(0, 5))}`);
    expect(lost.length === 0, 'E6-no-replace', `lost ids: ${JSON.stringify(lost.slice(0, 5))}`);
    expect(
      outcome.duplicates === 1,
      'E6-cross-source',
      `duplicates=${outcome.duplicates}（磁盘里那条与 live 完全相同的应只被挡掉一次）`,
    );
    expect(
      afterIds.length === beforeIds.length + SESSION_LOG.length,
      'E6-size',
      `entries=${afterIds.length} want ${beforeIds.length + SESSION_LOG.length}`,
    );
    expect(
      afterCards.length === 1 &&
        beforeCards.length === 1 &&
        afterCards[0]?.key === beforeCards[0]?.key,
      'E6-card-kept',
      `before=${JSON.stringify(beforeCards)} after=${JSON.stringify(afterCards)}`,
    );
    // 顺序无关的加强（同 A5 的口径，但这次比的是「实时先到」这一侧）：磁盘先到、实时后到
    // 折出来的 item 流必须逐字相等。
    const reversed = newStore();
    reversed.applyReplaySegment('session-log', SESSION_LOG, { sessionId: SESSION });
    reversed.push(liveStarted, { seq: 7 });
    reversed.push(liveDone, { seq: 8 });
    reversed.flush();
    expect(
      slim(reversed.items.getSnapshot().groups) === slim(store.items.getSnapshot().groups),
      'E6-order',
      'live-first vs disk-first item streams differ',
    );
    lines.push(
      '[E6 race] union=' +
        union.size +
        ' entries=' +
        afterIds.length +
        ' holes=' +
        holes.length +
        ' dups=' +
        dups.length +
        ' lost=' +
        lost.length +
        ' cardKept=' +
        String(afterCards.length === 1) +
        ' order-equal=' +
        String(
          slim(reversed.items.getSnapshot().groups) === slim(store.items.getSnapshot().groups),
        ),
    );
  }

  // E2（R4）覆盖反例：**同一张工具卡**先以 live 形式存在，再走一次「归档 / 回填」。卡片
  // 必须原地不动 —— 数量、key、状态都不许被替换（回填只允许把更早的东西加进来）。
  {
    const store = newStore();
    const started: RunEvent = {
      type: 'tool.call.started',
      run_id: RUN1,
      ts: ts(4),
      data: { tool_call_id: 'c1', tool_name: 'bash' },
    };
    const finished: RunEvent = {
      type: 'tool.call.completed',
      run_id: RUN1,
      ts: ts(5),
      data: { tool_call_id: 'c1', tool_name: 'bash', output: 'ok' },
    };
    store.push(started, { seq: 1 });
    store.push(finished, { seq: 2 });
    store.flush();
    const beforeCard = toolCards(store, 'c1');
    const beforeKeys = itemKeys(store);
    const beforeEntries = store.getSnapshot().entries.length;
    const diskCopy: ReplayEvent[] = [
      {
        seq: 4,
        type: 'tool.call.started',
        run_id: RUN1,
        ts: ts(4),
        data: { tool_call_id: 'c1', tool_name: 'bash' },
      },
      {
        seq: 5,
        type: 'tool.call.completed',
        run_id: RUN1,
        ts: ts(5),
        data: { tool_call_id: 'c1', tool_name: 'bash', output: 'ok' },
      },
    ];
    const outcome = store.applyReplaySegment('session-log', diskCopy, { sessionId: SESSION });
    store.flush();
    const afterCard = toolCards(store, 'c1');
    const afterKeys = itemKeys(store);
    expect(
      beforeCard.length === 1 && afterCard.length === 1,
      'E2-card-count',
      `before=${beforeCard.length} after=${afterCard.length}`,
    );
    expect(
      afterCard[0]?.key === beforeCard[0]?.key,
      'E2-card-key',
      `before=${beforeCard[0]?.key} after=${afterCard[0]?.key}`,
    );
    expect(
      afterCard[0]?.status === beforeCard[0]?.status && afterCard[0]?.status !== 'running',
      'E2-card-status',
      `before=${beforeCard[0]?.status} after=${afterCard[0]?.status}`,
    );
    expect(
      outcome.merged === 0 && outcome.duplicates === 2,
      'E2-no-new-entry',
      `merged=${outcome.merged} duplicates=${outcome.duplicates}`,
    );
    expect(
      store.getSnapshot().entries.length === beforeEntries,
      'E2-entries',
      `entries ${beforeEntries} -> ${store.getSnapshot().entries.length}`,
    );
    expect(
      JSON.stringify(afterKeys) === JSON.stringify(beforeKeys),
      'E2-item-set',
      `before=${JSON.stringify(beforeKeys)} after=${JSON.stringify(afterKeys)}`,
    );
    // 归档 / 回填再来一遍（第二次回填、二次归档）：仍然只许原地不动。
    const again = store.applyReplaySegment('session-log', diskCopy, { sessionId: SESSION });
    store.flush();
    expect(
      again.merged === 0 && toolCards(store, 'c1').length === 1,
      'E2-second-pass',
      `merged=${again.merged} cards=${toolCards(store, 'c1').length}`,
    );
    expect(
      JSON.stringify(itemKeys(store)) === JSON.stringify(beforeKeys),
      'E2-second-pass-items',
      'item keys changed on second pass',
    );
    lines.push(
      '[E2 overwrite] cards=' +
        afterCard.length +
        ' key=' +
        JSON.stringify(afterCard[0]?.key) +
        ' status=' +
        JSON.stringify(afterCard[0]?.status) +
        ' newEntries=' +
        outcome.merged +
        ' duplicates=' +
        outcome.duplicates +
        ' itemKeys-unchanged=' +
        String(JSON.stringify(afterKeys) === JSON.stringify(beforeKeys)),
    );
  }

  // D1（R3）押后的事件**不进 ledger**：同一次刷新里再回填一遍，它必须被**重新考虑**
  // （deferred 再 +1），而不是被记成「已并入」（alreadyMerged）。
  {
    const store = newStore();
    for (const item of RING) store.push(item.event, { seq: item.seq });
    store.flush();
    const inFlight: ReplayEvent = {
      seq: 9,
      type: 'llm.response',
      run_id: RUN2,
      ts: ts(99),
      data: { text: 'in flight' },
    };
    const log = [...SESSION_LOG, inFlight];
    await runRecoverWith(store, log);
    store.flush();
    const firstDeferred = store.diskBackfill.deferred;
    const firstMerged = store.diskBackfill.alreadyMerged;
    await runRecoverWith(store, log);
    store.flush();
    const secondDeferred = store.diskBackfill.deferred;
    const secondMerged = store.diskBackfill.alreadyMerged;
    expect(firstDeferred === 1, 'D1-first-deferred', `deferred=${firstDeferred}`);
    expect(
      secondDeferred === 2,
      'D1-retried',
      `deferred=${secondDeferred}（第二次仍应被重新考虑）`,
    );
    // 第二次只有 SESSION_LOG 那 8 条进 `alreadyMerged`；押后的那条不算「已并入」。
    expect(
      secondMerged - firstMerged === SESSION_LOG.length,
      'D1-not-ledgered',
      `alreadyMerged +${secondMerged - firstMerged}（应为 ${SESSION_LOG.length}）`,
    );
    expect(
      !storeContentIds(store).includes(stableEventId(inFlight)),
      'D1-absent',
      '押后的事件不该进 entries',
    );
    lines.push(
      `[D1 deferred-ledger] deferred ${firstDeferred} -> ${secondDeferred} alreadyMerged +${secondMerged - firstMerged}`,
    );
  }

  // D2（R3）「实时流后来到达」⇒ 押后段正常合并（不是永久挂账）：实时帧进来一次，之后
  // 再回填同一段时它已经被认成**重复**（跨源内容 id 命中），而不是又被押后 / 又被并入。
  {
    const store = newStore();
    for (const item of RING) store.push(item.event, { seq: item.seq });
    store.flush();
    const inFlight: ReplayEvent = {
      seq: 9,
      type: 'llm.response',
      run_id: RUN2,
      ts: ts(99),
      data: { text: 'in flight' },
    };
    const log = [...SESSION_LOG, inFlight];
    await runRecoverWith(store, log);
    store.flush();
    // 实时帧到达（hub seq 4，ts 与磁盘那条完全相同 —— 同一逻辑事件）。
    store.push(
      { type: 'llm.response', run_id: RUN2, ts: ts(99), data: { text: 'in flight' } },
      { seq: 4 },
    );
    store.flush();
    const id = stableEventId(inFlight);
    const copies = storeContentIds(store).filter((value) => value === id).length;
    const deferredBefore = store.diskBackfill.deferred;
    const dupBefore = store.diskBackfill.duplicates;
    await runRecoverWith(store, log);
    store.flush();
    expect(copies === 1, 'D2-live-merged', `copies=${copies}（实时帧到达后应恰好一条）`);
    expect(
      store.diskBackfill.deferred === deferredBefore,
      'D2-no-longer-deferred',
      `deferred ${deferredBefore} -> ${store.diskBackfill.deferred}`,
    );
    expect(
      store.diskBackfill.duplicates - dupBefore === 1,
      'D2-dedup-on-next-pass',
      `duplicates +${store.diskBackfill.duplicates - dupBefore}（应为 1：磁盘那条已被实时那条认领）`,
    );
    expect(
      storeContentIds(store).filter((value) => value === id).length === 1,
      'D2-single-copy',
      '回路之后不许变成两条',
    );
    lines.push(
      `[D2 live-late] copies=${copies} deferred ${deferredBefore} -> ${store.diskBackfill.deferred} duplicates +${store.diskBackfill.duplicates - dupBefore}`,
    );
  }

  // D3（R3）「实时流一直没来 + 再刷新一次」：第二次回填**会重新尝试**（D1 已证），并且
  // 刷新（= 新的 EventStore：环空、ledger 空）之后它会被正常补上 —— 押后从来没有变成
  // 永久挂账。**边界**：同一 store、实时流永不到达、且此后没有任何更新的环事件 ⇒ 天花板
  // 不动，它就会一直押后（今天的设计如此，见回报说明；不硬造断言）。
  {
    const store = newStore();
    for (const item of RING) store.push(item.event, { seq: item.seq });
    store.flush();
    const inFlight: ReplayEvent = {
      seq: 9,
      type: 'llm.response',
      run_id: RUN2,
      ts: ts(99),
      data: { text: 'in flight' },
    };
    const log = [...SESSION_LOG, inFlight];
    await runRecoverWith(store, log);
    store.flush();
    await runRecoverWith(store, log);
    store.flush();
    const stalledDeferred = store.diskBackfill.deferred;
    const stalledPresent = storeContentIds(store).includes(stableEventId(inFlight));
    // (a) 刷新一次：新的 store（环空 ⇒ 天花板 = +∞，ledger 空）⇒ 这次必须补上。
    const refreshed = newStore();
    await runRecoverWith(refreshed, log);
    refreshed.flush();
    const refreshedIds = storeContentIds(refreshed);
    // (b) 同一 store 里来了**更新的**环事件（天花板抬起来）⇒ 下一次回填也补上。
    store.push({ type: 'llm.stream.summary', run_id: RUN2, ts: ts(120), data: {} }, { seq: 5 });
    store.flush();
    await runRecoverWith(store, log);
    store.flush();
    const liftedIds = storeContentIds(store);
    expect(
      stalledDeferred === 2,
      'D3-retried',
      `deferred=${stalledDeferred}（第二次回填应再试一次）`,
    );
    expect(!stalledPresent, 'D3-stalled-absent', '天花板不动时它确实还不该进 entries');
    expect(
      refreshedIds.filter((value) => value === stableEventId(inFlight)).length === 1,
      'D3-after-refresh',
      '刷新后的回填必须把它补上（且只一条）',
    );
    expect(
      liftedIds.filter((value) => value === stableEventId(inFlight)).length === 1,
      'D3-after-ceiling-lift',
      '天花板抬起后必须补上（且只一条）',
    );
    lines.push(
      '[D3 deferred-recovery] retried=2 stalled-absent=' +
        String(!stalledPresent) +
        ' after-refresh=' +
        String(refreshedIds.filter((value) => value === stableEventId(inFlight)).length) +
        ' after-ceiling-lift=' +
        String(liftedIds.filter((value) => value === stableEventId(inFlight)).length),
    );
  }

  // R1 阶段一触顶必须可见：`stage1Pages` / `stage1HitCap` / 两个阶段二数字进观测面，且
  // 「触顶 + 本会话 run 数 > 3」时打一条明确的 warn（含 toast 文案）。
  {
    const store = newStore();
    let seq = 1;
    for (const runId of ['run-a', 'run-b', 'run-c', 'run-d']) {
      store.push(
        { type: 'run.started', run_id: runId, ts: ts(seq), data: { session_id: SESSION } },
        { seq },
      );
      seq += 1;
    }
    store.flush();
    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warned.push(args.map((value) => String(value)).join(' '));
    };
    let cappedWarn = false;
    try {
      store.beginDiskBackfillAttempt();
      cappedWarn = store.noteDiskBackfill({
        stage1Pages: REPLAY_MAX_SESSION_PAGES,
        stage1HitCap: true,
        stage2RunsRequested: REPLAY_MAX_TRACE_RUNS,
        stage2RunsFetched: 0,
        sessionId: SESSION,
      });
      // 反例一：只 2 个 run ⇒ 触顶也不报（阶段二覆盖得到）。
      const few = newStore();
      for (const runId of ['run-x', 'run-y']) {
        few.push(
          { type: 'run.started', run_id: runId, ts: ts(1), data: { session_id: SESSION } },
          { seq: 1 },
        );
      }
      few.flush();
      few.beginDiskBackfillAttempt();
      const fewWarn = few.noteDiskBackfill({
        stage1Pages: REPLAY_MAX_SESSION_PAGES,
        stage1HitCap: true,
        stage2RunsRequested: 2,
        stage2RunsFetched: 2,
        sessionId: SESSION,
      });
      // 反例二：4 个 run 但没触顶 ⇒ 不报（这次没有缺口）。
      const notCapped = newStore();
      for (const runId of ['run-p', 'run-q', 'run-r', 'run-s']) {
        notCapped.push(
          { type: 'run.started', run_id: runId, ts: ts(1), data: { session_id: SESSION } },
          { seq: 1 },
        );
      }
      notCapped.flush();
      notCapped.beginDiskBackfillAttempt();
      const noCapWarn = notCapped.noteDiskBackfill({
        stage1Pages: 2,
        stage1HitCap: false,
        stage2RunsRequested: REPLAY_MAX_TRACE_RUNS,
        stage2RunsFetched: 3,
        sessionId: SESSION,
      });
      const stats = store.diskBackfill;
      expect(
        stats.stage1Pages === REPLAY_MAX_SESSION_PAGES,
        'R1-pages',
        `pages=${stats.stage1Pages}`,
      );
      expect(stats.stage1HitCap === true, 'R1-hitcap', 'stage1HitCap must be true');
      expect(
        stats.stage2RunsRequested === REPLAY_MAX_TRACE_RUNS && stats.stage2RunsFetched === 0,
        'R1-stage2',
        `requested=${stats.stage2RunsRequested} fetched=${stats.stage2RunsFetched}`,
      );
      expect(cappedWarn === true && stats.stage1CapWarned === true, 'R1-warned', 'warn missing');
      expect(
        stats.stage1CapWarn === STAGE1_CAP_WARNING && STAGE1_CAP_WARNING.includes('早于最近'),
        'R1-warn-text',
        String(stats.stage1CapWarn),
      );
      expect(
        warned.some((line) => line.includes('阶段一已触顶')),
        'R1-console-warn',
        `warned=${JSON.stringify(warned)}`,
      );
      expect(warned.length === 1, 'R1-warn-once', `warned ${warned.length} times（只该打一条）`);
      expect(fewWarn === false, 'R1-few-runs', 'run 数 <= 3 时不该报触顶');
      expect(noCapWarn === false, 'R1-no-cap', '没触顶时不该报');
      expect(
        few.diskBackfill.stage1CapWarned === false &&
          notCapped.diskBackfill.stage1CapWarned === false,
        'R1-negative-stats',
        '反例的观测面必须是 false',
      );
      // 下一次尝试开始必须把「上一次触顶」清掉（它描述的是「这一次」）。
      store.beginDiskBackfillAttempt();
      expect(
        store.diskBackfill.stage1HitCap === false && store.diskBackfill.stage1Pages === 0,
        'R1-reset',
        'beginDiskBackfillAttempt 必须重置 stage1 快照',
      );
      lines.push(
        '[R1 stage1 cap] pages=' +
          stats.stage1Pages +
          ' hitCap=' +
          String(stats.stage1HitCap) +
          ' stage2=' +
          stats.stage2RunsFetched +
          '/' +
          stats.stage2RunsRequested +
          ' warned=' +
          String(stats.stage1CapWarned) +
          ' console-warns=' +
          warned.length,
      );
    } finally {
      console.warn = originalWarn;
    }
  }

  lines.push('-------------------------------------------------------------');
  lines.push(`checks=${checks} failures=${failures.length}`);
  for (const failure of failures) lines.push(`  FAIL ${failure}`);
  lines.push(`result: ${failures.length === 0 ? 'PASS' : 'FAIL'}`);
  lines.push('=============================================================');
  console.log(lines.join('\n'));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('check-replay-apply crashed:', error);
  process.exit(2);
});
