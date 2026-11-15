#!/usr/bin/env bun

/**
 * 「刷新时正好有 run 在跑」的复现样本（0.54 order-bug）——**待验收样本，不是门禁**。
 *
 * 用户原话（四条现象）与根因分析见 `docs/dev/reports/0.54/midrun-refresh-clump.md`。
 *
 * 它按**渲染面真实入参**拼一次「中途刷新」：
 * - 历史：`sessions.get` 回的那一页消息（`message_limit = TRANSCRIPT_WINDOW`）；
 * - 会话日志频带：已经落盘的事件（进行中那条 run 之外的一切）；
 * - 环频带：进行中那条 run 的事件（还没落盘），按到达序；`llm.stream.chunk` 不落盘，
 *   所以这里按「每个工具调用之前一段思考」造出 chunk（这是环里真实存在的东西）。
 * 然后用 app 真实走的那条路（`LiveItemStore.resume` → 整表重折叠 → `buildLiveItems`）
 * 出 item，再量 T1–T4。
 *
 * **色的约定**：现在（B2 之前）应当**红**（exit 1）；B2「单游标 + item 身份统一成 seq」
 * 落地后应当**绿**（exit 0）。所以它不进 gates 链 —— 它是 B2 的验收样本。
 *
 * 用法：
 *   bun run scripts/probe-midrun-refresh.ts                      # 默认会话 d813eaea
 *   bun run scripts/probe-midrun-refresh.ts --session=<id>       # 换会话
 *   VESSEL_SESSIONS=<dir> bun run scripts/probe-midrun-refresh.ts
 * 只读：本脚本只读用户数据，不写、不迁移。
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  buildLiveItems,
  buildTranscriptItems,
  type TranscriptItem,
} from '../apps/web/src/domains/chat/transcript-items';
import type { RunEvent } from '../apps/web/src/gateway/types';
import type { Message } from '../apps/web/src/gateway/types/sessions';
import { LiveItemStore } from '../apps/web/src/state/live-items';
import {
  isRuntimeMessageVisible,
  type RuntimeVisibility,
  runtimeMessageKind,
} from '../apps/web/src/state/runtime-kinds';
import { windowTail } from '../apps/web/src/transcript';

const SESSIONS_DIR = process.env.VESSEL_SESSIONS ?? 'C:/Users/Lirui/.vessel/data/sessions';
const ARGS = process.argv.slice(2);
const SESSION =
  ARGS.find((arg) => arg.startsWith('--session='))?.slice('--session='.length) ??
  'd813eaea-099d-4d77-a4a0-ebebf0bdec4b';
/** 与 `useChatTranscript.ts` 的 `TRANSCRIPT_WINDOW` 同值。 */
const PAGE = 50;
const RUNTIME_ALL: RuntimeVisibility = {
  notice: true,
  source: true,
  subscription: true,
  limit: true,
  compaction: true,
  other: true,
};
/** 会话日志频带（结构事件）的 seq 基址，与 `disk-replay.ts` 的带图同构。 */
const SESSION_BAND = -2_000_000_000;
/** 环频带的 seq 基址（比会话日志带更晚到达）。 */
const RING_BAND = -1_000_000_000;

interface RawEvent {
  seq?: number;
  ts?: number;
  type?: string;
  run_id?: string;
  session_id?: string;
  data?: Record<string, unknown>;
}

interface Loaded {
  messages: Message[];
  raw: RawEvent[];
}

