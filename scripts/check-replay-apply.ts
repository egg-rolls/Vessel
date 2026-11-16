#!/usr/bin/env bun
/**
 * check-replay-apply.ts — 单游标 + 单区间回填的行为门（离线、无真服务）。
 *
 * 0.54 B2 起，这个门禁钉的是**新的那一条**读路径（旧的三源补丁已整段删除）：
 *
 * | 组 | 断言 |
 * | --- | --- |
 * | S1 | 一个区间 `[1..N]` 一次并入 ⇒ 游标 = N、条目集合 = 闭区间、item 流 == 整表重建 |
 * | S2 | 幂等：同一区间喂两次 ⇒ 第二次一条不并、item 流逐字不变 |
 * | S3 | 区间起点早于游标（刷新 / 缺口重拉）⇒ 先退游标再升序并入，仍 == 整表重建 |
 * | V1 | **连续性**：中间少一条 ⇒ 不合并、`rule=1`、污点 |
 * | V2 | **count**：声明 40 实收 39 ⇒ 不合并、`rule=2`、污点 |
 * | V3 | **边界**：末条贴不住 `end_seq` ⇒ 不合并、`rule=3`、污点 |
 * | V4 | **重复**：同一 seq 出现两次 ⇒ 不合并、`rule=4`、污点 |
 * | V5 | **游标被篡改三种构造**（+1 / -1 / 落在声明洞里）⇒ 一律拒绝合并并报缺口（ADR-105 §7 A7） |
 * | V6 | 声明洞：`holes` 内的 seq 不期望收到 ⇒ 合并通过、游标推到区间右端、数据面记账 |
 * | T1 | 刷新时有 `tool.call.completed` ⇒ 工具卡不得停在 running / unknown |
 * | T2 | 同一 run 内工具项与思考项按各自 seq 交错（不许「工具全在前、思考全在后」） |
 * | T3 | 项的位置由自己的 seq 决定（不许集体锚到 run 起点 = 用户消息之后） |
 * | T4 | 回放段尾巴 ≤ 之后新到事件的 seq，两段接得上（游标唯一、连续） |
 *
 * 为什么不再有「阶段一 / 阶段二 / 押后 / 内容 id 去重」：那是三套 seq 空间（会话日志 /
 * run trace / 进程内环）的补丁。0.54 只有一个 `timeline_seq`，一段区间、一次校验、
 * 一次折叠 —— 这些用例证明它够用。
 *
 * 运行：`bun run scripts/check-replay-apply.ts`  退出码 0=PASS，1=FAIL，2=自身错误。
 */

import { buildLiveItems, type TranscriptItem } from '../apps/web/src/domains/chat/transcript-items';
import {
  inHoles,
  planBackfill,
  planRange,
  type TimelineCursor,
  type TimelineEvent,
  type TimelineHoleRange,
  type TimelineRangeHeader,
  toRunEvent,
  validateTimelineRange,
} from '../apps/web/src/gateway/timeline-protocol';
import { EventStore } from '../apps/web/src/state/event-store';
import {
  groupEvents,
  producesTimelineItem,
  type RunGroup,
  type StoredEvent,
} from '../apps/web/src/state/events';

const SESSION = 's-b2';
const RUN = 'r-b2';

interface Failure {
  name: string;
  detail: string;
}

const failures: Failure[] = [];

function expect(ok: boolean, name: string, detail: string): boolean {
  if (!ok) failures.push({ name, detail });
  return ok;
}

/** 一段「跑了一半的 run」：思考 / 工具交错，工具都有 completed（刷新时的真实形状）。 */
function midRunEvents(count = 40): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const push = (type: string, data: Record<string, unknown>): void => {
    const seq = events.length + 1;
    events.push({
      seq,
      type,
      run_id: RUN,
      ts: 1000 + seq,
      data: { run_id: RUN, session_id: SESSION, ...data },
    });
  };
  push('run.started', { input: '把这一单做完' });
  push('user.message', { text: '把这一单做完' });
  let round = 0;
  while (events.length < count - 1) {
    round += 1;
    push('llm.stream.chunk', {
      chunk: { type: 'reasoning_delta', delta: `想一想 ${String(round)}.` },
    });
    push('llm.stream.chunk', { chunk: { type: 'text_delta', delta: `第 ${String(round)} 句。` } });
    push('tool.call.started', { call_id: `c${String(round)}`, tool_name: 'bash' });
    push('tool.call.completed', {
      call_id: `c${String(round)}`,
      tool_name: 'bash',
      result: `ok ${String(round)}`,
    });
    push('agent.limit.warning', { round });
  }
  push('run.completed', { output: 'done' });
  return events.slice(0, count).map((event, index) => ({ ...event, seq: index + 1 }));
}

