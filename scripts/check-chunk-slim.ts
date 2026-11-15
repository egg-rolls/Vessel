#!/usr/bin/env bun
/**
 * check-chunk-slim.ts — 0.54 chunk 瘦身门禁（`tool_call_delta` / `finish` 不再进块、不占 seq）。
 *
 * **判的是什么**（每一条都是跑出来的，没有一条是读码判定）：
 *
 * | # | 断言 | 做法 |
 * | --- | --- | --- |
 * | ① | 瞬时 chunk（`tool_call_delta` / `finish`）**不进块、不进 ndjson**，但**实时通道一条不少** | 跑**生产链路**（`RunJournal.appendFact` → 双写旁路 → `TimelineWriter`），块里/`wal.log`/`events.ndjson` 逐处数帧；同时数订阅者收到的事件 |
 * | ② | 它们**不占 `timeline_seq`**（I2 的逆否），且 seq 仍然连续无洞 | 记录数 == `wal_head`、`holes` 空；另加**端口负控**：绕过 journal 直接 `record()` 一条瞬时 chunk ⇒ 被写者拒绝、seq 一条都不消费 |
 * | ③ | **`count` == 实收条数**（serve 口径 `timelineHello().count` vs 分页读） | heads 来自真写者（含 `published_head`），`count` 与 `readPage` 实收逐条比；另有**判据自检**：把右端人为推到「瞬时也占号」⇒ `count` 必须比实收多，证明判据不恒真 |
 * | ④ | **刷新后逐字复原**：live 折出来的东西 == 落盘重折出来的东西（工具卡的 `name` / `args` / `result` 逐字） | live 侧用事件流订阅序、落盘侧用 `readTimelineEvents`，两边都过 `apps/web` 的 `buildGroup`（渲染面唯一折叠），归一掉身份字段后整份比 |
 * | ⑤ | 体量：同一条流，「瞬时也进块（旧行为）」vs「现在」的块数 / 字节 / 帧数 | 旧行为用**生产编码器** `ChunkBlockStore` 按写者原算法重放（含「非 chunk 前封块」），三条口径同一把尺子 |
 *
 * ## 为什么 ①–⑤ 要跑生产链路而不是直接调写者
 *
 * 「不占 seq」这件事发生在**派发层**（`run-journal.ts#appendFact`）——那里是
 * 「这条事件要不要请求 timeline」的唯一分叉点。直接喂 `TimelineWriter` 会绕过它，
 * 判出来的东西和线上不是一件事。写者里的 `validateInput` 只是第二道闸门（防别的调用方
 * 绕过），所以它单独用**端口负控**（②）验：`record()` 是装配层的公开入口，正是
 * 「第二个调用方」的样子。
 *
 * ## 为什么 `count == 实收` 是本单的硬判据
 *
 * 本单最容易写错的形态是「**照取 seq、只是不写进块**」：那样 `wal_head` 会跨过一批
 * 永远读不回来的 seq，`count`（= 区间长度 − 洞）立刻比实收多 —— 也就是 ADR-105 §3 I2
 * 的违反（已发布未落盘）+ `count` 里凭空造洞。正确形态是**不取 seq**（这批 seq 根本不
 * 存在），于是 `count` 与实收天然相等。③ 把这两件事一起钉住。
 *
 * ## 体量的口径（③ 的「前后对照」为什么可信）
 *
 * 块字节的固定开销是每帧 12 B 帧头 + 记录元数据（`v/seq/session_id/run_id×2/ts/type/crc`）。
 * 所以「省下来的是帧数」而不是「编码方式」：本门禁比的正是**帧数→块数→字节**这条链，
 * 而不是「ndjson 与块谁更省」。
 *
 * ## 真机对照（`--real-session=<id>`，默认不跑）
 *
 * 读磁盘上真会话的 `wal.blocks`（现状 = 旧行为的产物），把同一批帧按「只留
 * `text_delta` / `reasoning_delta`」重算一遍，打印 `块数 / 字节 / 帧数` 前后对照。
 * 两条腿都用同一个 `ChunkBlockStore` + 同一个 32 KiB 封块策略 —— 因为真机那批块是
 * **实时节流**（150 ms 空闲封块）写出来的，与重放的「填满即封」不可直接比块数，
 * 所以对照必须同 pacing 重算，真机现值只作参照打印。默认不跑：门禁不许依赖用户数据。
 *
 * 用法：
 *   bun run scripts/check-chunk-slim.ts
 *   bun run scripts/check-chunk-slim.ts --real-session=055245da-be5f-460c-9856-8d5043ae4297
 *   VESSEL_SESSIONS=<dir> bun run scripts/check-chunk-slim.ts --real-session=<id>
 *
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGroup, type StoredEvent } from '../apps/web/src/state/events';
import {
  createRunJournalFactory,
  type Logger,
  MemoryEventStream,
  type RunEvent,
  SessionEventLog,
  sessionDirPath,
} from '../packages/core/src/index';
import {
  ChunkBlockStore,
  chunkSubtypeOf,
  isTransientChunkEvent,
} from '../packages/core/src/timeline/blocks';
import {
  BLOCK_MAX_BYTES,
  TIMELINE_LAYOUT,
  type TimelineRecord,
} from '../packages/core/src/timeline/types';
import {
  decodeChunkBlock,
  readTimelineEvents,
  stampRecord,
} from '../packages/core/src/timeline/wal';
import { timelineHello } from '../packages/serve/src/gateway/timeline-protocol';
import { createTimelineDualWrite, type TimelineDualWrite } from '../src/timeline-dual-write';

let checks = 0;
let failures = 0;

function pass(name: string, detail = ''): void {
  checks += 1;
  console.log(`[PASS] ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail = ''): void {
  checks += 1;
  failures += 1;
  console.log(`[FAIL] ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
}

function judge(name: string, ok: boolean, detail = ''): void {
  if (ok) pass(name, detail);
  else fail(name, detail);
}

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  judge(
    name,
    ok,
    ok
      ? `actual=${JSON.stringify(actual)}`
      : `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  );
}

const quietLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---- HARNESS ----

const SESSION = 'chunk-slim';
const RUN = 'run-slim';
const NOW = 1_780_000_000_000;

/**
 * 一次带工具调用的流式 run（按 provider 回调的真实顺序）。
 *
 * 形状对着 `StreamAccumulator`：`appendText/appendReasoning` 发 `*_delta`，
 * `appendToolCall` 发 `tool_call_delta`，`finalize()` 发 `finish`；随后 loop 落
 * `llm.response` + `tool.call.started` / `tool.call.completed`。
 *
 * 参数片段**故意**拆成多段（真实 provider 就是一段段吐 JSON 的），这样「运行时画出去的
 * 参数文本」与「`tool.call.started.data.arguments` 里的对象」能做等价断言（④ D4）。
 */