function load(id: string): Loaded | undefined {
  const eventsFile = `${SESSIONS_DIR}/${id}/events.ndjson`;
  const detailFile = `${SESSIONS_DIR}/${id}.json`;
  if (!existsSync(eventsFile) || !existsSync(detailFile)) return undefined;
  const raw: RawEvent[] = [];
  for (const line of readFileSync(eventsFile, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    raw.push(JSON.parse(line) as RawEvent);
  }
  const detail = JSON.parse(readFileSync(detailFile, 'utf8')) as { messages?: Message[] };
  return { messages: detail.messages ?? [], raw };
}

function matches(list: readonly Message[]): Message[] {
  const visible = list.filter((message) => {
    if (message.role === 'system') return false;
    const kind = runtimeMessageKind(message);
    return kind === undefined || isRuntimeMessageVisible(RUNTIME_ALL, kind);
  });
  const window = windowTail(visible, PAGE);
  return window.shown;
}

/** 进行中的 run = 最后一个 `run.started`、且在截断点之前没有 `run.completed`。 */
function runningRun(raw: readonly RawEvent[]): string | undefined {
  const started: string[] = [];
  const completed = new Set<string>();
  for (const event of raw) {
    if (event.type === 'run.started' && typeof event.run_id === 'string' && event.run_id !== '') {
      started.push(event.run_id);
    }
    if (event.type === 'run.completed' && typeof event.run_id === 'string') {
      completed.add(event.run_id);
    }
  }
  const unfinished = started.filter((runId) => !completed.has(runId));
  return unfinished.at(-1) ?? started.at(-1);
}

interface Built {
  runId: string;
  items: TranscriptItem[];
  completedCalls: Set<string>;
  timeline: TranscriptItem[];
}

function build(loaded: Loaded, runId: string): Built {
  const { raw } = loaded;
  const toEntry = (event: RawEvent, seq: number) => ({
    seq,
    sessionId: SESSION,
    event: {
      type: event.type ?? 'unknown',
      run_id: event.run_id ?? '',
      ts: event.ts ?? 0,
      data: event.data ?? {},
    } as RunEvent,
  });
  // 频带一：磁盘回放 = 整份会话日志（0.54 阶段一 `sessions.events` 是全量回放；
  // 进行中那条 run 的 `tool.call.*` 就在这里 —— 它的**消息**还没进历史，但事件已落盘）。
  const sessionBand = raw.map((event) => toEntry(event, SESSION_BAND + (event.seq ?? 0)));
  // 频带二：环里那条进行中的 run 的 chunk（`llm.stream.chunk` **不落盘**，只有环里有），
  // 而且作为**更晚的频带**到达 —— 这正是「思考被夹到工具之后」的来路。
  const live = raw.filter((event) => event.run_id === runId);
  const ringBand: ReturnType<typeof toEntry>[] = [];
  let rank = 0;
  for (const event of live) {
    if (event.type === 'tool.call.started' || event.type === 'llm.request') {
      rank += 1;
      ringBand.push({
        seq: RING_BAND + rank * 2,
        sessionId: SESSION,
        event: {
          type: 'llm.stream.chunk',
          run_id: runId,
          ts: (event.ts ?? 0) - 5,
          data: { chunk: { type: 'reasoning_delta', delta: `想 ${rank}` } },
        } as RunEvent,
      });
    }
    ringBand.push(toEntry(event, RING_BAND + rank * 2 + 1));
  }
  // app 真实路径：整表重折叠（会话日志带 → 环带）
  const store = new LiveItemStore({ showInternal: false, errorLevel: 'user' });
  store.resume([...sessionBand, ...ringBand]);
  store.flush();
  const groups = store.getSnapshot().groups;
  const target = groups.filter((group) => group.runId === runId).pop();
  const items = target === undefined ? [] : buildLiveItems([target]);
  const completedCalls = new Set<string>();
  for (const event of live) {
    if (event.type !== 'tool.call.completed') continue;
    const callId = (event.data?.tool_call_id ?? event.data?.call_id) as string | undefined;
    if (callId !== undefined) completedCalls.add(callId);
  }
  const messageIndexOffset = Math.max(0, loaded.messages.length - PAGE);
  const messages = loaded.messages.slice(messageIndexOffset);
  const visibleMessages = matches(messages);
  const timeline = buildTranscriptItems({
    messages,
    messageIndexOffset,
    liveGroups: groups,
    ...(visibleMessages[0]?.timestamp !== undefined
      ? { windowStartTs: visibleMessages[0].timestamp }
      : {}),
    isHidden: () => false,
    noticeKindOf: (message) => runtimeMessageKind(message),
  });
  return { runId, items, completedCalls, timeline };
}

// ---------------------------------------------------------------------------
// T1–T4：四条现象各一条断言
// ---------------------------------------------------------------------------

interface Check {
  id: string;
  name: string;
  detail: string;
  ok: boolean;
}

function kindOf(item: TranscriptItem): string {
  return item.kind;
}

function checkAll(built: Built): Check[] {
  const { items, completedCalls, timeline } = built;
  const tools = items.filter((item) => item.kind === 'tool') as {
    callId?: string;
    status?: string;
    ts?: number;
    seq?: number;
    anchorSeq?: number;
    output?: unknown;
  }[];
  const reasoning = items.filter((item) => item.kind === 'run-reasoning') as {
    ts?: number;
    seq?: number;
    anchorSeq?: number;
  }[];

  // T1「工具事件失去结果状态、按钮变灰」——有 completed 事件的 callId，卡片不得停在 running。
  const lostResult = tools.filter(
    (item) =>
      item.callId !== undefined &&
      completedCalls.has(item.callId) &&
      item.status !== 'done' &&
      item.status !== 'error',
  );

  // T2「所有思考块放在工具事件之后」——按各自事件时间，思考段必须与工具卡交错。
  const lastToolTs = Math.max(0, ...tools.map((item) => item.ts ?? 0));
  const thinkingAfterTools =
    reasoning.length > 0 && reasoning.every((item) => (item.ts ?? 0) >= lastToolTs);
  const mergedIntoOne = reasoning.length === 1 && tools.length > 1;
  // 相邻项逆序（前一项的时间晚于后一项）= 时间线内部不是时间序。
  const inversions = items.filter((item, index) => {
    const next = items[index + 1] as { ts?: number } | undefined;
    const ts = (item as { ts?: number }).ts;
    return next?.ts !== undefined && ts !== undefined && ts > next.ts;
  }).length;

  // T3「放置在触发 run 的用户消息后」——位置必须由自己的 seq 决定，不许集体锚到 run 起点。
  const withAnchor = items.filter(
    (item) => (item as { anchorSeq?: number }).anchorSeq !== undefined,
  ) as { seq?: number; anchorSeq?: number }[];
  const seqNotOwn = withAnchor.filter((item) => item.seq !== item.anchorSeq).length;
  const seqValues = new Set(withAnchor.map((item) => item.seq).filter((seq) => seq !== undefined));
  const seqCollapsed = withAnchor.length > 1 && seqValues.size === 1;

  // T4「新事件正常排在最下面」——回放段之后出现的项必须都比回放段更晚（时间序连续），
  // 不许把新到的事件插到回放项中间。
  const targetIndexes = timeline
    .map((item, index) => ({ item, index }))
    .filter((entry) => (entry.item as { runId?: string }).runId === built.runId)
    .map((entry) => entry.index);
  const lastTarget = targetIndexes.at(-1) ?? -1;
  const targetMaxTs = Math.max(
    0,
    ...timeline
      .map((item) => (item as { ts?: number }).ts ?? 0)
      .filter((ts, index) => targetIndexes.includes(index) && ts > 0),
  );
  const newerAfter = lastTarget >= 0 ? timeline.length - 1 - lastTarget : 0;
  const newerBeforeReplay = timeline.slice(lastTarget + 1).filter((item) => {
    const ts = (item as { ts?: number }).ts;
    return ts !== undefined && ts < targetMaxTs;
  }).length;
  const tailOrdered = lastTarget < 0 || newerBeforeReplay === 0;

  return [
    {
      id: 'T1',
      name: '有 tool.call.completed 的工具卡必须保住结果状态（不得停在 running / 灰按钮）',
      detail:
        lostResult.length === 0
          ? `0 例（检查了 ${tools.length} 张卡）`
          : `${lostResult.length} 例仍在 running，例如 callId=${String(lostResult[0]?.callId).slice(0, 20)}`,
      ok: lostResult.length === 0,
    },
    {
      id: 'T2',
      name: '进行中 run 的思考段与工具卡按各自事件时间交错（不许「工具全在前、思考全在后」）',
      detail:
        `思考段=${reasoning.length} 工具卡=${tools.length} ` +
        `思考全在工具之后=${thinkingAfterTools} 并成一段=${mergedIntoOne} 逆序相邻对=${inversions}`,
      ok: !thinkingAfterTools && !mergedIntoOne && inversions === 0,
    },
    {
      id: 'T3',
      name: 'run 内每一项的位置由自己的事件 seq 决定（不许集体锚到 run 起点）',
      detail:
        `带锚点项=${withAnchor.length} seq≠自己的 anchorSeq=${seqNotOwn} ` +
        `共用同一个 seq=${seqCollapsed ? `是（${[...seqValues].join(',')}）` : '否'}`,
      ok: seqNotOwn === 0 && !seqCollapsed,
    },
    {
      id: 'T4',
      name: '回放段与之后新到事件的顺序连续（回放尾巴在最下面，不被新事件插到中间）',
      detail: `时间线=${timeline.length} 条；该 run 最后一项之后还有 ${newerAfter} 条`,
      ok: tailOrdered,
    },
  ];
}

function main(): void {
  const loaded = load(SESSION);
  if (loaded === undefined) {
    console.log(`SKIP 找不到会话 ${SESSION}（${SESSIONS_DIR}）`);
    process.exit(0);
  }
  const runId = runningRun(loaded.raw);
  if (runId === undefined) {
    console.log(`SKIP 会话 ${SESSION} 里没有 run.started`);
    process.exit(0);
  }
  console.log(`== 中途刷新复现：${SESSION.slice(0, 8)}，进行中的 run = ${runId.slice(0, 8)} ==`);
  console.log(
    `   历史 ${loaded.messages.length} 条消息 / 事件 ${loaded.raw.length} 条（该 run ${loaded.raw.filter((event) => event.run_id === runId).length} 条走环频带）`,
  );
  const built = build(loaded, runId);
  console.log(`   折叠后该 run 的 item：${built.items.map((item) => kindOf(item)).join(' ')}`);
  const checks = checkAll(built);
  let failed = 0;
  for (const check of checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.id} ${check.name}`);
    console.log(`       ${check.detail}`);
    if (!check.ok) failed += 1;
  }
  console.log('');
  if (failed > 0) {
    console.log(`红：${failed}/4 条现象仍在（B2 落地前这是预期）。把这份输出当作 B2 的验收基线。`);
    process.exit(1);
  }
  console.log(
    '绿：四条现象都不再复现 —— 如果这是 B2 之后跑出来的，说明 B2 把这个 bug 结构性消灭了。',
  );
}

main();