function headerOf(
  events: readonly TimelineEvent[],
  holes: TimelineHoleRange[] = [],
): TimelineRangeHeader {
  const end = events.reduce((top, event) => Math.max(top, event.seq), 0);
  return planRange(1, end, {
    timeline_head: end,
    wal_head: end,
    holes,
    tainted: holes.length > 0,
  });
}

function storeWith(events: readonly TimelineEvent[]): EventStore {
  const store = new EventStore(0);
  store.setScopeSession(SESSION);
  store.applyTimelineRange(headerOf(events), events);
  return store;
}

function groupsOf(store: EventStore): RunGroup[] {
  store.flush();
  return [...store.items.getSnapshot().groups];
}

function rebuild(events: readonly TimelineEvent[]): RunGroup[] {
  // 两侧必须走**同一个** wire → `RunEvent` 转换（`toRunEvent`）：否则重建那侧会多带一个
  // `seq` 字段，比较的是转换差异而不是折叠差异。
  const stored: StoredEvent[] = events.map((event) => ({
    seq: event.seq,
    event: toRunEvent(event),
  }));
  return groupEvents(stored, false, 'user');
}

function itemsOf(groups: readonly RunGroup[]): TranscriptItem[] {
  return buildLiveItems([...groups]);
}

function seqsOf(store: EventStore): number[] {
  // `push` 只排 50ms 合批，快照要显式 flush 才是最新的（与渲染侧同一节拍）。
  store.flush();
  return store.getSnapshot().entries.map((entry) => entry.seq);
}

// ───────────────────────────── S1..S3：区间并入 ─────────────────────────────

function s1OneRange(): void {
  const events = midRunEvents();
  const store = storeWith(events);
  // 环里只留「产 item」的条目（`producesTimelineItem` 是唯一判据，与 `push` 同口径）：
  // 传输噪声（`tool_call_delta` / `finish`）不占额度，也不进环。
  const expected = events.filter((event) => producesTimelineItem(event)).map((event) => event.seq);
  expect(
    JSON.stringify(seqsOf(store)) === JSON.stringify(expected),
    'S1 覆盖',
    `entries ${String(seqsOf(store).length)} 条 != 应入环 ${String(expected.length)} 条`,
  );
  expect(
    store.currentSeq === events.length,
    'S1 游标',
    `游标 ${store.currentSeq} != ${events.length}`,
  );
  expect(
    JSON.stringify(itemsOf(groupsOf(store))) === JSON.stringify(itemsOf(rebuild(events))),
    'S1 item 流',
    '区间并入后的 item 流与整表重建不同',
  );
  expect(store.timelineGap.tainted === false, 'S1 无污点', '干净的区间不该留污点');
}

function s2Idempotent(): void {
  const events = midRunEvents();
  const store = storeWith(events);
  const before = JSON.stringify(itemsOf(groupsOf(store)));
  const entriesBefore = JSON.stringify(seqsOf(store));
  const again = store.applyTimelineRange(headerOf(events), events);
  expect(again.violation === undefined, 'S2 复喂不报缺口', '同一区间第二次不该被当成缺口');
  expect(again.merged === 0, 'S2 一条不并', `第二次并入了 ${String(again.merged)} 条`);
  expect(JSON.stringify(seqsOf(store)) === entriesBefore, 'S2 环不变', '复喂之后环里的条目变了');
  expect(
    JSON.stringify(itemsOf(groupsOf(store))) === before,
    'S2 item 幂等',
    '复喂之后 item 流变了',
  );
}