const TOOL_CALL_A = { path: 'packages/core/src/timeline/blocks.ts', limit: 120 };
const TOOL_CALL_B = { command: 'bun run typecheck', timeout_ms: 600_000 };
const TOOL_RESULT_A = 'const TRANSIENT_CHUNK_SUBTYPES = ...';
const TOOL_RESULT_B = 'tsc: 0 errors';

/** 把一个 JSON 串按 `size` 切成碎片（模拟 provider 的 arguments 增量）。 */
function fragmentsOf(value: unknown, size: number): string[] {
  const text = JSON.stringify(value);
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size)
    parts.push(text.slice(index, index + size));
  return parts;
}

interface ScriptStep {
  /** `chunk` 的 data 形状与 `llm.stream.chunk` 完全一致；`fact` 就是普通事实事件。 */
  event: RunEvent;
  /** 备注：供体量对照重放时区分「块帧」与「非 chunk 事实」。 */
  note: string;
}

function chunkStep(ts: number, chunk: Record<string, unknown>): ScriptStep {
  return {
    event: { type: 'llm.stream.chunk', run_id: RUN, ts, data: { run_id: RUN, chunk } },
    note: `chunk:${String(chunk.type)}`,
  };
}

function factStep(ts: number, type: string, data: Record<string, unknown>): ScriptStep {
  return { event: { type, run_id: RUN, ts, data }, note: `fact:${type}` };
}

function buildScript(): ScriptStep[] {
  const steps: ScriptStep[] = [];
  let ts = NOW;
  const push = (step: ScriptStep): void => {
    ts += 1;
    steps.push({ ...step, event: { ...step.event, ts } });
  };

  push(
    factStep(NOW, 'run.started', {
      run_id: RUN,
      session_id: SESSION,
      agent: 'primary',
      model: 'test-model',
    }),
  );
  // `llm.request` 只带元信息（与写盘副本逐字一致，正文裁剪那条路不在本单范围内）。
  push(
    factStep(NOW, 'llm.request', {
      session_id: SESSION,
      run_id: RUN,
      model: 'test-model',
      message_count: 3,
      attempt: 1,
      stream: true,
    }),
  );

  // 第一次响应：先思考、再吐工具参数（全程没有正文）。
  for (const delta of ['工具', '调用', '前端'])
    push(chunkStep(NOW, { type: 'reasoning_delta', delta }));
  const argsA = fragmentsOf(TOOL_CALL_A, 7);
  argsA.forEach((piece, index) => {
    push(
      chunkStep(NOW, {
        type: 'tool_call_delta',
        tool_call_index: 0,
        ...(index === 0 ? { tool_call_id: 'call-a', tool_call_name: 'read_file' } : {}),
        arguments_delta: piece,
      }),
    );
  });
  push(
    chunkStep(NOW, {
      type: 'finish',
      finish_reason: 'tool_calls',
      usage: { prompt_tokens: 1_100, completion_tokens: 42 },
    }),
  );
  push(
    factStep(NOW, 'llm.response', {
      session_id: SESSION,
      run_id: RUN,
      content: '',
      reasoning_content: '工具调用前端',
      tool_calls: [
        {
          id: 'call-a',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify(TOOL_CALL_A) },
        },
      ],
      finish_reason: 'tool_calls',
      usage: { prompt_tokens: 1_100, completion_tokens: 42 },
    }),
  );
  push(
    factStep(NOW, 'tool.call.started', {
      run_id: RUN,
      session_id: SESSION,
      tool_call_id: 'call-a',
      tool_name: 'read_file',
      arguments: TOOL_CALL_A,
    }),
  );
  push(
    factStep(NOW, 'tool.call.completed', {
      run_id: RUN,
      session_id: SESSION,
      tool_call_id: 'call-a',
      tool_name: 'read_file',
      result: TOOL_RESULT_A,
      duration_ms: 3,
    }),
  );

  // 第二次响应：正文流 + 再一次工具调用（让「正文段」与 `finish` 交错）。
  push(
    factStep(NOW, 'llm.request', {
      session_id: SESSION,
      run_id: RUN,
      model: 'test-model',
      message_count: 5,
      attempt: 1,
      stream: true,
    }),
  );
  for (const delta of ['块只装', '有持久化价值', '的增量。']) {
    push(chunkStep(NOW, { type: 'text_delta', delta }));
  }
  const argsB = fragmentsOf(TOOL_CALL_B, 5);
  argsB.forEach((piece, index) => {
    push(
      chunkStep(NOW, {
        type: 'tool_call_delta',
        tool_call_index: 0,
        ...(index === 0 ? { tool_call_id: 'call-b', tool_call_name: 'run_shell' } : {}),
        arguments_delta: piece,
      }),
    );
  });
  push(
    chunkStep(NOW, {
      type: 'finish',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1_240, completion_tokens: 88 },
    }),
  );
  push(
    factStep(NOW, 'llm.response', {
      session_id: SESSION,
      run_id: RUN,
      content: '块只装有持久化价值的增量。',
      tool_calls: [
        {
          id: 'call-b',
          type: 'function',
          function: { name: 'run_shell', arguments: JSON.stringify(TOOL_CALL_B) },
        },
      ],
      finish_reason: 'stop',
      usage: { prompt_tokens: 1_240, completion_tokens: 88 },
    }),
  );
  push(
    factStep(NOW, 'tool.call.started', {
      run_id: RUN,
      session_id: SESSION,
      tool_call_id: 'call-b',
      tool_name: 'run_shell',
      arguments: TOOL_CALL_B,
    }),
  );
  push(
    factStep(NOW, 'tool.call.completed', {
      run_id: RUN,
      session_id: SESSION,
      tool_call_id: 'call-b',
      tool_name: 'run_shell',
      result: TOOL_RESULT_B,
      duration_ms: 1_204,
    }),
  );
  push(
    factStep(NOW, 'run.completed', {
      run_id: RUN,
      session_id: SESSION,
      status: 'completed',
      output: '块只装有持久化价值的增量。',
    }),
  );
  // 非持久化事件（旧链路/新链路都不落盘，refresh 侧本来就没有它们）：
  // 放进夹具是为了让 ④ 的「live 少掉的那些到底是谁」这条判据真的被行使一次。
  push(
    factStep(NOW, 'run.checkpoint', {
      run_id: RUN,
      session_id: SESSION,
      status: 'running',
      iteration: 1,
    }),
  );
  return steps;
}

