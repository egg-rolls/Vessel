#!/usr/bin/env bun
/**
 * check-timeline-publish-after-wal.ts — ADR-105 §3 I2 的行为断言（门禁名见 §11 / §11.1）。
 *
 * **判的是什么**：`publish(event)` 只能发生在「该 seq 已经持久化并且被 `wal_head` 覆盖」之后。
 * 五组 I2 判据**全是跑出来的**（构造夹具、注入慢 fsync / fsync 失败 / 崩溃），没有一条是读码判定；
 * 唯一的静态扫描只服务于装配层那行 `KNOWN GAP`（检测 B 阶段是否已接线），它**不是** I2 的通过条件。
 *
 * | # | 断言 | 做法 |
 * | --- | --- | --- |
 * | ① | **顺序**：每次 `publish` 时该 `record.seq` 已 ≤ 当时的 `wal_head` | 注入**慢 fsync**（patch `FileHandle.prototype.sync`，每次真 fsync 前多等 `SLOW_FSYNC_MS`），用 spy 逐条记 `(publish 时刻, seq, wal_head)` 并逐条判；另判**没有 publish 落在 WAL/块 fsync 窗口内** |
 * | ② | **不越界**：任何 publish 的 seq 都不 > 当时 `wal_head`；「一次写多条 + 中途失败」那一批不许 publish | `appendMany([a,b,c])` 整批 fsync 失败；以及批量中途（外置 blob 的 fsync）失败 |
 * | ③ | **单调**：publish 的 seq 序列严格递增，且与 `publishedHead()` 一致 | 单条交错 + 批量里夹 chunk（块/非块边界封块），再重开写者续写 |
 * | ④ | **fsync 失败 ⇒ 不发布**：该 seq 既不 publish、也不可读，且必须落成**可声明的洞** | 注入 WAL fsync 失败 |
 * | ⑤ | **崩溃窗口**：写到一半（fsync 返回前）进程被杀，重开写者后 `wal_head` 不下降 | 子进程在 `beforeSync('wal')` 里 `process.exit(9)`（字节已进页面缓存、fsync 未返回）；另加撕裂尾帧（无换行）重开 |
 *
 * ## 与任务原文的一处偏差（必须显式报告，不是放宽判据）
 *
 * 任务原文写「fsync 失败 ⇒ 该 seq **既不 publish 也不推进 `walHead`**」。按 ADR-105 §3 对 `wal_head`
 * 的定义（「`[1..wal_head]` 里每个 seq 要么可读、要么在 `holes` 里被声明」的最大值）以及
 * `writer.ts:592-593`（失败后 `recordFailure` + `advanceWalHead`）与 `check-timeline-holes.ts:75`，
 * 失败 seq 被**登记成洞后** `wal_head` **应当**跨过它 —— 否则 `wal_head` 会永久停在第一个洞里。
 * 所以本条断言的是**精确形态**（比口号更严）：
 *
 *   `wal_head ≥ 失败 seq` ⟹ 该 seq 必须在 `holes` 里、且**不可读**、且**从未 publish**。
 *
 * ## 现状：端到端 I2 未接线（KNOWN GAP，不是判据失败）
 *
 * 写者内部确实「fsync 之后才发布」，但装配层 `src/timeline-dual-write.ts` 给 `TimelineWriter.open`
 * 传的 options **没有 `publish`**，UI 仍由旧链路广播（ADR-105 §11.1 最后一条）。本门禁在末行打印
 * 一行 `KNOWN GAP:`（可升级形态）：
 *
 * - 扫描 `src/timeline-dual-write.ts` 的**代码骨架**（注释与字符串已抹成空格）：出现 `publish`
 *   标识符 ⇒ 自动从 KNOWN GAP 升级为**硬断言**（每一个 `TimelineWriter.open` 的 options 都必须传
 *   `publish`，且不许传 `publish: undefined`）。B 阶段切发布点时本门禁自动变严，不用改代码。
 * - 检测器自带自检（注释/字符串里的 `publish` 不得触发升级），避免「检测器坏了 ⇒ 永远停在 GAP」。
 *
 * ## 为注入慢 fsync 动了什么
 *
 * **没有改任何生产代码**：`TimelineWriterOptions` 已有 `publish` / `beforeSync` 两个测试缝，
 * `heads()` / `publishedHead()` 已是公开 API，所以本脚本不需要新增 core 导出。慢 fsync 用
 * `FileHandle.prototype.sync` 的 monkeypatch 实现（见 `installSlowFsync()`），只在本进程内生效，
 * 判据结束后立刻还原。`beforeSync` 只用来给「即将发生的同步」打标签（`wal` / `block` / …），
 * 以及注入失败；标签在 `sync()` 调用处**同步消费**，不会串到下一次同步。
 *
 * ## 负控（证明判据不是恒真断言）
 *
 * 写这个门禁时做过两次变异验证（都已还原，未留在提交里）：
 *
 * 1. 把 `writer.ts` 的 `factStep` 改成「`publishRecord()` 提前到 `writeWal()` 之前」⇒ ①/②/③/④ 立刻红
 *    （`seq=3>wal_head=2`、`seq=1 durableEnd=-1` 等），说明这几条不是空转；
 * 2. 用合成源码喂 `judgeWiring()`：半接线（两个 open 调用点只有一个带 `publish`）与
 *    `publish: undefined` 都被打红，说明 KNOWN GAP 的升级形态真的会变严。
 *
 * 用法：`bun run scripts/check-timeline-publish-after-wal.ts`
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import {
  appendFile,
  mkdtemp,
  open as openFile,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MAX_INLINE_BYTES,
  type TimelineAppendInput,
  type TimelineRecord,
  type TimelineSyncKind,
} from '../packages/core/src/timeline/types';
import { TimelineWriter } from '../packages/core/src/timeline/writer';

const REPO_ROOT = join(import.meta.dir, '..');
const WIRING_PATH = join(REPO_ROOT, 'src', 'timeline-dual-write.ts');
const WIRING_REL = 'src/timeline-dual-write.ts';

/** 注入的慢 fsync 时长：足够长到「提前发布」必然落进窗口里，又短到整轮门禁秒级跑完。 */
const SLOW_FSYNC_MS = 20;

