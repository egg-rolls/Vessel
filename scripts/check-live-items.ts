#!/usr/bin/env bun

/**
 * 实时 item 流门禁：**增量折叠 ⇄ 从全量事件重建** 两路对拍（DESIGN.md §9）。
 *
 * 核心 oracle（唯一判据，不写死期望值）：
 *   给同一批事件 S（同 seq、同 data）
 *     路径 R（rebuild）：groupEvents(S)          —— 一次性从全量事件重建
 *     路径 L（live）   ：逐条 push 进 EventStore  —— 增量折叠（渲染侧的输入源）
 *   断言 JSON.stringify(R) === JSON.stringify(L)（RunGroup 全字段 + item 顺序 / 内容），
 *   以及 buildLiveItems(R) 与 buildLiveItems(L) 逐字相等。
 *
 * 为什么这条 oracle 有意义：R 一次看全量；L 是逐步的，还要经过去重水位、噪声过滤、
 * 缓冲裁剪、回填重折叠。oracle 钉的是「这些记账不改变输出」。它同时覆盖「重连后重建」
 * 与「实时增量」两条路（DESIGN.md §5.1 / §9.1）。
 *
 * 断言口径（防「改期望就过」）：
 * - 只允许「两路互比」或「key / 数量」这类结构性判据；不写死 item 文本或 key 字面量
 *   （那等于把期望抄一遍，改期望就绿了）；
 * - 改 fixture 必须与改实现**同一个 commit**（fixture 跟着实现一起漂 = 门禁坏了）。
 *
 * 覆盖（§9.2 里与阶段 1/2 相关的部分）：
 *   G-A 增量 == 重建（基本流：分段正文 / 思考 / 工具 / notice / hook 对 / 终态）
 *   G-B **缓冲裁剪不得让 item 消失**（用户诉求 #1；改动前红灯 R1）
 *   G-C 回放幂等（hello 重放整段；改动前红灯 R2：结尾正文重复）
 *   G-D 回放边界落在段内部（正文逐字相等；R2 的最小形态）
 *   G-E 乱序回填（freeze → 按 run 重折叠 → 锚点合并 Rule R）
 *   G-G run.completed 撤回失败卡（增量化最容易漏的一条）
 *   G-I 可见性切换重折叠幂等（重折叠必须等于「一开始就是这个口径」）
 *   G-J 一次工具调用恰好一张 tool:<callId>（不再出 ev-<seq> 原始事件行）
 *   G-K 超上限不许有 item 凭空消失（折叠覆盖数守恒 + overBudget 不静默）
 *   T1  渲染侧不读 EventStore.entries（I1 的文件级 tripwire）
 *
 * 用法：bun run scripts/check-live-items.ts
 * 退出码：0 = 全过；1 = 有 FAIL（失败打印两路差异，便于定位）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { buildLiveItems, type TranscriptItem } from '../apps/web/src/domains/chat/transcript-items';
import type { RunEvent } from '../apps/web/src/gateway/types';
import { EventStore } from '../apps/web/src/state/event-store';
import { groupEvents, type RunGroup, type StoredEvent } from '../apps/web/src/state/events';
import type { ItemStoreSnapshot } from '../apps/web/src/state/live-items';

type EvSpec = readonly [type: string, data?: Record<string, unknown>];

/** 一批事件 → wire 条目（seq = 下标 + 1，ts = 1000 + seq）。 */
function eventsOf(specs: readonly EvSpec[], runId: string): StoredEvent[] {
  return specs.map(([type, data], index) => {
    const seq = index + 1;
    const event: RunEvent = {
      type,
      run_id: runId,
      ts: 1000 + seq,
      // `data.run_id` 与 `run_id` 一致才算 run 事件（见 events.ts 的 hasRunEvent）。
      data: { run_id: runId, session_id: 's1', ...(data ?? {}) },
    };
    return { seq, event };
  });
}

const text = (delta: string): EvSpec => [
  'llm.stream.chunk',
  { chunk: { type: 'text_delta', delta } },
];
const reasoning = (delta: string): EvSpec => [
  'llm.stream.chunk',
  { chunk: { type: 'reasoning_delta', delta } },
];
const toolStarted = (callId: string, name = 'bash'): EvSpec => [
  'tool.call.started',
  { tool_call_id: callId, tool_name: name, arguments: { cmd: 'ls' } },
];
const toolCompleted = (callId: string, result = 'ok'): EvSpec => [
  'tool.call.completed',
  { call_id: callId, tool_call_id: callId, tool_name: 'bash', result, duration_ms: 7 },
];

