#!/usr/bin/env bun
/**
 * check-replay-merge.ts — A2 行为门 + A3 幂等门 + fail-open（离线、无真服务）。
 *
 * 用真实的 `packages/serve/src/replay-budget.ts` 与一组夹具，对"刷新后把落盘/环/trace 三段
 * 合并成完整时间线"的**最小适配器契约**做可执行断言（replay-wire 按此实现）：
 *
 *   A2 行为：fixture `derived_upto_seq=4 < last_seq=366` + 环空（重启）
 *            => 恢复覆盖 `[1..366]` **零洞**，且确实调用了 `sessions.events`（假 RPC 计数）。
 *   A3 幂等：磁盘段与环段**重叠** => 合并后无重复（按稳定 id 去重），总数 == 并集大小。
 *   fail-open：`sessions.events` 报错/超时 => 不抛、打警告、已渲染数据不丢。
 *   两段回填：适配器**能同时表达** session 日志（`fetchSessionLogSegment`）与 run trace
 *            （`fetchTraceSegment`，按 run_id / per-run seq）。断言"只做阶段一补不回 trace-only"，
 *            "阶段一+二能补回"——不许假接口假装两条都覆盖。
 *
 * 关键契约：三套 seq 空间（session 全局 / run per-run / hub 进程全局）不可混；
 * 跨源去重用**内容稳定 id**（`run_id|type|ts`），绝不能用 seq。
 *
 * 运行：`bun run scripts/check-replay-merge.ts`  退出码 0=PASS，1=FAIL，2=自身错误。
 */
import { replayBudgetUnitsOf, selectReplayBudgetWindow } from '../packages/serve/src/replay-budget';

// ───────────────────────── 最小适配器接口（replay-wire 按此实现） ─────────────────────────
export interface ReplayEvent {
  seq: number;
  type: string;
  run_id?: string;
  ts: number;
}
export interface ReplayCursor {
  last_seq: number;
  derived_upto_seq: number;
}
export interface ReplaySource {
  /** `sessions.get.event_cursor` 的快照。 */
  getCursor(): Promise<ReplayCursor>;
  /** 阶段一：session 日志（`sessions.events`，session 全局 seq）。`sinceSeq` 排他，返回升序页。 */
  fetchSessionLogSegment(sinceSeq: number, limit: number): Promise<ReplayEvent[]>;
  /** 阶段二（可选）：run trace（`events.list`，按 `run_id` 作用域，**per-run seq**）。 */
  fetchTraceSegment?(runId: string, sinceRunSeq: number, limit: number): Promise<ReplayEvent[]>;
  /** 快速路径：环回放（`events.subscribe{since:0}`），已按预算选出，升序。 */
  fetchRingSegment(): Promise<ReplayEvent[]>;
}
export interface ReplaySink {
  /** 幂等合并（按稳定 id 去重），返回 distinct 总数。 */
  apply(events: ReplayEvent[]): number;
  warn(message: string): void;
}
export interface RecoverOptions {
  /** 阶段二要回填的 run 列表；缺省 = **只做阶段一**（session 日志）。 */
  runs?: string[];
}
export interface RecoverResult {
  sessionCalls: number;
  traceCalls: number;
  ringCount: number;
}

/** 跨源稳定 id：三套 seq 空间不可混，必须用内容 id。 */
export function stableEventId(e: ReplayEvent): string {
  return (e.run_id ?? '') + '|' + e.type + '|' + e.ts;
}

const PAGE = 100;

/**
 * 参考回填编排（契约实现；replay-wire 的 src/web 版须与断言一致）。
 * 阶段一 = session 日志；阶段二 = run trace（可选，逐 run）；环 = 快速路径。
 * 全部 fail-open：任一源报错只 warn，不抛、不清空已有数据。
 */