const KNOWN_GAP_TEMPLATE =
  'KNOWN GAP: 端到端 I2 未接线 —— 装配层未传 publish（%WHERE%），本门禁只覆盖写者内部不变量';

let checkCount = 0;
let failureCount = 0;

function pass(name: string, detail = ''): void {
  checkCount += 1;
  console.log(`[PASS] ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string): void {
  checkCount += 1;
  failureCount += 1;
  console.log(`[FAIL] ${name} — ${detail}`);
}

function assertTrue(name: string, condition: boolean, detail = ''): void {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  assertTrue(name, actual === expected, `actual=${String(actual)} expected=${String(expected)}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function covers(holes: ReadonlyArray<{ from_seq: number; to_seq: number }>, seq: number): boolean {
  return holes.some((hole) => seq >= hole.from_seq && seq <= hole.to_seq);
}

function rangesOf(holes: ReadonlyArray<{ from_seq: number; to_seq: number }>): string {
  return holes.map((hole) => `${hole.from_seq}..${hole.to_seq}`).join(',') || '(空)';
}

function chunkEvent(ts: number, delta: string): TimelineAppendInput {
  return { run_id: 'run-1', type: 'llm.stream.chunk', ts, data: { delta } };
}

function factEvent(ts: number, type: string): TimelineAppendInput {
  return { run_id: 'run-1', type, ts, data: { ts } };
}

// ─────────────────────── 慢 fsync 注入（monkeypatch `FileHandle.sync`） ───────────────────────

interface SyncSpan {
  /** `beforeSync` 打的标签；没有标签的同步（索引 / 原子写）记 `other`。 */
  kind: TimelineSyncKind | 'other';
  start: number;
  end: number;
}

interface SyncPrototype {
  sync: () => Promise<void>;
}

interface FsyncProbe {
  delayMs: number;
  spans: SyncSpan[];
  restore?: () => void;
}

const fsyncProbe: FsyncProbe = { delayMs: 0, spans: [] };
/**
 * 「下一次 `sync()` 属于哪种同步」的标签。
 *
 * 写者/块/洞的代码都是 `beforeSync?.(kind)` 紧接着 `await handle.sync()`（中间没有 await），
 * 所以标签在 patch 后的 `sync()` 入口**同步消费**，不会与另一次异步同步串号。
 * 注入失败时（`beforeSync` 抛错）调用方会自己清掉标签。
 */
let pendingLabel: TimelineSyncKind | undefined;

/** 取 `FileHandle.prototype`（Bun 上 `sync` 是原型方法；不 patch 全局 fs 模块）。 */
async function fileHandlePrototype(): Promise<SyncPrototype> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-fh-probe-'));
  const handle = await openFile(join(dir, 'probe.bin'), 'a');
  const proto = Object.getPrototypeOf(handle) as SyncPrototype;
  await handle.close();
  await rm(dir, { recursive: true, force: true });
  return proto;
}

/**
 * 注入**慢 fsync**：每次真正的 `sync()` 之前先等 `delayMs`，并记下同步窗口 `[start, end]`。
 *
 * 慢下来才有观察价值：如果发布发生在 fsync 之前，「publish 时刻」就会落进某个同步窗口里，
 * 或者发生在窗口结束之前 —— 两条判据都能抓到（见 `verifyPublishInvariants()`）。
 */
async function installSlowFsync(delayMs: number): Promise<void> {
  const proto = await fileHandlePrototype();
  const original = proto.sync;
  fsyncProbe.delayMs = delayMs;
  fsyncProbe.spans = [];
  pendingLabel = undefined;
  proto.sync = async function patchedSync(this: unknown): Promise<void> {
    const kind = pendingLabel ?? 'other';
    pendingLabel = undefined;
    const start = performance.now();
    if (fsyncProbe.delayMs > 0) await delay(fsyncProbe.delayMs);
    await original.call(this);
    fsyncProbe.spans.push({ kind, start, end: performance.now() });
  };
  fsyncProbe.restore = () => {
    proto.sync = original;
  };
}

/** 还原 fsync 并交出本次记下的全部同步窗口。 */
function uninstallSlowFsync(): SyncSpan[] {
  fsyncProbe.restore?.();
  fsyncProbe.restore = undefined;
  fsyncProbe.delayMs = 0;
  pendingLabel = undefined;
  const spans = fsyncProbe.spans;
  fsyncProbe.spans = [];
  return spans;
}

async function withSlowFsyncRun<T>(
  body: () => Promise<T>,
): Promise<{ value: T; spans: SyncSpan[] }> {
  await installSlowFsync(SLOW_FSYNC_MS);
  try {
    const value = await body();
    return { value, spans: uninstallSlowFsync() };
  } catch (error) {
    uninstallSlowFsync();
    throw error;
  }
}

// ────────────────────────────── 失败注入缝（`beforeSync`） ──────────────────────────────

interface SyncSeam {
  beforeSync: (kind: TimelineSyncKind) => void;
  /** 已注入的失败点（`wal#2` = 第 2 次 WAL fsync）。 */
  failureLog: string[];
  counts: Map<TimelineSyncKind, number>;
}

function createSyncSeam(
  shouldFail: (kind: TimelineSyncKind, ordinal: number) => boolean,
): SyncSeam {
  const counts = new Map<TimelineSyncKind, number>();
  const failureLog: string[] = [];
  return {
    counts,
    failureLog,
    beforeSync: (kind) => {
      const ordinal = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, ordinal);
      pendingLabel = kind;
      if (!shouldFail(kind, ordinal)) return;
      // 注入点在 `sync()` 之前抛错 ⇒ 标签不能留给下一次真正的同步。
      pendingLabel = undefined;
      failureLog.push(`${kind}#${ordinal}`);
      throw new Error(`injected_${kind}_fsync_failure`);
    },
  };
}

// ─────────────────────────────── publish spy（三元组证据） ───────────────────────────────

interface PublishObservation {
  seq: number;
  type: string;
  /** **publish 那一刻**的 `wal_head`（I2 的证据就在这三元组里）。 */
  walHead: number;
  publishedHead: number;
  /** publish 的发生时刻（`performance.now()`，与同步窗口同一时钟）。 */
  at: number;
  /** publish 那一刻已完成的 WAL/块 fsync 次数（0 ⇒ 没有任何持久化屏障）。 */
  durableSyncs: number;
  /** publish 之前最后一个 WAL/块 fsync 的结束时刻（-1 ⇒ 没有）。 */
  durableEnd: number;
}