const roots: string[] = [];

async function makeRoot(label: string): Promise<{ root: string; sessionsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), `vessel-chunk-slim-${label}-`));
  roots.push(root);
  const sessionsDir = join(root, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  return { root, sessionsDir };
}

interface Wiring {
  root: string;
  sessionsDir: string;
  sessionDir: string;
  journal: ReturnType<ReturnType<typeof createRunJournalFactory>['begin']>;
  manager: TimelineDualWrite;
  /** 事件流订阅序（= 实时通道上 UI/TUI 真正看到的那一串）。 */
  live: RunEvent[];
}

async function wire(label: string): Promise<Wiring> {
  const { root, sessionsDir } = await makeRoot(label);
  const log = new SessionEventLog({ dir: sessionsDir, durable: false, logger: quietLogger });
  const events = new MemoryEventStream();
  const live: RunEvent[] = [];
  events.subscribe((event: RunEvent) => {
    live.push(event);
  });
  const manager = createTimelineDualWrite({
    dataDir: root,
    sessionsDir,
    dualWrite: true,
    verifySampleRate: 0,
    archiveIntervalMs: 0,
    logger: quietLogger,
  });
  const factory = createRunJournalFactory({
    eventLog: log,
    logger: quietLogger,
    timelineDualWrite: manager,
  });
  const journal = factory.begin({ runId: RUN, sessionId: SESSION, events });
  return {
    root,
    sessionsDir,
    sessionDir: sessionDirPath(sessionsDir, SESSION),
    journal,
    manager,
    live,
  };
}

/** 块的现场勘察：块数 / 字节 / 每帧的 type 与 chunk 子类型。 */
interface BlockSurvey {
  files: number;
  bytes: number;
  records: TimelineRecord[];
}

async function surveyBlocks(sessionDir: string): Promise<BlockSurvey> {
  const dir = join(sessionDir, TIMELINE_LAYOUT.walBlocks);
  const names = (await readdir(dir).catch((): string[] => [])).filter((name) =>
    name.endsWith('.wblk'),
  );
  names.sort();
  const survey: BlockSurvey = { files: 0, bytes: 0, records: [] };
  for (const name of names) {
    const path = join(dir, name);
    survey.files += 1;
    survey.bytes += (await stat(path)).size;
    survey.records.push(...decodeChunkBlock(await readFile(path)).records);
  }
  return survey;
}

/** `wal.log` 里的非 chunk 记录（顺带数一下有没有 chunk 漏进来）。 */
async function walLogRecords(sessionDir: string): Promise<TimelineRecord[]> {
  const text = await readFile(join(sessionDir, TIMELINE_LAYOUT.walLog), 'utf8').catch(() => '');
  const records: TimelineRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    records.push(JSON.parse(trimmed) as TimelineRecord);
  }
  return records;
}

async function legacyRecords(sessionDir: string): Promise<Array<{ type: string }>> {
  const text = await readFile(join(sessionDir, 'events.ndjson'), 'utf8').catch(() => '');
  const records: Array<{ type: string }> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    records.push(JSON.parse(trimmed) as { type: string });
  }
  return records;
}

/** 一条事件的身份（多重集比对的键；`data` 不进键 —— 落盘副本可能被裁剪）。 */
function eventKeyOf(event: { run_id: string; type: string; ts: number }): string {
  return `${event.run_id}\u0000${event.type}\u0000${String(event.ts)}`;
}

