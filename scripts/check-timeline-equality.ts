#!/usr/bin/env bun

/**
 * 0.54 A 阶段门禁：验收等式 **「UI == timeline(seq ≤ timeline_head) ∪ WAL(timeline_head < seq ≤ wal_head)」**
 * （ADR-105 §7 的 A1–A8；等式口径见 [unacked-queue-closure.md] §1）。
 *
 * 为什么这条门禁**必须存在且只此一条**：ADR-105 §11.1 实测「§7 点名的三个门禁尚未实现」，其中
 * `check-timeline-equality` 是唯一同时验「写者（WAL/timeline/holes）」与「客户端集合（UI）」
 * 两端的地方。其它 timeline 门禁各验一段：`-conformance`（写者 vs 参考实现）、`-holes`
 * （失败可声明）、`-index`（索引可重建）、`-archive`（归档/双指针）、`-dualwrite`（接线无副作用）、
 * `-perf`（延迟）；客户端那边 `check-reconnect`（退避 / 重连 hydrate，且不进 gates 链）。
 * **没有任何一条把「客户端 seq 集合 == 磁盘 seq 并集」当判据**，这正是本文件。
 *
 * ## 两端的定义（照 ADR-105 §7 原文，不改判据）
 *
 * - 右端「timeline ∪ WAL」= `readTimelineEvents(sessionDir)`：`timeline.ndjson`（归档段）+
 *   `wal.blocks/*.wblk`（chunk 块）+ `wal.log`（WAL 原文），按 `seq` 去重升序
 *   （`packages/core/src/timeline/wal.ts:333-351`）。它是**磁盘上的可枚举事实**。
 * - 左端「UI」= **真 `EventStore`**（`apps/web/src/state/event-store.ts`，ADR-105 §7 点名的
 *   `EventStore.entries` 里 `seq > 0` 的那部分）。喂它的只有两个入口，与线上同一条：
 *   ① 写者的 `publish` 回调（ADR-105 §3 I2 的**唯一发布点**，= WS/SSE 帧的来源）；
 *   ② 重连后的排他游标拉取（§6 的单游标握手：`after_timeline_seq = 本端已收到的最大 seq`）。
 *
 *   说明一条**不是**放宽判据的取舍：客户端不复刻 §6 的四条 `count` 校验（那是 A7，今天就缺，
 *   见下），本文件只把它当成「收到就进环」的客户端；`count` 校验缺席这件事在 A7 里
 *   显式报 `NOT_IMPLEMENTED`，不会被这里吸收掉。
 *
 * ## 逐条覆盖（A1–A8 的名字逐字来自 ADR-105 §7）
 *
 * | # | 断言 | 本文件的构造 |
 * | --- | --- | --- |
 * | A1 | `seqSet(UI) === seqSet(timeline ∪ WAL)` + 逐条 `(type, run_id, ts, sha256(data))` | 写入→断开（丢帧）→重连→拉全量 |
 * | A2 | 归档并行（归档到一半断开）⇒ A1 仍成立 | ① `timeline_head < wal_head` 窗口内断线重连；② 窗口内进程退出重启；③ 段文件 fsync 半途失败后回滚重试 |
 * | A3 | 注入归档失败（I3）⇒ A1 仍成立，`timeline_head` 停旧值、`wal_head` 已前进 | `beforeSync('timeline')` 恒失败 + 重试计数 |
 * | A4 | 注入磁盘坏块 ⇒ `holes` 恰好覆盖坏区间、`seqSet(UI) ⊎ holes === 闭区间`、UI 不空白 | 改写块内一帧载荷（帧头保留）→ 重启登记洞 |
 * | A5 | `published_head` 单调（重启前后 `wal_head` 不下降；握手报过的最大 seq 之后无更小的新 seq） | 跨两代 writer 的发布序列 + 撕裂尾帧重分配 |
 * | A6 | chunk / `tool.call.*` / `context.changed` 交织 ⇒ UI 的 seq 严格升序且无空洞 | 离线夹具（不进 UI 渲染面，只进 EventStore 环） |
 * | A7 | 游标篡改（+1 / −1 / 洞内）⇒ 客户端拒绝合并并报 `timeline_gap_reported` | **未实现**（C 阶段），见文件末尾 A7 段与证据表 |
 * | A8 | 旧格式会话：`after_timeline_seq` 订阅返回 `session_frozen_readonly`；`sessions.events` / `events.list` 逐字节不变 | 前半未实现（C 阶段）；后半是真回归夹具（快照逐字节） |
 *
 * ## 与已有 A5 探针的关系（ADR-105 §11.1 点名，**不复制粘贴**）
 *
 * - `scripts/check-timeline-holes.ts:85-89` 断言的是「注入 WAL fsync 失败后重启，`publishedHead()`
 *   **读数**不下降」—— 单点、单次重启、聚焦失败路径。
 * - `scripts/check-timeline-archive.ts:353-358` 断言的是「重启后**纯磁盘口径**算出的
 *   `timeline_head` / `wal_head` 不回退」—— 走的是双写装配层（`src/timeline-dual-write.ts`）。
 * - 本文件的 A5 不复用上面任何夹具/注入，独立构造，并且判据更硬一档：不只比「读数不下降」，
 *   还断言 **重启后新分配的每个 seq 都大于重启前对外报过的最大 seq**（I1「已发布不复用」的
 *   精确判据，ADR-105 §3 I1 末段），以及**跨重启的发布流整体严格升序**、撕裂尾帧重分配的
 *   seq 仍 > `published_head`。读数单调是它的必要条件，不是充分条件。
 *
 * ## 用法
 *
 * ```
 * bun run scripts/check-timeline-equality.ts            # FAIL ⇒ 退出码 1
 * bun run scripts/check-timeline-equality.ts --strict   # NOT_IMPLEMENTED 也算红（等 C 阶段落地后串 gates 用）
 * ```
 *
 * 默认（非 strict）只让 **FAIL** 变成退出码 1：今天 A7 与 A8 的一半**确实没实现**（证据在文件里），
 * 把它们算成红会让整条 gates 链永久红、从而被绕过。但它们在汇总里**逐条列出**，且
 * `--strict` 一开就是红 —— 不许理解成「跳过」。
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from '../apps/web/src/gateway/types';
import { EventStore } from '../apps/web/src/state/event-store';
import type { StoredEvent } from '../apps/web/src/state/events';
import type { ReadTraceOptions } from '../packages/core/src/index';
import { readTraceEvents, SessionEventLog, sessionDirPath } from '../packages/core/src/index';
import {
  TIMELINE_LAYOUT,
  type TimelineAppendInput,
  type TimelineHeads,
  type TimelineRecord,
  type TimelineSyncKind,
} from '../packages/core/src/timeline/types';
import {
  CHUNK_FRAME_HEADER_BYTES,
  readAllBlocks,
  readNdjsonFile,
  readTimelineEvents,
} from '../packages/core/src/timeline/wal';
import { TimelineWriter } from '../packages/core/src/timeline/writer';
import { createEventsMethods } from '../packages/serve/src/gateway/methods/observability';
import { createSessionMethods } from '../packages/serve/src/gateway/methods/sessions';
import { createSessionEventsSource } from '../src/session-events';

const STRICT = process.argv.includes('--strict');
const NOW = 1_760_000_000_000;

// ───────────────────────────────────────────────────────────────── 断言脚手架

let checkCount = 0;
let failureCount = 0;

type ItemStatus = 'pass' | 'fail' | 'partial' | 'NOT_IMPLEMENTED';
type ItemId = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8';

interface ItemState {
  checks: number;
  failed: number;
  notImplemented: string | undefined;
}

const items = new Map<ItemId, ItemState>();

let currentItem: ItemId = 'A1';

function beginItem(id: ItemId): void {
  currentItem = id;
  console.log('');
  console.log(`── ${id} ${'-'.repeat(Math.max(0, 68 - id.length))}`);
  items.set(id, { checks: 0, failed: 0, notImplemented: undefined });
}

function state(): ItemState {
  const found = items.get(currentItem);
  if (found === undefined) throw new Error(`item ${currentItem} not begun`);
  return found;
}

function pass(name: string, detail = ''): void {
  checkCount += 1;
  state().checks += 1;
  console.log(`[PASS] ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string): void {
  checkCount += 1;
  failureCount += 1;
  const item = state();
  item.checks += 1;
  item.failed += 1;
  console.log(`[FAIL] ${name} — ${detail}`);
}

/** 证据行：**不**计数、**不**当判据（只用于把「今天的行为」写进输出）。 */
function evidence(name: string, detail: string): void {
  console.log(`[EVIDENCE] ${name} — ${detail}`);
}

function assertTrue(name: string, condition: boolean, detail = ''): void {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  assertTrue(name, actual === expected, `actual=${String(actual)} expected=${String(expected)}`);
}

/**
 * 逐字节比较（只给长度 + 第一个差异位置：整份 JSON 打出来会把判据刷到看不见）。
 */
function assertBytes(name: string, actual: string, expected: string): void {
  if (actual === expected) {
    pass(name, `${String(actual.length)} bytes 完全相同`);
    return;
  }
  let offset = 0;
  while (
    offset < actual.length &&
    offset < expected.length &&
    actual[offset] === expected[offset]
  ) {
    offset += 1;
  }
  fail(
    name,
    `字节不同：actual=${String(actual.length)}B expected=${String(expected.length)}B，第一个差异在 offset=${String(offset)}`,
  );
}

/** 一个 item 里的一条「未实现」声明（不带任何恒真断言）。 */
function notImplemented(name: string, reason: string): void {
  const item = state();
  item.notImplemented = reason;
  console.log(`[NOT_IMPLEMENTED] ${name} — ${reason}`);
}