export async function recover(
  source: ReplaySource,
  sink: ReplaySink,
  opts: RecoverOptions = {},
): Promise<RecoverResult> {
  const res: RecoverResult = { sessionCalls: 0, traceCalls: 0, ringCount: 0 };
  let cursor: ReplayCursor;
  try {
    cursor = await source.getCursor();
  } catch (err) {
    sink.warn('getCursor failed, fail-open: ' + String(err));
    return res;
  }

  // 阶段一：session 日志
  let since = cursor.derived_upto_seq;
  for (let guard = 0; guard < 100000 && since < cursor.last_seq; guard += 1) {
    let page: ReplayEvent[];
    try {
      page = await source.fetchSessionLogSegment(since, PAGE);
      res.sessionCalls += 1;
    } catch (err) {
      sink.warn('sessions.events failed/hung, fail-open: ' + String(err));
      break;
    }
    if (page.length === 0) break;
    sink.apply(page);
    const maxSeq = page.reduce((a, e) => Math.max(a, e.seq), since);
    if (maxSeq <= since) break;
    since = maxSeq;
    if (page.length < PAGE) break;
  }

  // 阶段二：run trace（逐 run，per-run seq）
  if (source.fetchTraceSegment !== undefined && opts.runs !== undefined) {
    for (const runId of opts.runs) {
      let rseq = 0;
      for (let guard = 0; guard < 100000; guard += 1) {
        let page: ReplayEvent[];
        try {
          page = await source.fetchTraceSegment(runId, rseq, PAGE);
          res.traceCalls += 1;
        } catch (err) {
          sink.warn('events.list failed for ' + runId + ', fail-open: ' + String(err));
          break;
        }
        if (page.length === 0) break;
        sink.apply(page);
        const maxSeq = page.reduce((a, e) => Math.max(a, e.seq), rseq);
        if (maxSeq <= rseq) break;
        rseq = maxSeq;
        if (page.length < PAGE) break;
      }
    }
  }

  // 快速路径：环
  try {
    const ring = await source.fetchRingSegment();
    res.ringCount = ring.length;
    sink.apply(ring);
  } catch (err) {
    sink.warn('ring replay failed, fail-open: ' + String(err));
  }
  return res;
}