function s3JoinTail(): void {
  const events = midRunEvents();
  const store = new EventStore(0);
  store.setScopeSession(SESSION);
  // 刷新时环里只有尾部（`push` 是实时路径）：游标先到尾部。
  for (const event of events.slice(24)) store.push(toRunEvent(event), { seq: event.seq });
  const tail = store.currentSeq;
  const outcome = store.applyTimelineRange(headerOf(events), events);
  expect(outcome.violation === undefined, 'S3 不报缺口', '补更早一段不该被当成缺口');
  expect(
    store.currentSeq === events.length,
    'S3 游标',
    `游标 ${store.currentSeq} != ${events.length}`,
  );
  const stored = seqsOf(store);
  expect(stored.includes(tail - 1), 'S3 接上', `更早那一段没有接上（${String(tail)} 之前是空的）`);
  expect(
    JSON.stringify(itemsOf(groupsOf(store))) === JSON.stringify(itemsOf(rebuild(events))),
    'S3 item 流',
    '补上更早一段之后的 item 流与整表重建不同',
  );
}

// ───────────────────────────── V1..V7：四条校验 ─────────────────────────────

function gapOf(
  store: EventStore,
): { rule?: number; expected: string; received: string } | undefined {
  return store.timelineGap.last;
}

function v1Continuity(): void {
  const events = midRunEvents().filter((event) => event.seq !== 20);
  const store = new EventStore(0);
  store.setScopeSession(SESSION);
  const header = { ...headerOf(midRunEvents()), count: 39 };
  const outcome = store.applyTimelineRange(header, events);
  expect(outcome.merged === 0, 'V1 不合并', '连续性校验失败时一条都不许并');
  expect(gapOf(store)?.rule === 1, 'V1 rule', `rule=${String(gapOf(store)?.rule)}（应为 1）`);
  expect(store.timelineGap.tainted, 'V1 污点', '连续性被破坏必须留污点');
  expect(seqsOf(store).length === 0, 'V1 不落库', '校验失败仍改动了 entries');
}

function v2Count(): void {
  const events = midRunEvents();
  const store = new EventStore(0);
  store.setScopeSession(SESSION);
  const header = headerOf(events);
  const outcome = store.applyTimelineRange({ ...header, count: header.count + 1 }, events);
  expect(outcome.merged === 0, 'V2 不合并', 'count 对不上时不许并');
  expect(gapOf(store)?.rule === 2, 'V2 rule', `rule=${String(gapOf(store)?.rule)}（应为 2）`);
}

function v3Bounds(): void {
  const events = midRunEvents().slice(0, 38);
  const store = new EventStore(0);
  store.setScopeSession(SESSION);
  const header = headerOf(midRunEvents());
  const outcome = store.applyTimelineRange(header, events);
  expect(outcome.merged === 0, 'V3 不合并', '末条贴不住 end_seq 时不许并');
  expect(gapOf(store)?.rule === 3, 'V3 rule', `rule=${String(gapOf(store)?.rule)}（应为 3）`);
}

function v4Duplicate(): void {
  const events = midRunEvents();
  const duplicated = [...events, { ...(events[19] as TimelineEvent) }];
  const store = new EventStore(0);
  store.setScopeSession(SESSION);
  const outcome = store.applyTimelineRange(headerOf(events), duplicated);
  expect(outcome.merged === 0, 'V4 不合并', '重复 seq 时不许并');
  expect(gapOf(store)?.rule === 4, 'V4 rule', `rule=${String(gapOf(store)?.rule)}（应为 4）`);
}

/**
 * A7：把**客户端游标**篡改成 +1 / -1 / 落在声明洞里三种构造，客户端必须拒绝合并并报
 * `timeline_gap_reported`（ADR-105 §7 A7）。判据只认 `validateTimelineRange` 的结论与
 * store 的污点，不看「有没有重拉」这种实现动作。
 */