// ───────────────────────────────────────────────────────────────── 记录指纹

/** 稳定序列化：对象键排序（磁盘回读的键序与内存里的键序不一定相同，不能靠它）。 */
function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

/** `sha256(data)`（ADR-105 §7 A1 原文要求的那一项）。 */
function sha256Data(data: unknown): string {
  return createHash('sha256').update(canonical(data)).digest('hex');
}

/** 一条事件的判等元组：`(seq, type, run_id, ts, sha256(data))`。 */
interface Signature {
  seq: number;
  type: string;
  run_id: string;
  ts: number;
  sha: string;
}

function signatureOf(record: {
  seq: number;
  type: string;
  run_id: string;
  ts: number;
  data: unknown;
}): Signature {
  return {
    seq: record.seq,
    type: record.type,
    run_id: record.run_id,
    ts: record.ts,
    sha: sha256Data(record.data),
  };
}

function signatureLine(signature: Signature): string {
  return `${String(signature.seq)}|${signature.type}|${signature.run_id}|${String(signature.ts)}|${signature.sha}`;
}

/** 逐条比较两组元组（顺序按 seq 升序）。返回第一处差异的可读描述（相同则 `undefined`）。 */
function firstDifference(
  actual: readonly Signature[],
  expected: readonly Signature[],
): string | undefined {
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    const left = actual[index];
    const right = expected[index];
    if (left === undefined || right === undefined) {
      return `index=${String(index)} actual=${left === undefined ? 'none' : signatureLine(left)} expected=${right === undefined ? 'none' : signatureLine(right)}`;
    }
    if (signatureLine(left) !== signatureLine(right)) {
      return `seq=${String(right.seq)} actual=${signatureLine(left)} expected=${signatureLine(right)}`;
    }
  }
  return undefined;
}

/** 日志里的长列表要截断（判据仍然逐项比较，只是不把 520 个数字刷满屏）。 */
function brief(values: readonly number[]): string {
  const text = values.join(',');
  if (text.length <= 120) return text;
  const head = values.slice(0, 6).join(',');
  const tail = values.slice(-3).join(',');
  return `${head},…,${tail}（共 ${String(values.length)} 项）`;
}

function assertSameSet(name: string, actual: readonly number[], expected: readonly number[]): void {
  const left = [...new Set(actual)].sort((a, b) => a - b);
  const right = [...new Set(expected)].sort((a, b) => a - b);
  const same = left.length === right.length && left.every((value, index) => value === right[index]);
  if (same) {
    const first = left[0];
    const last = left[left.length - 1];
    pass(
      name,
      `${String(left.length)} 个 seq 相同${first === undefined || last === undefined ? '' : `（${String(first)}..${String(last)}）`}`,
    );
    return;
  }
  fail(name, `actual=${brief(left)} expected=${brief(right)}`);
}

function assertSameSignatures(
  name: string,
  actual: readonly Signature[],
  expected: readonly Signature[],
): void {
  const sorted = [...actual].sort((a, b) => a.seq - b.seq);
  const wanted = [...expected].sort((a, b) => a.seq - b.seq);
  const diff = firstDifference(sorted, wanted);
  if (diff === undefined) pass(name, `${String(wanted.length)} 条逐条相同`);
  else fail(name, diff);
}

// ───────────────────────────────────────────────────────────────── 夹具基础

interface Fixture {
  root: string;
  sessionsDir: string;
  sessionId: string;
  sessionDir: string;
}

const roots: string[] = [];

async function createFixture(sessionId: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `vessel-eq-${sessionId}-`));
  roots.push(root);
  const sessionsDir = join(root, 'sessions');
  const sessionDir = sessionDirPath(sessionsDir, sessionId);
  await mkdir(sessionDir, { recursive: true });
  return { root, sessionsDir, sessionId, sessionDir };
}

function input(runId: string, index: number, type: string, data: unknown): TimelineAppendInput {
  return { run_id: runId, type, ts: NOW + index, data };
}

/** chunk 的载荷必须是「产时间线产物」的形状（`events.ts#producesTimelineItem`），否则 UI 会当成噪声丢。 */
function chunk(index: number, text: string): TimelineAppendInput {
  return input('run-1', index, 'llm.stream.chunk', {
    chunk: { type: 'text_delta', delta: text },
  });
}

/** 右端：磁盘上的 timeline ∪ WAL（`timeline.ndjson` + `wal.blocks/*` + `wal.log`，按 seq 去重）。 */
function diskUnion(sessionDir: string): Promise<TimelineRecord[]> {
  return readTimelineEvents(sessionDir);
}

function diskSignatures(records: readonly TimelineRecord[]): Signature[] {
  return records.map((record) => signatureOf(record));
}

/** 归档段（`timeline.ndjson`）里的 seq。 */
async function archivedSeqs(sessionDir: string): Promise<number[]> {
  const read = await readNdjsonFile(join(sessionDir, TIMELINE_LAYOUT.timeline));
  return read.records.map((record) => record.seq).sort((a, b) => a - b);
}

/** WAL 原文（`wal.log`）里的 seq。 */
async function walSeqs(sessionDir: string): Promise<number[]> {
  const read = await readNdjsonFile(join(sessionDir, TIMELINE_LAYOUT.walLog));
  return read.records.map((record) => record.seq).sort((a, b) => a - b);
}

interface BlockView {
  name: string;
  seqs: number[];
  types: string[];
}

/** WAL 的 chunk 块（`wal.blocks/*.wblk`）逐个解码后的 seq 区间。 */
async function blockViews(sessionDir: string): Promise<BlockView[]> {
  const blocks = await readAllBlocks(sessionDir);
  return blocks.map((block) => ({
    name: block.name,
    seqs: block.decode.records.map((record) => record.seq),
    types: block.decode.records.map((record) => record.type),
  }));
}

function closedRange(fromSeq: number, toSeq: number): number[] {
  const out: number[] = [];
  for (let seq = fromSeq; seq <= toSeq; seq += 1) out.push(seq);
  return out;
}

function holeSeqs(holes: TimelineHeads['holes']): number[] {
  const out: number[] = [];
  for (const hole of holes) {
    for (let seq = hole.from_seq; seq <= hole.to_seq; seq += 1) out.push(seq);
  }
  return out;
}

/** 左端：一个**新的**客户端（= 刷新后重连的页面），游标从 0 起。 */
function newClient(): EventStore {
  const store = new EventStore(1_000);
  stores.push(store);
  return store;
}

/** 存活的客户端（结束前一起 `destroy()`：它们在等 50ms/1s 的合批定时器）。 */
const stores: EventStore[] = [];

function pushRecord(store: EventStore, record: TimelineRecord): boolean {
  const event: RunEvent = {
    type: record.type,
    run_id: record.run_id,
    ts: record.ts,
    // 类型层面 `RunEvent.data` 是 `Record<string, unknown>`；本文件的夹具都是对象载荷，
    // 值本身原样透传（不做任何包装，否则 `sha256(data)` 的逐条比较就失去意义）。
    data: record.data as Record<string, unknown>,
  };
  return store.push(event, { seq: record.seq });
}

/** UI 侧条目（`seq > 0` 的那部分，ADR-105 §7 原文口径）。 */
function uiEntries(store: EventStore): StoredEvent[] {
  store.flush();
  return store.getSnapshot().entries.filter((entry) => entry.seq > 0);
}

function uiSignatures(store: EventStore): Signature[] {
  return uiEntries(store).map((entry) =>
    signatureOf({
      seq: entry.seq,
      type: entry.event.type,
      run_id: entry.event.run_id,
      ts: entry.event.ts,
      data: entry.event.data,
    }),
  );
}

function uiSeqs(store: EventStore): number[] {
  return uiEntries(store).map((entry) => entry.seq);
}

function uiTypes(store: EventStore): string[] {
  return uiEntries(store).map((entry) => entry.event.type);
}

/**
 * 重连后的「拉全量」：§6 的单游标握手，`after_timeline_seq = 本端已收到的最大 seq`（**排他**），
 * 每页 ≤ 500 条，页间游标接力（ADR-105 §6 分页那一行）。返回本次真正进环的 seq。
 */
async function pullAll(
  store: EventStore,
  sessionDir: string,
  pageSize = 500,
): Promise<{ accepted: number[]; pages: number }> {
  const records = await diskUnion(sessionDir);
  const accepted: number[] = [];
  let cursor = store.currentSeq;
  let pages = 0;
  for (;;) {
    const page = records.filter((record) => record.seq > cursor).slice(0, pageSize);
    if (page.length === 0) break;
    pages += 1;
    for (const record of page) {
      if (pushRecord(store, record)) accepted.push(record.seq);
    }
    const last = page[page.length - 1];
    if (last === undefined) break;
    cursor = last.seq;
  }
  store.flush();
  return { accepted, pages };
}

interface Harness {
  writer: TimelineWriter;
  /** 写者 `publish` 回调收到的全部记录（= UI 帧的去向，ADR-105 §3 I2 的唯一发布点）。 */
  published: TimelineRecord[];
  /** 断开标记：`false` 时发布**记录**但**不投递**给客户端（模拟断线期间丢帧）。 */
  setLive(value: boolean): void;
}

interface HarnessOptions {
  publish?: (record: TimelineRecord) => void;
  beforeSync?: (kind: TimelineSyncKind) => void;
  onArchiveFailed?: (info: { from_seq: number; to_seq: number; reason: string }) => void;
  chunkFlushMs?: number;
}

