#!/usr/bin/env bun

/**
 * 「刷新后时间线按类聚堆」的复现探针 + 门禁（0.54 order-bug）。
 *
 * 症状（用户原话）：刷新之后事件不丢了，但工具卡与思考段**按类聚堆** —— 上方全是
 * 工具卡片，下方全是思考过程。
 *
 * 脚本做两件事，都不依赖人眼：
 *
 * 1. **真实数据复现（只读）**：本机 `~/.vessel/data/sessions/<id>` 的落盘事件
 *    （`events.ndjson`）+ 会话记录（`<id>.json`），按**渲染面真实入参**拼一遍：
 *    `sessions.get` 只回最近 50 条消息（`sessionStore.loadDetail` 的
 *    `TRANSCRIPT_WINDOW`），事件日志则**全量回放**（0.54 的 `sessions.events`）。
 *    然后打印排序后的 `(kind, ts, seq, runId)` 序列与三个客观指标：
 *    - `ghosts`：排在**第一条已加载消息之前**的 item 条数（= 未加载窗口的骨架）；
 *    - `topWall`：开头连续同 kind 的长度（「聚堆」的直观度量，越大越像一堵墙）；
 *    - `kindRuns`：kind 交替段数（交错程度，越大越交错）。
 *    用户数据**只读**：不写、不迁移、不改文件。
 *
 * 2. **确定性夹具**（`FIXTURES`，不依赖本机数据）：P1–P5。每条都标了它在**修前**
 *    的颜色，P1 是那条「修前红、修后绿」的回归钉。
 *
 * 用法：
 *   bun run scripts/probe-order-clump.ts                  # 断言 + 真实数据指标
 *   bun run scripts/probe-order-clump.ts --seq            # 另外打印 (kind, ts, seq, runId)
 *   VESSEL_SESSIONS=<dir> bun run scripts/probe-order-clump.ts --session=<id>
 * 退出码：0 = 全过；1 = 有 FAIL（或真实数据里看见聚堆）。
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  buildTranscriptItems,
  type TranscriptItem,
} from '../apps/web/src/domains/chat/transcript-items';
import type { RunEvent } from '../apps/web/src/gateway/types';
import type { Message } from '../apps/web/src/gateway/types/sessions';
import { groupEvents, type RunGroup, type StoredEvent } from '../apps/web/src/state/events';
import {
  isRuntimeMessageVisible,
  type RuntimeVisibility,
  runtimeMessageKind,
} from '../apps/web/src/state/runtime-visibility';
import { windowTail } from '../apps/web/src/transcript';

/** `useChatTranscript.ts` 的 `TRANSCRIPT_WINDOW`（那边是模块私有常量，这里照抄值）。 */
const PAGE = 50;
/** 单会话实时组上限（`useChatTranscript.ts#MAX_LIVE_GROUPS`）。 */
const MAX_LIVE_GROUPS = 200;
/** runtime 上下文（`vessel:*`）全放开的档位：本探针关心顺序，不关心可见性开关。 */
const RUNTIME_ALL: RuntimeVisibility = {
  notice: true,
  source: true,
  subscription: true,
  limit: true,
  compaction: true,
  other: true,
};

const SESSIONS_DIR = process.env.VESSEL_SESSIONS ?? 'C:/Users/Lirui/.vessel/data/sessions';
const ARGS = process.argv.slice(2);
const SHOW_SEQ = ARGS.includes('--seq');
const SESSION_ARG = ARGS.find((arg) => arg.startsWith('--session='))?.slice('--session='.length);

// ---------------------------------------------------------------------------
// 读真实数据（只读）
// ---------------------------------------------------------------------------