interface PublishProbe {
  observations: PublishObservation[];
  attach: (writer: TimelineWriter) => void;
  publish: (record: TimelineRecord) => void;
}

function createPublishProbe(): PublishProbe {
  const observations: PublishObservation[] = [];
  let writer: TimelineWriter | undefined;
  return {
    observations,
    attach: (target) => {
      writer = target;
    },
    publish: (record) => {
      const durable = fsyncProbe.spans.filter(
        (span) => span.kind === 'wal' || span.kind === 'block',
      );
      const last = durable[durable.length - 1];
      observations.push({
        seq: record.seq,
        type: record.type,
        // writer 未挂上 ⇒ -1，判据会立刻红（不会静默放行）。
        walHead: writer?.heads().wal_head ?? -1,
        publishedHead: writer?.publishedHead() ?? -1,
        at: performance.now(),
        durableSyncs: durable.length,
        durableEnd: last?.end ?? -1,
      });
    },
  };
}

function triplesOf(observations: readonly PublishObservation[]): string {
  return observations.map((item) => `${item.seq}@wal=${item.walHead}`).join(' ');
}

/** 逐条判（不是抽样）：每条 publish 都必须满足 I2 的三元组关系。 */
function verifyPublishInvariants(
  prefix: string,
  observations: readonly PublishObservation[],
  spans: readonly SyncSpan[],
): void {
  assertTrue(
    `${prefix}：本场景确实发生过 publish（否则下面几条是空断言）`,
    observations.length > 0,
    `n=${observations.length}`,
  );

  const overshoot = observations.filter((item) => item.seq > item.walHead);
  assertTrue(
    `${prefix}：逐条 publish 都满足 seq ≤ 当时的 wal_head（I2 核心）`,
    overshoot.length === 0,
    overshoot.length === 0
      ? `checked=${observations.length} triples=${triplesOf(observations)}`
      : overshoot.map((item) => `seq=${item.seq}>wal_head=${item.walHead}`).join(' '),
  );

  const noBarrier = observations.filter(
    (item) => item.durableSyncs === 0 || item.durableEnd < 0 || item.durableEnd > item.at,
  );
  assertTrue(
    `${prefix}：每次 publish 之前都已有结束的 WAL/块 fsync（发布点在 fsync 之后）`,
    noBarrier.length === 0,
    noBarrier.length === 0
      ? `checked=${observations.length}`
      : noBarrier
          .map((item) => `seq=${item.seq} durableEnd=${item.durableEnd} at=${item.at}`)
          .join(' '),
  );

  const inside = observations.filter((item) =>
    spans.some(
      (span) =>
        (span.kind === 'wal' || span.kind === 'block') &&
        span.start < item.at &&
        item.at < span.end,
    ),
  );
  assertTrue(
    `${prefix}：没有 publish 落在 WAL/块 fsync 窗口内（慢 fsync 撑开的窗口）`,
    inside.length === 0,
    inside.length === 0
      ? `spans=${spans.filter((span) => span.kind === 'wal' || span.kind === 'block').length}`
      : inside.map((item) => `seq=${item.seq}`).join(' '),
  );

  const headBehind = observations.filter((item) => item.publishedHead < item.seq);
  assertTrue(
    `${prefix}：每次 publish 时 published_head 已覆盖该 seq`,
    headBehind.length === 0,
    headBehind.length === 0
      ? `checked=${observations.length}`
      : headBehind.map((item) => `seq=${item.seq} published=${item.publishedHead}`).join(' '),
  );
}

function assertStrictlyIncreasing(prefix: string, seqs: readonly number[]): void {
  let broken = '';
  for (let index = 1; index < seqs.length; index += 1) {
    const prev = seqs[index - 1];
    const current = seqs[index];
    if (prev === undefined || current === undefined || current <= prev) {
      broken = `index=${index} prev=${String(prev)} current=${String(current)}`;
      break;
    }
  }
  assertTrue(
    `${prefix}：publish 的 seq 序列严格递增`,
    broken === '',
    broken === '' ? `n=${seqs.length} seqs=${seqs.join(',')}` : broken,
  );
}

/** 慢 fsync 真的生效了吗 —— 否则上面那两条窗口判据是空转。 */
function assertSlowFsyncEffective(prefix: string, spans: readonly SyncSpan[]): void {
  const durable = spans.filter((span) => span.kind === 'wal' || span.kind === 'block');
  const fast = durable.filter((span) => span.end - span.start < SLOW_FSYNC_MS - 2);
  assertTrue(
    `${prefix}：慢 fsync 注入生效（wal/块同步 ≥ 3 次且每次都 ≥ ${SLOW_FSYNC_MS}ms）`,
    durable.length >= 3 && fast.length === 0,
    `durable=${durable.length} durations=[${durable
      .map((span) => `${span.kind}:${Math.round(span.end - span.start)}ms`)
      .join(' ')}]`,
  );
}

// ─────────────────────────────── ① 顺序（慢 fsync + 逐条三元组） ───────────────────────────────

async function orderingScenario(workDir: string): Promise<void> {
  const sessionDir = join(workDir, 'ordering');
  const probe = createPublishProbe();
  const seam = createSyncSeam(() => false);
  const { value, spans } = await withSlowFsyncRun(async () => {
    const writer = await TimelineWriter.open({
      sessionId: 'ordering',
      sessionDir,
      chunkFlushMs: 20,
      publish: (record) => probe.publish(record),
      beforeSync: seam.beforeSync,
    });
    probe.attach(writer);
    // chunk 1/2 先进活动块；随后的非 chunk 事件（封块条件 ②）才让它们落盘并发布。
    const chunkA = writer.append(chunkEvent(1, 'a'));
    const chunkB = writer.append(chunkEvent(2, 'b'));
    await writer.append(factEvent(3, 'tool.call.started'));
    await Promise.all([chunkA, chunkB]);
    await writer.appendMany([factEvent(4, 'context.changed'), factEvent(5, 'tool.call.finished')]);
    await writer.append(chunkEvent(6, 'c'));
    await writer.append(factEvent(7, 'run.completed'));
    await writer.flush();
    const heads = writer.heads();
    const publishedHead = writer.publishedHead();
    await writer.close();
    return { heads, publishedHead };
  });

  const seqs = probe.observations.map((item) => item.seq);
  assertStrictlyIncreasing('① 顺序', seqs);
  assertEqual('① 顺序：publish 恰好覆盖 1..7、无重复无跳号', seqs.join(','), '1,2,3,4,5,6,7');
  verifyPublishInvariants('① 顺序', probe.observations, spans);
  assertSlowFsyncEffective('① 顺序', spans);
  assertEqual(
    '① 顺序：最后一次 publish 的 seq === publishedHead()',
    Math.max(...seqs),
    value.publishedHead,
  );
  assertEqual(
    '① 顺序：本场景无失败 ⇒ publishedHead() === wal_head',
    value.publishedHead,
    value.heads.wal_head,
  );
  assertEqual('① 顺序：wal_head 到 7', value.heads.wal_head, 7);
}