async function openWriter(fixture: Fixture, options: HarnessOptions = {}): Promise<Harness> {
  const published: TimelineRecord[] = [];
  let live = true;
  const writer = await TimelineWriter.open({
    sessionId: fixture.sessionId,
    sessionDir: fixture.sessionDir,
    // 1000 ms：让封块**只**由显式动作（factStep / flush / close）触发，块边界才可预测。
    // 空闲封块的时序（③ 150 ms）由 `check-timeline-perf` / `-conformance` 验，不在本文件。
    chunkFlushMs: options.chunkFlushMs ?? 1_000,
    publish: (record) => {
      published.push(record);
      if (live) options.publish?.(record);
    },
    ...(options.beforeSync !== undefined ? { beforeSync: options.beforeSync } : {}),
    ...(options.onArchiveFailed !== undefined ? { onArchiveFailed: options.onArchiveFailed } : {}),
  });
  return {
    writer,
    published,
    setLive: (value: boolean) => {
      live = value;
    },
  };
}

function publishedSeqs(published: readonly TimelineRecord[]): number[] {
  return published.map((record) => record.seq);
}

/** 发布序列必须严格升序（I2：fsync 之后才发布 ⇒ 不可能出现「小 seq 后到」）。 */
function strictlyAscending(seqs: readonly number[]): { ok: boolean; detail: string } {
  for (let index = 1; index < seqs.length; index += 1) {
    const previous = seqs[index - 1];
    const current = seqs[index];
    if (previous === undefined || current === undefined) continue;
    if (current <= previous)
      return {
        ok: false,
        detail: `index=${String(index)} prev=${String(previous)} cur=${String(current)}`,
      };
  }
  return { ok: true, detail: `${String(seqs.length)} 个 seq 严格升序` };
}

/** 无空洞：从 `fromSeq` 起逐条 +1。 */
function contiguous(seqs: readonly number[], fromSeq = 1): { ok: boolean; detail: string } {
  for (let index = 0; index < seqs.length; index += 1) {
    const expected = fromSeq + index;
    const actual = seqs[index];
    if (actual !== expected) {
      return {
        ok: false,
        detail: `index=${String(index)} expected=${String(expected)} actual=${String(actual)}`,
      };
    }
  }
  return { ok: true, detail: `${String(seqs.length)} 条从 ${String(fromSeq)} 起连续` };
}

/**
 * 在块文件里把某个 seq 的帧**载荷**整段改写成空格（帧头 8+4 字节原样保留）——模拟磁盘坏块。
 *
 * 为什么保留帧头：坏块的判据是「完整帧、载荷不可用」（`wal.ts#decodeChunkBlock` 的
 * `invalid` 分支），帧头坏掉会被当成撕裂尾帧（`torn`）而截断，两者语义不同（ADR-105 §6）。
 */
async function corruptChunkFrame(blockPath: string, seq: number): Promise<void> {
  const buffer = await readFile(blockPath);
  let offset = 0;
  while (offset + CHUNK_FRAME_HEADER_BYTES <= buffer.length) {
    const frameSeq = Number(buffer.readBigUInt64LE(offset));
    const length = buffer.readUInt32LE(offset + CHUNK_FRAME_HEADER_BYTES - 4);
    const payloadStart = offset + CHUNK_FRAME_HEADER_BYTES;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > buffer.length) break;
    if (frameSeq === seq) {
      buffer.fill(0x20, payloadStart, payloadEnd);
      await writeFile(blockPath, buffer);
      return;
    }
    offset = payloadEnd;
  }
  throw new Error(`frame seq=${String(seq)} not found in ${blockPath}`);
}

// ───────────────────────────────────────────────────────────────── A1

/**
 * A1：夹具会话跑「写入 → 断开 → 重连 → 拉全量」。
 *
 * 断开期间**故意继续写**：那几条帧客户端一条都没收到 —— 不这么造，「重连拉全量」这一半
 * 就永远是空操作（拉 0 条也能过）。等式成立必须靠「磁盘能补上 UI 没见过的」。
 */
async function checkA1(): Promise<void> {
  beginItem('A1');
  const fixture = await createFixture('a1-equality');
  const store = newClient();
  const harness = await openWriter(fixture, {
    publish: (record) => {
      pushRecord(store, record);
    },
  });
  const { writer } = harness;

  const script: TimelineAppendInput[] = [
    input('run-1', 0, 'run.started', { run_id: 'run-1', session_id: fixture.sessionId }),
    input('run-1', 1, 'user.message', { text: 'A1 hello' }),
    input('run-1', 2, 'llm.request', {
      model: 'eq-probe',
      messages: [{ role: 'user', content: 'A1 hello' }],
    }),
    chunk(3, 'he'),
    chunk(4, 'llo'),
    input('run-1', 5, 'llm.response', { content: 'hello', usage: { total_tokens: 3 } }),
    input('run-1', 6, 'tool.call.started', { tool_call_id: 'call-1', tool_name: 'bash' }),
    input('run-1', 7, 'tool.call.completed', { tool_call_id: 'call-1', result: 'ok' }),
    input('run-1', 8, 'assistant.message', { text: 'done' }),
    input('run-1', 9, 'run.completed', { run_id: 'run-1', status: 'completed' }),
  ];

  // ① 在线：写前 5 条，发布 → UI。
  for (const item of script.slice(0, 5)) await writer.append(item);
  await writer.flush();
  const liveSignatures = uiSignatures(store);
  const liveDisk = diskSignatures(await diskUnion(fixture.sessionDir));
  assertSameSignatures(
    'A1 在线阶段 UI == timeline ∪ WAL（I2「发布 ⊆ 磁盘」的第一半）',
    liveSignatures,
    liveDisk,
  );
  assertEqual('A1 在线阶段 UI 收齐 5 条', liveSignatures.length, 5);

  // ② 断开：停止投递帧，但写者继续写后 5 条（这正是线上「断线期间的事实」）。
  harness.setLive(false);
  for (const item of script.slice(5)) await writer.append(item);
  await writer.flush();
  const duringUi = uiSeqs(store);
  const duringDisk = await diskUnion(fixture.sessionDir);
  assertEqual('A1 断线窗口：UI 仍停在 5 条（后 5 条帧真的没收到）', duringUi.length, 5);
  assertEqual('A1 断线窗口：磁盘已前进到 10 条', duringDisk.length, script.length);
  assertEqual(
    'A1 断线窗口：UI 仍是 [1..5]（后 5 条的帧一条都没收到）',
    duringUi.join(','),
    '1,2,3,4,5',
  );
  const diskSeqList = duringDisk.map((record) => record.seq);
  assertTrue(
    'A1 断线窗口：UI 集合是磁盘集合的真子集（等式此刻本就不该成立）',
    duringUi.length < diskSeqList.length && duringUi.every((seq) => diskSeqList.includes(seq)),
    `ui=${String(duringUi.length)} 条 disk=${String(diskSeqList.length)} 条`,
  );

  // ③ 重连 → 拉全量（§6 单游标：after_timeline_seq = 5，排他）。
  harness.setLive(true);
  const pull = await pullAll(store, fixture.sessionDir);
  assertEqual('A1 重连拉全量：补回断线期间漏掉的 5 条', pull.accepted.join(','), '6,7,8,9,10');

  const uiAfter = uiSignatures(store);
  const diskAfter = diskSignatures(await diskUnion(fixture.sessionDir));
  assertSameSet(
    'A1 seqSet(UI) === seqSet(timeline ∪ WAL)',
    uiSeqs(store),
    diskAfter.map((item) => item.seq),
  );
  assertSameSignatures('A1 逐条 (type, run_id, ts, sha256(data)) 相等', uiAfter, diskAfter);
  const seqOrder = strictlyAscending(uiSeqs(store));
  assertTrue('A1 UI 的 seq 严格升序', seqOrder.ok, seqOrder.detail);
  const noHoles = contiguous(uiSeqs(store));
  assertTrue('A1 UI 的 seq 无空洞', noHoles.ok, noHoles.detail);
  assertEqual('A1 UI 无重复 seq', new Set(uiSeqs(store)).size, uiSeqs(store).length);

  // ④ 幂等：再拉一次不许把同一条塞两遍（ADR-105 §6 第 4 条「无重复」）。
  const again = await pullAll(store, fixture.sessionDir);
  assertEqual('A1 二次拉全量不重复合并', again.accepted.length, 0);
  assertEqual('A1 二次拉全量后条数不变', uiSeqs(store).length, script.length);
  assertSameSignatures('A1 二次拉全量后内容不变', uiSignatures(store), uiAfter);

  await writer.close();

  // ⑤ 进程重启后的新客户端从磁盘重建：集合必须与断线前那个 UI 逐条相同。
  const restarted = newClient();
  const restartedPull = await pullAll(restarted, fixture.sessionDir);
  assertEqual(
    'A1 重启后新客户端拉全量条数 == 脚本条数',
    restartedPull.accepted.length,
    script.length,
  );
  assertSameSignatures(
    'A1 重启后新客户端 == 原 UI 集合（等式可重放）',
    uiSignatures(restarted),
    uiAfter,
  );

  // ⑥ 分页：一次「拉全量」超过一页（§6 每页 ≤ 500 条）时必须靠游标接力穷尽 ——
  // 否则「等式成立」只是「刚好没超一页」的巧合。
  const pageFixture = await createFixture('a1-paging');
  const pageHarness = await openWriter(pageFixture, {});
  const many: TimelineAppendInput[] = [];
  for (let index = 0; index < 520; index += 1) {
    many.push(input('run-page', index, 'assistant.message', { text: `page ${String(index)}` }));
  }
  await pageHarness.writer.appendMany(many);
  await pageHarness.writer.close();
  const pageClient = newClient();
  const pagePull = await pullAll(pageClient, pageFixture.sessionDir, 500);
  assertEqual('A1 ⑥ 分页拉全量：520 条 ⇒ 2 页（游标接力）', pagePull.pages, 2);
  assertEqual('A1 ⑥ 分页拉全量：一条不少', uiSeqs(pageClient).length, 520);
  assertSameSet(
    'A1 ⑥ 分页后集合 === 磁盘集合',
    uiSeqs(pageClient),
    (await diskUnion(pageFixture.sessionDir)).map((record) => record.seq),
  );
}