function readEvents(file: string): StoredEvent[] {
  const entries: StoredEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const raw = JSON.parse(line) as {
      seq?: number;
      ts?: number;
      type?: string;
      run_id?: string;
      session_id?: string;
      data?: Record<string, unknown>;
    };
    const data = raw.data ?? {};
    const sessionId =
      raw.session_id ??
      (typeof data.session_id === 'string' ? (data.session_id as string) : undefined);
    const event: RunEvent = {
      type: raw.type ?? 'unknown',
      run_id: raw.run_id ?? '',
      ts: raw.ts ?? 0,
      data,
    };
    entries.push({
      seq: raw.seq ?? 0,
      ...(sessionId !== undefined ? { sessionId } : {}),
      event,
    });
  }
  return entries;
}

interface RealView {
  /** 会话 id（目录名）。 */
  id: string;
  items: TranscriptItem[];
  /** 已加载消息窗口的首条 ts（`TranscriptWindow` 的同名入参）。 */
  windowStartTs?: number;
  messageIndexOffset: number;
  messages: number;
  groups: number;
}

/**
 * 渲染面的真实入参复现（`useChatTranscript` + `TranscriptWindow` 的口径）：
 *
 * - `messages` = `sessions.get` 的窗口 = 最近 `PAGE` 条消息（不是全量）；
 * - `messageIndexOffset` = 该窗口的绝对起始下标；
 * - `liveGroups` = 事件日志全量回放出来的分组（按会话过滤，再截最近 200 组）；
 * - `windowStartTs` = 可见窗口首条消息的 ts。
 */
function realView(id: string): RealView | undefined {
  const eventsFile = `${SESSIONS_DIR}/${id}/events.ndjson`;
  const detailFile = `${SESSIONS_DIR}/${id}.json`;
  if (!existsSync(eventsFile) || !existsSync(detailFile)) return undefined;
  const detail = JSON.parse(readFileSync(detailFile, 'utf8')) as { messages?: Message[] };
  const all = detail.messages ?? [];
  const entries = readEvents(eventsFile);
  const groups = groupEvents(entries, false, 'user').filter((group) => group.sessionId === id);
  const liveGroups = groups.length > MAX_LIVE_GROUPS ? groups.slice(-MAX_LIVE_GROUPS) : groups;

  // `sessions.get`：不带游标时 gateway 回最近 DEFAULT 页（前端固定传 message_limit）。
  const messageIndexOffset = Math.max(0, all.length - PAGE);
  const messages = all.slice(messageIndexOffset);
  const visible = messages.filter((message) => {
    if (message.role === 'system') return false;
    const kind = runtimeMessageKind(message);
    return kind === undefined || isRuntimeMessageVisible(RUNTIME_ALL, kind);
  });
  const window = windowTail(visible, PAGE);
  const isHidden = (message: Message): boolean => {
    const kind = runtimeMessageKind(message);
    return kind !== undefined && !isRuntimeMessageVisible(RUNTIME_ALL, kind);
  };
  const items = buildTranscriptItems({
    messages,
    messageIndexOffset,
    liveGroups,
    ...(window.shown[0]?.timestamp !== undefined
      ? { windowStartTs: window.shown[0].timestamp }
      : {}),
    isHidden,
    noticeKindOf: (message) => runtimeMessageKind(message),
  });
  return {
    id,
    items,
    ...(window.shown[0]?.timestamp !== undefined
      ? { windowStartTs: window.shown[0].timestamp }
      : {}),
    messageIndexOffset,
    messages: all.length,
    groups: groups.length,
  };
}

// ---------------------------------------------------------------------------
// 指标
// ---------------------------------------------------------------------------

interface ItemView {
  kind: string;
  ts?: number;
  seq?: number;
  runId?: string;
  key: string;
}

function viewsOf(items: readonly TranscriptItem[]): ItemView[] {
  return items.map((item) => {
    const meta = item as { ts?: number; seq?: number; runId?: string };
    return {
      kind: item.kind,
      ...(meta.ts !== undefined ? { ts: meta.ts } : {}),
      ...(meta.seq !== undefined ? { seq: meta.seq } : {}),
      ...(meta.runId !== undefined ? { runId: meta.runId } : {}),
      key: item.key,
    };
  });
}

function kindsOf(items: readonly TranscriptItem[]): string[] {
  return items.map((item) => item.kind);
}