// ────────────────────────── ② 不越界（批量中途失败：一条都不许提前发布） ──────────────────────────

async function overshootScenario(workDir: string): Promise<void> {
  // ②a：一次写多条、整批 WAL fsync 失败 ⇒ 整批一条都不许 publish。
  const batchDir = join(workDir, 'batch-failure');
  const batchProbe = createPublishProbe();
  const batchSeam = createSyncSeam((kind, ordinal) => kind === 'wal' && ordinal === 2);
  const batch = await withSlowFsyncRun(async () => {
    const writer = await TimelineWriter.open({
      sessionId: 'batch-failure',
      sessionDir: batchDir,
      publish: (record) => batchProbe.publish(record),
      beforeSync: batchSeam.beforeSync,
    });
    batchProbe.attach(writer);
    const first = await writer.append(factEvent(1, 'run.started'));
    let batchError = '';
    try {
      await writer.appendMany([
        factEvent(2, 'tool.call.started'),
        factEvent(3, 'tool.call.finished'),
        factEvent(4, 'run.completed'),
      ]);
    } catch (error) {
      batchError = messageOf(error);
    }
    const heads = writer.heads();
    const readable = (await writer.readAll()).map((record) => record.seq);
    const publishedHead = writer.publishedHead();
    await writer.close();
    return { batchError, heads, readable, publishedHead, firstSeq: first.seq };
  });

  assertTrue(
    '② 不越界：整批 WAL fsync 失败 ⇒ appendMany 抛 timeline_write_failed',
    /timeline_write_failed/.test(batch.value.batchError),
    batch.value.batchError,
  );
  assertEqual(
    '② 不越界：失败那一批一条都没 publish（只发布了批次前的 1）',
    batchProbe.observations.map((item) => item.seq).join(','),
    String(batch.value.firstSeq),
  );
  assertEqual('② 不越界：失败区间落成可声明的洞 [2..4]', rangesOf(batch.value.heads.holes), '2..4');
  assertEqual('② 不越界：失败 seq 不可读', batch.value.readable.join(','), '1');
  assertEqual('② 不越界：失败后 tainted', batch.value.heads.tainted, true);
  assertEqual('② 不越界：publishedHead 停在 1', batch.value.publishedHead, 1);
  verifyPublishInvariants('② 不越界（整批失败）', batchProbe.observations, batch.spans);

  // ②b：批量写多条、中途（外置 blob 的 fsync）失败 ⇒ 已落盘的前一条可以发布，
  //      失败那条与后面从未取号的都不许 publish。
  const midDir = join(workDir, 'mid-batch-failure');
  const midProbe = createPublishProbe();
  const midSeam = createSyncSeam((kind, ordinal) => kind === 'blob' && ordinal === 1);
  const mid = await withSlowFsyncRun(async () => {
    const writer = await TimelineWriter.open({
      sessionId: 'mid-batch-failure',
      sessionDir: midDir,
      publish: (record) => midProbe.publish(record),
      beforeSync: midSeam.beforeSync,
    });
    midProbe.attach(writer);
    const first = await writer.append(factEvent(1, 'run.started'));
    let midError = '';
    try {
      await writer.appendMany([
        factEvent(2, 'tool.call.started'),
        {
          run_id: 'run-1',
          type: 'llm.request',
          ts: 3,
          data: { body: 'x'.repeat(MAX_INLINE_BYTES + 16) },
        },
        factEvent(4, 'tool.call.finished'),
      ]);
    } catch (error) {
      midError = messageOf(error);
    }
    const headsBeforeNext = writer.heads();
    const readable = (await writer.readAll()).map((record) => record.seq);
    const next = await writer.append(factEvent(5, 'run.completed'));
    const heads = writer.heads();
    await writer.close();
    return { midError, heads, headsBeforeNext, readable, nextSeq: next.seq, firstSeq: first.seq };
  });

  assertTrue(
    '② 不越界：批量中途失败（blob fsync）⇒ appendMany 抛 timeline_write_failed',
    /timeline_write_failed/.test(mid.value.midError),
    mid.value.midError,
  );
  assertEqual(
    '② 不越界：中途失败时只发布了失败前已持久的那条（2）+ 失败后的新写（4）',
    midProbe.observations.map((item) => item.seq).join(','),
    '1,2,4',
  );
  assertTrue(
    '② 不越界：失败 seq 3 从未 publish',
    !midProbe.observations.some((item) => item.seq === 3),
    triplesOf(midProbe.observations),
  );
  assertTrue(
    '② 不越界：失败 seq 3 落成洞且不可读',
    covers(mid.value.heads.holes, 3) && !mid.value.readable.includes(3),
    `holes=${rangesOf(mid.value.heads.holes)} readable=${mid.value.readable.join(',')}`,
  );
  assertEqual('② 不越界：失败 seq 不被复用（下一条是 4）', mid.value.nextSeq, 4);
  assertEqual(
    '② 不越界：批次尾巴（第 3 个入参）从未取号（失败时 wal_head 停在 3）',
    mid.value.headsBeforeNext.wal_head,
    3,
  );
  verifyPublishInvariants('② 不越界（中途失败）', midProbe.observations, mid.spans);
}

// ─────────────────────────────── ③ 单调（严格递增 + publishedHead 一致） ───────────────────────────────