/** 路径 R：从全量事件一次性重建（纯函数；`groupEvents` 就是 fold 的整表入口）。 */
function rebuild(events: readonly StoredEvent[]): RunGroup[] {
  return groupEvents(events, false, 'user');
}

function feed(store: EventStore, events: readonly StoredEvent[]): void {
  for (const entry of events) store.push(entry.event, { seq: entry.seq });
}

/**
 * 路径 L：EventStore 是传输面的唯一入口（`push`）；这里取渲染侧的输入 ——
 * **物化之后的 item 流**（`store.items`），不再是环里的 entries。
 */
function groupsFromStore(store: EventStore): RunGroup[] {
  store.flush();
  return [...store.items.getSnapshot().groups];
}

function live(events: readonly StoredEvent[]): RunGroup[] {
  const store = new EventStore(0);
  feed(store, events);
  return groupsFromStore(store);
}

/** 物化面快照（先 flush 到同一节拍再取）。 */
function itemSnapshotOf(store: EventStore): ItemStoreSnapshot {
  store.flush();
  return store.items.getSnapshot();
}

function itemsOf(groups: readonly RunGroup[]): TranscriptItem[] {
  return buildLiveItems(groups);
}

/** 正文段拼起来（回放幂等 / 段内边界断言的「正文逐字」判据）。 */
function textOf(items: readonly TranscriptItem[]): string {
  return items
    .filter((item) => item.kind === 'run-text')
    .map((item) => item.text)
    .join('');
}

function clip(value: string): string {
  return value.length <= 600 ? value : `${value.slice(0, 600)}…`;
}

/** 两路互比：null = 逐字相等；否则返回差异描述。 */
function sameJson(label: string, a: unknown, b: unknown): string | null {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left === right) return null;
  return `${label} 两路不一致\n    live    = ${clip(left)}\n    rebuild = ${clip(right)}`;
}