// ───────────────────────────────────────────────────────────────── A2

/**
 * A2：归档并行进行（归档到一半断开）⇒ A1 仍成立。
 *
 * 构造两种形态，都在 `timeline_head < wal_head` 的窗口里：
 * ① 归档只覆盖前缀（1..3）而写入继续到 6，此时断线 → 重连 → 等式成立；
 * ② 归档追到 6 之后又写了 7..9，**进程直接退出**（归档没跟上）→ 重启 → 等式仍成立。
 * 两种都必须证明「并集的两段各自完整」：归档段 = [1..timeline_head]，
 * WAL 原文 = (timeline_head..wal_head]，拼起来是闭区间且不重叠。
 */
async function checkA2(): Promise<void> {
  beginItem('A2');
  const fixture = await createFixture('a2-mid-archive');
  const store = newClient();
  const harness = await openWriter(fixture, {
    publish: (record) => {
      pushRecord(store, record);
    },
  });
  const { writer } = harness;

  const partOne: TimelineAppendInput[] = [
    input('run-1', 0, 'run.started', { run_id: 'run-1' }),
    input('run-1', 1, 'user.message', { text: 'A2 part 1' }),
    input('run-1', 2, 'assistant.message', { text: 'A2 answer 1' }),
  ];
  for (const item of partOne) await writer.append(item);
  await writer.flush();

  const archiveOne = await writer.archive();
  const headsOne = writer.heads();
  assertEqual('A2 ① 第一次归档成功', archiveOne.ok, true);
  assertEqual('A2 ① 归档后 timeline_head = 3', headsOne.timeline_head, 3);
  assertEqual(
    'A2 ① 归档后 timeline_head == wal_head（此时无窗口）',
    headsOne.timeline_head,
    headsOne.wal_head,
  );

  // 断线（归档「进行到一半」就断：这一段之后 UI 一条都收不到），写入继续。
  harness.setLive(false);
  const partTwo: TimelineAppendInput[] = [
    input('run-1', 3, 'llm.request', { model: 'eq-probe' }),
    input('run-1', 4, 'llm.response', { content: 'A2 answer 2' }),
    input('run-1', 5, 'tool.call.started', { tool_call_id: 'call-1', tool_name: 'bash' }),
  ];
  for (const item of partTwo) await writer.append(item);
  await writer.flush();

  const headsWindow = writer.heads();
  assertTrue(
    'A2 ① 制造出 timeline_head < wal_head 的窗口（3 < 6）',
    headsWindow.timeline_head === 3 && headsWindow.wal_head === 6,
    `timeline_head=${String(headsWindow.timeline_head)} wal_head=${String(headsWindow.wal_head)}`,
  );
  const archivedWindow = await archivedSeqs(fixture.sessionDir);
  assertEqual('A2 ① 归档段恰好 seq 1..3', archivedWindow.join(','), '1,2,3');
  assertEqual(
    'A2 ① 未归档区间 [4..6] 不在归档段里（只能从 WAL 读回）',
    archivedWindow.filter((seq) => seq > headsWindow.timeline_head).join(','),
    '',
  );
  assertEqual(
    'A2 ① WAL 原文覆盖 1..wal_head（归档是**复制**、不删 WAL：ADR-105 §10 第 5 项不授权 timeline 删除）',
    (await walSeqs(fixture.sessionDir)).join(','),
    '1,2,3,4,5,6',
  );
  assertEqual(
    'A2 ① 两段并集恰好 1..6（同一条在归档段与 WAL 各一份，按 seq 去重后每条只出现一次）',
    (await diskUnion(fixture.sessionDir)).map((record) => record.seq).join(','),
    '1,2,3,4,5,6',
  );

  const pullWindow = await pullAll(store, fixture.sessionDir);
  assertEqual('A2 ① 窗口内重连拉全量补回 3 条', pullWindow.accepted.join(','), '4,5,6');
  assertSameSignatures(
    'A2 ① 窗口内 A1 仍成立（UI == timeline ∪ WAL）',
    uiSignatures(store),
    diskSignatures(await diskUnion(fixture.sessionDir)),
  );

  // ② 归档追平 6，然后再写 7..9 就**不归档**，进程退出（= 归档没跟上就断开）。
  const archiveTwo = await writer.archive();
  assertEqual('A2 ② 第二次归档成功', archiveTwo.ok, true);
  assertEqual('A2 ② 归档后 timeline_head = 6', writer.heads().timeline_head, 6);
  const partThree: TimelineAppendInput[] = [
    input('run-1', 6, 'tool.call.completed', { tool_call_id: 'call-1', result: 'ok' }),
    input('run-1', 7, 'assistant.message', { text: 'A2 answer 3' }),
    input('run-1', 8, 'run.completed', { run_id: 'run-1', status: 'completed' }),
  ];
  for (const item of partThree) await writer.append(item);
  await writer.flush();
  const headsBeforeExit = writer.heads();
  assertTrue(
    'A2 ② 退出前窗口仍然开着（6 < 9）',
    headsBeforeExit.timeline_head === 6 && headsBeforeExit.wal_head === 9,
    `timeline_head=${String(headsBeforeExit.timeline_head)} wal_head=${String(headsBeforeExit.wal_head)}`,
  );
  await writer.close();

  assertEqual(
    'A2 ② 归档段是 1..6',
    (await archivedSeqs(fixture.sessionDir)).join(','),
    '1,2,3,4,5,6',
  );
  assertEqual(
    'A2 ② WAL 原文覆盖 1..9（未归档的 7..9 只在 WAL 里）',
    (await walSeqs(fixture.sessionDir)).join(','),
    '1,2,3,4,5,6,7,8,9',
  );

  const restartedHarness = await openWriter(fixture, {});
  const headsAfterRestart = restartedHarness.writer.heads();
  assertEqual('A2 ② 重启后 timeline_head 不复位（6）', headsAfterRestart.timeline_head, 6);
  assertEqual('A2 ② 重启后 wal_head 不复位（9）', headsAfterRestart.wal_head, 9);
  const restartedClient = newClient();
  await pullAll(restartedClient, fixture.sessionDir);
  assertSameSignatures(
    'A2 ② 重启后 A1 仍成立（UI == timeline ∪ WAL）',
    uiSignatures(restartedClient),
    diskSignatures(await diskUnion(fixture.sessionDir)),
  );
  const restartedSeqs = uiSeqs(restartedClient);
  assertEqual('A2 ② 重启后集合仍恰好 1..9', restartedSeqs.join(','), '1,2,3,4,5,6,7,8,9');
  await restartedHarness.writer.close();

  // ③ 归档真的**写到一半**（段文件 fsync 第一次失败）⇒ 回滚 + 重试成功。
  // 这一条防的是「重试把半成品留在段文件里」：如果回滚失效，`timeline.ndjson` 里会
  // 出现重复 seq 的行（读侧按 seq 去重会掩盖它，所以必须查**行**，不是查集合）。
  const partial = await createFixture('a2-partial-archive');
  let timelineSyncs = 0;
  const partialHarness = await openWriter(partial, {
    beforeSync: (kind) => {
      if (kind !== 'timeline') return;
      timelineSyncs += 1;
      if (timelineSyncs === 1) throw new Error('injected_halfway_archive_failure');
    },
  });
  const partialScript: TimelineAppendInput[] = [
    input('run-1', 0, 'run.started', { run_id: 'run-1' }),
    input('run-1', 1, 'user.message', { text: 'A2 partial' }),
    input('run-1', 2, 'assistant.message', { text: 'A2 partial answer' }),
    input('run-1', 3, 'run.completed', { run_id: 'run-1', status: 'completed' }),
  ];
  await partialHarness.writer.appendMany(partialScript);
  await partialHarness.writer.flush();
  const partialResult = await partialHarness.writer.archive();
  assertEqual('A2 ③ 第一次写段失败、重试后归档成功', partialResult.ok, true);
  assertEqual('A2 ③ 归档尝试了 2 次（1 失败 + 1 成功）', timelineSyncs, 2);
  assertEqual(
    'A2 ③ timeline_head 追平 wal_head（4）',
    partialHarness.writer.heads().timeline_head,
    4,
  );
  const partialTimeline = await readNdjsonFile(join(partial.sessionDir, TIMELINE_LAYOUT.timeline));
  assertEqual(
    'A2 ③ 段文件里没有重复行（半成品已被回滚，不是靠读侧去重掩盖）',
    partialTimeline.records.map((record) => record.seq).join(','),
    '1,2,3,4',
  );
  assertEqual('A2 ③ 段文件没有坏行', partialTimeline.invalid.length, 0);
  const partialClient = newClient();
  await pullAll(partialClient, partial.sessionDir);
  assertSameSignatures(
    'A2 ③ 半途失败再重试之后 A1 仍成立',
    uiSignatures(partialClient),
    diskSignatures(await diskUnion(partial.sessionDir)),
  );
  await partialHarness.writer.close();
}

// ───────────────────────────────────────────────────────────────── A3