async function monotonicityScenario(workDir: string): Promise<void> {
  const sessionDir = join(workDir, 'monotonic');
  const probe = createPublishProbe();
  const seam = createSyncSeam(() => false);
  const { value, spans } = await withSlowFsyncRun(async () => {
    const writer = await TimelineWriter.open({
      sessionId: 'monotonic',
      sessionDir,
      chunkFlushMs: 20,
      publish: (record) => probe.publish(record),
      beforeSync: seam.beforeSync,
    });
    probe.attach(writer);
    // ① 单条交错：chunk → chunk → 非 chunk（封块条件 ② 把更小的 seq 先发布掉）。
    const chunkA = writer.append(chunkEvent(1, 'a'));
    const chunkB = writer.append(chunkEvent(2, 'b'));
    await writer.append(factEvent(3, 'context.changed'));
    await Promise.all([chunkA, chunkB]);
    // ② 批量里夹 chunk：块/非块边界会封块，发布不允许出现「chunk 先发、更小 seq 后发」。
    await writer.appendMany([
      chunkEvent(4, 'c'),
      factEvent(5, 'tool.call.started'),
      chunkEvent(6, 'd'),
      factEvent(7, 'tool.call.finished'),
    ]);
    await writer.flush();
    const heads = writer.heads();
    const publishedHead = writer.publishedHead();
    await writer.close();
    // ③ 重开写者：published_head 不下降，新写的记录仍然只在自己的 fsync 之后发布。
    const reopened = await TimelineWriter.open({
      sessionId: 'monotonic',
      sessionDir,
      publish: (record) => probe.publish(record),
      beforeSync: seam.beforeSync,
    });
    probe.attach(reopened);
    const reopenedPublishedHead = reopened.publishedHead();
    const next = await reopened.append(factEvent(8, 'run.completed'));
    await reopened.close();
    return { heads, publishedHead, reopenedPublishedHead, nextSeq: next.seq };
  });

  const seqs = probe.observations.map((item) => item.seq);
  assertStrictlyIncreasing('③ 单调', seqs);
  assertEqual('③ 单调：publish 覆盖 1..8、无重复无跳号', seqs.join(','), '1,2,3,4,5,6,7,8');
  verifyPublishInvariants('③ 单调', probe.observations, spans);
  const mismatch = probe.observations.filter((item) => item.publishedHead !== item.seq);
  assertTrue(
    '③ 单调：每次 publish 时 published_head 恰好等于该 seq（与 publishedHead() 一致）',
    mismatch.length === 0,
    mismatch.length === 0
      ? `checked=${probe.observations.length}`
      : mismatch.map((item) => `seq=${item.seq} published=${item.publishedHead}`).join(' '),
  );
  assertEqual('③ 单调：关闭前 publishedHead() === 7', value.publishedHead, 7);
  assertEqual('③ 单调：重开后 publishedHead() 不下降（= 7）', value.reopenedPublishedHead, 7);
  assertEqual('③ 单调：重开后下一条 seq === 8（不复用已发布号）', value.nextSeq, 8);
  assertEqual('③ 单调：关闭前 wal_head === 7', value.heads.wal_head, 7);
}

// ─────────────────────────── ④ fsync 失败 ⇒ 不发布、不越界、必须落洞 ───────────────────────────

async function fsyncFailureScenario(workDir: string): Promise<void> {
  const sessionDir = join(workDir, 'fsync-failure');
  const probe = createPublishProbe();
  const seam = createSyncSeam((kind, ordinal) => kind === 'wal' && ordinal === 2);
  const { value, spans } = await withSlowFsyncRun(async () => {
    const writer = await TimelineWriter.open({
      sessionId: 'fsync-failure',
      sessionDir,
      publish: (record) => probe.publish(record),
      beforeSync: seam.beforeSync,
    });
    probe.attach(writer);
    await writer.append(factEvent(1, 'run.started'));
    let failure = '';
    try {
      await writer.append(factEvent(2, 'run.completed'));
    } catch (error) {
      failure = messageOf(error);
    }
    const heads = writer.heads();
    const publishedHead = writer.publishedHead();
    const readable = (await writer.readAll()).map((record) => record.seq);
    await writer.close();

    const reopenedProbe = createPublishProbe();
    const reopened = await TimelineWriter.open({
      sessionId: 'fsync-failure',
      sessionDir,
      publish: (record) => reopenedProbe.publish(record),
      beforeSync: seam.beforeSync,
    });
    reopenedProbe.attach(reopened);
    const reopenedHeads = reopened.heads();
    const reopenedPublishedHead = reopened.publishedHead();
    const reopenedNext = await reopened.append(factEvent(3, 'run.resumed'));
    await reopened.close();
    probe.observations.push(...reopenedProbe.observations);
    return {
      failure,
      heads,
      publishedHead,
      readable,
      reopenedHeads,
      reopenedPublishedHead,
      reopenedNextSeq: reopenedNext.seq,
    };
  });

  assertTrue(
    '④ fsync 失败：WAL fsync 失败 ⇒ append 抛 timeline_write_failed',
    /timeline_write_failed/.test(value.failure),
    value.failure,
  );
  assertEqual(
    '④ fsync 失败：失败 seq 2 从未 publish（只发布了 1）',
    probe.observations
      .filter((item) => item.seq <= 2)
      .map((item) => item.seq)
      .join(','),
    '1',
  );
  assertTrue(
    '④ fsync 失败：失败 seq 已落成可声明的洞',
    covers(value.heads.holes, 2),
    `holes=${rangesOf(value.heads.holes)}`,
  );
  assertEqual('④ fsync 失败：tainted', value.heads.tainted, true);
  assertEqual('④ fsync 失败：失败 seq 不可读（半写行已回滚）', value.readable.join(','), '1');
  // 偏差说明（见文件头）：ADR-105 §3 的 wal_head 定义允许跨过**已声明的洞**，
  // 所以这里判的是精确形态，而不是口号式的「wal_head 不动」。
  assertTrue(
    '④ fsync 失败：wal_head 只能通过「已声明的洞」跨过失败 seq（不可读 + 有洞）',
    value.heads.wal_head < 2 || (covers(value.heads.holes, 2) && !value.readable.includes(2)),
    `wal_head=${value.heads.wal_head} holes=${rangesOf(value.heads.holes)} readable=${value.readable.join(',')}`,
  );
  assertEqual('④ fsync 失败：wal_head 恰好停在失败 seq（洞已声明）', value.heads.wal_head, 2);
  assertEqual('④ fsync 失败：publishedHead 停在 1（不越界）', value.publishedHead, 1);
  assertTrue(
    '④ fsync 失败：publishedHead() ≤ wal_head',
    value.publishedHead <= value.heads.wal_head,
    `published=${value.publishedHead} wal_head=${value.heads.wal_head}`,
  );
  assertEqual('④ fsync 失败：重启后洞仍在', covers(value.reopenedHeads.holes, 2), true);
  assertEqual('④ fsync 失败：重启后 tainted', value.reopenedHeads.tainted, true);
  assertTrue(
    '④ fsync 失败：重启后 publishedHead 不下降',
    value.reopenedPublishedHead >= value.publishedHead,
    `before=${value.publishedHead} after=${value.reopenedPublishedHead}`,
  );
  assertEqual('④ fsync 失败：重启后下一条 seq === 3（失败号不复用）', value.reopenedNextSeq, 3);
  verifyPublishInvariants('④ fsync 失败（含重启后续写）', probe.observations, spans);
}