interface Fixture {
  name: string;
  why: string;
  check: () => string | null;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'G-A 增量 == 重建（基本流：分段正文 / 思考 / 工具 / notice / hook 对 / 终态）',
    why: '两条路径的记账不同（一次看全量 vs 逐步折叠）：输出必须逐字相等，否则终态一到就整段重排',
    check: () => {
      const events = eventsOf(
        [
          ['run.started', { input: '帮我跑一下 tsc' }],
          text('第一段'),
          text('继续'),
          reasoning('先看类型'),
          reasoning('再看引用'),
          text('第一段结束'),
          toolStarted('c1'),
          toolCompleted('c1'),
          text('第二段'),
          reasoning('收个尾'),
          ['agent.limit.warning', { percent: 0.72 }],
          text('第三段'),
          ['hook.started', { hook_name: 'guard' }],
          ['hook.completed', { hook_name: 'guard', duration_ms: 3 }],
          ['run.completed', { output: '第一段结束第二段第三段', duration_ms: 1200, iterations: 2 }],
        ],
        'r-a',
      );
      const liveGroups = live(events);
      const rebuilt = rebuild(events);
      return (
        sameJson('RunGroup', liveGroups, rebuilt) ??
        sameJson('TranscriptItem', itemsOf(liveGroups), itemsOf(rebuilt))
      );
    },
  },
  {
    name: 'G-B 缓冲裁剪不得让 item 消失（改动前红灯 R1）',
    why: '用户诉求 #1：环裁剪只是传输面的事，屏幕上已经显示的卡片不该跟着删（I4）',
    check: () => {
      const specs: EvSpec[] = [['run.started', { input: 'go' }]];
      for (let index = 0; index < 30; index += 1) {
        specs.push(['agent.limit.warning', { round: index }]);
      }
      specs.push(['run.completed', { output: 'done' }]);
      const events = eventsOf(specs, 'r-b');
      const store = new EventStore(0);
      feed(store, events);
      const before = itemsOf(groupsFromStore(store)).length;
      // 模拟环形缓冲把头部裁掉（真实路径是按 per-run 上限逐条丢，见 G-B2）。
      store.truncateAfter(11);
      const after = itemsOf(groupsFromStore(store));
      const rebuilt = itemsOf(rebuild(events));
      if (after.length !== rebuilt.length) {
        return `裁剪让 item 消失了：裁剪前 ${before} 项 / 裁剪后 ${after.length} 项 / 重建 ${rebuilt.length} 项`;
      }
      return sameJson('裁剪后的 item 流', groupsFromStore(store), rebuild(events));
    },
  },
  {
    name: 'G-B2 按 per-run 上限裁剪同样不得减 item（R1 的真实路径）',
    why: '真实触发是 delta 洪水把该 run 的额度吃满后逐条丢最旧的非锚点条目（不是 truncateAfter）',
    check: () => {
      const specs: EvSpec[] = [['run.started', { input: 'go' }]];
      for (let index = 0; index < 30; index += 1) {
        specs.push(['agent.limit.warning', { round: index }]);
      }
      specs.push(['run.completed', { output: 'done' }]);
      const events = eventsOf(specs, 'r-b2');
      const store = new EventStore(0, { maxEventsPerRun: 12 });
      feed(store, events);
      const items = itemsOf(groupsFromStore(store));
      const rebuilt = itemsOf(rebuild(events));
      if (items.length !== rebuilt.length) {
        return `per-run 上限裁剪让 item 变少：${items.length} 项 / 重建 ${rebuilt.length} 项`;
      }
      return sameJson('per-run 上限裁剪后的 item 流', groupsFromStore(store), rebuild(events));
    },
  },
  {
    name: 'G-C 回放幂等（hello 重放整段，改动前红灯 R2）',
    why: '重连 / hello 会把窗口内的事件重新送一遍：同 seq 只能生效一次，正文不许出现两遍',
    check: () => {
      const specs: EvSpec[] = [['run.started', { input: '写一段长回答' }]];
      for (let index = 0; index < 10; index += 1) specs.push(text(`第${index + 1}句`));
      specs.push(['run.completed', { output: '结束' }]);
      const events = eventsOf(specs, 'r-c');
      const single = live(events);
      const store = new EventStore(0);
      feed(store, events);
      // hello 的游标回退（from_seq - 1）之后重放整段尾部。
      store.truncateAfter(3);
      feed(store, events.slice(3));
      const replayed = groupsFromStore(store);
      const singleText = textOf(itemsOf(single));
      const replayedText = textOf(itemsOf(replayed));
      if (singleText !== replayedText) {
        return `重放后正文变了\n    single   = ${singleText}\n    replayed = ${replayedText}`;
      }
      return sameJson('重放后的 item 流', replayed, single);
    },
  },
  {
    name: 'G-D 回放边界落在段内部（正文逐字相等，R2 的最小形态）',
    why: '合并条目只在 seq 上留首条时，truncateAfter 按条目 seq 判去留会把边界判进条目内部 —— 重放就把尾巴又拼一遍',
    check: () => {
      const specs: EvSpec[] = [['run.started', { input: 'go' }]];
      for (let index = 0; index < 20; index += 1) specs.push(text(`t${index}`));
      specs.push(toolStarted('c1'), toolCompleted('c1'), ['run.completed', { output: 'go' }]);
      const events = eventsOf(specs, 'r-d');
      const single = live(events);
      const store = new EventStore(0);
      feed(store, events);
      // 边界落在正文段中间：重放从第 16 条开始。
      store.truncateAfter(15);
      feed(store, events.slice(15));
      const replayed = groupsFromStore(store);
      const expected = textOf(itemsOf(single));
      const actual = textOf(itemsOf(replayed));
      if (actual !== expected) {
        return `边界落在段内部时正文被重复 / 丢失\n    expected = ${expected}\n    actual   = ${actual}`;
      }
      return sameJson('重放后的 item 流', replayed, single);
    },
  },
  {
    name: 'G-E 乱序回填（freeze → 按 run 重折叠 → 锚点合并 Rule R）',
    why: '回填页是新→旧到达的：重折叠必须让「更早的内容长出来」而不是把已经上屏的内容缩回去（§5.2）',
    check: () => {
      const specs: EvSpec[] = [['run.started', { input: 'go' }]];
      for (let index = 0; index < 8; index += 1) specs.push(text(`a${index}`));
      specs.push(
        toolStarted('c1'),
        toolCompleted('c1'),
        ['agent.limit.warning', { round: 1 }],
        text('尾巴'),
        ['run.completed', { output: 'done' }],
      );
      const events = eventsOf(specs, 'r-e');
      const rebuilt = rebuild(events);
      const rebuiltItems = itemsOf(rebuilt);
      // ① 尾部先到（更早的分页还在路上）；之后 freeze → 回填全量 → endBackfill 重折叠。
      const store = new EventStore(0);
      feed(store, events.slice(9));
      store.beginBackfill(0);
      feed(store, events);
      store.endBackfill();
      const afterBackfill = groupsFromStore(store);
      const mismatch = sameJson('回填后的 item 流', afterBackfill, rebuilt);
      if (mismatch !== null) return mismatch;
      // ② 同一个 run 再被冻结 / 重折叠（环内容不变）：必须原样，不许缩回。
      const before = itemsOf(afterBackfill).length;
      store.beginBackfill(store.currentSeq);
      store.endBackfill();
      const after = itemsOf(groupsFromStore(store));
      if (after.length !== before) return `重折叠让 item 少了：${before} → ${after.length}`;
      const rebuiltKeys = rebuiltItems.map((item) => item.key);
      const liveKeys = after.map((item) => item.key);
      if (rebuiltKeys.some((key) => !liveKeys.includes(key))) {
        return `重折叠丢了重建路径有的 item：${rebuiltKeys.filter((k) => !liveKeys.includes(k)).join(',')}`;
      }
      return null;
    },
  },
  {
    name: 'G-E2 回填时环已淘汰更早的事件 → 保留项仍在（Rule R 的「保留」）',
    why: '环只覆盖尾部时重折叠复现不出更早的 notice / 段：它们必须由旧 item 保住（宁可重复，绝不吞内容）',
    check: () => {
      const specs: EvSpec[] = [['run.started', { input: 'go' }]];
      for (let index = 0; index < 12; index += 1) {
        specs.push(['agent.limit.warning', { round: index }]);
      }
      specs.push(text('尾巴'), ['run.completed', { output: 'done' }]);
      const events = eventsOf(specs, 'r-e2');
      const store = new EventStore(0, { maxEventsPerRun: 8 });
      // 环里只剩尾部（锚点保留），item 侧这时是完整的。
      feed(store, events);
      const before = itemsOf(groupsFromStore(store)).map((item) => item.key);
      const rebuiltKeys = itemsOf(rebuild(events)).map((item) => item.key);
      // 被迫重折叠（回填结束）：环里已经取不到更早的 notice，它们只能来自 Rule R 的保留。
      store.beginBackfill(store.currentSeq);
      store.endBackfill();
      const after = itemsOf(groupsFromStore(store)).map((item) => item.key);
      const lost = before.filter((key) => !after.includes(key));
      if (lost.length > 0) return `回填丢失了已经上屏的 item：${lost.join(',')}`;
      const lostRebuilt = rebuiltKeys.filter((key) => !after.includes(key));
      if (lostRebuilt.length > 0) {
        return `回填丢失了重建路径有的 item（Rule R 保留失效）：${lostRebuilt.join(',')}`;
      }
      return null;
    },
  },
  {
    name: 'G-G run.completed 撤回失败卡',
    why: '同一 run 可能先收到误判的 run.failed（session-liveness），随后正常 completed：增量化若忘了撤回就留一张幽灵失败卡',
    check: () => {
      const failureKey = 'run:r-g:failure';
      const failed = eventsOf(
        [
          ['run.started', { input: 'go' }],
          ['run.failed', { error: 'run lost', error_code: 'run_lost', retryable: true }],
        ],
        'r-g',
      );
      const store = new EventStore(0);
      feed(store, failed);
      const failedItems = itemsOf(groupsFromStore(store));
      if (!failedItems.some((item) => item.key === failureKey)) {
        return 'run.failed 之后时间线上没有失败卡';
      }
      const completed = eventsOf(
        [
          ['run.started', { input: 'go' }],
          ['run.failed', { error: 'run lost', error_code: 'run_lost', retryable: true }],
          ['run.completed', { output: 'ok' }],
        ],
        'r-g',
      );
      feed(store, completed.slice(failed.length));
      const doneItems = itemsOf(groupsFromStore(store));
      if (doneItems.some((item) => item.key === failureKey)) {
        return 'run.completed 之后失败卡还在（幽灵失败卡：已经成功了却显示失败）';
      }
      return sameJson('终态后的 item 流', groupsFromStore(store), rebuild(completed));
    },
  },
  {
    name: 'G-J 一次工具调用恰好一张 tool:<callId>（不出 ev-<seq> 原始事件行）',
    why: 'tool.call.* 在 fold 里就地配对（started 建卡、completed / failed 改状态）；原始事件行归 Observe / 运行详情，不许再进时间线',
    check: () => {
      const events = eventsOf(
        [
          ['run.started', { input: 'go' }],
          toolStarted('c1'),
          text('中间正文'),
          toolCompleted('c1'),
          toolStarted('c2'),
          ['tool.call.failed', { tool_call_id: 'c2', tool_name: 'bash', error: 'boom' }],
          ['run.completed', { output: 'ok' }],
        ],
        'r-j',
      );
      const items = itemsOf(rebuild(events));
      const cards = items.filter((item) => item.kind === 'tool');
      if (cards.length !== 2) return `工具卡数量 ${cards.length} != 2 次调用（配对必须一对一）`;
      if (!cards.every((item) => item.key === 'tool:c1' || item.key === 'tool:c2')) {
        return `工具卡身份不是 tool:<callId>：${cards.map((item) => item.key).join(',')}`;
      }
      const rawRows = items.filter((item) => item.key.includes('ev-'));
      if (rawRows.length > 0) {
        return `时间线上出现了原始事件行：${rawRows.map((item) => item.key).join(',')}`;
      }
      return null;
    },
  },
  {
    name: 'G-I 可见性切换重折叠幂等（showInternal false → true）',
    why: 'internal / observe 档事件在 fold 之前就被过滤，等于「不构成段边界」：口径一变段边界就变，重折叠必须等于「一开始就是这个口径」',
    check: () => {
      const events = eventsOf(
        [
          ['run.started', { input: 'go' }],
          text('a'),
          ['context.pressure', { percent: 0.8 }],
          text('b'),
          ['hook.started', { hook_name: 'guard' }],
          ['hook.completed', { hook_name: 'guard', duration_ms: 2 }],
          ['guardrail.error', { error: 'boom' }],
          ['run.completed', { output: 'ab' }],
        ],
        'r-i',
      );
      const store = new EventStore(0);
      feed(store, events);
      // 默认档（隐藏 internal）先落一版，并与「一开始就隐藏」逐字相等。
      const hiddenMismatch = sameJson(
        '默认档的 item 流',
        groupsFromStore(store),
        groupEvents(events, false, 'user'),
      );
      if (hiddenMismatch !== null) return hiddenMismatch;
      // 展开内部事件：store 必须重折叠（不是增量的近似）。
      store.setItemVisibility(true, 'user');
      return sameJson(
        'showInternal 切换后的 item 流',
        groupsFromStore(store),
        groupEvents(events, true, 'user'),
      );
    },
  },
  {
    name: 'G-K 超上限不许有 item 凭空消失（折叠覆盖数守恒）',
    why: '上限只能把「更旧的」折成一张带条数的折叠卡（可点进运行详情），不允许静默丢（I9）',
    check: () => {
      const specs: EvSpec[] = [['run.started', { input: 'go' }]];
      for (let index = 0; index < 60; index += 1) {
        specs.push(['agent.limit.warning', { round: index }]);
      }
      specs.push(['run.completed', { output: 'done' }]);
      const events = eventsOf(specs, 'r-k');
      // 基准：不触发上限时 item 总数（含 run 输入那一项）。
      const plain = itemsOf(rebuild(events)).length;
      // ① 每 run 上限极小：折成一张卡，条数必须守恒（现存 + 覆盖 == 全量）。
      const capped = new EventStore(0, { maxItemsPerRun: 8, maxItemsTotal: 1000 });
      feed(capped, events);
      const cappedSnapshot = itemSnapshotOf(capped);
      const cappedItems = itemsOf(cappedSnapshot.groups);
      const cards = cappedItems.filter(
        (item) => item.kind === 'notice' && item.event.type === 'vessel.ui.condensed',
      );
      if (cards.length !== 1) return `折叠卡数量 ${cards.length}（同一 run 只该有一张）`;
      const covered = coveredCount(cards);
      const restored = cappedItems.length - 1 + covered;
      if (restored !== plain) {
        return `折叠覆盖数不守恒：现存 ${cappedItems.length} - 折叠卡 1 + 覆盖 ${covered} = ${restored} != 全量 ${plain}`;
      }
      if (cappedSnapshot.overBudget) return '预算内不该置 overBudget（那会让提示钩子常亮）';
      if (cappedSnapshot.stats.condensed !== covered) {
        return `stats.condensed(${cappedSnapshot.stats.condensed}) != 折叠卡覆盖数(${covered})`;
      }
      // ② 预算不可能满足（总量上限 4）：必须置 overBudget，但**仍然**不许凭空丢 item。
      const tight = new EventStore(0, { maxItemsPerRun: 8, maxItemsTotal: 4 });
      feed(tight, events);
      const tightSnapshot = itemSnapshotOf(tight);
      const tightItems = itemsOf(tightSnapshot.groups);
      const tightCards = tightItems.filter(
        (item) => item.kind === 'notice' && item.event.type === 'vessel.ui.condensed',
      );
      const tightRestored = tightItems.length - tightCards.length + coveredCount(tightCards);
      if (tightRestored !== plain) {
        return `收紧预算后 item 消失了：现存 ${tightItems.length} + 覆盖 ${coveredCount(tightCards)} != 全量 ${plain}`;
      }
      if (!tightSnapshot.overBudget) return '预算无法满足时必须置 overBudget（不许静默）';
      return null;
    },
  },
  {
    name: 'T1 渲染侧不读 EventStore.entries（I1 tripwire）',
    why: '时间线只读物化后的 item 流：`domains/chat/**` 不许再按 entries 批量分组，也不许再 import 已弃用的 group-cache；`snapshot.entries` 的每处用法必须标注为传输面消费者',
    check: () => {
      const webSrc = join(import.meta.dir, '..', 'apps', 'web', 'src');
      const chatDir = join('domains', 'chat');
      const allowBatchGroup = new Set(['SubagentTranscript.tsx']);
      const problems: string[] = [];
      for (const file of walk(webSrc)) {
        if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
        const path = relative(webSrc, file);
        const source = readFileSync(file, 'utf8');
        // I1-a：生产代码不许再引用按 entries 分组的旧缓存。
        if (path !== join('state', 'group-cache.ts') && source.includes('group-cache')) {
          problems.push(`${path}: 仍引用 group-cache（渲染侧必须读 LiveItemStore）`);
        }
        // I1-b：会话域不许再「从事件批量分组」。
        if (
          path.startsWith(chatDir + sep) &&
          !allowBatchGroup.has(basenameOf(path)) &&
          (source.includes('groupEvents(') || source.includes('buildGroup('))
        ) {
          problems.push(`${path}: 仍从事件批量分组（groupEvents / buildGroup）`);
        }
      }
      // I1-c：`snapshot.entries` 的每一处用法都要显式标注传输面消费者。
      const transcriptHook = readFileSync(
        join(webSrc, 'domains', 'chat', 'useChatTranscript.ts'),
        'utf8',
      ).split('\n');
      transcriptHook.forEach((line, index) => {
        if (!line.includes('.entries')) return;
        // 注释里提到 `snapshot.entries` 不算用法（这里只查真实代码行）。
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        const window = transcriptHook.slice(Math.max(0, index - 2), index + 1).join('\n');
        if (!window.includes('transport-consumer')) {
          problems.push(`useChatTranscript.ts:${index + 1}: 读了 .entries 却没有 transport-consumer 标注`);
        }
      });
      return problems.length > 0 ? problems.join('\n    ') : null;
    },
  },
];