/**
 * A3：注入归档失败（I3）⇒ A1 仍成立，且 `timeline_head` 停在旧值、`wal_head` 已前进。
 *
 * 注入方式：`beforeSync('timeline')` 恒抛（归档段 fsync 必失败）。写入侧照常（它走
 * `wal` / `block` 两个同步点），所以「归档坏了 = 只有空间回收坏了」这条能被单独观察。
 * 顺带把 I3 ①「重试 3 次（100/500/2000 ms）」也断言掉：尝试次数必须恰好 4。
 */
async function checkA3(): Promise<void> {
  beginItem('A3');
  const fixture = await createFixture('a3-archive-failure');
  const store = newClient();
  let archiveSyncAttempts = 0;
  const failures: Array<{ from_seq: number; to_seq: number; reason: string }> = [];
  const harness = await openWriter(fixture, {
    publish: (record) => {
      pushRecord(store, record);
    },
    beforeSync: (kind) => {
      if (kind !== 'timeline') return;
      archiveSyncAttempts += 1;
      throw new Error('injected_archive_fsync_failure');
    },
    onArchiveFailed: (info) => {
      failures.push(info);
    },
  });
  const { writer } = harness;

  const script: TimelineAppendInput[] = [
    input('run-1', 0, 'run.started', { run_id: 'run-1' }),
    input('run-1', 1, 'user.message', { text: 'A3 archive fails' }),
    chunk(2, 'ch'),
    chunk(3, 'unk'),
  ];
  for (const item of script) await writer.append(item);
  await writer.flush();

  const headsBeforeArchive = writer.heads();
  const archiveResult = await writer.archive();
  const headsAfterArchive = writer.heads();

  assertEqual('A3 归档返回 ok=false', archiveResult.ok, false);
  assertEqual(
    'A3 I3 ① 重试 3 次（首试 + 3 次 = 4 次尝试，间隔 100/500/2000ms）',
    archiveSyncAttempts,
    4,
  );
  assertEqual('A3 timeline_head 停在旧值（0）', headsAfterArchive.timeline_head, 0);
  assertEqual(
    'A3 wal_head 已前进（等于失败前的 wal_head = 4）',
    headsAfterArchive.wal_head,
    headsBeforeArchive.wal_head,
  );
  assertEqual('A3 wal_head = 4', headsAfterArchive.wal_head, 4);
  assertTrue(
    'A3 wal_head 领先 timeline_head（窗口是失败造成的）',
    headsAfterArchive.wal_head > headsAfterArchive.timeline_head,
    `${String(headsAfterArchive.timeline_head)} < ${String(headsAfterArchive.wal_head)}`,
  );
  assertEqual(
    'A3 归档失败不登记洞（数据没丢，丢的只是空间回收）',
    headsAfterArchive.holes.length,
    0,
  );
  assertEqual('A3 tainted = true', headsAfterArchive.tainted, true);
  assertEqual('A3 onArchiveFailed 恰好回调一次', failures.length, 1);
  assertEqual(
    'A3 回调区间 = [1..4]',
    `${String(failures[0]?.from_seq)}-${String(failures[0]?.to_seq)}`,
    '1-4',
  );
  assertEqual(
    'A3 归档段没有半成品（失败已回滚）',
    (await archivedSeqs(fixture.sessionDir)).join(','),
    '',
  );

  assertSameSignatures(
    'A3 失败窗口里 A1 仍成立（UI == timeline ∪ WAL）',
    uiSignatures(store),
    diskSignatures(await diskUnion(fixture.sessionDir)),
  );

  // 失败之后写入照常：wal_head 继续前进，timeline_head 仍冻结。
  const extra = await writer.append(
    input('run-1', 4, 'assistant.message', { text: 'after failure' }),
  );
  await writer.flush();
  const headsAfterMore = writer.heads();
  assertEqual('A3 失败后继续写仍拿到下一个号（5）', extra.seq, 5);
  assertEqual('A3 失败后 wal_head 继续前进（5）', headsAfterMore.wal_head, 5);
  assertEqual('A3 失败后 timeline_head 仍冻结（0）', headsAfterMore.timeline_head, 0);
  await writer.close();

  // 重启：失败状态与等式都要能复现（归档失败的数据一直在 WAL 里，可读）。
  const restarted = await openWriter(fixture, {});
  const headsRestarted = restarted.writer.heads();
  assertEqual('A3 重启后 timeline_head 仍停在旧值（0）', headsRestarted.timeline_head, 0);
  assertEqual('A3 重启后 wal_head 已前进（5）', headsRestarted.wal_head, 5);
  assertEqual('A3 重启后 tainted 仍为 true', headsRestarted.tainted, true);
  const restartedClient = newClient();
  const pull = await pullAll(restartedClient, fixture.sessionDir);
  assertEqual('A3 重启后拉全量补齐 5 条', pull.accepted.length, 5);
  assertSameSignatures(
    'A3 重启后 A1 仍成立（UI == timeline ∪ WAL）',
    uiSignatures(restartedClient),
    diskSignatures(await diskUnion(fixture.sessionDir)),
  );
  await restarted.writer.close();
}

// ───────────────────────────────────────────────────────────────── A4

/**
 * A4：注入磁盘坏块 ⇒ `holes` **恰好**覆盖坏区间，`seqSet(UI) ⊎ holes === 闭区间`，UI 不空白。
 *
 * 坏块造法：块内某一帧的**载荷**整段改写成空格（帧头保留 ⇒ 读侧判定为「完整帧但载荷坏」，
 * `wal.ts#decodeChunkBlock` 的 `invalid` 分支），重启后由写者登记成洞（`writer.ts:421-435`）。
 *
 * 等式在这里有两个读法，**都断言**（ADR-105 §7 A4 一行里其实混着两件事）：
 * - 读法 ①（客户端凭磁盘重建）：`seqSet(UI_重连后) ⊎ holes === [1..wal_head]`；
 * - 读法 ②（客户端曾收到过）：`seqSet(UI_坏块前) === 可读 ∪ holes`，且差集**恰好**是 holes
 *   ——「见过但读不回」的 seq 只有一种解释：已声明的洞（ADR-105 §6 / unacked §3 的收尾）。
 */
async function checkA4(): Promise<void> {
  beginItem('A4');
  const fixture = await createFixture('a4-corrupt-block');
  const liveBefore = newClient();
  const harness = await openWriter(fixture, {
    publish: (record) => {
      pushRecord(liveBefore, record);
    },
  });
  const { writer } = harness;

  const script: TimelineAppendInput[] = [
    input('run-1', 0, 'run.started', { run_id: 'run-1' }),
    chunk(1, 'a'),
    chunk(2, 'b'),
    chunk(3, 'c'),
    input('run-1', 4, 'assistant.message', { text: 'after chunks' }),
    chunk(5, 'd'),
    input('run-1', 6, 'run.completed', { run_id: 'run-1', status: 'completed' }),
  ];
  // 整批写入（`appendMany`）：块边界只由「FACT 前封块」决定，这样块划分才可预测
  // （逐条 `await append(chunk)` 会等空闲封块定时器，一条 chunk 一个块）。
  await writer.appendMany(script);
  await writer.flush();
  const headsClean = writer.heads();
  assertEqual('A4 坏块之前 wal_head = 7', headsClean.wal_head, 7);
  assertEqual('A4 坏块之前没有洞', headsClean.holes.length, 0);
  await writer.close();

  const blocks = await blockViews(fixture.sessionDir);
  assertEqual(
    'A4 块边界可预测（块 1 = seq 2,3,4；块 2 = seq 6）',
    blocks.map((block) => block.seqs.join(',')).join('|'),
    '2,3,4|6',
  );
  const target = blocks.find((block) => block.seqs.includes(3));
  if (target === undefined) throw new Error('block containing seq=3 not found');
  await corruptChunkFrame(join(fixture.sessionDir, TIMELINE_LAYOUT.walBlocks, target.name), 3);

  const reopened = await openWriter(fixture, {});
  const heads = reopened.writer.heads();
  assertEqual('A4 洞恰好一条（不多登记、不整块作废）', heads.holes.length, 1);
  assertEqual(
    'A4 洞恰好覆盖坏区间 [3,3]',
    `${String(heads.holes[0]?.from_seq)}-${String(heads.holes[0]?.to_seq)}`,
    '3-3',
  );
  assertEqual('A4 坏帧被标记 tainted', heads.tainted, true);
  assertEqual('A4 wal_head 覆盖坏区间（洞已声明 ⇒ 连续性不破）', heads.wal_head, 7);

  const readable = await diskUnion(fixture.sessionDir);
  const readableSeqs = readable.map((record) => record.seq);
  assertEqual('A4 可读集合 = 除 3 以外全部', readableSeqs.join(','), '1,2,4,5,6,7');
  assertTrue(
    'A4 坏帧的邻居 2 / 4 仍可读（洞不越界、不吞邻）',
    readableSeqs.includes(2) && readableSeqs.includes(4),
    `2=${String(readableSeqs.includes(2))} 4=${String(readableSeqs.includes(4))}`,
  );
  const holeSet = holeSeqs(heads.holes);
  assertTrue(
    'A4 可读 ∩ 洞 = ∅（⊎ 的左半）',
    holeSet.every((seq) => !readableSeqs.includes(seq)),
    `holes=${holeSet.join(',')} readable=${readableSeqs.join(',')}`,
  );
  assertSameSet(
    'A4 可读 ∪ 洞 === 闭区间 [1..wal_head]',
    [...readableSeqs, ...holeSet],
    closedRange(1, heads.wal_head),
  );

  const fresh = newClient();
  await pullAll(fresh, fixture.sessionDir);
  const freshSeqs = uiSeqs(fresh);
  assertTrue(
    'A4 重连后 UI 不空白（坏块只吃掉声明的区间）',
    freshSeqs.length === readableSeqs.length && freshSeqs.length > 0,
    `${String(freshSeqs.length)} 条`,
  );
  assertSameSet(
    'A4 seqSet(UI) ⊎ holes === 闭区间 [1..wal_head]',
    [...freshSeqs, ...holeSet],
    closedRange(1, heads.wal_head),
  );
  assertSameSignatures(
    'A4 UI 的每条都与磁盘可读副本逐条相同',
    uiSignatures(fresh),
    diskSignatures(readable),
  );

  const liveSeqs = uiSeqs(liveBefore);
  assertSameSet('A4 坏块前客户端的集合 === 可读 ∪ 洞', liveSeqs, [...readableSeqs, ...holeSet]);
  const liveOnly = liveSeqs.filter((seq) => !readableSeqs.includes(seq));
  assertEqual(
    'A4 客户端见过但读不回的 seq 恰好 = 洞（没有第二种解释）',
    liveOnly.join(','),
    holeSet.join(','),
  );
  // 对称差的写法（最接近 ADR-105 §7 A4 原文的「⊎」）：两边只差一个已声明的洞。
  const symmetric = [
    ...liveSeqs.filter((seq) => !readableSeqs.includes(seq)),
    ...readableSeqs.filter((seq) => !liveSeqs.includes(seq)),
  ];
  assertSameSet('A4 对称差 seqSet(UI) △ seqSet(timeline ∪ WAL) === holes', symmetric, holeSet);
  await reopened.writer.close();
}