// ───────────────────────────── ⑤ 崩溃窗口（fsync 返回前被杀） ─────────────────────────────

interface CrashProbeFile {
  wal_head: number;
  published_head: number;
  published: number[];
}

/** 子进程源码：第 3 条记录「字节已写、fsync 未返回」时被杀（`exit(9)`，等价 kill -9）。 */
function crashChildSource(): string {
  const writerUrl = pathToFileURL(
    join(REPO_ROOT, 'packages', 'core', 'src', 'timeline', 'writer.ts'),
  ).href;
  return [
    "import { writeFile } from 'node:fs/promises';",
    `import { TimelineWriter } from '${writerUrl}';`,
    'const sessionDir = process.argv[2];',
    'const probePath = process.argv[3];',
    'if (!sessionDir || !probePath) process.exit(2);',
    'let walSyncs = 0;',
    'const published = [];',
    'const writer = await TimelineWriter.open({',
    "  sessionId: 'crash',",
    '  sessionDir,',
    '  publish: (record) => { published.push(record.seq); },',
    '  beforeSync: (kind) => {',
    "    if (kind !== 'wal') return;",
    '    walSyncs += 1;',
    '    // 第 3 条：writeAll 已完成（字节在页缓存里），fsync 还没返回 —— 进程在这里被 kill。',
    '    if (walSyncs === 3) process.exit(9);',
    '  },',
    '});',
    "await writer.append({ run_id: 'run-1', type: 'run.started', ts: 1, data: {} });",
    "await writer.append({ run_id: 'run-1', type: 'tool.call.started', ts: 2, data: {} });",
    'await writeFile(',
    '  probePath,',
    '  JSON.stringify({',
    '    wal_head: writer.heads().wal_head,',
    '    published_head: writer.publishedHead(),',
    '    published,',
    '  }),',
    "  'utf8',",
    ');',
    "await writer.append({ run_id: 'run-1', type: 'run.completed', ts: 3, data: {} });",
    "await writeFile(probePath + '.unexpected', 'not-crashed', 'utf8');",
    '',
  ].join('\n');
}

