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
import { EventStore } from '../apps/web/src/state/event-store';
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
    }),
  );
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

async function main(): Promise<void> {
  const lines: string[] = [];
  lines.push('================ check-replay-apply (A4..A12) ================');

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
    expect(partial !== 'replay.notice.partial' && !partial.includes('{'), 'A12-partial', partial);
    expect(failed !== 'replay.notice.failed', 'A12-failed', failed);
    lines.push(`[A12 notice] partial=${JSON.stringify(partial)} failed=${JSON.stringify(failed)}`);
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