// ───────────────────────────── 测试用假件 ─────────────────────────────
class CollectingSink implements ReplaySink {
  readonly ids = new Set<string>();
  readonly applied: ReplayEvent[] = [];
  readonly dupIds: string[] = [];
  readonly seqs = new Set<number>();
  readonly warnings: string[] = [];
  constructor(seed: ReplayEvent[] = []) {
    for (const e of seed) {
      this.ids.add(stableEventId(e));
      this.applied.push(e);
      this.seqs.add(e.seq);
    }
  }
  apply(events: ReplayEvent[]): number {
    for (const e of events) {
      const id = stableEventId(e);
      if (this.ids.has(id)) {
        this.dupIds.push(id);
      } else {
        this.ids.add(id);
        this.applied.push(e);
        this.seqs.add(e.seq);
      }
    }
    return this.ids.size;
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  get size(): number {
    return this.ids.size;
  }
}

class FakeRpc implements ReplaySource {
  sessionCalls = 0;
  traceCalls = 0;
  throwOnSession = false;
  constructor(
    private readonly events: ReplayEvent[],
    private readonly cursor: ReplayCursor,
    private readonly ring: ReplayEvent[],
    private readonly trace: Map<string, ReplayEvent[]> = new Map(),
  ) {}
  async getCursor(): Promise<ReplayCursor> {
    return this.cursor;
  }
  async fetchSessionLogSegment(sinceSeq: number, limit: number): Promise<ReplayEvent[]> {
    this.sessionCalls += 1;
    if (this.throwOnSession) throw new Error('simulated sessions.events timeout');
    return this.events.filter((e) => e.seq > sinceSeq).slice(0, limit);
  }
  async fetchTraceSegment(
    runId: string,
    sinceRunSeq: number,
    limit: number,
  ): Promise<ReplayEvent[]> {
    this.traceCalls += 1;
    const rows = this.trace.get(runId) ?? [];
    return rows.filter((e) => e.seq > sinceRunSeq).slice(0, limit);
  }
  async fetchRingSegment(): Promise<ReplayEvent[]> {
    return this.ring;
  }
}

function makeSessionEvents(lastSeq: number, derived: number): ReplayEvent[] {
  const out: ReplayEvent[] = [];
  for (let s = 1; s <= lastSeq; s += 1) {
    let type = 'llm.stream.summary';
    if (s === 1) type = 'session.created';
    else if (s === 2) type = 'run.started';
    else if (s === derived) type = 'user.message';
    else if (s % 9 === 0) type = 'tool.call.completed';
    else if (s % 7 === 0) type = 'tool.call.started';
    else if (s % 5 === 0) type = 'llm.response';
    out.push({ seq: s, type, run_id: s >= 2 ? 'run-1' : undefined, ts: 1000 + s });
  }
  return out;
}

const TRACE_ONLY = new Set([
  'hook.started',
  'hook.completed',
  'context.changed',
  'run.checkpoint',
  'runtime.notice',
]);
function isTraceOnly(type: string): boolean {
  return TRACE_ONLY.has(type) || type.startsWith('hook.');
}

/** 用真实 `selectReplayBudgetWindow` 从事件构造环段（chunk 饱和 + 前缀淘汰）。 */
function ringViaBudget(
  events: ReplayEvent[],
  chunksPerStructure: number,
  dropPrefix: number,
): ReplayEvent[] {
  const kept = events.slice(dropPrefix);
  type Tag = { type: string; bytes: number; real: ReplayEvent | null };
  const src: Tag[] = [];
  for (const e of kept) {
    for (let c = 0; c < chunksPerStructure; c += 1) {
      src.push({ type: 'llm.stream.chunk', bytes: 200, real: null });
    }
    src.push({ type: e.type, bytes: JSON.stringify(e).length, real: e });
  }
  const units = replayBudgetUnitsOf(src.map((s) => ({ type: s.type, bytes: s.bytes })));
  const sel = selectReplayBudgetWindow(units);
  const out: ReplayEvent[] = [];
  if (sel.startIndex >= 0) {
    for (let i = sel.startIndex; i < src.length; i += 1) {
      const s = src[i];
      if (s !== undefined && s.real !== null) out.push(s.real);
    }
  }
  return out;
}

// ───────────────────────────── 断言框架 ─────────────────────────────
let checks = 0;
const failures: string[] = [];
function expect(cond: boolean, name: string, detail: string): void {
  checks += 1;
  if (!cond) failures.push(name + ': ' + detail);
}
function oneTo(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

async function main(): Promise<void> {
  const lines: string[] = [];
  lines.push('==================== check-replay-merge (A2/A3/fail-open) ====================');

  // A2-1：derived=4 < last=366，环空（重启）=> 覆盖 [1..366] 零洞，且确实调 RPC。
  {
    const ev = makeSessionEvents(366, 4);
    const seed = ev.filter((e) => e.seq <= 4);
    const sink = new CollectingSink(seed);
    const src = new FakeRpc(ev, { last_seq: 366, derived_upto_seq: 4 }, []);
    await recover(src, sink);
    const holes = oneTo(366).filter((s) => !sink.seqs.has(s));
    expect(
      holes.length === 0,
      'A2.1-hole',
      'uncovered seqs: ' + JSON.stringify(holes.slice(0, 10)),
    );
    expect(
      src.sessionCalls > 0,
      'A2.1-rpc-called',
      'sessions.events must be called, calls=' + src.sessionCalls,
    );
    expect(sink.size === 366, 'A2.1-size', 'distinct=' + sink.size + ' want 366');
    lines.push(
      '[A2.1 restart/empty-ring] covered 1..366 holes=' +
        holes.length +
        ' rpcCalls=' +
        src.sessionCalls +
        ' distinct=' +
        sink.size,
    );
  }

  // A3：磁盘段与环段重叠 => 去重后无重复（总数 == 并集大小）。
  {
    const ev = makeSessionEvents(366, 4);
    const seed = ev.filter((e) => e.seq <= 4);
    const ring = ringViaBudget(ev, 7, 2); // 真实预算选出的后缀，内容与磁盘段重叠
    const sink = new CollectingSink(seed);
    const src = new FakeRpc(ev, { last_seq: 366, derived_upto_seq: 4 }, ring);
    await recover(src, sink);
    const appliedIds = sink.applied.map(stableEventId);
    const appliedUnique = new Set(appliedIds).size;
    expect(ring.length > 0, 'A3-ring-nonempty', 'budget ring must be non-empty');
    expect(sink.size === 366, 'A3-union', 'distinct=' + sink.size + ' want 366 (union)');
    expect(
      appliedUnique === sink.applied.length,
      'A3-nodup',
      'applied has dup ids: ' + (sink.applied.length - appliedUnique),
    );
    expect(
      sink.dupIds.length === ring.length,
      'A3-ring-deduped',
      'ring dups=' + sink.dupIds.length + ' ring=' + ring.length,
    );
    lines.push(
      '[A3 overlap/dedup] ring=' +
        ring.length +
        ' dupIds=' +
        sink.dupIds.length +
        ' distinct=' +
        sink.size +
        ' appliedUnique=' +
        appliedUnique,
    );
  }

  // fail-open：sessions.events 抛错 => 不抛、有警告、已有数据保留。
  {
    const ev = makeSessionEvents(366, 4);
    const seed = ev.filter((e) => e.seq <= 4);
    const ring = ev.filter((e) => e.seq >= 300); // 环提供最近 67 条（不同 seq 空间，但内容同 => 去重）
    const sink = new CollectingSink(seed);
    const src = new FakeRpc(ev, { last_seq: 366, derived_upto_seq: 4 }, ring);
    src.throwOnSession = true;
    let threw = false;
    try {
      await recover(src, sink);
    } catch {
      threw = true;
    }
    expect(threw === false, 'failopen-no-throw', 'recover must not throw');
    expect(sink.warnings.length > 0, 'failopen-warn', 'must emit a warning');
    expect(sink.size === 4 + 67, 'failopen-preserve', 'seed+ring preserved, size=' + sink.size);
    lines.push(
      '[fail-open] threw=' +
        threw +
        ' warnings=' +
        sink.warnings.length +
        ' preserved=' +
        sink.size,
    );
  }

  // 阶段二（trace）：接口能表达两条回填；只做阶段一补不回 trace-only。
  {
    const sessionEv = makeSessionEvents(20, 4);
    const runId = 'run-1';
    const traceEv: ReplayEvent[] = [
      { seq: 1, type: 'run.started', run_id: runId, ts: 5001 },
      { seq: 2, type: 'hook.started', run_id: runId, ts: 5002 },
      { seq: 3, type: 'context.changed', run_id: runId, ts: 5003 },
      { seq: 4, type: 'llm.response', run_id: runId, ts: 5004 },
    ];
    const seed = sessionEv.filter((e) => e.seq <= 4);

    const sinkP1 = new CollectingSink(seed);
    const src1 = new FakeRpc(
      sessionEv,
      { last_seq: 20, derived_upto_seq: 4 },
      [],
      new Map([[runId, traceEv]]),
    );
    await recover(src1, sinkP1); // no opts.runs => phase1 only
    const p1TraceOnly = sinkP1.applied.filter((e) => isTraceOnly(e.type)).length;

    const sinkP2 = new CollectingSink(seed);
    const src2 = new FakeRpc(
      sessionEv,
      { last_seq: 20, derived_upto_seq: 4 },
      [],
      new Map([[runId, traceEv]]),
    );
    await recover(src2, sinkP2, { runs: [runId] });
    const p2TraceOnly = sinkP2.applied.filter((e) => isTraceOnly(e.type)).length;

    expect(
      p1TraceOnly === 0,
      'phase2-p1-no-trace',
      'phase1 alone must not produce trace-only, got ' + p1TraceOnly,
    );
    expect(
      p2TraceOnly >= 2,
      'phase2-p2-trace',
      'phase1+2 must recover trace-only, got ' + p2TraceOnly,
    );
    lines.push(
      '[phase1 vs phase1+2] trace-only recovered: p1=' +
        p1TraceOnly +
        ' p1+2=' +
        p2TraceOnly +
        ' (interface expresses BOTH backfills)',
    );
  }

  lines.push('----------------------------------------------------------');
  lines.push('checks=' + checks + ' failures=' + failures.length);
  for (const f of failures) lines.push('  FAIL ' + f);
  lines.push('result: ' + (failures.length === 0 ? 'PASS' : 'FAIL'));
  lines.push('===========================================================');
  console.log(lines.join('\n'));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('check-replay-merge crashed:', err);
  process.exit(2);
});