function multiset(values: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}

/** `left` 里比 `right` 多出来的（多重集差）。 */
function multisetDiff(left: readonly string[], right: readonly string[]): string[] {
  const pool = multiset(right);
  const out: string[] = [];
  for (const value of left) {
    const count = pool.get(value) ?? 0;
    if (count > 0) pool.set(value, count - 1);
    else out.push(value);
  }
  return out;
}

/** 同一批帧按写者原算法（含「非 chunk 前封块」）重放，量「旧行为」的块数/字节/帧数。 */
interface ReplayVolume {
  files: number;
  bytes: number;
  frames: number;
}

async function replayVolume(label: string, steps: readonly ScriptStep[]): Promise<ReplayVolume> {
  const { sessionsDir } = await makeRoot(label);
  const dir = sessionDirPath(sessionsDir, SESSION);
  await mkdir(dir, { recursive: true });
  const open = await ChunkBlockStore.open(dir);
  const store = open.store;
  let seq = 0;
  const nextRecord = (event: RunEvent): TimelineRecord => {
    seq += 1;
    return stampRecord({
      v: 1,
      seq,
      session_id: SESSION,
      run_id: event.run_id,
      ts: event.ts,
      type: event.type,
      data: event.data,
    });
  };
  // 旧行为：每个事件都取一个 seq；chunk 进块，非 chunk 前先封块。
  for (const step of steps) {
    if (step.note.startsWith('chunk:')) {
      store.push(nextRecord(step.event));
      if (store.shouldSeal()) await store.seal();
    } else if (store.pendingCount() > 0) {
      await store.seal();
    }
  }
  await store.seal();
  await store.flushManifests();
  store.close();
  const survey = await surveyBlocks(dir);
  return { files: survey.files, bytes: survey.bytes, frames: survey.records.length };
}

// ---- MAIN ----

/** 身份/锚点字段：live 与落盘两套 seq 基址不同（瞬时 chunk 不占号），内容无关。 */
function stripIdentity(group: ReturnType<typeof buildGroup>): unknown {
  const items = group.items.map((item) => {
    const copy: Record<string, unknown> = { ...(item as unknown as Record<string, unknown>) };
    delete copy.key;
    delete copy.anchorSeq;
    return copy;
  });
  return {
    status: group.status,
    items,
    ...(group.output !== undefined ? { output: group.output } : {}),
    ...(group.liveText !== undefined ? { liveText: group.liveText } : {}),
    ...(group.liveReasoning !== undefined ? { liveReasoning: group.liveReasoning } : {}),
  };
}

interface ToolCard {
  name: string;
  status: string;
  args: unknown;
  result: unknown;
}

function toolCardsOf(group: ReturnType<typeof buildGroup>): ToolCard[] {
  const cards: ToolCard[] = [];
  for (const item of group.items) {
    if (item.kind !== 'tool') continue;
    cards.push({ name: item.name, status: item.status, args: item.args, result: item.result });
  }
  return cards;
}

function foldEntries(
  events: readonly { type: string; run_id: string; ts: number; data: unknown }[],
  seqOf: (index: number) => number,
): StoredEvent[] {
  return events.map((event, index) => ({
    event: {
      type: event.type,
      run_id: event.run_id,
      ts: event.ts,
      data: (event.data ?? {}) as Record<string, unknown>,
    },
    seq: seqOf(index),
    sessionId: SESSION,
  }));
}

/** 旧链路就不落盘的类型：refresh 侧本来也没有它们，与本单无关（④ D1 的排除项）。 */
const PRE_EXISTING_NON_PERSISTED: ReadonlySet<string> = new Set([
  'run.checkpoint',
  'session.saved',
  'context.changed',
]);

function formatBytes(bytes: number): string {
  return `${String(bytes)}B（${(bytes / 1024 / 1024).toFixed(2)} MiB）`;
}