/** 折叠卡覆盖的 item 条数之和（`vessel.ui.condensed` 的 `data.count`）。 */
function coveredCount(items: readonly TranscriptItem[]): number {
  let total = 0;
  for (const item of items) {
    if (item.kind !== 'notice') continue;
    if (item.event.type !== 'vessel.ui.condensed') continue;
    const count = item.event.data.count;
    if (typeof count === 'number') total += count;
  }
  return total;
}

function basenameOf(path: string): string {
  const parts = path.split(sep);
  return parts[parts.length - 1] ?? path;
}

/** 递归列出目录下的文件（门禁级的 tripwire 用，不引第三方）。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const failures: { name: string; why: string; detail: string }[] = [];
for (const fixture of FIXTURES) {
  let detail: string | null = null;
  try {
    detail = fixture.check();
  } catch (error) {
    detail = `抛出异常：${error instanceof Error ? error.message : String(error)}`;
  }
  if (detail !== null) failures.push({ name: fixture.name, why: fixture.why, detail });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`FAIL ${failure.name}`);
    console.log(`     why: ${failure.why}`);
    console.log(`     ${failure.detail}`);
  }
  console.error(`live items: ${failures.length}/${FIXTURES.length} fixture(s) FAILED`);
  process.exit(1);
}

console.log(`live items: ${FIXTURES.length} fixtures passed`);