function v5CursorTamper(): void {
  const events = midRunEvents();
  const cursor: TimelineCursor = { timeline_head: 30, wal_head: 40, holes: [], tainted: false };
  // 篡改①：游标 +1（少拉一条）⇒ 区间从 32 起，收到的却是 1..40。
  const plus = planBackfill(cursor, 31);
  expect(plus !== undefined && plus.start_seq === 32, 'V5 构造①', '游标 +1 的区间起点不对');
  const plusGap =
    plus === undefined
      ? undefined
      : validateTimelineRange(
          plus,
          events.map((e) => e.seq),
        );
  expect(plusGap !== undefined && plusGap.rule === 3, 'V5 拒绝①', '游标 +1 未被拒绝（应报边界）');
  // 篡改②：游标 -1（多拉一条）⇒ 区间从 30 起，但首条是 1。
  const minus = planBackfill(cursor, 29);
  expect(minus !== undefined && minus.start_seq === 30, 'V5 构造②', '游标 -1 的区间起点不对');
  const minusGap =
    minus === undefined
      ? undefined
      : validateTimelineRange(
          minus,
          events.map((e) => e.seq),
        );
  expect(minusGap !== undefined, 'V5 拒绝②', '游标 -1 未被拒绝');
  // 篡改③：游标落在声明洞里 ⇒ 该 seq 本来就不该收到；实收里有它 ⇒ 连续性对不上。
  const holed: TimelineCursor = {
    timeline_head: 30,
    wal_head: 40,
    holes: [{ from_seq: 31, to_seq: 33 }],
    tainted: true,
  };
  const inHole = planBackfill(holed, 30);
  expect(inHole !== undefined && inHoles(31, inHole.holes), 'V5 构造③', '声明的洞没进区间头部');
  const holeGap =
    inHole === undefined
      ? undefined
      : validateTimelineRange(
          inHole,
          events.map((e) => e.seq),
        );
  expect(holeGap !== undefined, 'V5 拒绝③', '落在洞内的实收未被拒绝');
  // 三种构造都必须留下可读的 expected / received（不是只喊「有缺口」）。
  for (const gap of [plusGap, minusGap, holeGap]) {
    if (gap === undefined) continue;
    expect(
      gap.expected.length > 0 && gap.received.length > 0,
      'V5 可读',
      '缺口报告缺 expected/received',
    );
  }
}

function v6Holes(): void {
  const all = midRunEvents();
  const holes: TimelineHoleRange[] = [{ from_seq: 10, to_seq: 12 }];
  const events = all.filter((event) => !inHoles(event.seq, holes));
  const store = new EventStore(0);
  store.setScopeSession(SESSION);
  const header = headerOf(all, holes);
  const outcome = store.applyTimelineRange(header, events);
  expect(
    outcome.violation === undefined,
    'V6 洞内不期望',
    `声明的洞被判成缺口：${String(gapOf(store)?.rule)}`,
  );
  const expected = events.filter((event) => producesTimelineItem(event)).length;
  expect(
    outcome.merged === expected,
    'V6 条数',
    `并入 ${String(outcome.merged)} != ${String(expected)}`,
  );
  expect(
    store.currentSeq === all.length,
    'V6 游标',
    `游标 ${store.currentSeq} != ${all.length}（洞不许卡住游标）`,
  );
  expect(store.timelineGap.tainted, 'V6 污点', '有声明洞时必须记账（数据面，不上 UI）');
}

// ─────────────────────── T1..T4：刷新时正在跑的 run ───────────────────────

/** 刷新时正在跑的 run：区间回填 `[1..N]`，随后实时帧从 N+1 续上。 */
function midRunRefresh(tail = 12): { store: EventStore; live: TimelineEvent[] } {
  const events = midRunEvents();
  const store = storeWith(events);
  const live: TimelineEvent[] = [];
  const base = events[events.length - 1] as TimelineEvent;
  for (let index = 1; index <= tail; index += 1) {
    const seq = base.seq + index;
    live.push({
      seq,
      type: index === tail ? 'run.completed' : 'agent.limit.warning',
      run_id: RUN,
      ts: 1000 + seq,
      data: { run_id: RUN, session_id: SESSION, round: index },
    });
    store.push(toRunEvent(live[live.length - 1] as TimelineEvent), { seq });
  }
  return { store, live };
}

function t1ToolStatus(): void {
  const events = midRunEvents();
  const { store } = midRunRefresh();
  const group = groupsOf(store)[0];
  if (group === undefined) {
    expect(false, 'T1 组', '没有 run 组');
    return;
  }
  const completed = new Set(
    events
      .filter((event) => event.type === 'tool.call.completed')
      .map((event) => (event.data as { call_id?: string }).call_id ?? ''),
  );
  for (const item of group.items) {
    if (item.kind !== 'tool') continue;
    const callId = (item as { callId?: string }).callId ?? '';
    if (!completed.has(callId)) continue;
    const status = (item as { status?: string }).status;
    expect(
      status === 'done' || status === 'error',
      'T1 工具卡状态',
      `${callId} 有 completed 却停在 ${String(status)}（刷新时结果状态不许丢）`,
    );
  }
}

