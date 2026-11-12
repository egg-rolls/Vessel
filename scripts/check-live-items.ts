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
 *   G-A  增量 == 重建（基本流：分段正文 / 思考 / 工具 / notice / hook 对 / 终态）
 *   G-B  增量 == 重建（长 run + per-run 上限裁剪；用户诉求 #1，改动前红灯 R1）
 *   G-B2 环被 truncateAfter 裁剪（游标回退）同样不得减 item
 *   G-C  回放幂等（hello 重放整段；改动前红灯 R2：结尾正文重复）
 *   G-D  回放边界落在段内部（正文逐字相等；R2 的最小形态）
 *   G-E  乱序回填（freeze → 按 run 重折叠 → 锚点合并 Rule R）
 *   G-E2 回填时环已淘汰更早的事件 → Rule R 的「保留」仍在
 *   G-G  run.completed 撤回失败卡（增量化最容易漏的一条）
 *   G-H  每 run 上限折叠可见（折叠卡条数 == 被折条数，最近 10 项仍在）
 *   G-I  可见性切换重折叠幂等（重折叠必须等于「一开始就是这个口径」）
 *   G-J  一次工具调用恰好一张 tool:<callId>（running → done → error 就地更新，不出 ev- 行）
 *   G-K  总量硬上界不删内容（四档折不动时只置 stats.overBudget，不许静默）
 *   G-F  历史先到不重复（§4.3 时序 C/D：key 序列 == 只有 history）
 *   G-F2 认领粘性（live 内容增长 / 改写不让已成立的认领失效）
 *   G-F3 认领失败计数可读（diagnostics 取数面 + 两边都渲染）
 *   G-L  交棒释放：屏幕零变化 + 幂等
 *   G-L2 没有替身的 item 永不释放（notice / ev 行 / 失败卡）
 *   G-L3 内存不随轮数线性增长（N 轮之后 live item 的数量上界）
 *   G-L4 已交棒 run 的残留折叠（§8.2 档 3：折成一张卡，不静默）
 *   T1   渲染侧不读 EventStore.entries（I1 的文件级 tripwire）
 *
 * 用法：bun run scripts/check-live-items.ts
 * 退出码：0 = 全过；1 = 有 FAIL（失败打印两路差异，便于定位）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  buildHistoryIndex,
  buildLiveItems,
  buildTranscriptItems,
  type ClaimDecision,
  ClaimLedger,
  claimRunFactsOf,
  type TranscriptItem,
} from '../apps/web/src/domains/chat/transcript-items';
import type { RunEvent } from '../apps/web/src/gateway/types';
import type { Message } from '../apps/web/src/gateway/types/sessions';
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

// ── 认领 / 交棒 fixture 的公共脚手架（历史消息 + 账本判定 + 屏幕 key 序列） ──

/** 一条已落盘的消息（只填 fixture 需要的字段）。 */
function msg(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { role, content, ...extra };
}

/** 历史侧的「调用 + 结果」一对消息（让 `tool:<callId>` 在历史里有同一张卡）。 */
function callPair(callId: string, name = 'bash', output = 'ok', ts = 1100): Message[] {
  return [
    msg('assistant', '', {
      timestamp: ts,
      tool_calls: [{ id: callId, type: 'function', function: { name, arguments: '{}' } }],
    }),
    msg('tool', output, { tool_call_id: callId, timestamp: ts + 1 }),
  ];
}

/** 账本判定（装配面的同一段调用：身份 = 会话 + 纪元 + 历史窗口）。 */
function decideClaims(
  groups: readonly RunGroup[],
  messages: readonly Message[],
  options: { detailReady?: boolean; failureRunId?: string; ledger?: ClaimLedger } = {},
): { history: ReturnType<typeof buildHistoryIndex>; decision: ClaimDecision; ledger: ClaimLedger } {
  const history = buildHistoryIndex(messages, 0);
  const ledger = options.ledger ?? new ClaimLedger();
  const decision = ledger.decide(
    { sessionId: 's1', epoch: 1, history },
    {
      history,
      facts: claimRunFactsOf(groups),
      detailReady: options.detailReady ?? true,
      ...(options.failureRunId !== undefined ? { failureRunId: options.failureRunId } : {}),
    },
  );
  return { history, decision, ledger };
}

/** 屏幕上那一帧的最终列表（带认领结论；等价于装配面 give 给渲染的 item 流）。 */
function screenItems(
  groups: readonly RunGroup[],
  messages: readonly Message[],
  history: ReturnType<typeof buildHistoryIndex>,
  decision: ClaimDecision,
  sessionFailure?: Parameters<typeof buildTranscriptItems>[0]['sessionFailure'],
): TranscriptItem[] {
  return buildTranscriptItems({
    messages,
    messageIndexOffset: 0,
    liveGroups: groups,
    historyIndex: { ...history, claims: decision },
    ...(sessionFailure !== undefined ? { sessionFailure } : {}),
  });
}

/** 屏幕上的 key 序列（同上，只要 key）。 */
function screenKeys(
  groups: readonly RunGroup[],
  messages: readonly Message[],
  history: ReturnType<typeof buildHistoryIndex>,
  decision: ClaimDecision,
  sessionFailure?: Parameters<typeof buildTranscriptItems>[0]['sessionFailure'],
): string[] {
  return screenItems(groups, messages, history, decision, sessionFailure).map((item) => item.key);
}

/** 物化面里还剩多少条 item（交棒释放的可观测面：`fold.itemCount` 之和）。 */
function liveItemCount(groups: readonly RunGroup[]): number {
  return groups.reduce((total, group) => total + group.items.length, 0);
}