async function crashWindowScenario(workDir: string): Promise<void> {
  // ⑤a：真正的「fsync 前被杀」——子进程 exit(9)，父进程看盘 + 重开写者。
  const sessionDir = join(workDir, 'crash');
  const probePath = join(workDir, 'crash-probe.json');
  const childPath = join(workDir, 'crash-child.ts');
  await writeFile(childPath, crashChildSource(), 'utf8');
  const child = Bun.spawn({
    cmd: [process.execPath, childPath, sessionDir, probePath],
    cwd: workDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [childStdout, childStderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assertEqual('⑤ 崩溃窗口：子进程在 fsync 返回前被杀（exit=9）', exitCode, 9);
  const unexpected = await fileExists(`${probePath}.unexpected`);
  assertTrue(
    '⑤ 崩溃窗口：第 3 条 append 确实没写成功（注入点真的命中了）',
    !unexpected,
    `unexpected=${String(unexpected)} stdout=${childStdout.trim()} stderr=${childStderr.trim()}`,
  );
  const crashProbe = JSON.parse(await readFile(probePath, 'utf8')) as CrashProbeFile;
  assertEqual(
    '⑤ 崩溃窗口：崩溃前 publish 的只有已 fsync 的 seq（1,2）',
    crashProbe.published.join(','),
    '1,2',
  );
  assertTrue(
    '⑤ 崩溃窗口：未 fsync 的 seq 3 从未 publish',
    !crashProbe.published.includes(3),
    JSON.stringify(crashProbe),
  );

  const probe = createPublishProbe();
  const seam = createSyncSeam(() => false);
  const { value, spans } = await withSlowFsyncRun(async () => {
    const reopened = await TimelineWriter.open({
      sessionId: 'crash',
      sessionDir,
      publish: (record) => probe.publish(record),
      beforeSync: seam.beforeSync,
    });
    probe.attach(reopened);
    const heads = reopened.heads();
    const publishedHead = reopened.publishedHead();
    const readable = (await reopened.readAll()).map((record) => record.seq);
    const next = await reopened.append(factEvent(4, 'run.resumed'));
    await reopened.close();
    return { heads, publishedHead, readable, nextSeq: next.seq };
  });

  assertTrue(
    '⑤ 崩溃窗口：重放后 wal_head 不下降（A5 的写者内版本）',
    value.heads.wal_head >= crashProbe.wal_head,
    `before=${crashProbe.wal_head} after=${value.heads.wal_head}`,
  );
  assertTrue(
    '⑤ 崩溃窗口：重放后已发布的水位不下降',
    value.publishedHead >= crashProbe.published_head,
    `before=${crashProbe.published_head} after=${value.publishedHead}`,
  );
  assertTrue(
    '⑤ 崩溃窗口：已持久的两条仍可读',
    value.readable.includes(1) && value.readable.includes(2),
    `readable=${value.readable.join(',')}`,
  );
  assertEqual(
    '⑤ 崩溃窗口：新写的 seq 接在 wal_head 之后（不复用已覆盖的号）',
    value.nextSeq,
    value.heads.wal_head + 1,
  );
  assertTrue(
    '⑤ 崩溃窗口：新写的 seq 大于崩溃前已发布过的最大号',
    value.nextSeq > crashProbe.published_head,
    `next=${value.nextSeq} published_before=${crashProbe.published_head}`,
  );
  verifyPublishInvariants('⑤ 崩溃窗口（重启后续写）', probe.observations, spans);

  // ⑤b：撕裂尾帧（写到一半、无换行）—— 重开后 wal_head 也不许下降。
  const tornDir = join(workDir, 'torn-tail');
  const tornProbe = createPublishProbe();
  const tornSeam = createSyncSeam(() => false);
  const torn = await withSlowFsyncRun(async () => {
    const writer = await TimelineWriter.open({
      sessionId: 'torn-tail',
      sessionDir: tornDir,
      publish: (record) => tornProbe.publish(record),
      beforeSync: tornSeam.beforeSync,
    });
    tornProbe.attach(writer);
    await writer.append(factEvent(1, 'run.started'));
    await writer.append(factEvent(2, 'tool.call.started'));
    await writer.append(factEvent(3, 'run.completed'));
    const before = writer.heads();
    const publishedHeadBefore = writer.publishedHead();
    await writer.close();
    // 模拟「write 中途被杀」：一条没有换行、没有 crc 的半行。
    await appendFile(
      join(tornDir, 'wal.log'),
      '{"v":1,"seq":4,"session_id":"torn-tail","run_id":"run-1","ts":4,"type":"x","data":{',
      'utf8',
    );
    const reopened = await TimelineWriter.open({
      sessionId: 'torn-tail',
      sessionDir: tornDir,
      publish: (record) => tornProbe.publish(record),
      beforeSync: tornSeam.beforeSync,
    });
    tornProbe.attach(reopened);
    const after = reopened.heads();
    const publishedHeadAfter = reopened.publishedHead();
    const readable = (await reopened.readAll()).map((record) => record.seq);
    const nextSeq = (await reopened.append(factEvent(5, 'run.resumed'))).seq;
    await reopened.close();
    return {
      before,
      after,
      publishedHeadBefore,
      publishedHeadAfter,
      readable,
      nextSeq,
    };
  });

  assertTrue(
    '⑤ 撕裂尾帧：重开后 wal_head 不下降',
    torn.value.after.wal_head >= torn.value.before.wal_head,
    `before=${torn.value.before.wal_head} after=${torn.value.after.wal_head}`,
  );
  assertEqual('⑤ 撕裂尾帧：已持久的 1,2,3 仍可读', torn.value.readable.join(','), '1,2,3');
  assertEqual(
    '⑤ 撕裂尾帧：从未发布的撕裂号被重新分配（下一条 = 4，ADR-105 §3 I1 例外）',
    torn.value.nextSeq,
    4,
  );
  assertTrue(
    '⑤ 撕裂尾帧：published_head 不下降',
    torn.value.publishedHeadAfter >= torn.value.publishedHeadBefore,
    `before=${torn.value.publishedHeadBefore} after=${torn.value.publishedHeadAfter}`,
  );
  verifyPublishInvariants('⑤ 撕裂尾帧（重启后续写）', tornProbe.observations, torn.spans);
}

// ───────────────────── 装配层扫描：KNOWN GAP ⇄ 硬断言（可升级形态） ─────────────────────

/** 骨架化状态机的状态。 */
type SkeletonState = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';

/**
 * 把**注释与字符串/模板字面量原地抹成空格**（保留长度与换行 ⇒ 括号平衡与行号都精确）。
 *
 * 已知边界：模板字面量按整体抹掉（内部 `${...}` 里的代码也看不见）。装配层若把
 * `TimelineWriter.open(...)` 写进模板插值里，本扫描会漏看 —— 那种写法在本仓库没有先例。
 */
function skeleton(source: string): string {
  const out = source.split('');
  let state: SkeletonState = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (state === 'code') {
      if (current === '/' && next === '/') {
        out[index] = ' ';
        out[index + 1] = ' ';
        state = 'line';
        index += 1;
        continue;
      }
      if (current === '/' && next === '*') {
        out[index] = ' ';
        out[index + 1] = ' ';
        state = 'block';
        index += 1;
        continue;
      }
      if (current === "'") {
        out[index] = ' ';
        state = 'single';
        continue;
      }
      if (current === '"') {
        out[index] = ' ';
        state = 'double';
        continue;
      }
      if (current === '`') {
        out[index] = ' ';
        state = 'template';
      }
      continue;
    }
    if (state === 'line') {
      if (current === '\n') state = 'code';
      else out[index] = ' ';
      continue;
    }
    if (state === 'block') {
      if (current === '*' && next === '/') {
        out[index] = ' ';
        out[index + 1] = ' ';
        state = 'code';
        index += 1;
        continue;
      }
      if (current !== '\n') out[index] = ' ';
      continue;
    }
    if (current === '\\') {
      out[index] = ' ';
      if (next !== '\n') out[index + 1] = ' ';
      index += 1;
      continue;
    }
    const close = state === 'single' ? "'" : state === 'double' ? '"' : '`';
    if (current === close) {
      out[index] = ' ';
      state = 'code';
      continue;
    }
    if (current !== '\n') out[index] = ' ';
  }
  return out.join('');
}

const PUBLISH_TOKEN = /(?<![A-Za-z0-9_$])publish(?![A-Za-z0-9_$])/;

export interface OpenCallSite {
  startLine: number;
  endLine: number;
  /** 括号内的骨架文本（注释/字符串已抹掉）：用来判 options 里有没有 `publish`。 */
  args: string;
  hasPublish: boolean;
}

export interface WiringScan {
  /** 代码骨架里出现了 `publish` 标识符 ⇒ 装配层进入 B 阶段，本门禁升级。 */
  publishSeen: boolean;
  openCalls: OpenCallSite[];
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, source.length);
  for (let index = 0; index < limit; index += 1) {
    if (source[index] === '\n') line += 1;
  }
  return line;
}

export function scanWiringText(source: string): WiringScan {
  const code = skeleton(source);
  const publishSeen = PUBLISH_TOKEN.test(code);
  const openCalls: OpenCallSite[] = [];
  const needle = 'TimelineWriter.open(';
  let from = code.indexOf(needle);
  while (from >= 0) {
    const openParen = from + needle.length - 1;
    let depth = 0;
    let closeParen = -1;
    for (let index = openParen; index < code.length; index += 1) {
      const char = code[index];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          closeParen = index;
          break;
        }
      }
    }
    const args = closeParen > openParen ? code.slice(openParen + 1, closeParen) : '';
    openCalls.push({
      startLine: lineOf(code, from),
      endLine: lineOf(code, closeParen > 0 ? closeParen : from),
      args,
      hasPublish: PUBLISH_TOKEN.test(args),
    });
    from = code.indexOf(needle, from + needle.length);
  }
  return { publishSeen, openCalls };
}