/** 内容项（工具 / 思考 / 正文）在 item 流里的顺序，按它们各自的首个事件 seq 计。 */
function contentSeqs(items: readonly TranscriptItem[]): number[] {
  const out: number[] = [];
  for (const item of items) {
    if (item.kind !== 'tool' && item.kind !== 'run-reasoning' && item.kind !== 'run-text') continue;
    const seq = (item as { seq?: number }).seq;
    if (typeof seq === 'number') out.push(seq);
  }
  return out;
}

function t2Interleave(): void {
  const { store } = midRunRefresh();
  const items = itemsOf(groupsOf(store));
  const kinds = items
    .filter((item) => item.kind === 'tool' || item.kind === 'run-reasoning')
    .map((item) => item.kind);
  let runs = 0;
  let previous = '';
  for (const kind of kinds) {
    if (kind !== previous) {
      runs += 1;
      previous = kind;
    }
  }
  // 「工具全在前、思考全在后」= 2 段。夹具里两者交替 ⇒ 段数必须远大于 2。
  expect(runs >= 4, 'T2 交错', `工具 / 思考只有 ${String(runs)} 段（聚堆了）`);
  const tools = kinds.filter((kind) => kind === 'tool').length;
  const reasoning = kinds.filter((kind) => kind === 'run-reasoning').length;
  expect(
    tools > 0 && reasoning > 0,
    'T2 两类都在',
    `工具 ${String(tools)} / 思考 ${String(reasoning)}`,
  );
}

function t3OwnSeq(): void {
  const { store } = midRunRefresh();
  const items = itemsOf(groupsOf(store));
  const seqs = contentSeqs(items);
  expect(seqs.length > 0, 'T3 有锚点', '内容项一个都没有 seq 锚点');
  let ascending = true;
  for (let index = 1; index < seqs.length; index += 1) {
    if ((seqs[index] ?? 0) < (seqs[index - 1] ?? 0)) ascending = false;
  }
  expect(ascending, 'T3 升序', `内容项 seq 不是升序：${seqs.join(',')}`);
  // 「集体锚到 run 起点」的机械判据：所有内容项的锚点 seq 全等 ⇒ 一定是被 run 起点接管了。
  expect(new Set(seqs).size > 1, 'T3 各自为政', '所有内容项锚在同一个 seq（= run 起点）');
}

function t4SegmentsJoin(): void {
  const events = midRunEvents();
  const { store, live } = midRunRefresh();
  const last = live[live.length - 1] as TimelineEvent;
  expect(
    store.currentSeq === last.seq,
    'T4 游标',
    `游标 ${store.currentSeq} != 实时末条 ${last.seq}`,
  );
  const stored = seqsOf(store);
  const tailOfRange = events[events.length - 1]?.seq ?? 0;
  expect(
    stored.includes(tailOfRange) && stored.includes(tailOfRange + 1),
    'T4 接得上',
    `回放段尾巴 ${String(tailOfRange)} 与之后第一条没有相邻`,
  );
  let contiguous = true;
  for (let index = 1; index < stored.length; index += 1) {
    if ((stored[index] ?? 0) !== (stored[index - 1] ?? 0) + 1) contiguous = false;
  }
  expect(contiguous, 'T4 无洞', '回放段与实时段之间有洞');
}

// ───────────────────────────────── main ─────────────────────────────────

function main(): void {
  s1OneRange();
  s2Idempotent();
  s3JoinTail();
  v1Continuity();
  v2Count();
  v3Bounds();
  v4Duplicate();
  v5CursorTamper();
  v6Holes();
  t1ToolStatus();
  t2Interleave();
  t3OwnSeq();
  t4SegmentsJoin();

  if (failures.length === 0) {
    console.log('单游标区间回填：S1–S3 / V1–V6 / T1–T4 全过');
    return;
  }
  for (const failure of failures) {
    console.log(`FAIL [${failure.name}] ${failure.detail}`);
  }
  console.log(`FAIL：${String(failures.length)} 条`);
  process.exit(1);
}

main();