function pct(part: number, total: number): string {
  if (total <= 0) return '0.0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

async function runGate(): Promise<void> {
  const script = buildScript();
  const chunkSteps = script.filter((step) => step.note.startsWith('chunk:'));
  const transientSteps = chunkSteps.filter((step) => isTransientChunkEvent(step.event));
  const persistedChunkSteps = chunkSteps.filter((step) => !isTransientChunkEvent(step.event));
  const transientCount = transientSteps.length;
  const finishCount = chunkSteps.filter((step) => chunkSubtypeOf(step.event) === 'finish').length;
  const toolDeltaCount = transientCount - finishCount;

  const on = await wire('on');
  try {
    for (const step of script) on.journal.appendFact(step.event);
    await on.journal.flush();
    await on.manager.finishRun(SESSION, RUN);

    const survey = await surveyBlocks(on.sessionDir);
    const walLog = await walLogRecords(on.sessionDir);
    const legacy = await legacyRecords(on.sessionDir);
    const persisted = await readTimelineEvents(on.sessionDir);
    const headsBefore = await on.manager.heads(SESSION);
    if (headsBefore === undefined)
      throw new Error('timeline heads unavailable (writer not installed)');

    const frameSubtypes = new Map<string, number>();
    for (const record of survey.records) {
      const subtype = chunkSubtypeOf(record) ?? '(none)';
      frameSubtypes.set(subtype, (frameSubtypes.get(subtype) ?? 0) + 1);
    }
    const liveSubtypes = new Map<string, number>();
    for (const event of on.live) {
      const subtype = chunkSubtypeOf(event);
      if (subtype === undefined) continue;
      liveSubtypes.set(subtype, (liveSubtypes.get(subtype) ?? 0) + 1);
    }

    // ══════════════════════════════════════ ① 不进块、不进 ndjson，但实时通道一条不少
    assertEqual('① 块里 `tool_call_delta` 帧数 == 0', frameSubtypes.get('tool_call_delta') ?? 0, 0);
    assertEqual('① 块里 `finish` 帧数 == 0', frameSubtypes.get('finish') ?? 0, 0);
    assertEqual('① 块里只留下正文/思考两个子类型', [...frameSubtypes.keys()].sort(), [
      'reasoning_delta',
      'text_delta',
    ]);
    assertEqual(
      '① 块里的 chunk 帧数 == 该落盘的 delta 条数',
      survey.records.filter((record) => record.type === 'llm.stream.chunk').length,
      persistedChunkSteps.length,
    );
    const chunkInWal = walLog.filter((record) => record.type === 'llm.stream.chunk').length;
    assertEqual('① `wal.log` 里 chunk 家族 0 条（块才是 chunk 的 WAL）', chunkInWal, 0);
    const chunkInLegacy = legacy.filter((record) =>
      record.type.endsWith('llm.stream.chunk'),
    ).length;
    assertEqual('① `events.ndjson` 里 chunk 家族 0 条（没退回老口子）', chunkInLegacy, 0);
    assertEqual(
      '① 实时通道：`tool_call_delta` 一条不少',
      liveSubtypes.get('tool_call_delta') ?? 0,
      toolDeltaCount,
    );
    assertEqual('① 实时通道：`finish` 一条不少', liveSubtypes.get('finish') ?? 0, finishCount);
    assertEqual(
      '① 实时通道：正文/思考 delta 一条不少',
      (liveSubtypes.get('text_delta') ?? 0) + (liveSubtypes.get('reasoning_delta') ?? 0),
      persistedChunkSteps.length,
    );

    // ══════════════════════════════════════ ② 不占 seq（I2 的逆否）
    const persistedSeqs = persisted.map((record) => record.seq).sort((a, b) => a - b);
    const contiguous = persistedSeqs.every((seq, index) => seq === index + 1);
    judge(
      '② seq 从 1 连续到 N（瞬时 chunk 没有在中间占号）',
      contiguous,
      `N=${String(persistedSeqs.length)} max=${String(persistedSeqs.at(-1) ?? 0)}`,
    );
    assertEqual(
      '② 记录数 == wal_head（没有「已占号却不可读」的尾部）',
      persistedSeqs.length,
      headsBefore.wal_head,
    );
    assertEqual('② holes 为空（没有凭空造出来的洞）', headsBefore.holes.length, 0);
    assertEqual(
      '② published_head == wal_head（每条都已发布）',
      headsBefore.published_head,
      headsBefore.wal_head,
    );
    const nonPersistedSteps = script.filter((step) =>
      PRE_EXISTING_NON_PERSISTED.has(step.event.type),
    ).length;
    assertEqual(
      '② 记录总数 == 该落盘的事件数（瞬时 chunk 一条都没进账）',
      persisted.length,
      script.length - transientCount - nonPersistedSteps,
    );

    // 端口负控：绕过 journal、直接走装配层的 `record()`（=「第二个调用方」的样子）。
    const recordsBeforeProbe = (await readTimelineEvents(on.sessionDir)).length;
    on.manager.record(SESSION, {
      run_id: RUN,
      type: 'llm.stream.chunk',
      ts: NOW + 9_000,
      data: {
        run_id: RUN,
        chunk: { type: 'tool_call_delta', tool_call_index: 0, arguments_delta: '"x"' },
      },
      persisted: false,
    });
    await on.manager.flushSession(SESSION);
    const recordsAfterProbe = (await readTimelineEvents(on.sessionDir)).length;
    const stats = on.manager.stats();
    judge(
      '② 端口负控：写者拒绝了直接塞进来的瞬时 chunk（第二道闸门真的在）',
      stats.failed > 0,
      `failed=${String(stats.failed)}`,
    );
    assertEqual(
      '② 端口负控：seq 一条都没被消费（记录数不变）',
      recordsAfterProbe,
      recordsBeforeProbe,
    );
    const headsAfterProbe = await on.manager.heads(SESSION);
    assertEqual('② 端口负控：wal_head 不动', headsAfterProbe?.wal_head, headsBefore.wal_head);
    assertEqual('② 端口负控：holes 仍为空', headsAfterProbe?.holes.length, 0);

    // ══════════════════════════════════════ ③ count == 实收（serve 口径）
    const heads = await on.manager.heads(SESSION);
    if (heads === undefined) {
      fail('③ heads 可取（写者还活着）');
    } else {
      const hello = timelineHello({ afterTimelineSeq: 0, heads });
      const page = await on.manager.readPage(SESSION, {
        afterSeq: 0,
        untilSeq: hello.end_seq,
        limit: 500,
      });
      assertEqual('③ count == 分页实收条数', hello.count, page.length);
      assertEqual('③ count == 落盘记录条数', hello.count, persisted.length);
      assertEqual('③ hello 的洞区间为空', hello.holes.length, 0);
      // 判据自检：把右端推到「瞬时 chunk 也占号」的样子 ⇒ count 必须比实收多出它们。
      // 这条证明 `count == 实收` 不是恒真断言 —— 照取 seq 不落盘，判据立刻红。
      const inflated = timelineHello({
        afterTimelineSeq: 0,
        heads: {
          ...heads,
          wal_head: heads.wal_head + transientCount,
          published_head: heads.published_head + transientCount,
        },
      });
      assertEqual(
        '③ 判据自检：若瞬时 chunk 也占号，count 会比实收多出它们的条数',
        inflated.count,
        persisted.length + transientCount,
      );
      judge(
        '③ 判据自检：多出来的那一截正是「已发布未落盘」会被判红的形态',
        inflated.count !== hello.count && transientCount > 0,
        `inflated=${String(inflated.count)} actual=${String(hello.count)} transient=${String(transientCount)}`,
      );
    }

    // ══════════════════════════════════════ ④ 刷新后逐字复原
    const persistedKeys = new Set([`${RUN}\u0000llm.stream.chunk`]);
    void persistedKeys;
    const liveKeys = on.live.map(eventKeyOf);
    const persistedKeysAll = persisted.map((record) =>
      eventKeyOf({ run_id: record.run_id, type: record.type, ts: record.ts }),
    );
    const missing = multisetDiff(liveKeys, persistedKeysAll);
    const missingEvents = on.live.filter((event) => missing.includes(eventKeyOf(event)));
    const unexpected = missingEvents.filter(
      (event) => !isTransientChunkEvent(event) && !PRE_EXISTING_NON_PERSISTED.has(event.type),
    );
    judge(
      '④ 实时有、落盘没有的，只有「瞬时 chunk」和「本来就不落盘的类型」',
      unexpected.length === 0,
      `missing=${String(missingEvents.length)}（瞬时 chunk ${String(transientCount)} + 非持久化 ${String(missingEvents.length - transientCount)}），越界=${JSON.stringify(unexpected.map((event) => event.type))}`,
    );
    assertEqual(
      '④ 瞬时 chunk 在落盘侧 0 条',
      persisted.filter((record) => isTransientChunkEvent(record)).length,
      0,
    );
    const extraOnDisk = multisetDiff(persistedKeysAll, liveKeys);
    assertEqual('④ 落盘侧没有凭空多出来的事件', extraOnDisk.length, 0);

    // 折叠对照：live（去掉本来不落盘的类型）vs 落盘。
    //
    // **两边都按事件时间（`ts`）归并**，因为两边的「到达序」本来就不是同一个东西：
    // 落盘那份的顺序是 seq 序，而 seq 的分配点在写者的队列里 —— 事实事件要等旧链路的
    // `append` resolve 之后才轮到它取号（`run-journal.ts#enqueuePersistedEvent` 的 `.then`），
    // 所以**紧跟在事实后面的 chunk 会先拿到更小的 seq**。这是双写旁路的既有性质，
    // 与本单（瞬时 chunk 不占号）无关，本判据也判不了它 —— 下面把这件事显式量出来，
    // 再按事件时间归并后比内容，既不掩盖、也不混判。
    const liveForFold = orderByEventTime(
      on.live.filter((event) => !PRE_EXISTING_NON_PERSISTED.has(event.type)),
    );
    const diskForFold = orderByEventTime(persisted);
    const seqOrder = persisted.map((record) => record.ts);
    const timeOrder = [...seqOrder].sort((left, right) => left - right);
    const inversions = seqOrder.filter((ts, index) => ts !== timeOrder[index]).length;
    console.log(
      `       顺序注记（既有性质，非本单）：落盘 seq 序里有 ${String(inversions)}/${String(seqOrder.length)} 条与事件时间序不一致 —— 事实的 seq 在旧链路 append 之后才取`,
    );
    const liveGroup = buildGroup(
      RUN,
      foldEntries(liveForFold, (index) => index + 1),
    );
    const diskGroup = buildGroup(
      RUN,
      foldEntries(
        diskForFold.map((record) => ({
          type: record.type,
          run_id: record.run_id,
          ts: record.ts,
          data: record.data,
        })),
        (index) => index + 1,
      ),
    );
    const liveView = JSON.stringify(stripIdentity(liveGroup));
    const diskView = JSON.stringify(stripIdentity(diskGroup));
    judge(
      '④ 刷新重建 == 流式期间的折叠结果（整份逐字）',
      liveView === diskView,
      liveView === diskView
        ? `items=${String(liveGroup.items.length)}`
        : `live=${liveView.slice(0, 400)} disk=${diskView.slice(0, 400)}`,
    );

    const liveCards = toolCardsOf(liveGroup);
    const diskCards = toolCardsOf(diskGroup);
    assertEqual('④ 工具卡张数一致', diskCards.length, liveCards.length);
    assertEqual(
      '④ 工具卡 name == 流式期间那一张',
      diskCards.map((card) => card.name),
      liveCards.map((card) => card.name),
    );
    assertEqual(
      '④ 工具卡 args 逐字（从 tool.call.started 复原）',
      diskCards.map((card) => JSON.stringify(card.args)),
      liveCards.map((card) => JSON.stringify(card.args)),
    );
    assertEqual(
      '④ 工具卡 result 逐字（从 tool.call.completed 复原）',
      diskCards.map((card) => JSON.stringify(card.result)),
      liveCards.map((card) => JSON.stringify(card.result)),
    );
    assertEqual(
      '④ 工具卡终态一致（running/done/error）',
      diskCards.map((card) => card.status),
      liveCards.map((card) => card.status),
    );
    for (const card of diskCards) {
      console.log(
        `       工具卡 ${card.name}(${card.status}) args=${JSON.stringify(card.args)} result=${JSON.stringify(card.result)}`,
      );
    }
    // 参数等价：流式期间一段段画出去的 arguments 文本，解析出来就是工具卡上的那个对象。
    // 片段按 `tool_call_index` 归并、以 `finish` 为一次响应的边界（每个响应各自从 0 编号，
    // 与 provider/`StreamAccumulator` 一致）。
    const streamedCalls: Array<{ id?: string; text: string }> = [];
    let openFragments = new Map<number, { id?: string; text: string }>();
    for (const step of script) {
      const chunk = (
        step.event.data as {
          chunk?: {
            type?: string;
            tool_call_index?: number;
            tool_call_id?: string;
            arguments_delta?: string;
          };
        }
      ).chunk;
      if (chunk?.type === 'finish') {
        streamedCalls.push(...openFragments.values());
        openFragments = new Map();
        continue;
      }
      if (chunk?.type !== 'tool_call_delta') continue;
      const index = chunk.tool_call_index ?? 0;
      const entry = openFragments.get(index) ?? { text: '' };
      if (chunk.tool_call_id !== undefined) entry.id = chunk.tool_call_id;
      entry.text = `${entry.text}${chunk.arguments_delta ?? ''}`;
      openFragments.set(index, entry);
    }
    streamedCalls.push(...openFragments.values());
    const startedArgs = new Map<string, unknown>();
    for (const step of script) {
      if (step.event.type !== 'tool.call.started') continue;
      const data = step.event.data as { tool_call_id?: string; arguments?: unknown };
      if (data.tool_call_id !== undefined) startedArgs.set(data.tool_call_id, data.arguments);
    }
    let argsEquivalent = streamedCalls.length > 0 && streamedCalls.length === startedArgs.size;
    for (const call of streamedCalls) {
      const parsed: unknown = (() => {
        try {
          return JSON.parse(call.text);
        } catch {
          return undefined;
        }
      })();
      if (call.id === undefined) argsEquivalent = false;
      else if (JSON.stringify(parsed) !== JSON.stringify(startedArgs.get(call.id)))
        argsEquivalent = false;
    }
    judge(
      '④ 流式画出去的参数文本 == `tool.call.started.arguments`（逐字等价）',
      argsEquivalent,
      `工具调用 ${String(streamedCalls.length)} 个`,
    );

    // ══════════════════════════════════════ ⑤ 体量前后对照
    const beforeVolume = await replayVolume('before', script);
    const afterVolume: ReplayVolume = {
      files: survey.files,
      bytes: survey.bytes,
      frames: survey.records.length,
    };
    const expectedFrames = beforeVolume.frames - transientCount;
    assertEqual('⑤ 帧数：旧行为 − 瞬时 chunk == 现在', expectedFrames, afterVolume.frames);
    assertEqual(
      '⑤ 旧行为里瞬时 chunk 确实全部进块了',
      beforeVolume.frames - persistedChunkSteps.length,
      transientCount,
    );
    const headerOnly = survey.records.reduce(
      (sum, record) => sum + 12 + Buffer.byteLength(JSON.stringify(record), 'utf8'),
      0,
    );
    assertEqual(
      '⑤ 块字节 == Σ(12 B 帧头 + 记录 JSON)（没有别的放大）',
      headerOnly,
      afterVolume.bytes,
    );
    console.log('       体量前后对照（同一条流，同一把尺子）');
    console.log(
      `         旧行为（瞬时也进块）：块数=${String(beforeVolume.files)} 帧数=${String(beforeVolume.frames)} 字节=${formatBytes(beforeVolume.bytes)}`,
    );
    console.log(
      `         现在（瞬时只走实时）：块数=${String(afterVolume.files)} 帧数=${String(afterVolume.frames)} 字节=${formatBytes(afterVolume.bytes)}`,
    );
    console.log(
      `         省下：帧数 ${String(beforeVolume.frames - afterVolume.frames)}（${pct(beforeVolume.frames - afterVolume.frames, beforeVolume.frames)}）字节 ${formatBytes(beforeVolume.bytes - afterVolume.bytes)}（${pct(beforeVolume.bytes - afterVolume.bytes, beforeVolume.bytes)}）块数 ${String(beforeVolume.files - afterVolume.files)}`,
    );
    judge(
      '⑤ 字节真的少了（省下来的正是那些帧的固定元数据）',
      afterVolume.bytes < beforeVolume.bytes,
      `${String(beforeVolume.bytes)} → ${String(afterVolume.bytes)}`,
    );
  } finally {
    await on.manager.closeAll().catch(() => {});
  }
}

/** 按事件时间归并（`ts` 相同则保序）—— 与 `events.ts#orderEntriesByEventTime` 同口径。 */
function orderByEventTime<T extends { ts: number }>(events: readonly T[]): T[] {
  return [...events].sort((left, right) => left.ts - right.ts);
}

/** 真机对照：读磁盘会话，把同一批帧按旧/新两种路由各重放一次（同 pacing）。 */
async function runRealSession(idOrPrefix: string): Promise<void> {
  const sessionsDir = process.env.VESSEL_SESSIONS ?? 'C:/Users/Lirui/.vessel/data/sessions';
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    console.log(`[SKIP] 真机对照：会话根目录不可读（${sessionsDir}）`);
    return;
  }
  const dirName = names.find((name) => name.startsWith(idOrPrefix) && !name.endsWith('.json'));
  if (dirName === undefined) {
    console.log(`[SKIP] 真机对照：找不到会话 ${idOrPrefix}`);
    return;
  }
  const sessionDir = join(sessionsDir, dirName);
  const survey = await surveyBlocks(sessionDir);
  const bySubtype = new Map<string, { frames: number; bytes: number; deltaBytes: number }>();
  for (const record of survey.records) {
    const subtype = chunkSubtypeOf(record) ?? '(none)';
    const payloadBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
    const data = record.data as { chunk?: { delta?: string; arguments_delta?: string } };
    const deltaBytes = Buffer.byteLength(
      data.chunk?.delta ?? data.chunk?.arguments_delta ?? '',
      'utf8',
    );
    const entry = bySubtype.get(subtype) ?? { frames: 0, bytes: 0, deltaBytes: 0 };
    entry.frames += 1;
    entry.bytes += 12 + payloadBytes;
    entry.deltaBytes += deltaBytes;
    bySubtype.set(subtype, entry);
  }
  console.log(`       真机会话 ${dirName}`);
  console.log(
    `         盘上现值（实时节流写的，块数不可比）：块数=${String(survey.files)} 帧数=${String(survey.records.length)} 字节=${formatBytes(survey.bytes)}`,
  );
  for (const [subtype, entry] of [...bySubtype.entries()].sort(
    (a, b) => b[1].frames - a[1].frames,
  )) {
    console.log(
      `           ${subtype.padEnd(16)} 帧=${String(entry.frames).padStart(6)} 帧字节=${String(entry.bytes).padStart(9)} 正文=${String(entry.deltaBytes).padStart(7)} 放大=${(entry.bytes / Math.max(1, entry.deltaBytes)).toFixed(0)}×`,
    );
  }

  // 读面实测：这个真会话（有工具调用）的 `count` 是否等于实收。口径与 serve 完全同一份代码
  // （`heads()` → `timelineHello()`），实收 = 全量读到的那份记录里落在有效区间内的条数。
  const reader = createTimelineDualWrite({
    dataDir: sessionsDir,
    sessionsDir,
    dualWrite: true,
    verifySampleRate: 0,
    archiveIntervalMs: 0,
    logger: quietLogger,
  });
  const heads = await reader.heads(dirName);
  if (heads === undefined) {
    fail('③（真机）heads 可读');
  } else {
    const hello = timelineHello({ afterTimelineSeq: 0, heads });
    const all = await readTimelineEvents(sessionDir);
    const effectiveEnd = Math.min(hello.wal_head, hello.published_head);
    const readable = all.filter(
      (record) => record.seq >= hello.start_seq && record.seq <= effectiveEnd,
    ).length;
    console.log(
      `         读面：wal_head=${String(hello.wal_head)} published_head=${String(hello.published_head)} timeline_head=${String(hello.timeline_head)} 洞=${String(hello.holes.length)} 记录=${String(all.length)}`,
    );
    assertEqual('③（真机）count == 实收条数', hello.count, readable);
    assertEqual('③（真机）count == 盘上记录条数（无未发布尾部）', hello.count, all.length);
    assertEqual('③（真机）holes 为空', hello.holes.length, 0);
  }

  const replay = async (
    label: string,
    keep: (record: TimelineRecord) => boolean,
  ): Promise<{ files: number; frames: number; bytes: number }> => {
    const root = await mkdtemp(join(tmpdir(), `vessel-chunk-slim-real-${label}-`));
    roots.push(root);
    const dir = join(root, 'session');
    await mkdir(dir, { recursive: true });
    const opened = await ChunkBlockStore.open(dir, { maxBytes: BLOCK_MAX_BYTES });
    const store = opened.store;
    let seq = 0;
    for (const record of survey.records) {
      if (!keep(record)) continue;
      seq += 1;
      store.push(
        stampRecord({
          v: 1,
          seq,
          session_id: record.session_id,
          run_id: record.run_id,
          ts: record.ts,
          type: record.type,
          data: record.data,
        }),
      );
      if (store.shouldSeal()) await store.seal();
    }
    await store.seal();
    await store.flushManifests();
    store.close();
    const after = await surveyBlocks(dir);
    return { files: after.files, frames: after.records.length, bytes: after.bytes };
  };
  const before = await replay('before', () => true);
  const after = await replay('after', (record) => !isTransientChunkEvent(record));
  console.log('       同一批帧、同一个封块策略（32 KiB 填满即封）下重放：');
  console.log(
    `         前后对照：块数 ${String(before.files)} → ${String(after.files)}　帧数 ${String(before.frames)} → ${String(after.frames)}（${pct(before.frames - after.frames, before.frames)}）　字节 ${formatBytes(before.bytes)} → ${formatBytes(after.bytes)}（省 ${pct(before.bytes - after.bytes, before.bytes)}）`,
  );
  judge(
    '⑤（真机）瞬时 chunk 的帧数归零',
    after.frames ===
      before.frames -
        [...bySubtype.entries()].reduce(
          (sum, [subtype, entry]) =>
            sum + (subtype === 'tool_call_delta' || subtype === 'finish' ? entry.frames : 0),
          0,
        ),
    `frames=${String(after.frames)}`,
  );
}

const REAL_FLAG = '--real-session=';
try {
  await runGate();
  const realArg = process.argv.find((arg) => arg.startsWith(REAL_FLAG))?.slice(REAL_FLAG.length);
  if (realArg !== undefined && realArg.length > 0) await runRealSession(realArg);
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log('');
console.log(`检查项 ${String(checks)} 条，失败 ${String(failures)} 条`);
if (failures > 0) {
  console.log(
    '结论：FAIL（瞬时 chunk 必须只走实时通道：不进块、不占 seq、刷新后由 tool.call.* 复原）',
  );
  process.exit(1);
}
console.log('结论：PASS（不进块 / 不占 seq / count==实收 / 刷新后工具卡逐字复原 / 体量下降）');