// ───────────────────────────────────────────────────────────────── A5

/**
 * A5：`published_head` 单调（ADR-105 §3 I1 末段 + I4 第三条）。
 *
 * 与 `check-timeline-holes.ts:85-89`（注入 fsync 失败后重启，`publishedHead()` 读数不下降）
 * 与 `check-timeline-archive.ts:353-358`（重启后纯磁盘口径的 heads 不回退）的**关系**：
 * 那两条验的是「读数不下降」，是必要条件；本文件验的是**充分一侧**——重启后**新分配**的
 * 每一个 seq 都严格大于「握手/帧曾经报过的最大 seq」，即「已发布绝不复用」。读法不同、
 * 夹具不同、注入不同，互不覆盖。另外断言的「撕裂尾帧可重分配但必须 > published_head」
 * 是 I1 里那条唯一例外（ADR-105 §3 I3 末段），上面两个探针都没有。
 */
async function checkA5(): Promise<void> {
  beginItem('A5');
  const fixture = await createFixture('a5-monotonic');
  const first = await openWriter(fixture, {});

  const firstScript: TimelineAppendInput[] = [
    input('run-1', 0, 'run.started', { run_id: 'run-1' }),
    input('run-1', 1, 'user.message', { text: 'A5 before restart' }),
    chunk(2, 'ch'),
    chunk(3, 'unks'),
    input('run-1', 4, 'run.completed', { run_id: 'run-1', status: 'completed' }),
  ];
  for (const item of firstScript) await first.writer.append(item);
  await first.writer.flush();

  const headsBefore = first.writer.heads();
  const publishedHeadBefore = first.writer.publishedHead();
  const streamBefore = publishedSeqs(first.published);
  const handshakeMax = streamBefore.length === 0 ? 0 : Math.max(...streamBefore);
  assertEqual('A5 关机前 published_head == wal_head', publishedHeadBefore, headsBefore.wal_head);
  assertEqual('A5 握手/帧报过的最大 seq == wal_head', handshakeMax, headsBefore.wal_head);
  const ascBefore = strictlyAscending(streamBefore);
  assertTrue('A5 关机前的发布流严格升序', ascBefore.ok, ascBefore.detail);
  await first.writer.close();

  // 重启（第二代 writer）。
  const second = await openWriter(fixture, {});
  const headsAfterRestart = second.writer.heads();
  assertTrue(
    'A5 重启后 wal_head 不下降',
    headsAfterRestart.wal_head >= headsBefore.wal_head,
    `before=${String(headsBefore.wal_head)} after=${String(headsAfterRestart.wal_head)}`,
  );
  assertTrue(
    'A5 重启后 published_head 不下降',
    second.writer.publishedHead() >= publishedHeadBefore,
    `before=${String(publishedHeadBefore)} after=${String(second.writer.publishedHead())}`,
  );
  assertTrue(
    'A5 重启后 timeline_head 不下降',
    headsAfterRestart.timeline_head >= headsBefore.timeline_head,
    `before=${String(headsBefore.timeline_head)} after=${String(headsAfterRestart.timeline_head)}`,
  );

  const appended = [
    await second.writer.append(input('run-1', 5, 'user.message', { text: 'A5 after restart 1' })),
    await second.writer.append(
      input('run-1', 6, 'assistant.message', { text: 'A5 after restart 2' }),
    ),
  ];
  await second.writer.flush();
  const newSeqs = appended.map((record) => record.seq);
  assertTrue(
    'A5 重启后新分配的每个 seq 都 > 握手报过的最大 seq（已发布不复用）',
    newSeqs.every((seq) => seq > handshakeMax),
    `handshake_max=${String(handshakeMax)} new=${newSeqs.join(',')}`,
  );
  const streamAcross = [...streamBefore, ...publishedSeqs(second.published)];
  const ascAcross = strictlyAscending(streamAcross);
  assertTrue('A5 跨重启的发布流整体严格升序', ascAcross.ok, ascAcross.detail);

  // 撕裂尾帧（唯一允许重分配的情形）：手工在 WAL 尾部留一条**半写行**（无换行）。
  const publishedHeadBeforeTear = second.writer.publishedHead();
  await second.writer.close();
  const walPath = join(fixture.sessionDir, TIMELINE_LAYOUT.walLog);
  const walBeforeTear = await readFile(walPath);
  await appendFile(
    walPath,
    '{"v":1,"seq":99,"session_id":"a5-monotonic","run_id":"run-1","ts":',
    'utf8',
  );
  const third = await openWriter(fixture, {});
  const walAfterTear = await readFile(walPath);
  assertBytes(
    'A5 撕裂尾帧被截断（半写行一个字节都不留）',
    walAfterTear.toString('utf8'),
    walBeforeTear.toString('utf8'),
  );
  const afterTear = await third.writer.append(
    input('run-1', 99, 'assistant.message', { text: 'after torn tail' }),
  );
  assertTrue(
    'A5 撕裂尾帧重分配的 seq 仍 > published_head（未发布的尾部可重分配，已发布的绝不可）',
    afterTear.seq > publishedHeadBeforeTear,
    `published_head=${String(publishedHeadBeforeTear)} new=${String(afterTear.seq)}`,
  );
  const streamWithTear = [...streamAcross, ...publishedSeqs(third.published)];
  const ascWithTear = strictlyAscending(streamWithTear);
  assertTrue('A5 含撕裂尾帧重分配后发布流仍严格升序', ascWithTear.ok, ascWithTear.detail);
  await third.writer.close();
}

// ───────────────────────────────────────────────────────────────── A6

/**
 * A6：严格交错 —— chunk / `tool.call.*` / `context.changed` 交织。
 *
 * ADR-105 §7 A6 点名今天做不到的是「同一 run 内 trace-only 事件排到正文之后」
 * （`disk-replay.ts:33-36` 自述的负数带偏移）。本夹具把 `context.changed` 写在
 * 两条 chunk **中间**，断言它在 UI 里的位置就是它被写入的位置；同时断言两条更硬的：
 * - UI 的 seq **严格升序且无空洞**（1..N 逐条 +1）；
 * - 块边界只包 chunk（FACT 的 seq 绝不落在块区间里）——这是 §3 I2 封块条件 ②。
 *
 * 离线夹具：不启动渲染，只喂 `EventStore`（= 传输窗口）。ADR 允许这么验（§7「构造夹具」）。
 */