/** 物化面里还剩多少条**正文 / 思考段**（交棒唯一能删的那一类 item）。 */
function segmentItemCount(groups: readonly RunGroup[]): number {
  let total = 0;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.kind === 'text' || item.kind === 'reasoning') total += 1;
    }
  }
  return total;
}

/** 物化面里还剩多少条**内容**项（正文 / 思考 / 工具卡）。 */
function contentItemCount(groups: readonly RunGroup[]): number {
  let total = 0;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.kind === 'text' || item.kind === 'reasoning' || item.kind === 'tool') total += 1;
    }
  }
  return total;
}

/** 布尔断言 → fixture 的 `string | null` 约定（迁入的 F 组 fixture 用，措辞保持原样）。 */
function expect(label: string, ok: boolean): string | null {
  return ok ? null : `${label}：断言不成立`;
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
          // 「模型上下文」卡（`prompt.system_context`）：增量折叠与全量重建都必须出同一个
          // item、同一个 key（key 锚事件 seq）—— 刷新后的回放靠这条路径。
          [
            'prompt.system_context',
            {
              hash: '0123456789abcdef',
              system_prompt: 'BASE SYSTEM',
              self_card: '[Self Card]\nrole: r-a',
              model: 'test-model',
              message_count: 2,
              tools_count: 1,
              estimated_tokens: 1200,
            },
          ],
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
    name: 'G-B 增量 == 重建（长 run + per-run 上限裁剪，R1 转绿）',
    why: '用户诉求 #1：环裁剪只是传输面的事，屏上已显示的 item 一条都不该少（I4）',
    check: () => {
      const specs: EvSpec[] = [['run.started', { input: 'go' }]];
      for (let index = 0; index < 40; index += 1) {
        specs.push(text(`段${index}`), ['agent.limit.warning', { round: index }]);
      }
      specs.push(['run.completed', { output: 'done' }]);
      const events = eventsOf(specs, 'r-b');
      // 真实路径：delta 洪水把该 run 的额度吃满后逐条丢最旧的非锚点条目。
      const store = new EventStore(0, { maxEventsPerRun: 20 });
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
    name: 'G-B2 环被 truncateAfter 裁剪同样不得减 item',
    why: 'per-run 上限之外的另一条裁剪路径（hello / gap 的游标回退）也不许动 item（I6）',
    check: () => {
      const specs: EvSpec[] = [['run.started', { input: 'go' }]];
      for (let index = 0; index < 30; index += 1) {
        specs.push(['agent.limit.warning', { round: index }]);
      }
      specs.push(['run.completed', { output: 'done' }]);
      const events = eventsOf(specs, 'r-b2');
      const store = new EventStore(0);
      feed(store, events);
      const before = itemsOf(groupsFromStore(store)).length;
      store.truncateAfter(11);
      const after = itemsOf(groupsFromStore(store));
      const rebuilt = itemsOf(rebuild(events));
      if (after.length !== rebuilt.length) {
        return `truncateAfter 让 item 消失了：裁剪前 ${before} 项 / 裁剪后 ${after.length} 项 / 重建 ${rebuilt.length} 项`;
      }
      return sameJson('游标回退后的 item 流', groupsFromStore(store), rebuild(events));
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
    name: 'G-J 工具调用只出一张卡、不出原始事件行（running → done → error 就地更新）',
    why: 'tool.call.* 配对下沉进 fold：一次调用恰好 1 个 tool:<callId> item；原始事件行归 Observe / 运行详情',
    check: () => {
      const events = eventsOf(
        [
          ['run.started', { input: 'go' }],
          toolStarted('c1'),
          toolCompleted('c1'),
          // 同一 callId 再来一条终态（重复 / 迟到）：只许更新既有那张卡，不许新开一张。
          ['tool.call.failed', { tool_call_id: 'c1', tool_name: 'bash', error: 'boom' }],
          ['run.completed', { output: 'ok' }],
        ],
        'r-j',
      );
      const store = new EventStore(0);
      const steps: string[] = [];
      for (const entry of events) {
        store.push(entry.event, { seq: entry.seq });
        store.flush();
        const items = itemsOf(store.items.getSnapshot().groups);
        const cards = items.filter((item) => item.kind === 'tool');
        if (cards.length > 1) {
          return `第 ${entry.seq} 步出现了 ${cards.length} 张工具卡（一次调用只许一张）`;
        }
        const card = cards[0];
        steps.push(`${cards.length}:${card?.key ?? '-'}:${card?.status ?? '-'}`);
      }
      const expected = [
        '0:-:-',
        '1:tool:c1:running',
        '1:tool:c1:done',
        '1:tool:c1:error',
        '1:tool:c1:error',
      ];
      if (steps.join(' | ') !== expected.join(' | ')) {
        return `工具卡状态序列不对\n    expected = ${expected.join(' | ')}\n    actual   = ${steps.join(' | ')}`;
      }
      const finalItems = itemsOf(store.items.getSnapshot().groups);
      const rawRows = finalItems.filter((item) => item.key.includes('ev-'));
      if (rawRows.length > 0) {
        return `时间线上出现了原始事件行：${rawRows.map((item) => item.key).join(',')}`;
      }
      return sameJson('工具卡 item 流', store.items.getSnapshot().groups, rebuild(events));
    },
  },
  {
    name: 'G-H 每 run 上限折叠可见（maxItemsPerRun: 10 + 40 notice）',
    why: '超过上限只能折成一张带条数的折叠卡（保留最近 10 项）：条数必须等于被折条数，最近项仍在（I9）',
    check: () => {
      const specs: EvSpec[] = [['run.started', { input: 'go' }]];
      for (let index = 0; index < 40; index += 1) {
        specs.push(['agent.limit.warning', { round: index }]);
      }
      specs.push(['run.completed', { output: 'done' }]);
      const events = eventsOf(specs, 'r-h');
      const store = new EventStore(0, { maxItemsPerRun: 10 });
      feed(store, events);
      const snapshot = itemSnapshotOf(store);
      const items = itemsOf(snapshot.groups);
      const cards = items.filter(
        (item) => item.kind === 'notice' && item.event.type === 'vessel.ui.condensed',
      );
      if (cards.length !== 1) return `折叠卡数量 ${cards.length}（同一 run 只该有一张）`;
      const notices = items.filter(
        (item) => item.kind === 'notice' && item.event.type === 'agent.limit.warning',
      );
      if (notices.length !== 10) return `保留的最近项数 ${notices.length} != 10`;
      const covered = coveredCount(cards);
      if (covered !== 40 - notices.length) {
        return `折叠卡条数 ${covered} != 被折条数 ${40 - notices.length}`;
      }
      // 最近 10 项仍在：notice 的 seq 是 2..41，最后 10 个必须是 32..41。
      const keys = new Set(items.map((item) => item.key));
      for (let seq = 32; seq <= 41; seq += 1) {
        if (!keys.has(`notice:notice-${seq}`))
          return `最近项 notice-${seq} 不见了（最近 10 项必须保留）`;
      }
      if (snapshot.stats.condensed !== covered) {
        return `stats.condensed(${snapshot.stats.condensed}) != 折叠卡覆盖数(${covered})`;
      }
      if (snapshot.stats.overBudget) return '每 run 上限内不该置 overBudget';
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
    name: 'G-K 总量硬上界不删内容（stats.overBudget 不许静默）',
    why: '四档触发顺序的最后两档：折无可折时只能置 overBudget，任何 item 都不许凭空消失（I9）',
    check: () => {
      const makeEvents = (runId: string, count: number): StoredEvent[] => {
        const specs: EvSpec[] = [['run.started', { input: 'go' }]];
        for (let index = 0; index < count; index += 1) {
          specs.push(['agent.limit.warning', { round: index }]);
        }
        specs.push(['run.completed', { output: 'done' }]);
        return eventsOf(specs, runId);
      };
      // ① 12 个 notice、总量上限 5（设计 §9.2 的造法）：折无可折 → 只置 overBudget，
      //    内容一条不少（全部保留）。
      const small = makeEvents('r-k1', 12);
      const plainSmall = itemsOf(rebuild(small)).length;
      const tight = new EventStore(0, { maxItemsTotal: 5 });
      feed(tight, small);
      const tightSnapshot = itemSnapshotOf(tight);
      const tightItems = itemsOf(tightSnapshot.groups);
      const tightCards = tightItems.filter(
        (item) => item.kind === 'notice' && item.event.type === 'vessel.ui.condensed',
      );
      const tightRestored = tightItems.length - tightCards.length + coveredCount(tightCards);
      if (tightRestored !== plainSmall) {
        return `总量超限后 item 消失了：现存 ${tightItems.length} + 覆盖 ${coveredCount(tightCards)} != 全量 ${plainSmall}`;
      }
      if (!tightSnapshot.stats.overBudget) return '折无可折时必须置 stats.overBudget（不许静默）';
      // ② 30 个 notice、总量上限 5：第 1 档（最旧的已终态 run）先加大折叠到 20 项，
      //    仍超 → overBudget；现存 + 折叠卡覆盖数仍然守恒。
      const big = makeEvents('r-k2', 30);
      const plainBig = itemsOf(rebuild(big)).length;
      const capped = new EventStore(0, { maxItemsTotal: 5 });
      feed(capped, big);
      const cappedSnapshot = itemSnapshotOf(capped);
      const cappedItems = itemsOf(cappedSnapshot.groups);
      const cards = cappedItems.filter(
        (item) => item.kind === 'notice' && item.event.type === 'vessel.ui.condensed',
      );
      const restored = cappedItems.length - cards.length + coveredCount(cards);
      if (restored !== plainBig) {
        return `总量折叠后 item 消失了：现存 ${cappedItems.length} + 覆盖 ${coveredCount(cards)} != 全量 ${plainBig}`;
      }
      if (coveredCount(cards) === 0) return '终态 run 该先加大折叠（第 1 档），这里一条都没折';
      if (cappedSnapshot.stats.condensed !== coveredCount(cards)) {
        return `stats.condensed(${cappedSnapshot.stats.condensed}) != 折叠卡覆盖数(${coveredCount(cards)})`;
      }
      if (!cappedSnapshot.stats.overBudget) return '折完仍超限时必须置 stats.overBudget';
      return null;
    },
  },
  {
    name: 'G-F 历史先到不重复（§4.3 时序 C/D：key 序列 == 只有 history）',
    why: '刷新 / 回放时 detail 先到、事件后到：该 run 的内容项必须在进入 item 流之前就被判为已交棒，屏上不许出现两份',
    check: () => {
      const events = eventsOf(
        [
          ['run.started', { input: 'q1' }],
          text('回答'),
          text('一二'),
          ['run.completed', { output: '回答一二' }],
        ],
        'r-f',
      );
      const store = new EventStore(0);
      feed(store, events);
      const groups = groupsFromStore(store);
      const messages = [
        msg('user', 'q1', { timestamp: 1000 }),
        msg('assistant', '回答一二', { timestamp: 1100 }),
      ];
      const { history, decision } = decideClaims(groups, messages);
      const merged = screenKeys(groups, messages, history, decision);
      const historyOnly = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
      }).map((item) => item.key);
      const mismatch = sameJson('key 序列（live + history vs 只有 history）', merged, historyOnly);
      if (mismatch !== null) return mismatch;
      // 计数可读（diagnostics）：这一组内容全部认领成功，不该记失败。
      if (decision.stats.userMisses !== 0 || decision.stats.assistantMisses !== 0) {
        return `认领失败计数不该 > 0（user ${decision.stats.userMisses} / assistant ${decision.stats.assistantMisses}）`;
      }
      if (decision.yieldedAnchors.size === 0) return '正文段没有让位（历史那份已经在渲染它）';
      return null;
    },
  },
  {
    name: 'G-F2 认领粘性：live 内容继续增长（guardrail 改写）不让已成立的认领失效',
    why: '每帧按内容重算认领会抖动（改写后内容不等 → 认领失败 → 两份）；账本一次判定后粘住，只随历史窗口 / 新 run 失效',
    check: () => {
      const events = eventsOf(
        [['run.started', { input: 'q1' }], text('回复'), ['run.completed', { output: '回复' }]],
        'r-f2',
      );
      const store = new EventStore(0);
      feed(store, events);
      const original = groupsFromStore(store);
      const messages = [
        msg('user', 'q1', { timestamp: 1000 }),
        msg('assistant', '回复', { timestamp: 1100 }),
      ];
      const history = buildHistoryIndex(messages, 0);
      const ledger = new ClaimLedger();
      const identity = { sessionId: 's1', epoch: 1, history };
      const first = ledger.decide(identity, {
        history,
        facts: claimRunFactsOf(original),
        detailReady: true,
      });
      // live 内容被改写（同一 run / 同一历史窗口 = 同一身份）：结论必须原样复用。
      const group = original[0];
      if (group === undefined) return '没有 live 分组';
      const grown: RunGroup = {
        ...group,
        output: '改写后的回复',
        items: group.items.map((item) =>
          item.kind === 'text' ? { ...item, text: '改写后的回复' } : item,
        ),
      };
      const second = ledger.decide(identity, {
        history,
        facts: claimRunFactsOf([grown]),
        detailReady: true,
      });
      if (second !== first) return '同一身份下的重判改动了结论（粘性必须直接复用，不许重算）';
      const sticky = screenKeys([grown], messages, history, second);
      const historyOnly = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
      }).map((item) => item.key);
      const mismatch = sameJson('粘住之后的 key 序列（vs 只有 history）', sticky, historyOnly);
      if (mismatch !== null) return mismatch;
      // 对照：没有账本的一次性判定在同一份（改写后的）内容上会丢掉让位 → 屏上多一份正文。
      const withoutLedger = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [grown],
      });
      if (!withoutLedger.some((item) => item.kind === 'run-text')) {
        return '对照失败：一次性判定本该在改写后失去认领（说明这条 fixture 没有测到粘性）';
      }
      return null;
    },
  },
  {
    name: 'G-F3 认领失败计数可读（guardrail 改写 → 两边都渲染 + 计数）',
    why: '「位置认领要不要打开」取决于重复的量级；这个计数是唯一的取数面（diagnostics），必须真的会动',
    check: () => {
      const events = eventsOf(
        [
          ['run.started', { input: '被改写过的输入' }],
          text('答复'),
          ['run.completed', { output: '完全不同的输出' }],
        ],
        'r-f3',
      );
      const store = new EventStore(0);
      feed(store, events);
      const groups = groupsFromStore(store);
      const messages = [
        msg('user', '原始输入', { timestamp: 1000 }),
        msg('assistant', '落盘答复', { timestamp: 1100 }),
      ];
      const { history, decision } = decideClaims(groups, messages);
      if (decision.stats.userMisses === 0) return '输入认领失败没有计数（diagnostics 取不到数）';
      if (decision.stats.assistantMisses === 0) return '输出认领失败没有计数';
      // 方向不变（I8）：认领失败时 live 与 history 都渲染，绝不吞内容。
      const keys = screenKeys(groups, messages, history, decision);
      if (!keys.includes('msg:0')) return '历史消息被吞了';
      if (!keys.includes('run:r-f3:input')) return 'live 输入被吞了（认领失败时必须两份都渲染）';
      return null;
    },
  },
  {
    name: 'G-L 交棒释放：屏幕零变化（交棒前后的 key 序列完全相同）',
    why: '释放内存的全部理由是「历史那份已经在渲染」：删掉重复的那一份不许让屏上少一条、也不许多一条',
    check: () => {
      const events = eventsOf(
        [
          ['run.started', { input: 'q1' }],
          text('回复'),
          toolStarted('c1'),
          toolCompleted('c1'),
          ['run.completed', { output: '回复' }],
        ],
        'r-l',
      );
      const store = new EventStore(0);
      feed(store, events);
      const before = groupsFromStore(store);
      const messages = [
        msg('user', 'q1', { timestamp: 1000 }),
        msg('assistant', '回复', { timestamp: 1100 }),
        ...callPair('c1', 'bash', 'ok', 1200),
      ];
      const { history, decision } = decideClaims(before, messages);
      const request = decision.handover.get('r-l');
      if (request === undefined) return '终态且历史完全覆盖的 run 没有进交棒清单';
      if (request.segments.length === 0) return '正文段没有交棒（它已经让位给历史了）';
      // 屏幕（整条 item，不只 key）：交棒前后必须逐字相等。
      const itemsBefore = screenItems(before, messages, history, decision);
      const liveBefore = liveItemCount(before);
      store.items.release(decision.handover);
      const snapshot = itemSnapshotOf(store);
      const after = [...snapshot.groups];
      const itemsAfter = screenItems(after, messages, history, decision);
      if (snapshot.stats.released === 0) return '交棒没有移出任何 item（内存没动）';
      if (liveItemCount(after) >= liveBefore) {
        return `交棒后 item 数没减少：${liveBefore} → ${liveItemCount(after)}`;
      }
      // 零变化的强判据：**整个 item 的 JSON 逐字相等**（ts / 字段 / 顺序都不许变）。
      const mismatch = sameJson('交棒前后的屏幕 item 流', itemsAfter, itemsBefore);
      if (mismatch !== null) return mismatch;
      // 工具卡没有替身（执行态历史侧不复现）→ 它必须还在 live 里，且**一个字段都没变**。
      if (!itemsAfter.some((item) => item.kind === 'tool' && item.key === 'tool:c1')) {
        return '工具卡从屏幕上消失了（它不该被交棒）';
      }
      // 交棒记录是持久的：再交一次同样的清单必须幂等（不多删、不多计）。
      store.items.release(decision.handover);
      const again = [...itemSnapshotOf(store).groups];
      if (liveItemCount(again) !== liveItemCount(after)) return '重复交棒又删掉了 item（不幂等）';
      if (itemSnapshotOf(store).stats.released !== snapshot.stats.released) {
        return '重复交棒重复计数（stats.released 不是幂等的）';
      }
      return sameJson(
        '幂等交棒后的 item 流',
        screenItems(again, messages, history, decision),
        itemsBefore,
      );
    },
  },
  {
    name: 'G-L2 没有替身的 item 永不释放（notice / ev 行 / 失败卡）',
    why: '交棒只许删「历史确实会渲染」的那三种 item：运行过程行与失败卡删了就是吞内容（I8 / I9）',
    check: () => {
      // ① 终态 run 的 notice 行：正文让位、notice 没有替身 → 只删正文那一份。
      const noticeEvents = eventsOf(
        [
          ['run.started', { input: 'q1' }],
          text('回复'),
          ['agent.limit.warning', { percent: 0.8 }],
          ['run.completed', { output: '回复' }],
        ],
        'r-l2a',
      );
      const storeA = new EventStore(0);
      feed(storeA, noticeEvents);
      const groupsA = groupsFromStore(storeA);
      const messagesA = [
        msg('user', 'q1', { timestamp: 1000 }),
        msg('assistant', '回复', { timestamp: 1100 }),
      ];
      const a = decideClaims(groupsA, messagesA);
      const reviewA = a.decision.handover.get('r-l2a');
      if (reviewA === undefined) return 'notice run 没有进交棒清单';
      storeA.items.release(a.decision.handover);
      const afterA = [...itemSnapshotOf(storeA).groups];
      const notices = itemsOf(afterA).filter((item) => item.key.startsWith('notice:'));
      if (notices.length !== 1) return `notice 行被交棒删了（应剩 1 条，实际 ${notices.length}）`;
      if (contentItemCount(afterA) !== 0) return '内容项没有交棒干净';

      // ② failed 的 run：会话快照不能提供同一张卡时**一件都不许交棒**。
      const failedEvents = eventsOf(
        [
          ['run.started', { input: 'q2' }],
          text('半截回复'),
          ['run.failed', { error: 'boom', error_code: 'rate_limited' }],
        ],
        'r-l2b',
      );
      const storeB = new EventStore(0);
      feed(storeB, failedEvents);
      const groupsB = groupsFromStore(storeB);
      const messagesB = [
        msg('user', 'q2', { timestamp: 1000 }),
        msg('assistant', '半截回复', { timestamp: 1100 }),
      ];
      const withoutSnapshot = decideClaims(groupsB, messagesB);
      if (withoutSnapshot.decision.handover.has('r-l2b')) {
        return '失败卡没有替身（会话快照对不上）却交棒了 —— 失败可能永远看不见';
      }
      // ③ failed 的 run + 会话快照提供同一张卡（同 runId / 同 key）：允许交棒，
      //    但**失败卡本身仍然在**（它不在 items 里，由 group.status 派生）。
      const withSnapshot = decideClaims(groupsB, messagesB, { failureRunId: 'r-l2b' });
      if (!withSnapshot.decision.handover.has('r-l2b')) {
        return '会话快照能提供同一张卡时应当允许交棒';
      }
      storeB.items.release(withSnapshot.decision.handover);
      const afterB = [...itemSnapshotOf(storeB).groups];
      const failureKey = 'run:r-l2b:failure';
      if (!itemsOf(afterB).some((item) => item.key === failureKey)) {
        return '失败卡被交棒删掉了（失败必须永远可见）';
      }
      return null;
    },
  },
  {
    name: 'G-L3 内存不随轮数线性增长（N 轮之后 live item 的数量上界）',
    why: '交棒的意义就是「已落盘的内容交给历史」：跑过的轮数越多，live 里剩的越只有「无替身行 + 执行态卡片」，而不是线性累加正文',
    check: () => {
      const ROUNDS = 6;
      const store = new EventStore(0);
      const messages: Message[] = [];
      const allEvents: StoredEvent[] = [];
      let seq = 0;
      const push = (runId: string, type: string, data: Record<string, unknown>): void => {
        seq += 1;
        const event: RunEvent = { type, run_id: runId, ts: 900 + seq, data };
        allEvents.push({ seq, event });
        store.push(event, { seq });
      };
      let segmentsEverHeld = 0;
      for (let round = 0; round < ROUNDS; round += 1) {
        const runId = `r-n${round}`;
        const callId = `c${round}`;
        // 每轮两段正文（中间夹一次工具调用 → 两段）：段数随轮数线性增长，正是要交棒的东西。
        // 正文要够长（>= 8 字符）：认领的强证据是「run 输出包含这条消息正文」。
        const first = `先答第一段正文内容第${round}轮`;
        const second = `再答第二段正文内容第${round}轮`;
        push(runId, 'run.started', { run_id: runId, session_id: 's1', input: `q${round}` });
        push(runId, 'llm.stream.chunk', {
          run_id: runId,
          chunk: { type: 'text_delta', delta: first },
        });
        push(runId, 'tool.call.started', {
          run_id: runId,
          tool_call_id: callId,
          tool_name: 'bash',
          arguments: {},
        });
        push(runId, 'tool.call.completed', {
          run_id: runId,
          tool_call_id: callId,
          tool_name: 'bash',
          result: 'ok',
          duration_ms: 1,
        });
        push(runId, 'llm.stream.chunk', {
          run_id: runId,
          chunk: { type: 'text_delta', delta: second },
        });
        push(runId, 'agent.limit.warning', { run_id: runId, round });
        push(runId, 'run.completed', { run_id: runId, output: first + second });
        const base = 1000 + round * 10;
        messages.push(
          msg('user', `q${round}`, { timestamp: base }),
          msg('assistant', first, { timestamp: base + 1 }),
          msg('assistant', '', {
            timestamp: base + 2,
            tool_calls: [
              { id: callId, type: 'function', function: { name: 'bash', arguments: '{}' } },
            ],
          }),
          msg('tool', 'ok', { tool_call_id: callId, timestamp: base + 3 }),
          msg('assistant', second, { timestamp: base + 4 }),
        );
        const groups = groupsFromStore(store);
        segmentsEverHeld += segmentItemCount(groups);
        const { decision } = decideClaims(groups, messages);
        store.items.release(decision.handover);
      }
      const snapshot = itemSnapshotOf(store);
      const groups = [...snapshot.groups];
      // ① 正文 / 思考段一条不剩（不是丢掉：它们仍在历史里）。
      if (segmentItemCount(groups) !== 0) {
        return `还有 ${segmentItemCount(groups)} 条正文/思考段留在 live 里（应全部交给历史）`;
      }
      // ② live 里只剩「每轮恒定的两张」：无替身的 notice + 带执行态的工具卡。
      //    与轮数线性相关的是这两张的**每轮固定开销**，不是正文内容量。
      if (liveItemCount(groups) !== ROUNDS * 2) {
        return `live item 数 ${liveItemCount(groups)} != ${ROUNDS * 2}（上界 = Σ 每轮无替身行 + 执行态卡）`;
      }
      // ③ 释放是「转移」不是「丢」：累计交棒条数 = 曾经持有的段数。
      if (snapshot.stats.released !== segmentsEverHeld) {
        return `stats.released(${snapshot.stats.released}) != 曾持有的段数(${segmentsEverHeld})`;
      }
      if (snapshot.stats.releasedRuns !== ROUNDS) {
        return `stats.releasedRuns(${snapshot.stats.releasedRuns}) != ${ROUNDS}`;
      }
      // ④ 守恒：屏幕上的条数 == 从全量事件重建出来的条数（少一条都是丢内容）。
      const history = buildHistoryIndex(messages, 0);
      const { decision } = decideClaims(groups, messages);
      const screen = screenItems(groups, messages, history, decision).length;
      const full = itemsOf(rebuild(allEvents)).length;
      if (screen !== full) return `屏幕 ${screen} 条 != 全量 ${full} 条`;
      return null;
    },
  },
  {
    name: 'G-L4 已交棒 run 的残留折叠（§8.2 档 3：折成一张卡，不静默）',
    why: '已交棒的 run 只剩运行过程行：总量再超限时把它们折成一张带条数的卡（可见、可进运行详情），绝不静默删',
    check: () => {
      const events = eventsOf(
        [
          ['run.started', { input: 'q1' }],
          text('回复'),
          ['run.completed', { output: '回复' }],
          ...[...Array(30)].map((_, index) => ['agent.limit.warning', { round: index }] as EvSpec),
        ],
        'r-l4',
      );
      const fullItems = itemsOf(rebuild(events)).length;
      const store = new EventStore(0, { maxItemsTotal: 5 });
      const messages = [
        msg('user', 'q1', { timestamp: 1000 }),
        msg('assistant', '回复', { timestamp: 1100 }),
      ];
      // ① 先交棒（run 已终态、内容项交给历史），② 再灌 30 条运行过程行触发总量上限。
      feed(store, events.slice(0, 3));
      const early = groupsFromStore(store);
      const earlyClaims = decideClaims(early, messages);
      store.items.release(earlyClaims.decision.handover);
      feed(store, events.slice(3));
      const groups = groupsFromStore(store);
      const { decision } = decideClaims(groups, messages);
      store.items.release(decision.handover);
      const snapshot = itemSnapshotOf(store);
      const items = itemsOf(snapshot.groups);
      const cards = items.filter(
        (item) => item.kind === 'notice' && item.event.type === 'vessel.ui.condensed',
      );
      if (cards.length !== 1) return `折叠卡数量 ${cards.length}（同一 run 只该有一张）`;
      // 守恒：现存 + 折叠卡覆盖 + 已交棒 == 全量（一条都不许凭空消失）。
      const restored = items.length - cards.length + coveredCount(cards) + snapshot.stats.released;
      if (restored !== fullItems) {
        return `交棒 + 折叠之后内容消失了：现存 ${items.length} + 覆盖 ${coveredCount(cards)} + 交棒 ${snapshot.stats.released} != 全量 ${fullItems}`;
      }
      if (snapshot.stats.overBudget) return '档 3 折完之后仍置 overBudget（说明残留没被折掉）';
      return null;
    },
  },
  {
    name: 'G-M 段序身份（0.51）：段序来自 fold 的计数器，交棒删掉前一段后后面那段仍是第 1 段',
    why: '身份认领拿「本 run 内第几段正文」去对落盘消息的 run_segment。若段序从 items 下标反推，交棒 / 折叠删掉第 0 段后，第 1 段会变成 0 号 ⇒ 认领会拿它去对另一条落盘正文，把 live 这一段永久藏起来（唯一不可恢复的方向）',
    check: () => {
      const events = eventsOf(
        [
          ['run.started', { input: 'q1' }],
          text('第一段'),
          // 工具事件把第一段 flush 成 item，第二段才有自己的段号。
          toolStarted('c1'),
          toolCompleted('c1'),
          text('第二段'),
          ['run.completed', { output: '第一段第二段' }],
        ],
        'r-m',
      );
      const store = new EventStore(0);
      feed(store, events);
      const before = buildLiveItems(groupsFromStore(store)).filter(
        (item) => item.kind === 'run-text',
      );
      const indexes = before.map((item) => (item.kind === 'run-text' ? item.segmentIndex : -1));
      if (indexes.join(',') !== '0,1') return `段序 ${indexes.join(',')}（应为 0,1）`;
      // 交棒删掉第 0 段（模拟「这一段已经由历史负责」），第 1 段的身份必须不变。
      const firstAnchor = before[0]?.anchorSeq;
      if (firstAnchor === undefined) return '第一段没有段锚点（无法交棒）';
      store.items.release(new Map([['r-m', { segments: [firstAnchor] }]]));
      const after = buildLiveItems(groupsFromStore(store)).filter(
        (item) => item.kind === 'run-text',
      );
      if (after.length !== 1) return `交棒后正文段 ${after.length} 条（应为 1）`;
      const remaining = after[0];
      if (remaining === undefined || remaining.kind !== 'run-text') return '剩余段不是正文段';
      if (remaining.text !== '第二段') return `剩余段正文是「${remaining.text}」（应为第二段）`;
      if (remaining.segmentIndex !== 1) {
        return `交棒后段序 ${String(remaining.segmentIndex)}（应仍为 1：段序由计数器给，不看 items 下标）`;
      }
      // 未 flush 的尾巴也带段序：它的段号 = flush 之后会拿到的那个号。
      const partialStore = new EventStore(0);
      feed(partialStore, eventsOf([['run.started', { input: 'q2' }], text('尾巴')], 'r-m2'));
      const tailGroup = groupsFromStore(partialStore)[0];
      if (tailGroup === undefined) return '尾巴分组缺失';
      if (tailGroup.liveTextSegmentIndex !== 0) {
        return `尾巴段序 ${String(tailGroup.liveTextSegmentIndex)}（应为 0）`;
      }
      return null;
    },
  },
  {
    name: 'F16（迁入）长 run（数千 delta、3 段思考、多轮工具）→ 所有 reasoning 段都在且有序',
    why: 'per-run 上限按 delta 计数会把最早的 thinking 段整段挤出（真实 run 177 轮 / 70k tokens）：迁入后由 I4（环裁剪不动 item）守，且与「从全量事件重建」逐字对拍',
    check: () => {
      const specs: EvSpec[] = [['run.started', { input: 'go' }]];
      for (let round = 0; round < 3; round += 1) {
        // 每段思考 1200 个 delta：旧上限（2000/run）下第二段起就会挤掉前面的段。
        for (let index = 0; index < 1200; index += 1) specs.push(reasoning('x'));
        specs.push(toolStarted(`c${round}`), toolCompleted(`c${round}`));
      }
      const events = eventsOf(specs, 'r-long');
      // 真实路径：delta 洪水把该 run 的环额度（2000 条）吃满、锚点之外的条目逐条被裁。
      const store = new EventStore(0);
      feed(store, events);
      const groups = groupsFromStore(store);
      const items = buildLiveItems(groups);
      const reasoningItems = items.filter((item) => item.kind === 'run-reasoning');
      const tools = items.filter((item) => item.kind === 'tool');
      if (reasoningItems.length !== 3) return `思考段 ${reasoningItems.length} 条（应为 3）`;
      if (tools.length !== 3) return `工具卡 ${tools.length} 张（应为 3）`;
      const anchors: number[] = reasoningItems.map((item) => item.anchorSeq ?? -1);
      const ascending = anchors.every((anchor, index) => {
        const previous = anchors[index - 1];
        return previous === undefined || previous < anchor;
      });
      if (!ascending) return `思考段顺序不对：${anchors.join(',')}`;
      return sameJson('长 run 的 item 流（增量 vs 重建）', groups, rebuild(events));
    },
  },
  {
    name: 'F21（迁入）失败卡落位：run 有正文/工具后 run.failed → run:<runId>:failure 是该 run 最后一个 item',
    why: '失败此前只活在 RunItems（子 agent 面板）里；位置若缺 ts 或取错时刻，卡会沉到会话底部或排到本轮正文之上',
    check: () => {
      const events = eventsOf(
        [
          ['run.started', { input: 'go' }],
          text('half answer'),
          toolStarted('c1'),
          toolCompleted('c1'),
          // run.failed 是第 5 条 → ts = 1005（本 fixture 断言的就是这个终态时刻）。
          [
            'run.failed',
            {
              error: 'provider 429: rate limited',
              error_code: 'rate_limited',
              category: 'provider',
              phase: 'llm',
              retryable: true,
              duration_ms: 2500,
            },
          ],
        ],
        'r-fail',
      );
      const store = new EventStore(0);
      feed(store, events);
      const items = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: groupsFromStore(store),
      });
      const cards = items.filter((item) => item.kind === 'run-failure');
      const card = cards[0];
      return expect(
        '失败卡落位',
        cards.length === 1 &&
          card !== undefined &&
          card.kind === 'run-failure' &&
          card.key === 'run:r-fail:failure' &&
          card.source === 'event' &&
          card.error === 'provider 429: rate limited' &&
          card.errorMeta?.code === 'rate_limited' &&
          card.errorMeta?.retryable === true &&
          // 终态时刻（run.failed 的 ts），不是 undefined —— 后者会被规则「缺 ts 排最后」沉底。
          card.ts === 1005 &&
          // 该 run 的最后一个 item：输入 → 正文 → 工具卡 → 失败卡。
          items.map((item) => item.key).join(',') ===
            'run:r-fail:input,run:r-fail:text:2,tool:c1,run:r-fail:failure',
      );
    },
  },
  {
    name: 'F22（迁入）快照来源与去重：只有会话快照也出卡；同 run 只一张；failed 后 completed 不出卡',
    why: '历史消息不带失败信息、事件缓冲有界（刷新 / 切会话后 run.failed 可能已不在回放窗口）；两个来源共用 run:<runId>:failure，不许出两张卡',
    check: () => {
      const snapshot = {
        runId: 'r-old',
        sessionId: 's1',
        error: 'boom',
        completedAt: 2000,
        source: 'session' as const,
      };
      // (a) 只有会话快照：缓冲里没有这个 run 的任何分组。
      const onlySnapshot = buildTranscriptItems({
        messages: [
          msg('user', 'q1', { timestamp: 1000 }),
          msg('assistant', 'a1', { timestamp: 1500 }),
        ],
        messageIndexOffset: 0,
        liveGroups: [],
        sessionFailure: snapshot,
      });
      // (b) 事件流里已有同 runId 的分组 → 事件流优先，只出一张。
      const both = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [
          {
            runId: 'r-old',
            status: 'failed',
            hasRunEvent: true,
            items: [],
            startedAt: 1000,
            completedAt: 2000,
            error: 'live error',
          },
        ],
        sessionFailure: snapshot,
      });
      // (c) failed 之后又 completed（session-liveness 误判）：终态以最后一次为准，不出卡。
      const store = new EventStore(0);
      feed(
        store,
        eventsOf(
          [
            ['run.started', { input: 'go' }],
            ['run.failed', { error: 'run lost' }],
            ['run.completed', { output: 'ok' }],
          ],
          'r-flap',
        ),
      );
      const flapped = buildLiveItems(groupsFromStore(store));

      const cards = onlySnapshot.filter((item) => item.kind === 'run-failure');
      const a = cards[0];
      const bothCards = both.filter((item) => item.kind === 'run-failure');
      const b = bothCards[0];
      return expect(
        '快照来源与去重',
        // (a) 快照卡：ts 取 completed_at，落在该轮消息之后。
        cards.length === 1 &&
          a !== undefined &&
          a.kind === 'run-failure' &&
          a.key === 'run:r-old:failure' &&
          a.source === 'session' &&
          a.ts === 2000 &&
          onlySnapshot.map((item) => item.key).join(',') === 'msg:0,msg:1,run:r-old:failure' &&
          // (b) 同 run 恰好一张，且是事件流那条。
          bothCards.length === 1 &&
          b !== undefined &&
          b.kind === 'run-failure' &&
          b.key === 'run:r-old:failure' &&
          b.source === 'event' &&
          b.error === 'live error' &&
          // (c) failed → completed 不留假失败卡。
          flapped.every((item) => item.kind !== 'run-failure'),
      );
    },
  },
  {
    name: 'T1 渲染侧不读 EventStore.entries（I1 tripwire）',
    why: '时间线只读物化后的 item 流：`domains/chat/**` 不许再按 entries 批量分组，也不许再引用已删除的 group-cache；`snapshot.entries` 的每处用法必须标注为传输面消费者',
    check: () => {
      const webSrc = join(import.meta.dir, '..', 'apps', 'web', 'src');
      const chatDir = join('domains', 'chat');
      const allowBatchGroup = new Set(['SubagentTranscript.tsx']);
      const problems: string[] = [];
      // I1-a'：`EventGroupCache` 已删除（设计 §6：它只会变成「第二次投影」）。
      // 这条断言的意义：把文件误 git checkout 回来 / 有人又加一层缓存包装时，门禁先红。
      if (existsSync(join(webSrc, 'state', 'group-cache.ts'))) {
        problems.push(
          'state/group-cache.ts: 已删除的缓存包装又回来了（渲染侧必须读 LiveItemStore）',
        );
      }
      for (const file of walk(webSrc)) {
        if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
        const path = relative(webSrc, file);
        const source = readFileSync(file, 'utf8');
        // I1-a：生产代码不许再引用按 entries 分组的旧缓存（文件已删，**代码行**里的提及
        // 一律是错的；注释里提到历史实现不算 —— 那种「谁曾经用它」的说明留着有用）。
        for (const line of source.split('\n')) {
          const code = line.trim();
          if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
          if (!code.includes('group-cache') && !code.includes('EventGroupCache')) continue;
          problems.push(`${path}: 仍引用已删除的 group-cache（渲染侧必须读 LiveItemStore）`);
          break;
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
          problems.push(
            `useChatTranscript.ts:${index + 1}: 读了 .entries 却没有 transport-consumer 标注`,
          );
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