/** 开头连续同 kind 的长度（「一堵墙」的厚度）。 */
function topWall(items: readonly TranscriptItem[]): number {
  const kinds = kindsOf(items);
  if (kinds.length === 0) return 0;
  let i = 1;
  while (i < kinds.length && kinds[i] === kinds[0]) i += 1;
  return i;
}

/** kind 交替段数：越小越聚堆（全同 kind = 1）。 */
function kindRuns(items: readonly TranscriptItem[]): number {
  const kinds = kindsOf(items);
  let runs = 0;
  let previous: string | undefined;
  for (const kind of kinds) {
    if (kind !== previous) {
      runs += 1;
      previous = kind;
    }
  }
  return runs;
}

/** 最长的「连续工具卡」厚度：一堵工具墙有多高（中间没有任何别的 item）。 */
function toolWall(items: readonly TranscriptItem[]): number {
  let best = 0;
  let current = 0;
  for (const item of items) {
    if (item.kind === 'tool') {
      current += 1;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best;
}

/** 排在已加载窗口之前的 item 条数（未加载窗口的骨架 = 用户看到的那堵工具墙）。 */
function ghostsOf(items: readonly TranscriptItem[], windowStartTs: number | undefined): number {
  if (windowStartTs === undefined) return 0;
  return viewsOf(items).filter((view) => view.ts !== undefined && view.ts < windowStartTs).length;
}

function kindHistogram(items: readonly TranscriptItem[]): string {
  const rows = new Map<string, { n: number; noTs: number }>();
  for (const item of items) {
    const meta = item as { ts?: number };
    const row = rows.get(item.kind) ?? { n: 0, noTs: 0 };
    row.n += 1;
    if (meta.ts === undefined) row.noTs += 1;
    rows.set(item.kind, row);
  }
  return [...rows.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([kind, row]) => `${kind}=${row.n}${row.noTs > 0 ? `(noTs=${row.noTs})` : ''}`)
    .join(' ');
}

function printSequence(items: readonly TranscriptItem[]): void {
  const views = viewsOf(items);
  for (let i = 0; i < views.length; i += 1) {
    const view = views[i] as ItemView;
    console.log(
      `${String(i).padStart(4)} ${view.kind.padEnd(14)} ts=${String(view.ts ?? 'undef').padStart(14)}` +
        ` seq=${String(view.seq ?? '-').padStart(6)} run=${(view.runId ?? '').slice(0, 8).padEnd(8)} ${view.key.slice(0, 56)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 夹具：确定性、不依赖本机数据
// ---------------------------------------------------------------------------

function msg(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { role, content, ...extra };
}

function group(overrides: Partial<RunGroup> & { runId: string }): RunGroup {
  return { status: 'completed', hasRunEvent: true, items: [], ...overrides };
}

function toolItem(callId: string, startedAt: number): RunGroup['items'][number] {
  return {
    kind: 'tool',
    key: `ev-${callId}`,
    callId,
    name: 'bash',
    status: 'done',
    startedAt,
  };
}

function reasoningItem(
  text: string,
  startedAt?: number,
  endedAt?: number,
): RunGroup['items'][number] {
  return {
    kind: 'reasoning',
    text,
    key: `reasoning-${text}`,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

interface Fixture {
  name: string;
  why: string;
  /** 修前期望：`red` = 修前红（回归钉）、`guard` = 修前就该绿（防误伤 / 防放宽）。 */
  before: 'red' | 'guard';
  check: () => boolean;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'P1 窗口被截断时，早于已加载窗口的 live 骨架项不渲染（上方那堵工具墙）',
    why: '刷新后事件日志全量回放 + 历史只加载最近 50 条消息 ⇒ 更早那些 run 只剩工具卡骨架，正文/思考在窗口外，于是它们以「一整片工具卡、中间没有任何内容」挂在最上方（用户报的就是这个形状）。它们的历史替身在「加载更早」后出现，不该提前以骨架示人。',
    before: 'red',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          msg('user', '最近的问题', { timestamp: 5000 }),
          msg('assistant', '最近的答复', { timestamp: 5500 }),
        ],
        messageIndexOffset: 589,
        windowStartTs: 5000,
        liveGroups: [
          group({
            runId: 'run-old',
            input: '很早以前的问题',
            startedAt: 1000,
            firstSeq: 3,
            items: [
              reasoningItem('旧思考', 1100, 1150),
              toolItem('c-old-1', 1200),
              toolItem('c-old-2', 1300),
            ],
          }),
          group({
            runId: 'run-new',
            input: '最近的问题',
            startedAt: 5000,
            firstSeq: 900,
            items: [toolItem('c-new-1', 5100)],
          }),
        ],
      });
      const ghosts = viewsOf(items).filter((view) => view.ts !== undefined && view.ts < 5000);
      const keys = items.map((item) => item.key);
      // 窗口内的工具卡必须还在（不能把整类砍掉），窗口外的骨架一条都不许露。
      const keptInWindow = keys.includes('tool:c-new-1');
      return ghosts.length === 0 && keptInWindow && !keys.includes('tool:c-old-1');
    },
  },
  {
    name: 'P2 同一 run 内工具卡与思考段按事件顺序交错（不被 P1 的闸门误伤）',
    why: 'P1 的闸门只能按「窗口之前的时刻」筛，不能把窗口内的思考段一起吞掉；交错顺序=事件发生顺序。',
    before: 'guard',
    check: () => {
      const items = buildTranscriptItems({
        messages: [msg('user', 'q', { timestamp: 6000 })],
        messageIndexOffset: 589,
        windowStartTs: 6000,
        liveGroups: [
          group({
            runId: 'run-live',
            input: 'q',
            startedAt: 6000,
            firstSeq: 10,
            items: [
              reasoningItem('想一想', 6010, 6020),
              toolItem('t1', 6030),
              reasoningItem('再想想', 6040, 6050),
              toolItem('t2', 6060),
            ],
          }),
        ],
      });
      const content = items
        .filter(
          (item) =>
            item.kind === 'tool' || item.kind === 'run-reasoning' || item.kind === 'run-text',
        )
        .map((item) => item.kind);
      const expected = ['run-reasoning', 'tool', 'run-reasoning', 'tool'];
      return JSON.stringify(content) === JSON.stringify(expected);
    },
  },
  {
    name: 'P3 跨 run 的交错不乱：两个 run 的条目按各自事件时间互相插入，不被整段归堆',
    why: '排序口径是 (ts, seq, 插入序)；任何按 run 归堆的实现都会让这两个 run 各自成段',
    before: 'guard',
    check: () => {
      const items = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'run-a',
            startedAt: 1000,
            firstSeq: 20,
            items: [reasoningItem('a-1', 1000, 1000), reasoningItem('a-2', 3000, 3000)],
          }),
          group({
            runId: 'run-b',
            startedAt: 2000,
            firstSeq: 30,
            items: [toolItem('b-1', 2000), toolItem('b-2', 4000)],
          }),
        ],
      });
      const runs = items
        .filter((item) => item.kind === 'run-reasoning' || item.kind === 'tool')
        .map((item) => (item as { runId?: string }).runId);
      const expected = ['run-a', 'run-b', 'run-a', 'run-b'];
      return JSON.stringify(runs) === JSON.stringify(expected);
    },
  },
  {
    name: 'P4 全缺 ts 的极端输入：顺序 == 插入序，且不出现「某类整段沉底」',
    why: '比较器的 ts 主序只在有 ts 时成立；全缺 ts 时必须整串回落到插入序（= 事件顺序），不能把某类聚到一头',
    before: 'guard',
    check: () => {
      // 全部 item 都**没有 ts**（回放拿到的事件全缺时间戳的极端输入）。
      const withoutTs = [
        { kind: 'run-reasoning', key: 'r1', runId: 'run-x', text: 'w1', streaming: false },
        { kind: 'tool', key: 'tool:x1', runId: 'run-x', name: 'bash', status: 'done' },
        { kind: 'run-reasoning', key: 'r2', runId: 'run-x', text: 'w2', streaming: false },
        { kind: 'tool', key: 'tool:x2', runId: 'run-x', name: 'bash', status: 'done' },
      ] as unknown as TranscriptItem[];
      const items = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [],
        liveItems: withoutTs,
      });
      const kinds = kindsOf(items);
      const expected = withoutTs.map((item) => item.kind);
      const orderKept = JSON.stringify(kinds) === JSON.stringify(expected);
      // 「某类整段沉底」的机械判据：两种 kind 的交替段数 == 理想值（这里 4 段，逐条交替）。
      return orderKept && kindRuns(items) === expected.length;
    },
  },
  {
    name: 'P5 「缺 ts 排最后」这条设计不变量不许被顺手改掉',
    why: '历史侧真的没有时间的项要沉底（有意为之）；缺 ts 的不许被当成 0 推到时间线开头',
    before: 'guard',
    check: () => {
      const items = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [],
        liveItems: [
          { kind: 'run-text', key: 'no-ts', text: '没有时间', streaming: false },
          { kind: 'run-text', key: 'has-ts', text: '有时间', streaming: false, ts: 7000 },
        ] as unknown as TranscriptItem[],
      });
      return JSON.stringify(items.map((item) => item.key)) === JSON.stringify(['has-ts', 'no-ts']);
    },
  },
];

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function runFixtures(): number {
  console.log('== 确定性夹具 ==');
  let failed = 0;
  for (const fixture of FIXTURES) {
    const tag = fixture.before === 'red' ? '[修前应红]' : '[守护]';
    let ok = false;
    try {
      ok = fixture.check();
    } catch (error) {
      console.log(`  FAIL ${tag} ${fixture.name}\n        抛出：${String(error)}`);
      failed += 1;
      continue;
    }
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${tag} ${fixture.name}`);
    if (!ok) {
      console.log(`       为什么：${fixture.why}`);
      failed += 1;
    }
  }
  return failed;
}

function reportReal(id: string): number {
  const view = realView(id);
  if (view === undefined) {
    console.log(`\n== 真实数据 ==\n  SKIP 找不到会话 ${id}（${SESSIONS_DIR}）`);
    return 0;
  }
  const ghosts = ghostsOf(view.items, view.windowStartTs);
  const wall = topWall(view.items);
  const toolBarrier = toolWall(view.items);
  const runs = kindRuns(view.items);
  console.log(`\n== 真实数据（只读）：${id} ==`);
  console.log(
    `  会话记录 ${view.messages} 条消息 / 事件回放 ${view.groups} 组；` +
      `已加载窗口从绝对下标 ${view.messageIndexOffset} 起，windowStartTs=${view.windowStartTs ?? 'undef'}`,
  );
  console.log(`  item 总数 ${view.items.length}：${kindHistogram(view.items)}`);
  console.log(
    `  聚堆指标：ghosts=${ghosts} toolWall=${toolBarrier} topWall=${wall} kindRuns=${runs}`,
  );
  console.log(`  开头 8 条：${kindsOf(view.items).slice(0, 8).join(' → ')}`);
  if (SHOW_SEQ) printSequence(view.items);
  // 结构判据（与「窗口截断」这条事实绑定）：截断的窗口前面不许出现任何 item。
  return ghosts;
}

function main(): void {
  const failed = runFixtures();
  const ids = [
    SESSION_ARG ?? 'd813eaea-099d-4d77-a4a0-ebebf0bdec4b',
    ...(SESSION_ARG === undefined ? ['main'] : []),
  ];
  let ghostTotal = 0;
  for (const id of ids) ghostTotal += reportReal(id);
  console.log('');
  if (failed > 0 || ghostTotal > 0) {
    console.log(`FAIL（夹具失败 ${failed} 条；未加载窗口之前的 item ${ghostTotal} 条）`);
    process.exit(1);
  }
  console.log('PASS（夹具全过；未加载窗口之前没有骨架 item）');
}

main();