async function checkA6(): Promise<void> {
  beginItem('A6');
  const fixture = await createFixture('a6-interleave');
  const store = newClient();
  const harness = await openWriter(fixture, {
    publish: (record) => {
      pushRecord(store, record);
    },
  });
  const { writer } = harness;

  const script: TimelineAppendInput[] = [
    input('run-1', 0, 'run.started', { run_id: 'run-1' }),
    chunk(1, 'think-1'),
    input('run-1', 2, 'tool.call.started', { tool_call_id: 'call-1', tool_name: 'bash' }),
    chunk(3, 'think-2'),
    input('run-1', 4, 'context.changed', { reason: 'tools_changed', added: ['read'] }),
    chunk(5, 'think-3'),
    chunk(6, 'think-4'),
    input('run-1', 7, 'tool.call.completed', { tool_call_id: 'call-1', result: 'ok' }),
    input('run-1', 8, 'llm.response', { content: 'abc' }),
    chunk(9, 'tail'),
    input('run-1', 10, 'context.changed', { reason: 'manual_compact' }),
    input('run-1', 11, 'run.completed', { run_id: 'run-1', status: 'completed' }),
  ];
  // 整批写入：封块只发生在「FACT 之前」，块边界才等于「被两条 FACT 夹住的那段 chunk」。
  await writer.appendMany(script);
  await writer.flush();

  const uiSeqList = uiSeqs(store);
  const asc = strictlyAscending(uiSeqList);
  assertTrue('A6 UI 的 seq 严格升序', asc.ok, asc.detail);
  const noHoles = contiguous(uiSeqList);
  assertTrue('A6 UI 的 seq 无空洞（1..N 逐条 +1）', noHoles.ok, noHoles.detail);

  const expectedTypes = script.map((item) => item.type);
  assertEqual(
    'A6 UI 的事件顺序 == 写入顺序（交错没有被结构性重排）',
    uiTypes(store).join('>'),
    expectedTypes.join('>'),
  );
  assertEqual(
    'A6 `context.changed` 停在它被写入的位置（第 5 条），没有排到正文之后',
    uiTypes(store)[4],
    'context.changed',
  );
  assertTrue(
    'A6 第一条 `context.changed` 早于 `tool.call.completed`（P4 的失真不复现）',
    uiTypes(store).indexOf('context.changed') < uiTypes(store).indexOf('tool.call.completed'),
    `context.changed@${String(uiTypes(store).indexOf('context.changed'))} tool.call.completed@${String(uiTypes(store).indexOf('tool.call.completed'))}`,
  );

  // 块结构与「FACT 不落进块」：封块条件 ②（写 FACT 前先封块）。
  const blocks = await blockViews(fixture.sessionDir);
  assertEqual(
    'A6 块边界只包连续 chunk（本例 4 个块：2 / 4 / 6,7 / 10）',
    blocks.map((block) => block.seqs.join(',')).join('|'),
    '2|4|6,7|10',
  );
  const factSeqs = script
    .map((item, index) => ({ type: item.type, seq: index + 1 }))
    .filter((item) => item.type !== 'llm.stream.chunk')
    .map((item) => item.seq);
  const chunkSeqs = blocks.flatMap((block) => block.seqs);
  assertTrue(
    'A6 没有任何 FACT 的 seq 落在 chunk 块里（严格交错的存储侧条件）',
    factSeqs.every((seq) => !chunkSeqs.includes(seq)),
    `fact=${factSeqs.join(',')} chunk=${chunkSeqs.join(',')}`,
  );

  // chunk 的内容一个字都没被交错吃掉（按 seq 对回脚本载荷）。
  const disk = await diskUnion(fixture.sessionDir);
  const diskBySeq = new Map(disk.map((record) => [record.seq, record]));
  const chunkMismatch: string[] = [];
  for (const item of script) {
    if (item.type !== 'llm.stream.chunk') continue;
    const seq = script.indexOf(item) + 1;
    const record = diskBySeq.get(seq);
    if (record === undefined) {
      chunkMismatch.push(`missing:${String(seq)}`);
      continue;
    }
    if (sha256Data(record.data) !== sha256Data(item.data))
      chunkMismatch.push(`data:${String(seq)}`);
  }
  assertTrue(
    'A6 每条 chunk 的载荷与写入时逐字节相同',
    chunkMismatch.length === 0,
    chunkMismatch.length === 0
      ? `${String(chunkSeqs.length)} 条 chunk（seq ${chunkSeqs.join(',')}）载荷一致`
      : chunkMismatch.join(','),
  );
  assertSameSignatures(
    'A6 UI == timeline ∪ WAL（A1 的交错版）',
    uiSignatures(store),
    diskSignatures(disk),
  );
  await writer.close();
}

// ───────────────────────────────────────────────────────────────── A7

/**
 * A7：客户端 `count` 校验（ADR-105 §6 的四条硬校验 + §7 A7）。
 *
 * **未实现，且不是本文件能补的**：校验属于客户端（`apps/web/src/state/event-store.ts` 的
 * 单游标 + 四条校验），而 `count` 属于握手帧（`timeline.hello`）。今天两样都不在代码里，
 * 所以这里**不写**任何「恒真断言」或「catch 住异常就算过」的替代品：篡改游标今天根本
 * 没有接收方可以拒绝合并 —— 把它写成绿等于把「没有校验」记成「校验通过」。
 *
 * 判定：`NOT_IMPLEMENTED`，阻塞于 C 阶段（计划的 B-3 回归项）。
 */
function checkA7(): void {
  beginItem('A7');
  evidence(
    'A7-证据1 握手帧没有 count / start_seq / end_seq / timeline_head / wal_head',
    'packages/serve/src/gateway/frames.ts:88-99（helloFrame 只发 from_seq / latest_seq；ADR-105 §6 要求的那五个字段一个都没有）',
  );
  evidence(
    'A7-证据2 客户端把洞与重复静默吸收，没有 count 可核',
    'apps/web/src/state/event-store.ts:501（`if (meta.seq <= this.lastSeq) return false;` —— 低于游标的帧直接丢，洞与重复都不留痕）',
  );
  evidence(
    'A7-证据3 代码里 0 处 timeline_gap_reported',
    '全仓 grep：只有 docs/adr/ADR-105-session-timeline-single-source.md:245,273 与 docs/dev/handoff/plan-054-timeline-migration.md:57,59 提到；.ts 里 0 处',
  );
  evidence(
    'A7-证据4 events.subscribe 没有 after_timeline_seq 这个参数名',
    'packages/serve/src/gateway.ts:1606-1622（参数只有 since / since_ts / run_id / session_id / types / until_seq）',
  );
  notImplemented(
    'A7 游标篡改（+1 / −1 / 落在洞内）三种构造',
    '阻塞于 C-1（客户端四条校验 + timeline_gap_reported 未实现，证据：packages/serve/src/gateway/frames.ts:88-99 握手无 count；apps/web/src/state/event-store.ts:501 静默吸收洞与重复；代码里 0 处 timeline_gap_reported）',
  );
}

// ───────────────────────────────────────────────────────────────── A8

interface SessionsEventsResult {
  events: Array<{ seq: number; type: string; ts: number; run_id?: string; data?: unknown }>;
  next_seq: number;
  latest_seq: number;
  has_more: boolean;
}

interface EventsListResult {
  events: Array<Record<string, unknown>>;
}

/**
 * A8：旧格式会话（ADR-105 D4「只读冻结，不迁移」）。
 *
 * 两半：
 * - **可断言的一半（今天就有）**：`sessions.events` / `events.list` 的结果与**旧链路逐字节相同**，
 *   并且 `TimelineWriter.open()` 拒绝打开这种会话（`session_frozen_readonly`）。把
 *   「逐字节」钉在**原始文件内容**上（独立 oracle，不是把实现的输出抄一遍），并断言
 *   「冻结层碰过一次之后，两个 RPC 的输出与文件都一个字节没变」。
 * - **未实现的一半**：`events.subscribe { after_timeline_seq }` 返回 `session_frozen_readonly`
 *   ——订阅路径今天根本不认识 timeline（证据见下），所以显式记 `NOT_IMPLEMENTED`。
 */