/** 检测器自检：注释/字符串里的 `publish` **不得**触发升级，options 里的必须触发。 */
function selfTestWiringScan(): void {
  const wired = [
    'const openWriter = (input) => TimelineWriter.open({',
    '  sessionId: input.sessionId,',
    '  publish: (record) => input.onPublish(record),',
    '});',
  ].join('\n');
  const wiredScan = scanWiringText(wired);
  assertTrue(
    '自检：options 里传 publish ⇒ 识别为已接线（升级判据的方向）',
    wiredScan.publishSeen && wiredScan.openCalls.some((call) => call.hasPublish),
    `publishSeen=${String(wiredScan.publishSeen)} calls=${wiredScan.openCalls.length}`,
  );

  const commentOnly = [
    '// publish 必须发生在 fsync 之后（I2）',
    'const openWriter = (input) => TimelineWriter.open({ sessionId: input.sessionId });',
  ].join('\n');
  const commentScan = scanWiringText(commentOnly);
  assertTrue(
    '自检：只有注释提 publish ⇒ 不升级（不误判）',
    !commentScan.publishSeen && commentScan.openCalls.every((call) => !call.hasPublish),
    `publishSeen=${String(commentScan.publishSeen)} calls=${commentScan.openCalls.length}`,
  );

  const stringOnly = [
    "const kind = 'publish';",
    'const openWriter = (input) => TimelineWriter.open({ sessionId: input.sessionId });',
  ].join('\n');
  const stringScan = scanWiringText(stringOnly);
  assertTrue(
    '自检：只有字符串常量 publish ⇒ 不升级（不误判）',
    !stringScan.publishSeen && stringScan.openCalls.every((call) => !call.hasPublish),
    `publishSeen=${String(stringScan.publishSeen)}`,
  );
}

interface WiringVerdict {
  mode: 'gap' | 'wired';
  scan: WiringScan;
}

/**
 * 判定装配层处于哪一阶段，并只在**已接线**时打硬断言（缺口阶段打的是缺口事实）。
 *
 * 分开成纯函数是为了可自证：负控（半接线 / `publish: undefined`）可以在不动物理文件的前提下
 * 用合成源码跑一遍，证明「升级后真的会变严」。
 */
export function judgeWiring(scan: WiringScan): 'gap' | 'wired' {
  assertTrue(
    '装配层扫描：找到了 TimelineWriter.open 调用点（扫描器没瞎）',
    scan.openCalls.length > 0,
    `calls=${scan.openCalls.length} publishSeen=${String(scan.publishSeen)}`,
  );

  if (!scan.publishSeen) {
    const missing = scan.openCalls.filter((call) => !call.hasPublish);
    assertTrue(
      '装配层现状（缺口事实，不是判据）：每一个 TimelineWriter.open 都**没有**传 publish',
      scan.openCalls.length > 0 && missing.length === scan.openCalls.length,
      `calls=${scan.openCalls.length} 未传=${missing.length} 行=${scan.openCalls
        .map((call) => `${call.startLine}-${call.endLine}`)
        .join(',')}`,
    );
    return 'gap';
  }

  // 进入 B 阶段：从 KNOWN GAP 升级为硬断言。
  const missing = scan.openCalls.filter((call) => !call.hasPublish);
  assertTrue(
    'I2 升级：装配层出现 publish ⇒ 每一个 TimelineWriter.open 的 options 都必须传 publish',
    scan.openCalls.length > 0 && missing.length === 0,
    `calls=${scan.openCalls.length} 缺=${missing
      .map((call) => `行${call.startLine}-${call.endLine}`)
      .join(',')}`,
  );
  const undefinedPublish = scan.openCalls.filter((call) =>
    /publish\s*:\s*undefined/.test(call.args),
  );
  assertTrue(
    'I2 升级：不许用 `publish: undefined` 冒充接线',
    undefinedPublish.length === 0,
    undefinedPublish.map((call) => `行${call.startLine}-${call.endLine}`).join(','),
  );
  return 'wired';
}

async function wiringCheck(): Promise<WiringVerdict> {
  const source = await readFile(WIRING_PATH, 'utf8');
  const scan = scanWiringText(source);
  return { mode: judgeWiring(scan), scan };
}

function whereOf(scan: WiringScan): string {
  const first = scan.openCalls[0];
  if (first === undefined) return `${WIRING_REL}（未找到 TimelineWriter.open 调用点）`;
  return `${WIRING_REL}:${first.startLine}-${first.endLine}`;
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'vessel-i2-publish-after-wal-'));
  console.log('ADR-105 I2：publish 只能发生在 WAL 之后（行为断言，无静态读码）');
  console.log(`work-dir: ${workDir}`);
  let verdict: WiringVerdict = { mode: 'gap', scan: { publishSeen: false, openCalls: [] } };
  try {
    selfTestWiringScan();
    await orderingScenario(workDir);
    await overshootScenario(workDir);
    await monotonicityScenario(workDir);
    await fsyncFailureScenario(workDir);
    await crashWindowScenario(workDir);
    verdict = await wiringCheck();
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  console.log('');
  console.log(
    `RESULT: ${failureCount === 0 ? 'PASS' : 'FAIL'} (checks=${checkCount} failed=${failureCount})`,
  );
  if (verdict.mode === 'gap') {
    // 末行必须显式报出这处缺口（ADR-105 §11.1 最后一条）：它不是断言失败。
    console.log(KNOWN_GAP_TEMPLATE.replace('%WHERE%', whereOf(verdict.scan)));
  } else {
    console.log(
      `I2 WIRING: 装配层已传 publish（${whereOf(verdict.scan)}）—— KNOWN GAP 已升级为硬断言`,
    );
  }
  if (failureCount > 0) process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