async function checkA8(): Promise<void> {
  beginItem('A8');
  const fixture = await createFixture('a8-legacy');
  const runId = 'run-legacy-1';

  // 旧格式：只有 `events.ndjson`，没有任何 timeline 文件（0.54 之前的落盘形态）。
  const legacyRecords = [
    {
      v: 1,
      seq: 1,
      session_id: fixture.sessionId,
      run_id: runId,
      ts: NOW,
      type: 'run.started',
      data: { run_id: runId },
    },
    {
      v: 1,
      seq: 2,
      session_id: fixture.sessionId,
      run_id: runId,
      ts: NOW + 1,
      type: 'user.message',
      data: { text: 'legacy hello' },
    },
    {
      v: 1,
      seq: 3,
      session_id: fixture.sessionId,
      run_id: runId,
      ts: NOW + 2,
      type: 'assistant.message',
      data: { text: 'legacy answer' },
    },
  ];
  const legacyPath = join(fixture.sessionDir, 'events.ndjson');
  const legacyBytes = `${legacyRecords.map((record) => JSON.stringify(record)).join('\n')}\n`;
  await writeFile(legacyPath, legacyBytes, 'utf8');

  // 旧 trace（`data/events/<run_id>.jsonl`）——`events.list` 的读源。
  const traceDir = join(fixture.root, 'events');
  await mkdir(traceDir, { recursive: true });
  const traceEvents: Array<Record<string, unknown>> = [
    { type: 'run.started', run_id: runId, ts: NOW, seq: 1, data: { run_id: runId } },
    { type: 'user.message', run_id: runId, ts: NOW + 1, seq: 2, data: { text: 'legacy hello' } },
    { type: 'context.changed', run_id: runId, ts: NOW + 2, seq: 3, data: { reason: 'legacy' } },
  ];
  await writeFile(
    join(traceDir, `${encodeURIComponent(runId)}.jsonl`),
    `${traceEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );

  const quietLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const log = new SessionEventLog({
    dir: fixture.sessionsDir,
    durable: false,
    logger: quietLogger,
  });
  const sessionMethods = createSessionMethods({
    sessionFor: () =>
      ({
        load: async (id: string) => ({ session_id: id, messages: [], status: 'completed' }),
      }) as never,
    sessionEvents: createSessionEventsSource({
      log,
      // 旧日志只当夹具（本门禁自己写它）；水位按它给不影响断言。
      watermark: async (id: string) => {
        const info = await stat(
          join(sessionDirPath(fixture.sessionsDir, id), 'events.ndjson'),
        ).catch(() => undefined);
        return info === undefined
          ? undefined
          : `${String(info.size)}:${String(Math.floor(info.mtimeMs))}`;
      },
    }),
  });
  const eventsMethods = createEventsMethods({
    trace: {
      readEvents: (filter) => readTraceEvents(traceDir, filter as ReadTraceOptions),
    },
  });

  async function readSessionsEvents(): Promise<string> {
    const method = sessionMethods.find((item) => item.name === 'sessions.events');
    if (method === undefined) throw new Error('sessions.events missing');
    const result = (await method.handler(
      { session_id: fixture.sessionId },
      {} as never,
    )) as SessionsEventsResult;
    return JSON.stringify(result);
  }

  async function readEventsList(): Promise<string> {
    const method = eventsMethods.find((item) => item.name === 'events.list');
    if (method === undefined) throw new Error('events.list missing');
    const result = (await method.handler({ run_id: runId }, {} as never)) as EventsListResult;
    return JSON.stringify(result);
  }

  // ① 基线（「今天」的逐字节形态），oracle 是**原始文件内容**。
  const sessionsEventsBefore = await readSessionsEvents();
  const eventsListBefore = await readEventsList();
  const expectedViews = legacyRecords.map((record) => ({
    seq: record.seq,
    type: record.type,
    ts: record.ts,
    run_id: record.run_id,
    data: record.data,
  }));
  const sessionsEvents = JSON.parse(sessionsEventsBefore) as SessionsEventsResult;
  assertBytes(
    'A8 sessions.events 的事件体与旧格式日志逐字节相同（顺序 / 字段 / 内容都不变）',
    JSON.stringify(sessionsEvents.events),
    JSON.stringify(expectedViews),
  );
  assertEqual(
    'A8 sessions.events 不吞记录（3 条全回）',
    sessionsEvents.events.length,
    legacyRecords.length,
  );
  assertEqual('A8 sessions.events next_seq = 3', sessionsEvents.next_seq, 3);
  assertEqual('A8 sessions.events latest_seq = 3', sessionsEvents.latest_seq, 3);
  assertEqual('A8 sessions.events has_more = false', sessionsEvents.has_more, false);
  assertBytes(
    'A8 events.list 与旧 trace 逐字节相同',
    JSON.stringify((JSON.parse(eventsListBefore) as EventsListResult).events),
    JSON.stringify(traceEvents),
  );

  // ② 冻结：写者必须拒绝打开（D4 已实现的那一半）。
  let frozenCode = '';
  let frozenMessage = '';
  try {
    await TimelineWriter.open({ sessionId: fixture.sessionId, sessionDir: fixture.sessionDir });
  } catch (error) {
    frozenCode = (error as { code?: string }).code ?? '';
    frozenMessage = error instanceof Error ? error.message : String(error);
  }
  assertEqual(
    'A8 旧格式会话：写者打开被拒（session_frozen_readonly）',
    frozenCode,
    'session_frozen_readonly',
  );
  assertTrue(
    'A8 拒绝原因写清了「有旧日志、没有 timeline 标记」',
    frozenMessage.includes('events.ndjson'),
    frozenMessage,
  );
  assertEqual(
    'A8 写者没有在旧会话目录里留下任何 timeline 标记（不迁移、不回填）',
    (await timelineArtifacts(fixture.sessionDir)).join(','),
    '',
  );

  // ③ 冻结层碰过之后，读路径一个字节都不许变。
  assertBytes(
    'A8 sessions.events 在冻结层碰过之后逐字节不变',
    await readSessionsEvents(),
    sessionsEventsBefore,
  );
  assertBytes(
    'A8 events.list 在冻结层碰过之后逐字节不变',
    await readEventsList(),
    eventsListBefore,
  );
  assertBytes(
    'A8 旧 events.ndjson 文件本身一个字节没变',
    await readFile(legacyPath, 'utf8'),
    legacyBytes,
  );

  await log.close();

  // ④ 未实现的一半：订阅路径的冻结语义。
  evidence(
    'A8-证据1 events.subscribe 不认识 timeline（参数里没有 after_timeline_seq）',
    'packages/serve/src/gateway.ts:1606-1622；全仓 .ts 里 0 处 after_timeline_seq',
  );
  evidence(
    'A8-证据2 session_frozen_readonly 只有写者打开会话时抛',
    'packages/core/src/timeline/types.ts:164（错误码）+ packages/core/src/timeline/writer.ts:386-391（唯一抛出点，`TimelineWriter.open`）',
  );
  notImplemented(
    'A8 `after_timeline_seq` 订阅返回 session_frozen_readonly',
    '阻塞于 C-1（订阅路径未接 timeline：packages/serve/src/gateway.ts:1606-1622 无 after_timeline_seq；session_frozen_readonly 只由 packages/core/src/timeline/writer.ts:386-391 在打开写者时抛）',
  );
}

/** 会话目录里的 timeline 痕迹（只看文件名，`events.ndjson` / `index.json` 不算）。 */
async function timelineArtifacts(sessionDir: string): Promise<string[]> {
  const names: string[] = [];
  for (const name of [
    TIMELINE_LAYOUT.timelineManifest,
    TIMELINE_LAYOUT.walManifest,
    TIMELINE_LAYOUT.walLog,
    TIMELINE_LAYOUT.timeline,
    TIMELINE_LAYOUT.holes,
    TIMELINE_LAYOUT.walBlocks,
    TIMELINE_LAYOUT.indexDir,
  ]) {
    try {
      await readFile(join(sessionDir, name));
      names.push(name);
    } catch {
      // 不存在 / 是目录：都不算「写过 timeline」
    }
  }
  return names.sort();
}

// ───────────────────────────────────────────────────────────────── 汇总

const ORDER: ItemId[] = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'];

interface ItemResult {
  id: ItemId;
  status: ItemStatus;
  checks: number;
  failed: number;
  notImplemented: string | undefined;
}

function collect(): ItemResult[] {
  return ORDER.map((id) => {
    const item = items.get(id);
    if (item === undefined) {
      return { id, status: 'NOT_IMPLEMENTED', checks: 0, failed: 0, notImplemented: '未执行' };
    }
    const status: ItemStatus =
      item.failed > 0
        ? 'fail'
        : item.notImplemented !== undefined
          ? item.checks > 0
            ? 'partial'
            : 'NOT_IMPLEMENTED'
          : 'pass';
    return {
      id,
      status,
      checks: item.checks,
      failed: item.failed,
      notImplemented: item.notImplemented,
    };
  });
}

/** 一个 item 崩了也要落成 FAIL（不许让异常把这一条吞掉）。 */
async function runItem(id: ItemId, body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (!items.has(id)) beginItem(id);
    fail(`${id} 夹具未能跑完`, error instanceof Error ? `${error.message}` : String(error));
  }
}

async function main(): Promise<void> {
  console.log(
    '0.54 equality gate — UI == timeline(seq ≤ timeline_head) ∪ WAL(timeline_head < seq ≤ wal_head)',
  );
  console.log(
    '判据来源：docs/adr/ADR-105-session-timeline-single-source.md §7 A1–A8（口径见 §3 I1–I4、§6）',
  );

  await runItem('A1', checkA1);
  await runItem('A2', checkA2);
  await runItem('A3', checkA3);
  await runItem('A4', checkA4);
  await runItem('A5', checkA5);
  await runItem('A6', checkA6);
  await runItem('A7', checkA7);
  await runItem('A8', checkA8);

  const results = collect();
  const notImpl = results.filter(
    (result) => result.status === 'NOT_IMPLEMENTED' || result.status === 'partial',
  );
  const passed = results.filter((result) => result.status === 'pass');
  const failed = results.filter((result) => result.status === 'fail');

  console.log('');
  console.log('');
  console.log('════════════ NOT_IMPLEMENTED（显式列出：**不是**通过，是缺实现） ════════════');
  if (notImpl.length === 0) {
    console.log('（没有：A1–A8 全部落地）');
  }
  for (const result of notImpl) {
    console.log(`* ${result.id}: NOT_IMPLEMENTED — ${result.notImplemented ?? ''}`);
  }
  console.log('══════════════════════════════════════════════════════════════════════════');
  console.log('');
  console.log('── 覆盖度（ADR-105 §7 A1–A8）');
  for (const result of results) {
    const label =
      result.status === 'pass'
        ? 'pass'
        : result.status === 'fail'
          ? `FAIL（${String(result.failed)}/${String(result.checks)} 条断言红）`
          : result.status === 'partial'
            ? `PARTIAL（${String(result.checks - result.failed)} 条断言通过，其余 NOT_IMPLEMENTED）`
            : 'NOT_IMPLEMENTED';
    console.log(`${result.id}: ${label}`);
  }
  console.log('');
  console.log(
    `[NOTE] A5 与既有探针的关系：check-timeline-holes.ts:85-89 验的是「重启后 publishedHead() 读数不下降」、check-timeline-archive.ts:353-358 验的是「重启后纯磁盘口径 heads 不回退」——两者都是必要条件；A5 在这里独立构造并加硬一档：重启后**新分配**的每个 seq 必须 > 握手/帧报过的最大 seq，且撕裂尾帧重分配仍 > published_head。夹具与注入互不复用。`,
  );
  console.log(
    `[NOTE] A8 的读路径一半是真断言（sessions.events / events.list 与旧格式文件逐字节相同 + 冻结层碰过后零变化）；只有 after_timeline_seq 冻结订阅是 NOT_IMPLEMENTED。`,
  );
  console.log('');
  console.log(`检查项 ${String(checkCount)} 条，失败 ${String(failureCount)} 条`);
  console.log(
    `equality: ${String(passed.length)}/8 implemented, ${String(notImpl.length)} NOT_IMPLEMENTED (${notImpl.map((result) => result.id).join(', ')})`,
  );

  for (const store of stores) store.destroy();
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});

  if (failed.length > 0) {
    console.log('结论：FAIL（等式或判据被打破，禁止进 C 阶段 —— ADR-105 §7 末尾「失败时的处置」）');
    process.exitCode = 1;
    return;
  }
  if (notImpl.length > 0) {
    console.log(
      STRICT
        ? '结论：FAIL（--strict：NOT_IMPLEMENTED 也算红）'
        : '结论：PASS（已实现的都绿；NOT_IMPLEMENTED 见上，未计入通过）',
    );
    if (STRICT) process.exitCode = 1;
    return;
  }
  console.log('结论：PASS（A1–A8 全绿）');
}

await main();
