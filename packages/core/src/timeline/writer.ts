/**
 * 会话 timeline 写入者（0.54 A 阶段，ADR-105 §3 / §4）。
 *
 * 这是 `timeline_seq` 的**唯一分配点**，也是 `publish` 的**唯一出口**。四条不变量：
 *
 * | # | 约束 | 实现位置 |
 * | --- | --- | --- |
 * | I1 | seq 在写 WAL 那一刻分配；取号与追加同一个临界区 | `enqueue()` 串行队列 + `factStep`/`chunkStep` |
 * | I2 | publish 只能在 WAL fsync 之后 | `writeWal()` / `sealPendingBlock()` 成功后才 `publishRecord` |
 * | I3 | 归档失败只影响空间回收 | `archiveNow()`：不推进 `timelineHead`、记 `tainted`、失败区间落洞 |
 * | I4 | 两个 head / holes / tainted 可上报；`published_head` 单调 | `heads()` / `publishedHead()` |
 *
 * 不变量 I5（dup-seq 事故之后补上的一条，**归档侧**）：**同一个 `seq` 在 `timeline.ndjson`
 * 里最多出现一次**。重复一次就违反这条 append-only 副本不变量（归档不再是 `wal.log` 事实行的
 * 副本）。**当下读路径对重复 seq 免疫**：`readTimelineEvents` 的 `bySeq`、
 * `timeline-dual-write#readPage` 的 `seen`、serve `selectTimelinePage` 的 `seen` 三处都按
 * seq 去重。但一旦归档成为唯一读源、或消费者按物理顺序把行喂给 `validateTimelineRange`，
 * 第 4 条（不得重复）会整段拒收 —— 实测 10 行 vs 声明 5 行 ⇒ `merged=0`、左缘不动、
 * `hasEarlier` 恒 true。所以这条不变量由闸门而不是读侧容错来守。
 * 实现是四道闸门叠加：进程内只增的 `archiveWatermark`、严格读（读不出来不算空）、
 * 追加前重读归档尾窗、逐条断言 payload（`assertAppendOnlyPayload`），外加 `archive-lock.ts`
 * 把「读水位 → 追加 → 提交 manifest」串行化。损坏的存量数据**不自动修**，只在打开时报一条
 * warn（`archive-audit.ts`）；人工裁的执行器是 `scripts/timeline-dedup-archive.ts`。
 *
 * 失败语义（ADR-105 §3 I3 补充条款）：
 * - **append 失败** ⇒ 回滚本次写入到写前偏移 → 在 `holes.ndjson` 登记该 seq → `tainted`；
 * - **chunk 块写失败** ⇒ 删除本次新建的半块 → 整个块区间登记成洞；
 * - **撕裂尾帧**（半写、从未发布）在 `open()` 时截断并允许重新分配 seq。
 *
 * 污点（`tainted`）是**派生值，不是历史累加**：会话级 `tainted` = 「当前还有**未退役**的洞」或
 * 「manifest 里物理顺序上最后一条状态声明是 `tainted`」。归档成功推进 `timeline_head`
 * 且当前无存活洞时追加一条 `tainted_cleared` 把它撤掉（`clearTaint()`）；
 * 历史 `tainted` 行一条都不删（审计）。三种表达分工固定：
 *
 * | 概念 | 载体 | 语义 |
 * | --- | --- | --- |
 * | 损坏区间 | `holes.ndjson` | 事实；登记只增，**退役**必须自证（`retireHoles()`） |
 * | `tainted` | 本模块的派生值 | 会话级**当前**健康位（UI / 运维消费的就是它） |
 * | 曾经发生什么 | `timeline.manifest` 的 `tainted` / `tainted_cleared` 行 | 审计历史，全保留 |
 *
 * **洞的退役（第二刀）**：`holes` 过去只增不减 ⇒ 一个洞被修好之后 `tainted` 永远回不到
 * false（与 `tainted` 粘性 bug 同构）。现在 `retireHoles()` 可以**显式**把一个已登记区间
 * 退役：它先对该区间做**区间重读自证**（每个 seq 必须逐条 CRC 通过），通过才追加
 * `hole_retired`；随后若无存活洞就顺带写 `tainted_cleared`。**没有任何自动退役**：
 * `open()` 不做全量重读、不写退役行（否则启动变慢且掩盖坏块）。
 *
 * **迁移事实（写死，别当实现细节）**：存量老会话没有 trailing `tainted_cleared` 行 ⇒
 * 升级后**第一次健康归档之前仍是 `tainted = true`**，不会自动洗白。这是可接受的保守姿态
 * （安全方向：宁可多报一次脏，不可漏报一次真丢失）。
 *
 * 封块时机（I2 之内的延迟来源；**0.57 可追加块之后只剩四个**）：
 * ① 活动块 ≥ `BLOCK_MAX_BYTES`（4 MiB 硬上限）；② run 换人（chunk 的 `run_id` 变了）；③
 * `close()`；④ 崩溃后 `open()` 补记账。
 *
 * 与旧口径的差别（用户拍的那一刀）：**空闲 `chunk_flush_ms` 与非 chunk 事件都不再封块**，
 * 它们只触发「落盘 + 发布」（`flushPendingChunks`）。发布延迟仍然 `≤ chunk_flush_ms`
 * （ADR-105 的 P95 预算不变），块却从「150 ms 一刀」变成「一个 run 一个块」
 * （真身实测 13,177 → 106）。
 *
 * ## 打开（`open()`）读多少（第十一条：启动路径不许 O(会话大小)）
 *
 * 两条路径，**一套语义**（产出同一份状态：`next_seq` / 两个 head / `published` / 洞 /
 * 污点 / 索引 / 下一个块号），差别只是读多少：
 *
 * | 路径 | 读什么 | 上界（常量） | 什么时候走 |
 * | --- | --- | --- | --- |
 * | 增量（`tryIncrementalRecovery`） | `timeline.idx` + `wal.log` 尾窗 + 归档尾窗 + `timeline.manifest` 尾窗 + **最后一个**块 + `wal.manifest` 尾窗 + `holes.ndjson` | 32 MiB + 4 MiB×2 + 1 MiB + 一个块（32 KiB 级）+ 洞文件 | 缺省；能自洽答出四个 head 时 |
 * | 全量（`fullRecovery`） | 上面全部 + 其余所有块与整份 `wal.log` / 归档 | O(会话大小) | 增量路径任何一条自洽检查不成立时，**以及显式修复**（删掉 `timeline.idx/` 再 open） |
 *
 * 增量路径**一条判定都没有放松**：它只是「少读」。可疑就整份读 —— 索引缺失/算术不自洽、
 * 与尾窗不一致、尾窗里有坏行/坏帧、`wal.manifest` 说写完但块缺帧、manifest 尾部答不准，
 * 六种情况一律退回全量。因此「洞声明」「adopt 边界」「冻结闸门」「`published_head` 语义」
 * 在两条路径上完全一样。取舍写在明处：**历史中段**（早已封好的老块、更早的 `wal.log` 行）
 * 的外部损坏不再每次打开都重扫一遍 —— 那是显式修复路径的职责，不是启动路径的。
 *
 * 实测量级（`d813eaea`：206,561 条 seq / `wal.log` 6.9 MB / 归档 6.9 MB / 12,900 个块
 * 88 MB）：全量恢复要逐帧解析 340 MB，秒级；增量恢复只解析尾部几十条，毫秒级。
 *
 * **谁能进本写者（0.54 chunk-slim）**：chunk 家族里只有**有持久化价值**的那两个子类型
 * （`text_delta` / `reasoning_delta`）。`tool_call_delta` / `finish` 是瞬时 UI 提示
 * （刷新后由 `tool.call.started` / `tool.call.completed` / `llm.response` 复原），
 * 见 `blocks.ts#isTransientChunkEvent`。它们在 {@link TimelineWriter#append} 里被
 * **在分配 seq 之前**拒绝（`timeline_event_type_excluded`），理由就是 I2 的逆否：
 * 不落盘 ⇒ 不许取 seq（照取 seq 而不写 = 已发布未落盘 + `count` 里凭空造洞）。
 * 正常路径上第一刀在 `run-journal.ts#appendFact`，本闸门是第二道（防止别的调用方绕过）。
 *
 * 本模块**不读配置、不读环境变量**：块大小与间隔由装配层传进来。发布回调也在装配层
 * 接（0.54 A 阶段是双写，旧广播路径不动）。
 *
 * @module @vessel-agent/core/timeline
 */

import { type FileHandle, mkdir, open, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { noopLogger } from '../logging.js';
import { atomicWrite } from '../session/atomic-write.js';
import type { Logger } from '../types/logging.js';
import { auditArchiveDuplicates, describeArchiveDuplicates } from './archive-audit.js';
import { withArchiveLock } from './archive-lock.js';
import { type ChunkBlockSeal, ChunkBlockStore, isTransientChunkEvent } from './blocks.js';
import { HoleRegistry, type HoleRetirementResult } from './holes.js';
import { loadIndexSnapshot, TimelineIndexBuilder, writeIndexSnapshot } from './index.js';
import { assertSessionFormatSupported } from './legacy-format.js';
import {
  BLOCK_MAX_BYTES,
  CHUNK_FLUSH_LEAD_MS,
  clampChunkFlushMs,
  isChunkEventType,
  isExcludedEventType,
  MAX_INLINE_BYTES,
  TIMELINE_LAYOUT,
  type TimelineAppendInput,
  type TimelineBlobRef,
  TimelineError,
  type TimelineHeads,
  type TimelineHole,
  type TimelineManifestLine,
  type TimelineRecord,
  type TimelineSyncKind,
} from './types.js';
import {
  blobPath,
  crc32Hex,
  encodeLine,
  fsyncDirectory,
  parseRecordLine,
  parseWithCrc,
  readCrcNdjsonFile,
  readNdjsonFile,
  readNdjsonFileStrict,
  readNdjsonRangeStrict,
  readNdjsonTail,
  readTimelineEvents,
  stampRecord,
  TAIL_WINDOW_MAX_BYTES,
  truncateFile,
  withCrc,
} from './wal.js';

/**
 * 写者选项。
 *
 * `beforeSync` 是**测试缝**（自证脚本用它注入 fsync 失败）；生产装配不要传。
 */
export interface TimelineWriterOptions {
  sessionId: string;
  /** 会话目录（`<sessions>/<session_id>`）；不存在会创建。 */
  sessionDir: string;
  /**
   * 发布回调：**只在对应 WAL fsync 之后**调用（I2）。
   *
   * 回调抛错/拒绝不会回滚事实（事实已经持久）；写者吞掉消费者异常，避免把
   * “通道坏了”误报成“数据没写进去”。
   */
  publish?: (record: TimelineRecord) => void | Promise<void>;
  /** 活动块封块阈值；缺省 32 KiB。 */
  blockMaxBytes?: number;
  /** 空闲封块间隔；缺省 150 ms，上限 1000 ms。 */
  chunkFlushMs?: number;
  /** 测试缝：每次真正 fsync 之前调用；抛错 = 模拟 fsync/写失败。 */
  beforeSync?: (kind: TimelineSyncKind) => void;
  /** 归档重试耗尽后的通知（ADR-105 §3 I3 ③；不进 timeline 自身）。 */
  onArchiveFailed?: (info: { from_seq: number; to_seq: number; reason: string }) => void;
  /** 测试缝：时刻来源。 */
  now?: () => number;
  /**
   * 诊断日志口（缺省丢弃）。
   *
   * 只有一件事会往这里写：**打开时扫到归档副本里有重复 seq**（见
   * `archive-audit.ts`）。那不是一个可以静默的损坏 —— 它让读侧整段拒绝、「往上加载更早」
   * 永久卡住，而且不会自愈。写者只报警、**不修数据**（保留还是裁掉要人决定）。
   */
  logger?: Logger;
}

export interface ArchiveResult {
  ok: boolean;
  from_seq: number;
  to_seq: number;
  reason?: string;
}

interface PendingChunk {
  record: TimelineRecord;
  resolve: (record: TimelineRecord) => void;
  reject: (error: unknown) => void;
}

interface ChunkStep {
  record: TimelineRecord;
  /** 该 seq 真正落到块文件并 fsync 后 resolve（I2 的发布点在它之前不会发生）。 */
  durability: Promise<TimelineRecord>;
}

const ARCHIVE_RETRY_DELAYS_MS = [100, 500, 2_000] as const;

/*
 * ── `open()` 的读预算（第十一条：上界是常量，不是「取决于数据量」） ──────────
 *
 * 三问：上界 = 下面四个常量之和（32 MiB + 4 MiB×2 + 1 MiB + 一个块文件）；
 * 谁触发 = `TimelineWriter.open()`（进程启动 / 会话打开 / idle 压缩 / adopt）；
 * 用户看得到吗 = 看不到，所以只读回答问题所需的最尾部。
 *
 * 取值理由：
 * - `OPEN_INDEX_SEED_MAX_BYTES`：`type.idx` ≈ 7 B/事件 ⇒ 32 MiB ≈ 450 万事件。超过这个
 *   量级的索引不再是「派生缓存」而是第二份数据，此时宁可退回全量重建（慢但确定）；
 * - `OPEN_TAIL_MAX_EXTENSION_RECORDS`：尾窗能覆盖的增量（索引滞后 = 进程被强杀之后）。
 *   尾窗本身受 `TAIL_WINDOW_MAX_BYTES`（4 MiB）约束，这里再给一个条数上界（≈ 4 MiB / 64 B）；
 * - `MANIFEST_TAIL_*`：主 manifest 一行 ≈ 100 B，64 KiB ≈ 650 行；扩到 1 MiB ≈ 1 万行。
 */
const OPEN_INDEX_SEED_MAX_BYTES = 32 * 1024 * 1024;
const OPEN_TAIL_MAX_EXTENSION_RECORDS = 64 * 1024;
const MANIFEST_TAIL_FIRST_BYTES = 64 * 1024;
const MANIFEST_TAIL_MAX_BYTES = 1024 * 1024;

/*
 * ── 索引落盘节流（jn-F1）──────────────────────────────────────────────────
 *
 * 索引是派生物（ADR-105 §5：可删、可重建、open 自洽校验兜底），但过去每次带 settle
 * 的读（分页 / lastSeq / checkpoint）只要 `indexDirty` 就整份重写 type.idx/run.idx/
 * session.idx ×3 durable fsync（大会话 ~26–30 ms/次，且排在 append 串行队列上）。
 * 流式期间 dirty 几乎恒真 ⇒ 每页/每 checkpoint 付一遍 O(会话) 的写，累计 O(n²)。
 *
 * 现在 `flush()` 路径按「时间 ≥2 s 或 新增 ≥500 条」合并落盘；`close()` / 洞退役 /
 * open 恢复仍**无条件**写（调用点直接调 `persistIndex()`，不经过节流判定）。
 * run 终态事件（completed/failed/cancelled）也强制落盘 —— 终态之后读侧（liveness /
 * run→session 解析）可能马上依赖盘上索引。
 *
 * 正确性兜底不变：节流造成的索引滞后上界 = 2 s 或 500 条，远小于 open 尾窗的
 * `OPEN_TAIL_MAX_EXTENSION_RECORDS`（64k 条）/ `TAIL_WINDOW_MAX_BYTES`（4 MiB）；
 * 滞后超限只是退回 fullRecovery，判定不放松。
 */
const INDEX_PERSIST_MIN_INTERVAL_MS = 2_000;
const INDEX_PERSIST_MAX_PENDING_RECORDS = 500;

/** run 终态事件（与 session-liveness / connect-run-wait 的既有事件面一致，不新增）。 */
const INDEX_FORCE_TERMINAL_TYPES: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

/**
 * `open()` 时扫「归档副本有没有重复 seq」的字节预算（**常量上界**，不是 O(会话)）。
 *
 * 为什么值得在启动路径上花这几十毫秒：重复 seq 是**永久性**损坏（读侧整段拒绝、「往上加载
 * 更早」卡住、不会自愈、不会报错），现场三个会话躺了十几个小时没人知道。8 MiB 覆盖了
 * 绝大多数会话的**整份**归档（实测量级：`09f82ac6` 5.0 MB 全扫到、`d813eaea` 6.9 MB 全扫到），
 * 更大的会话只扫尾部 8 MiB —— 那也比「一条都不查」好得多，且 doctor 可以显式整份扫。
 *
 * 精度取 `fast`（只认行首 `{"v":1,"seq":N,`，不 `JSON.parse`、不算 CRC）：检测器要的是
 * 「有没有」，不是「哪一份可信」；真到人工裁决时 doctor 会用 `strict` 再跑一遍。
 */
const OPEN_ARCHIVE_AUDIT_MAX_BYTES = 8 * 1024 * 1024;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAll(handle: FileHandle, buffer: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) throw new Error('timeline_write_returned_zero');
    offset += bytesWritten;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maxRecordSeq(records: readonly TimelineRecord[]): number {
  let max = 0;
  for (const record of records) max = Math.max(max, record.seq);
  return max;
}

function validateManifestLine(parsed: unknown): TimelineManifestLine | undefined {
  const line = parseWithCrc<TimelineManifestLine>(parsed);
  if (line === undefined || line.v !== 1) return undefined;
  if (line.kind === 'open') {
    return typeof line.at === 'number' ? line : undefined;
  }
  if (line.kind === 'archive') {
    return typeof line.from_seq === 'number' &&
      typeof line.to_seq === 'number' &&
      typeof line.at === 'number'
      ? line
      : undefined;
  }
  if (line.kind === 'tainted' || line.kind === 'tainted_cleared') {
    return typeof line.reason === 'string' &&
      typeof line.from_seq === 'number' &&
      typeof line.to_seq === 'number' &&
      typeof line.at === 'number'
      ? line
      : undefined;
  }
  return undefined;
}

/**
 * 会话级污点的**当前值**：物理顺序上最后一条状态声明说了算（last-wins）。
 *
 * 从后往前扫，第一条 `tainted` / `tainted_cleared` 就是答案。**不按 `at` 排序**：时钟回退
 * 会把顺序搞反，而 append-only 文件的行序才是真实写入顺序（这两行的 `at` 只作审计）。
 *
 * 没有状态声明（只有 `open` / `archive` 行）⇒ `false`：从未污点过。
 */
function lastTaintedState(lines: readonly TimelineManifestLine[]): boolean {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (line.kind === 'tainted') return true;
    if (line.kind === 'tainted_cleared') return false;
  }
  return false;
}

/**
 * 主 manifest 尾窗里一行文本 → 行对象（坏行 ⇒ `undefined`，与全量读同口径忽略）。
 *
 * 尾窗读给的是原始行（`wal.ts#readNdjsonTail` 不解析 JSON），判据仍然只有
 * {@link validateManifestLine} 一份。
 */
function parseManifestText(text: string): TimelineManifestLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return validateManifestLine(parsed);
}

/**
 * 尾窗里的行 → 记录；**任何一行不合法就返回 `undefined`**。
 *
 * 为什么不是「跳过坏行」：坏行意味着「这条 seq 读不回来」，而「读不回来必须可声明」
 * （ADR-105 §3）—— 声明要按原口径走全量恢复那一条路（含从残行里捞 seq、与已有洞去重）。
 * 增量路径没有写洞的资格，也就不许把坏行当没事。
 */
function parseTailRecords(lines: readonly string[]): TimelineRecord[] | undefined {
  const records: TimelineRecord[] = [];
  for (const text of lines) {
    const record = parseRecordLine(text);
    if (record === undefined) return undefined;
    records.push(record);
  }
  return records;
}

/**
 * 把 `[from,to]` 里**已经在 `records` 里出现**的 seq 剔掉，剩下的按连续段切出来（升序）。
 *
 * 为什么需要：0.57 的块区间会横跨事实行（块只装 chunk，事实行在 `wal.log`）。块尾被截断
 * 时，`missingRanges` 报出来的区间可能**夹着照样读得回来的事实行** —— 洞只许覆盖真的
 * 读不回来的 seq，否则客户端会把可读记录算成洞（`count = 区间长度 - |holes|`）。
 *
 * 只在恢复路径上跑一次，区间长度就是单块覆盖的 seq 数（≤ 单块帧数），完全可接受。
 */
function subtractReadable(
  from: number,
  to: number,
  records: ReadonlyMap<number, TimelineRecord>,
): Array<{ from_seq: number; to_seq: number }> {
  const out: Array<{ from_seq: number; to_seq: number }> = [];
  let start: number | undefined;
  for (let seq = from; seq <= to; seq += 1) {
    if (records.has(seq)) {
      if (start !== undefined) {
        out.push({ from_seq: start, to_seq: seq - 1 });
        start = undefined;
      }
      continue;
    }
    start ??= seq;
  }
  if (start !== undefined) out.push({ from_seq: start, to_seq: to });
  return out;
}

/** 找出 `[1..maxKnown]` 里既没有记录、也没被洞覆盖的区间（恢复时补登记）。 */
function findGaps(
  recordSeqs: readonly number[],
  holes: readonly TimelineHole[],
  maxKnown: number,
): Array<{ from_seq: number; to_seq: number }> {
  const intervals: Array<[number, number]> = recordSeqs.map((seq) => [seq, seq]);
  for (const hole of holes) intervals.push([hole.from_seq, hole.to_seq]);
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const gaps: Array<{ from_seq: number; to_seq: number }> = [];
  let cursor = 1;
  for (const [start, end] of intervals) {
    if (start > maxKnown) break;
    if (end < cursor) continue;
    if (start > cursor) {
      gaps.push({ from_seq: cursor, to_seq: Math.min(start - 1, maxKnown) });
    }
    cursor = Math.max(cursor, end + 1);
    if (cursor > maxKnown) break;
  }
  if (cursor <= maxKnown) gaps.push({ from_seq: cursor, to_seq: maxKnown });
  return gaps;
}

/** 合并记录 seq 与洞区间，返回 `[1..h]` 全部可读/已声明的最大 `h`。 */
function contiguousHead(recordSeqs: readonly number[], holes: readonly TimelineHole[]): number {
  const intervals: Array<[number, number]> = recordSeqs.map((seq) => [seq, seq]);
  for (const hole of holes) intervals.push([hole.from_seq, hole.to_seq]);
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cursor = 1;
  for (const [start, end] of intervals) {
    if (start > cursor) break;
    if (end >= cursor) cursor = end + 1;
  }
  return cursor - 1;
}

/**
 * `(fromExclusive, toInclusive]` 里**没被存活洞覆盖**的区间（升序）—— 增量路径版的
 * {@link findGaps}。
 *
 * 全量恢复逐个 seq 问「这个号在不在记录集合里」；增量路径已经证明了记录集恰好是连续区间
 * `[1..fromExclusive]`，于是同一个判定只需要在洞区间上做减法：判据一样，20 万次集合查询
 * 换成几个区间的比较。
 *
 * `fromExclusive >= toInclusive` ⇒ 空数组（没有需要补声明的缺口）。
 */
function uncoveredTailRanges(
  fromExclusive: number,
  toInclusive: number,
  holes: readonly TimelineHole[],
): Array<{ from_seq: number; to_seq: number }> {
  if (toInclusive <= fromExclusive) return [];
  const covered: Array<[number, number]> = [];
  for (const hole of holes) {
    if (hole.to_seq <= fromExclusive) continue;
    covered.push([Math.max(hole.from_seq, fromExclusive + 1), hole.to_seq]);
  }
  covered.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const gaps: Array<{ from_seq: number; to_seq: number }> = [];
  let cursor = fromExclusive + 1;
  for (const [start, end] of covered) {
    if (end < cursor) continue;
    if (start > cursor) {
      gaps.push({ from_seq: cursor, to_seq: Math.min(start - 1, toInclusive) });
    }
    cursor = Math.max(cursor, end + 1);
    if (cursor > toInclusive) break;
  }
  if (cursor <= toInclusive) gaps.push({ from_seq: cursor, to_seq: toInclusive });
  return gaps;
}

/**
 * 每会话一个的 append-only timeline 写入者。
 *
 * 同一会话只允许一个实例（跨进程由数据目录写意图锁保证；本模块不做锁）。
 */
export class TimelineWriter {
  private readonly sessionId: string;
  private readonly sessionDir: string;
  private readonly walPath: string;
  private readonly timelinePath: string;
  private readonly manifestPath: string;
  private readonly chunkFlushMs: number;
  private readonly options: TimelineWriterOptions;

  private walHandle!: FileHandle;
  private holes!: HoleRegistry;
  private blocks!: ChunkBlockStore;
  /**
   * 索引构造器。**不是 `readonly`**：全量恢复要从零重建（`fullRecovery` 会换一个新实例，
   * 否则增量路径打过的底会让条数被算两遍）。
   */
  private indexBuilder = new TimelineIndexBuilder();

  private nextSeq = 1;
  private walHead = 0;
  private timelineHead = 0;
  private published = 0;
  private taintedFlag = false;
  private walSize = 0;

  /**
   * 污点「代际」计数（jn-F2：归档移出 append 队列后的并发护栏）。
   *
   * 每次把 `taintedFlag` 置 true 都 +1。归档成功后的 {@link clearTaint} 只在「代际没变」
   * 时才真正清污点 —— 否则说明清退行写盘期间又有新的失败把污点点亮，宁可保留（保守方向，
   * 绝不把一条刚发生的失败洗掉）。append 队列与归档链共用这一个计数器。
   */
  private taintEpoch = 0;

  /**
   * `wal.log` 已严格校验到的**字节边界**（行边界；jn-F2 增量校验缓存）。
   *
   * 归档只 strict 读 `[walValidatedBytes, walSize快照)` 的新增段，而不是整份重读。
   * 只在「本次归档段成功提交」或「水位已覆盖右端、无需抄」时才前进到本次读到的右端；
   * 抄写失败 ⇒ 不前进（下一次重试重读同一段，绝不漏抄）。文件回退（rollback 截断）⇒
   * 边界大于当前 `walSize` 时退回整份读。`0` = 尚未校验过（首次归档整份读，与旧行为一致）。
   */
  private walValidatedBytes = 0;

  /**
   * `timeline.ndjson` 归档校验缓存（jn-F2：`size:mtime` 失效键，与 heads 缓存同口径）。
   *
   * 文件没变 ⇒ 上次「整份 strict 读」的结论（最大 seq + 无坏行）仍有效，跳过整份读、
   * 只读尾窗（闸门 3 保留）。本进程自己追加成功后主动刷新戳与最大 seq，免得下一次归档
   * 因为「自己刚写过」而误判失效再整份读。跨进程写者改动了文件 ⇒ 戳变 ⇒ 重新整份校验。
   */
  private archiveStamp = '';
  private archiveValidated = false;
  private archiveValidatedMaxSeq = 0;

  /**
   * 归档水位的**进程内高水位**（只增不减）：`timeline.ndjson` 里已经有过记录的最大 seq。
   *
   * 它是「同一段绝不被抄两次」的第一道闸门，且**不依赖盘上那一读**：
   *
   * - `open()` 恢复时置成「归档副本 / manifest 里见过的最大 seq」；
   * - 每次成功追加归档段之后推进到该段右端。
   *
   * 为什么必须有它（真实事故）：`archiveNow()` 的起点过去只由「重读归档副本」决定，而那一读
   * 在宽容读法里**任何失败都等于「空文件」**（Windows 上 `EPERM`/`EBUSY` 就够）。一旦它返回
   * 空，`writeFrom` 就退回内存里的 `timeline_head + 1`，把**已经落盘的整段再抄一遍**
   * （现场：`09f82ac6` 的 71194–71198 就是被抄了两次）。水位是本进程亲眼看过的最大值，
   * 读盘再怎么失败都拉不低它。
   */
  private archiveWatermark = 0;

  private readonly logger: Logger;

  private queue: Promise<void> = Promise.resolve();
  /**
   * 归档专用串行链（jn-F2：与 append 队列**分离**）。
   *
   * 归档的整份/增量读 + 抄写不再排在 `queue` 上 ⇒ 归档期间事实 append/publish 不停摆。
   * 同一会话的归档仍一个一个跑（这条链保证）；跨进程仍靠 {@link withArchiveLock} 串行。
   * `close()` 会先 drain 这条链再关句柄。
   */
  private archiveChain: Promise<void> = Promise.resolve();
  private pendingChunks: PendingChunk[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private indexDirty = false;
  /** 上次索引落盘时刻（`Date.now()`；0 = 本写者还没写过）。节流判定用，见常量注释。 */
  private lastIndexPersistAt = 0;
  /** 上次索引落盘以来新增的记录条数（事实 + 块内 chunk）。 */
  private indexPendingRecords = 0;
  /** run 终态事件置位：下一次 flush 无条件落盘索引。 */
  private indexForcePersist = false;

  private constructor(options: TimelineWriterOptions) {
    this.options = options;
    this.logger = options.logger ?? noopLogger;
    this.sessionId = options.sessionId;
    this.sessionDir = options.sessionDir;
    this.walPath = join(this.sessionDir, TIMELINE_LAYOUT.walLog);
    this.timelinePath = join(this.sessionDir, TIMELINE_LAYOUT.timeline);
    this.manifestPath = join(this.sessionDir, TIMELINE_LAYOUT.timelineManifest);
    this.chunkFlushMs = clampChunkFlushMs(options.chunkFlushMs);
  }

  /**
   * 打开（或创建）一个会话的写者并恢复状态。
   *
   * **0.55**：旧格式会话（只有 `events.ndjson`、没有 timeline 标记）不写、不迁移，
   * 直接抛 `legacy_session_unsupported`（`legacy-format.ts`）。0.54 时代的
   * `session_frozen_readonly`（只读冻结）随之取消 —— 那套格式已经没有代码能解析。
   */
  static async open(options: TimelineWriterOptions): Promise<TimelineWriter> {
    if (typeof options.sessionId !== 'string' || options.sessionId.length === 0) {
      throw new TimelineError('timeline_write_failed', 'sessionId must be non-empty');
    }
    const writer = new TimelineWriter(options);
    await writer.initialize();
    return writer;
  }

  // ---------------------------------------------------------------- public API

  /**
   * 追加一条事件；返回的记录在对应 WAL 落盘后才 resolve（I1/I2）。
   *
   * - 非 chunk：写 `wal.log` 一行 + fsync；
   * - chunk（仅 `text_delta` / `reasoning_delta`）：进活动块；块满/被迫封块后 fsync，再 resolve；
   * - **瞬时 chunk**（`tool_call_delta` / `finish`）：不在这里 —— 在分配 seq **之前**就抛
   *   `timeline_event_type_excluded`（它们只走实时通道，见 `blocks.ts#isTransientChunkEvent`）。
   *
   * 失败 ⇒ 抛 `timeline_write_failed`，该 seq 作废不回收，并已落盘成洞。
   */
  append(input: TimelineAppendInput): Promise<TimelineRecord> {
    if (this.closed) {
      return Promise.reject(new TimelineError('timeline_writer_closed', 'writer is closed'));
    }
    try {
      this.validateInput(input);
      // 不可序列化的 data 必须在**分配 seq 之前**拒绝（否则 seq 被消费却没有可声明的洞）。
      this.dataBytes(input.data);
    } catch (error) {
      return Promise.reject(error);
    }
    if (isChunkEventType(input.type)) {
      return this.enqueue(async () => this.chunkStep(input)).then((step) => step.durability);
    }
    return this.enqueue(() => this.factStep(input));
  }

  /**
   * 批量追加（同一会话）：连续非 chunk 事件一次 write + 一次 fsync。
   *
   * 语义与逐条 `append` 一致（seq 序列相同、发布顺序相同）；块/非块交替时会在边界
   * 处封块，因此**不会**出现“chunk 先发布、更小的 seq 后发布”。
   *
   * 校验在分配任何 seq **之前**跑完全部入参：任一条不合法（含瞬时 chunk，见
   * {@link TimelineWriter#append}）⇒ 整批拒绝、一条 seq 都不消费。
   */
  appendMany(inputs: readonly TimelineAppendInput[]): Promise<TimelineRecord[]> {
    if (this.closed) {
      return Promise.reject(new TimelineError('timeline_writer_closed', 'writer is closed'));
    }
    try {
      for (const input of inputs) {
        this.validateInput(input);
        this.dataBytes(input.data);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(() => this.appendManyNow(inputs));
  }

  /**
   * 把已 append 的东西都写成 durable、可枚举；**不封块**（块在 run 存活期间继续追加）。
   *
   * 事实/chunk 本体的 durability 不受节流影响（wal/块各自 fsync）；节流的只有**派生
   * 索引**的落盘（jn-F1）：读路径每次 settle 都走到这里，过去每次都整份重写三个索引
   * 文件，现在按时间/条数阈值合并（见 `INDEX_PERSIST_*` 常量注释）。`close()` 必写。
   */
  flush(): Promise<void> {
    return this.enqueue(async () => {
      await this.flushPendingChunks();
      await this.blocks.flushManifests();
      if (this.indexDirty && this.indexPersistDue()) await this.persistIndex();
    });
  }

  /** 关闭：flush → 封块 → drain 归档链 → 关句柄。重复调用幂等。 */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    // 关闭是「这个 run 的 chunk 流到此为止」的最后一个边界：把活动块收口并写下 manifest
    // 条目（否则最后一个块要等下一次 `open()` 才补记账）。
    await this.enqueue(async () => {
      await this.sealPendingBlock();
      await this.blocks.flushManifests();
      if (this.indexDirty) await this.persistIndex();
    });
    // 先标 closed：此后排队的归档任务在 archiveNow 入口即跳过；再 drain 在飞归档，
    // 保证它不会在句柄关闭之后还往 timeline.ndjson / manifest 追加（jn-F2 独立链）。
    this.closed = true;
    await this.archiveChain;
    this.clearIdleTimer();
    this.blocks.close();
    await this.holes.close();
    // benign: 关闭路径尽力释放 WAL 句柄，失败不抛（数据已 flush）。
    await this.walHandle.close().catch(() => {});
  }

  /**
   * 对外可上报的四字段（ADR-105 §3 I4；字段名固定）。
   *
   * `tainted` 是**派生值**：「还有**未退役**的洞」恒 true，否则取「物理顺序上最后一条状态
   * 声明」——这样它才不会因为一次瞬时失败（或一个已修好的洞）永久为真。
   *
   * `holes` 报的是**存活**洞（`HoleRegistry.list()` 已剔掉退役区间）：客户端拿它算
   * 「可读条数」时不能减掉已退役的区间 —— 那些 seq 现在真的可读了。
   *
   * ## `wal_head` 的定义（本字段存在的全部意义）
   *
   * `wal_head` = **最大的 `h`，使 `[1..h]` 里每个 seq 要么读得回来、要么已在
   * `holes.ndjson` 里声明**（ADR-105 §3）。读侧据此算 `count = 区间长度 - |holes ∩ 区间|`，
   * 它只要偏离一点点，客户端就会把「服务端自己没读到」当成缺口。
   *
   * 因此 head 只在这两件事**都已落盘**时才前进：该 seq 的载荷（`wal.log` 行 / 块文件）
   * fsync 过；或该 seq 的洞声明进了 `holes.ndjson`。**没落盘成功的洞不许顶 head**
   * （`recordFailure` 返回 false ⇒ 不推进）：宁可少报，绝不把「读不到又没声明」的 seq
   * 算进来。另一半责任在读侧 —— 一次读必须是自洽快照（见 `wal.ts#readTimelineEvents`
   * 的读取顺序），否则「可读」这个词本身就没有定义。
   */
  heads(): TimelineHeads {
    return {
      timeline_head: this.timelineHead,
      wal_head: this.walHead,
      holes: this.holes.list().slice(),
      tainted: this.taintedFlag || this.holes.list().length > 0,
    };
  }

  /** 已发布过的最大 seq（具名断言 A5 用；不属于对外四字段）。 */
  publishedHead(): number {
    return this.published;
  }

  /** 读回全部事件（按 seq 升序）；先 flush 保证包含刚追加的 chunk。 */
  async readAll(): Promise<TimelineRecord[]> {
    await this.flush();
    return readTimelineEvents(this.sessionDir);
  }

  /**
   * 归档：把已持久 WAL 里的非 chunk 行复制进 `timeline.ndjson`，块只记 manifest 指针。
   *
   * 失败：重试 3 次（100/500/2000 ms）；仍失败 ⇒ `timelineHead` 不动、`walHead` 照常、
   * 主 manifest 记 `tainted`、回调 `onArchiveFailed`。**不**写 holes（数据没丢）。
   *
   * 成功：`timelineHead` 推进到 `walHead`；若此时**已无存活洞**且当前是污点，再追加一条
   * `tainted_cleared`（历史 `tainted` 行保留），会话级污点随之撤销。
   */
  archive(): Promise<ArchiveResult> {
    // jn-F2：挂在归档专用链上，**不**与 append 共队列 —— 归档读盘期间事实 append 不停摆。
    const run = this.archiveChain.then(() => this.archiveNow());
    this.archiveChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * **显式**退役一段已登记的洞（第二刀；`hole_retired` 声明 + last-wins）。
   *
   * 触发方式只有这一个 API：没有显式的 `retireHoles()` 调用就不会有任何退役，`open()` 也不会
   * 「顺手腾一下」（运维命令/CLI 接线在装配层 `src/**`，不在本切片范围）。为什么**默认不做
   * 自动退役**：自动判定需要全量重读（启动变慢），而且判错方向是把坏块洗白 —— 那是不可逆的
   * 静默错误，必须由人显式发起。
   *
   * 退役**前提 = 区间重读自证**（`HoleRegistry.retire` → `verifyHoleIntervalReadable`）：
   * `[from_seq,to_seq]` 里每个 seq 都必须能读出一条 CRC 通过的记录。任何一条缺/坏 ⇒
   * 返回 `ok:false` 且一个字节都不写（`reason` 里带缺哪些 seq）。
   *
   * 成功后的连带动作：
   * - `wal_head` 只可能**前进**（该区间现在真的可读；`published` 一个字节都不动 ——
   *   退役不是「发布」，把没发过的东西算成已发布就是撒谎）。注意这里的收紧只基于**索引
   *   已经见过的** seq（打开不重读，见上）：区间右端若当初没进索引，`wal_head` 会**少报**
   *   而不是多报 —— 下一次 `open()` 读到那些记录后自然补齐；
   * - 若无别的存活洞且当前是污点 ⇒ 追加一条 `tainted_cleared`（与健康归档同一个函数，
   *   `clearTaint()`），历史行一条不改。
   */
  retireHoles(input: {
    from_seq: number;
    to_seq: number;
    reason: string;
  }): Promise<HoleRetirementResult> {
    return this.enqueue(() => this.retireHolesNow(input));
  }

  private async retireHolesNow(input: {
    from_seq: number;
    to_seq: number;
    reason: string;
  }): Promise<HoleRetirementResult> {
    if (this.closed) {
      throw new TimelineError('timeline_writer_closed', 'retireHoles() after close()');
    }
    const outcome = await this.holes.retire(input.from_seq, input.to_seq, input.reason);
    if (!outcome.ok) return outcome;
    // 区间逐条可读 ⇒ 可读性右端可能前进（只增不减；`published` 不动）。
    this.walHead = Math.max(
      this.walHead,
      contiguousHead(this.indexBuilder.seqs(), this.holes.list()),
    );
    await this.clearTaint('holes_retired', input.from_seq, input.to_seq);
    this.indexDirty = true;
    await this.persistIndex();
    return outcome;
  }

  // ---------------------------------------------------------------- queue

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---------------------------------------------------------------- open

  /**
   * 打开时的状态恢复：**先增量、后全量**，两条路径产出同一份状态。
   *
   * 增量路径（`tryIncrementalRecovery`）读的是「索引 + 尾部窗口」，上界全是常量；只要它
   * 能自洽地答出四个 head，就不碰会话的历史部分。任何一条自洽检查不成立 ⇒ 退回
   * `fullRecovery`（整份读，0.54 之前唯一的那条路径），**判定口径一个字都不放宽**。
   *
   * 为什么必须这样分（第十一条 · 真实事故）：`d813eaea` 这种 19 万事件 / 340 MB 的会话，
   * 一次全量恢复要读 6.9 MB `wal.log` + 6.9 MB 归档 + 4,150~12,900 个块文件（≈ 88 MB），
   * 逐帧 JSON.parse + CRC，实测秒级；而 `dualWrite` 现在是每次进程启动 / 会话打开 /
   * idle 压缩 / adopt 都要付一遍。用户看到的就是「重启后明显变慢」。
   */
  private async initialize(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
    // 旧格式会话（0.54 之前）：**拒绝**，不是「只读」。判据与错误码在 `legacy-format.ts`
    // 一处定义，索引写回（`writeIndexSnapshot`）走同一个闸门，所以「哪条写路径忘了判」
    // 在结构上不成立。0.55 删掉 `events.ndjson` 的全部读写之后，这种目录既不能读也不能写，
    // 唯一的出路是用 0.54 导出（文案里写着）。
    await assertSessionFormatSupported(this.sessionDir, this.sessionId);
    await this.ensureManifest();

    this.holes = await HoleRegistry.open(this.sessionDir, {
      beforeSync: this.options.beforeSync,
      now: this.options.now,
    });

    const incremental = await this.tryIncrementalRecovery();
    if (!incremental) await this.fullRecovery();

    // benign: 大小探针——stat 失败按 0（恢复后重新计量）。
    const info = await stat(this.walPath).catch(() => undefined);
    this.walSize = info?.size ?? 0;
    this.walHandle = await open(this.walPath, 'a', 0o600);

    // 打开的最后一步：**看一眼归档副本有没有重复 seq**（不修、只 warn）。
    //
    // 为什么放在这里而不是读侧：重复 seq 是写侧留下的损坏，读侧看见它只会（正确地）整段拒绝；
    // 让它「不静默」的唯一位置就是写者打开这个会话的那一刻 —— 那一刻之后，用户就能在日志里
    // 看到「这个会话的哪一段被抄了两次、要人来决定保留还是裁掉」。
    await this.reportArchiveDuplicates();
  }

  /**
   * 启动时的重复 seq 巡检（有界、best-effort、**不改一个字节**）。
   *
   * 失败/超预算都不影响打开：它只回答「要不要 warn 一条」。
   */
  private async reportArchiveDuplicates(): Promise<void> {
    try {
      const audit = await auditArchiveDuplicates(this.sessionDir, {
        maxBytes: OPEN_ARCHIVE_AUDIT_MAX_BYTES,
      });
      const described = describeArchiveDuplicates(audit);
      if (described === undefined) {
        // 只扫了尾部（大会话）：**不许**把「尾部没重复」说成「没有重复」，留一行 debug 记账。
        if (audit.truncated) {
          this.logger.debug('timeline archive duplicate scan covered tail only', {
            session_id: this.sessionId,
            scanned_bytes: audit.scanned_bytes,
            bytes: audit.bytes,
          });
        }
        return;
      }
      this.logger.warn(described.message, described.detail);
    } catch (error) {
      this.logger.debug('timeline archive duplicate scan failed', {
        session_id: this.sessionId,
        error: messageOf(error),
      });
    }
  }

  /**
   * 增量恢复（启动路径；读量上界 = 索引 32 MiB + 尾窗各 4 MiB + 一个块文件）。
   *
   * 返回 `false` = **什么都没提交**（除了撕裂尾帧的截断，那是两条路径共有的清理），调用方
   * 必须走 {@link fullRecovery}。所有自洽检查的结论都只用「索引的算术性质 + 盘上尾窗实测」
   * 两件事，任一处对不上就整份读：
   *
   * | 检查 | 不成立意味着 |
   * | --- | --- |
   * | 索引存在且三文件总量 ≤ 32 MiB | 索引缺失/被删/过大 ⇒ 没有水位锚点 |
   * | `first_seq = 1 ∧ count = last_seq`（空会话单独放行） | `1..last_seq` 可能有号不在 ⇒ 算不出 `wal_head` 的连续性 |
   * | 尾窗实测 `tailMax ≥ last_seq` 且 `(last_seq, tailMax]` 逐号齐全 | 索引比盘上还新，或尾窗没覆盖住尾部 |
   * | 尾窗里每一行都是合法记录 | 有坏行 ⇒ 必须按原口径登记成洞（那是全量路径的活） |
   * | 块侧 `manifestCrossChecked` 且 `invalid` 为空 | 最后一个块与 manifest 对不上 ⇒ 可能真有丢数据 |
   * | manifest 尾窗找得到 `archive` 行与状态声明（或已到文件起点） | `timeline_head` / `tainted` 的 last-wins 答不准 |
   *
   * 第 5、6 行是**故意保守**的：任何可疑都退回全量，宁可慢一次也不猜。
   */
  private async tryIncrementalRecovery(): Promise<boolean> {
    // ① 索引（派生数据）：先看预算再读。超过上限 ⇒ 不读，走全量（第十一条：有界优先）。
    const snapshot = await loadIndexSnapshot(this.sessionDir, OPEN_INDEX_SEED_MAX_BYTES);
    if (snapshot === undefined) return false;
    // 「1..last_seq 每个号都在」只能由索引自己的算术给出：`count` 是**不同 seq 的个数**，
    // 于是 `first_seq = 1 ∧ count = last_seq` ⇒ 1..last_seq 没有一个号缺失。空会话（还没
    // 写过任何事件，`count = last_seq = 0`）没有「1..N」可数，单独放行。
    const isEmptyIndex = snapshot.session.count === 0 && snapshot.session.last_seq === 0;
    const isContiguous =
      snapshot.session.first_seq === 1 && snapshot.session.count === snapshot.session.last_seq;
    if (!isEmptyIndex && !isContiguous) return false;

    // ② 归档副本尾窗：`timeline_head` 只要「最后一条归档行的 seq」，一段就够。
    const archivedTail = await readNdjsonTail(this.timelinePath);
    if (archivedTail === undefined) return false;
    // 坏行**不在这一步声明**：洞必须按原口径（含残行捞 seq、与已有洞去重）由全量路径登记，
    // 所以这里见到一行不合法就整份重读。
    const archivedRecords = parseTailRecords(archivedTail.lines);
    if (archivedRecords === undefined) return false;

    // ③ 主 manifest 尾窗：最后一条 `archive`（archivedTo）+ 最后一条状态声明（污点 last-wins）。
    const manifest = await this.readManifestTail();
    if (manifest === undefined) return false;

    // ④ 块：只解最后一个块，并用 `wal.manifest` 尾窗与它互校（口径同 `recovery:'full'`）。
    const blockOpen = await ChunkBlockStore.open(this.sessionDir, {
      maxBytes: this.options.blockMaxBytes ?? BLOCK_MAX_BYTES,
      beforeSync: this.options.beforeSync,
      recovery: 'tail',
    });
    if (!blockOpen.recovery.manifestCrossChecked) return false;
    // 块侧任何一处不自洽（坏帧 / manifest 说写完但帧缺 / 块文件不在）⇒ 退回全量：
    // 洞声明是正确性，这一步一个字都不省。
    if (blockOpen.recovery.invalid.length > 0) return false;

    /**
     * 一趟 `wal.log` 尾窗 → `(last_seq, tailMax]` 的增量记录。
     *
     * 返回 `undefined` 的三种情形都意味着「这趟尾窗答不准」：尾窗里有坏行、索引比盘上还新、
     * 或增量区间不是逐号齐全（尾窗没覆盖住 / 中间可能缺号）。
     */
    const buildExtension = (
      walLines: readonly string[],
    ): { extension: TimelineRecord[]; tailMax: number } | undefined => {
      const walRecords = parseTailRecords(walLines);
      if (walRecords === undefined) return undefined;
      const tail = new Map<number, TimelineRecord>();
      // 覆盖顺序与全量恢复一致：归档副本 < 块帧 < WAL 原文（同一条逐字节相同，后者覆盖以防截断）。
      for (const record of archivedRecords) tail.set(record.seq, record);
      for (const record of blockOpen.recovery.records) tail.set(record.seq, record);
      for (const record of walRecords) tail.set(record.seq, record);
      let tailMax = 0;
      for (const seq of tail.keys()) if (seq > tailMax) tailMax = seq;
      if (tailMax < snapshot.session.last_seq) return undefined; // 索引比盘上还新 ⇒ 不自洽
      if (tailMax - snapshot.session.last_seq > OPEN_TAIL_MAX_EXTENSION_RECORDS) return undefined;
      const extension: TimelineRecord[] = [];
      for (let seq = snapshot.session.last_seq + 1; seq <= tailMax; seq += 1) {
        const record = tail.get(seq);
        if (record === undefined) return undefined;
        extension.push(record);
      }
      return { extension, tailMax };
    };

    // ⑤ `wal.log` 尾窗（首窗 256 KiB）。装不下增量就按上限（4 MiB）再读一次 —— 那正是
    // 「进程被强杀、索引滞后一段」的常见形态，仍是有界读。再装不下 ⇒ 全量。
    let walTail = await readNdjsonTail(this.walPath);
    if (walTail === undefined) return false;
    let built = buildExtension(walTail.lines);
    if (built === undefined && !walTail.fromStart) {
      walTail = await readNdjsonTail(this.walPath, TAIL_WINDOW_MAX_BYTES, TAIL_WINDOW_MAX_BYTES);
      if (walTail === undefined) return false;
      built = buildExtension(walTail.lines);
    }
    if (built === undefined) return false;
    const { extension, tailMax } = built;

    // 撕裂尾帧清理：与全量路径逐字同一口径（末尾没有换行的那一段从未完整写出）。
    if (walTail.truncateTo !== undefined) await truncateFile(this.walPath, walTail.truncateTo);
    if (archivedTail.truncateTo !== undefined) {
      await truncateFile(this.timelinePath, archivedTail.truncateTo);
    }

    // ⑥ 补声明恢复洞。全量路径的判据是 `findGaps(记录 seq 集合, 洞, knownMax)`：`[1..knownMax]`
    //    里**既没有记录、也没被洞覆盖**的区间一律登记成 `missing_seq_on_recovery`。
    //    这里记录集已经证明恰好是区间 `[1..tailMax]`（① 的算术 + ⑤ 的逐号检查），于是同一个
    //    判定退化成「`(tailMax, knownMax]` 减去洞区间」—— 判据不变，省掉的只是 20 万次
    //    「这个号在不在集合里」。`archivedTo` 出现在 `knownMax` 里正是「manifest 说已经归档、
    //    盘上却读不回来」那一类缺口，和全量路径一样要声明，不许因为读得少就少报。
    const knownMax = Math.max(tailMax, this.holes.maxSeq(), manifest.archivedTo);
    let declaredHoles = 0;
    for (const range of uncoveredTailRanges(tailMax, knownMax, this.holes.list())) {
      try {
        await this.holes.add(range.from_seq, range.to_seq, 'missing_seq_on_recovery');
        declaredHoles += 1;
      } catch {
        // 洞没落盘 ⇒ 不许拿它顶 `wal_head`（`recordFailure` 的同一纪律）。退回全量，让它再试。
        return false;
      }
    }

    // ⑦ 提交：索引打底 + 追加增量（此后 `persistIndex()` 写出的仍是**完整**索引）。
    if (!this.indexBuilder.seed(snapshot)) return false;
    for (const record of extension) this.indexBuilder.add(record);

    this.blocks = blockOpen.store;
    // ⑥ 之后 `[1..knownMax]` 每条要么是记录、要么已声明成洞 ⇒ 连续头就是 `knownMax`
    // （与全量路径的 `contiguousHead(seqs, holes)` 同一个结果）。
    this.walHead = knownMax;
    this.published = this.walHead;
    const maxArchived = Math.max(manifest.archivedTo, maxRecordSeq(archivedRecords));
    this.timelineHead = Math.min(maxArchived, this.walHead);
    // 归档水位只增不减：这是「同一段绝不抄两次」的起点（见字段注释）。
    this.archiveWatermark = maxArchived;
    this.nextSeq = Math.max(knownMax, this.holes.maxSeq()) + 1;
    // 两个来源，任一为真即污点（与全量路径同一判据）。
    this.taintedFlag = this.holes.list().length > 0 || manifest.tainted;
    // 索引没变化就不重写：`open()` 不该为「什么都没变」付一次 1 MB 级的 durable 写。
    // （⑤ 有增量、或 ⑥ 声明了新洞时必须落盘：否则下一次打开又要多读一遍尾部。）
    this.indexDirty = extension.length > 0 || declaredHoles > 0;
    if (this.indexDirty) await this.persistIndex();
    return true;
  }

  /**
   * 全量恢复（**唯一的全量重读入口**；0.54 之前 `open()` 只有这一条）。
   *
   * 什么时候走到这里（都是「增量路径答不准」的情况，不是错误）：
   *
   * - 索引缺失 / 被删 / 超过 {@link OPEN_INDEX_SEED_MAX_BYTES} / 算术不自洽；
   * - 尾窗里有坏行、坏帧，或 `wal.manifest` 与块对不上（**洞要按原口径声明**）；
   * - 索引比盘上还新，或尾部的增量超出一个尾窗（例如进程被强杀后索引滞后很多）；
   * - `wal.manifest` / `timeline.manifest` 的尾部读不出结论。
   *
   * 它也是显式修复路径：把索引删掉再打开一次，就等于「整份重读并重建索引 + 重新声明洞」。
   * 成本 O(会话大小) —— 这就是它不该在启动路径上的原因。
   */
  private async fullRecovery(): Promise<void> {
    // 增量路径可能已经给构造器打过底；全量重建必须从零开始（否则条数会被算两遍）。
    this.indexBuilder = new TimelineIndexBuilder();
    const blockOpen = await ChunkBlockStore.open(this.sessionDir, {
      maxBytes: this.options.blockMaxBytes ?? BLOCK_MAX_BYTES,
      beforeSync: this.options.beforeSync,
      recovery: 'full',
    });
    this.blocks = blockOpen.store;

    const walRead = await readNdjsonFile(this.walPath);
    if (walRead.truncateTo !== undefined) await truncateFile(this.walPath, walRead.truncateTo);
    const timelineRead = await readNdjsonFile(this.timelinePath);
    if (timelineRead.truncateTo !== undefined) {
      await truncateFile(this.timelinePath, timelineRead.truncateTo);
    }
    const manifest = await this.readManifest();

    // 恢复记录：归档副本 < 块帧 < WAL 原文（同一条应逐字节相同，后者覆盖以防归档副本截断）
    const records = new Map<number, TimelineRecord>();
    for (const record of timelineRead.records) records.set(record.seq, record);
    for (const record of blockOpen.recovery.records) records.set(record.seq, record);
    for (const record of walRead.records) records.set(record.seq, record);
    const sorted = [...records.values()].sort((a, b) => a.seq - b.seq);
    for (const record of sorted) this.indexBuilder.add(record);

    // 完整但损坏的帧/行：seq 可读的登记成洞（读不回来必须可声明）。
    // 块的 `invalid` 自带 reason（坏帧 / manifest 说写完了但帧缺 / 块文件不在），
    // 原样落到洞记录里 —— 恢复期最需要的正是「为什么少了这一段」。
    const invalidRanges: Array<{ from_seq: number; to_seq: number; reason: string }> = [
      ...blockOpen.recovery.invalid.map((item) => ({
        from_seq: item.from_seq,
        to_seq: item.to_seq,
        reason: item.reason,
      })),
    ];
    for (const invalid of [...walRead.invalid, ...timelineRead.invalid]) {
      if (invalid.seq !== undefined) {
        invalidRanges.push({
          from_seq: invalid.seq,
          to_seq: invalid.seq,
          reason: 'corrupt_frame_on_recovery',
        });
      }
    }
    // 洞只许覆盖**真的读不回来**的 seq：恢复出来的区间里可能夹着读得回来的记录
    // （可追加块的块区间横跨事实行，事实行的载荷在 `wal.log` 里；块尾被截断时，被截掉的
    // 标记帧后面那些事实行照样可读）。多报一个 seq 就等于让客户端少算一条可读记录 ——
    // 那是「声明式少给」，与静默少给只差一层包装。所以逐号剔除可读的，再按连续段声明。
    for (const range of invalidRanges) {
      for (const sub of subtractReadable(range.from_seq, range.to_seq, records)) {
        if (this.holes.covers(sub.from_seq)) continue;
        await this.declareRecoveryHole(sub.from_seq, sub.to_seq, range.reason);
      }
    }

    // 恢复出的空洞（既无记录也无洞）必须补声明，否则 wal_head 会停在一个说不出原因的洞里。
    const knownMax = Math.max(this.indexBuilder.maxSeq(), this.holes.maxSeq(), manifest.archivedTo);
    for (const gap of findGaps(this.indexBuilder.seqs(), this.holes.list(), knownMax)) {
      await this.declareRecoveryHole(gap.from_seq, gap.to_seq, 'missing_seq_on_recovery');
    }

    this.nextSeq = Math.max(knownMax, this.holes.maxSeq()) + 1;
    this.walHead = contiguousHead(this.indexBuilder.seqs(), this.holes.list());
    this.published = this.walHead;
    const maxArchived = Math.max(manifest.archivedTo, maxRecordSeq(timelineRead.records));
    this.timelineHead = Math.min(maxArchived, this.walHead);
    // 归档水位只增不减（同增量路径）。注意取的是**归档副本里见过的最大 seq**，不是
    // `timelineHead`：后者会被 `wal_head` 夹小（有洞时），拿它当水位会允许重抄。
    this.archiveWatermark = maxArchived;
    // 两个来源，任一为真即污点：盘上还有**未退役**的洞（真丢失），或 manifest 的
    // last-wins 状态是 `tainted`。`holes.list()` 已是存活口径，退役区间不再压制污点。
    // 打开时**不重读区间**：退役声明只在自证通过后才被写出（`retireHoles()`）。
    this.taintedFlag = this.holes.list().length > 0 || manifest.tainted;

    this.indexDirty = true;
    await this.persistIndex();
  }

  private async ensureManifest(): Promise<void> {
    if (await fileExists(this.manifestPath)) return;
    const line = withCrc({ v: 1 as const, kind: 'open' as const, at: this.now() });
    await atomicWrite(this.manifestPath, `${JSON.stringify(line)}\n`, {
      mode: 0o600,
      durable: true,
    });
  }

  /**
   * 磁盘上的两个事实：已归档到的 seq，以及**当前**的会话级污点。
   *
   * `tainted` 用 last-wins 读法（`lastTaintedState()`），不是「出现过任何 tainted 行」——
   * 后者会让一次瞬时失败永久钉死会话（本单修的就是这个）。
   */
  private async readManifest(): Promise<{ archivedTo: number; tainted: boolean }> {
    const result = await readCrcNdjsonFile<TimelineManifestLine>(
      this.manifestPath,
      validateManifestLine,
    );
    if (result.truncateTo !== undefined) {
      await truncateFile(this.manifestPath, result.truncateTo);
    }
    let archivedTo = 0;
    for (const line of result.items) {
      if (line.kind === 'archive') archivedTo = Math.max(archivedTo, line.to_seq);
    }
    return { archivedTo, tainted: lastTaintedState(result.items) };
  }

  /**
   * 从**尾部**读主 manifest 的两个事实（增量恢复用；不整份读）。
   *
   * 与 {@link readManifest} 同一个判据，只是范围换成尾窗：
   *
   * - `archivedTo` = **文件序最后一条** `archive` 行的 `to_seq`（`archive` 行的 `to_seq` 恒
   *   单调：`from = timelineHead + 1`、`to = walHead`，而 `timelineHead` 只会推进到 `to`），
   *   所以「最后一条」就是「全部行里的最大」；
   * - `tainted` = 从后往前扫到的**第一条**状态声明（last-wins，物理行序，不看 `at`）——
   *   与 `lastTaintedState()` 同一条口径。
   *
   * 两个事实都在尾窗之外时扩窗（64 KiB → 1 MiB）；到上限还答不准 ⇒ `undefined`，调用方
   * 退回全量恢复。坏行按 {@link readManifest} 的口径**忽略**（那边也不为坏行做任何声明）。
   */
  private async readManifestTail(): Promise<{ archivedTo: number; tainted: boolean } | undefined> {
    let firstBytes = MANIFEST_TAIL_FIRST_BYTES;
    for (;;) {
      const window = await readNdjsonTail(this.manifestPath, firstBytes, MANIFEST_TAIL_MAX_BYTES);
      if (window === undefined) return undefined;
      // 崩在「manifest 追加中途」留下的半行：与全量读同一处理（截掉，否则下一次追加会接在半行后面）。
      if (window.truncateTo !== undefined) {
        await truncateFile(this.manifestPath, window.truncateTo);
      }
      let archivedTo = 0;
      let state: boolean | undefined;
      for (let index = window.lines.length - 1; index >= 0; index -= 1) {
        const text = window.lines[index];
        if (text === undefined) continue;
        const line = parseManifestText(text);
        if (line === undefined) continue; // 坏行：与全量读同口径忽略
        if (archivedTo === 0 && line.kind === 'archive') archivedTo = line.to_seq;
        if (state === undefined && (line.kind === 'tainted' || line.kind === 'tainted_cleared')) {
          state = line.kind === 'tainted';
        }
        if (archivedTo > 0 && state !== undefined) break;
      }
      // 读到了文件起点 ⇒ 更早的行不存在，答案就是它（没有状态声明 ⇒ tainted = false）。
      if (window.fromStart || (archivedTo > 0 && state !== undefined)) {
        return { archivedTo, tainted: state === true };
      }
      if (firstBytes >= MANIFEST_TAIL_MAX_BYTES) return undefined;
      firstBytes = Math.min(firstBytes * 4, MANIFEST_TAIL_MAX_BYTES);
    }
  }

  /**
   * 追加一行 manifest（**自带精确回滚**）。
   *
   * 回滚只截掉**这一行自己的字节**，而且仅在它确实还是文件末尾时：
   *
   * - 过去用的是「本次尝试开始时 `stat` 出来的文件长度」，那是调用方猜的偏移。两个写者
   *   （或一次 fsync 失败后的重试）交错时，按那个偏移截断会**吃掉别人的行** ——
   *   现场 `09f82ac6` 就出现过「归档段已经落了盘、对应的 `archive` 行却不在 manifest 里」
   *   的组合（归档指针因此不前进，下一次归档又从头抄一遍：重复段正是这么来的）。
   * - 现在偏移来自**自己的句柄**（`handle.stat()`），而且只在 `size === 起点 + 本行长度`
   *   时才截断：后面已经有人追加过 ⇒ 一个字节都不动（宁可留半行让读者按 `truncateTo`
   *   处理，也不删别人的事实）。
   */
  private async appendManifest(line: TimelineManifestLine): Promise<void> {
    const stamped = withCrc(line);
    const buffer = Buffer.from(`${JSON.stringify(stamped)}\n`, 'utf8');
    const handle = await open(this.manifestPath, 'a', 0o600);
    let start = -1;
    try {
      start = (await handle.stat()).size;
      await writeAll(handle, buffer);
      this.options.beforeSync?.('manifest');
      await handle.sync();
    } catch (error) {
      // benign: 错误路径关闭句柄，失败不掩盖原始错误（回滚后重抛）。
      await handle.close().catch(() => {});
      await this.rollbackTrailingAppend(this.manifestPath, start, buffer.length);
      throw error;
    }
    // benign: 成功路径关闭句柄，失败不掩盖已 sync 的写入结果。
    await handle.close().catch(() => {});
  }

  /**
   * 回滚一次「追加」：只在磁盘上确实还是「起点 + 本次字节数」时截断到起点。
   *
   * 三个保守出口（都不截断）：没拿到起点、`stat` 读不出来、后面已经有人追加过。
   * 回滚失败一律吞掉 —— 它只是尽力而为，判据在调用方（登记洞 / 报污点），不在这里。
   */
  private async rollbackTrailingAppend(
    path: string,
    start: number,
    written: number,
  ): Promise<void> {
    if (start < 0) return;
    // benign: 回滚判据探针——stat 读不出来就不截断（保守出口，见函数注释）。
    const size = (await stat(path).catch(() => undefined))?.size;
    if (size === undefined || size !== start + written) return;
    try {
      await truncateFile(path, start);
    } catch {
      // 留半行：下一次读按 `truncateTo` 处理（与崩溃后同一口径）。
    }
  }

  // ---------------------------------------------------------------- append

  private validateInput(input: TimelineAppendInput): void {
    if (typeof input.type !== 'string' || input.type.length === 0) {
      throw new TimelineError('timeline_write_failed', 'event type must be a non-empty string');
    }
    if (isExcludedEventType(input.type)) {
      throw new TimelineError(
        'timeline_event_type_excluded',
        `${input.type} is not a session fact (ADR-105 §8.1)`,
      );
    }
    // 0.54 chunk-slim（I2 的逆否）：瞬时 chunk（`tool_call_delta` / `finish`）刷新后由
    // `tool.call.*` / `llm.response` 复原，没有「读不回来」的内容 ⇒ 不落盘。而不落盘就
    // **不许取 seq** —— 所以必须在 `nextSeq += 1` 之前拒绝，否则「已发布未落盘」+ `count`
    // 里凭空多出不可读区间。第一刀在 `run-journal.ts#appendFact`，这里是第二道闸门。
    if (isTransientChunkEvent(input)) {
      throw new TimelineError(
        'timeline_event_type_excluded',
        `${input.type} carries a transient chunk (tool_call_delta / finish): live channel only, never a timeline_seq`,
      );
    }
    if (typeof input.run_id !== 'string') {
      throw new TimelineError('timeline_write_failed', 'run_id must be a string');
    }
    if (typeof input.ts !== 'number' || !Number.isFinite(input.ts)) {
      throw new TimelineError('timeline_write_failed', 'ts must be a finite number');
    }
  }

  private dataBytes(data: unknown): number {
    try {
      return Buffer.byteLength(JSON.stringify(data ?? null), 'utf8');
    } catch {
      throw new TimelineError('timeline_write_failed', 'data is not JSON-serializable');
    }
  }

  /**
   * 把超大 `data` 外置到 `timeline/blobs/<seq>.bin`，返回记录行里的引用。
   *
   * 顺序纪律：blob 先写 + fsync，之后调用方才写记录行。blob 写失败会删除半文件并抛回，
   * 调用方把该 seq 登记成洞（不会出现“行在、data 永远读不回来”）。
   */
  private async writeBlob(seq: number, data: unknown): Promise<TimelineBlobRef> {
    const payload = Buffer.from(JSON.stringify(data), 'utf8');
    const path = blobPath(this.sessionDir, seq);
    await mkdir(dirname(path), { recursive: true });
    let handle: FileHandle | undefined;
    try {
      // 'w' 而不是 'wx'：崩溃可能留下一个从未被记录行引用的 blob；该 seq 随后被重新分配时
      // 覆盖它是安全的（引用该 seq 的持久记录不存在）。
      handle = await open(path, 'w', 0o600);
      await writeAll(handle, payload);
      this.options.beforeSync?.('blob');
      await handle.sync();
    } catch (error) {
      // benign: blob 错误路径关闭/清理，失败不掩盖原始错误（重抛）。
      await handle?.close().catch(() => {});
      await unlink(path).catch(() => {});
      throw error;
    }
    // benign: blob 成功路径关闭句柄，失败不掩盖已 sync 的写入结果。
    await handle.close().catch(() => {});
    await fsyncDirectory(dirname(path));
    return { blob: true, bytes: payload.length, crc32: crc32Hex(payload) };
  }

  private buildRecord(
    seq: number,
    input: TimelineAppendInput,
    data: unknown = input.data,
  ): TimelineRecord {
    const body: Omit<TimelineRecord, 'crc'> = {
      v: 1,
      seq,
      session_id: this.sessionId,
      run_id: input.run_id,
      ts: input.ts,
      type: input.type,
      data,
    };
    if (input.fencing_token !== undefined) body.fencing_token = input.fencing_token;
    return stampRecord(body);
  }

  private async factStep(input: TimelineAppendInput): Promise<TimelineRecord> {
    // 严格交错（不动）：任何非 chunk 事件落盘前，先把活动块里**更早的** chunk 落盘并发布。
    //
    // 0.57 起这一步只是「落盘」而不是「封块」：块在 run 存活期间继续往后追加（一个 run
    // 一个块），但 `seq` 更小的事实绝不会先于 `seq` 更大的 chunk 可见 —— 判据没变，
    // 变的只是块边界（不再每条事实切一刀）。
    if (this.blocks.pendingCount() > 0) await this.flushPendingChunks();

    const seq = this.nextSeq;
    this.nextSeq += 1;
    let storedData = input.data;
    if (this.dataBytes(input.data) > MAX_INLINE_BYTES) {
      try {
        storedData = await this.writeBlob(seq, input.data);
      } catch (error) {
        // 只有洞真的落到 `holes.ndjson` 才允许把 head 推过这个 seq（见 recordFailure）。
        const declared = await this.recordFailure(
          seq,
          seq,
          `blob_write_failed: ${messageOf(error)}`,
        );
        if (declared) this.advanceWalHead(seq);
        throw new TimelineError('timeline_write_failed', `blob seq=${seq}`, { cause: error });
      }
    }
    const record = this.buildRecord(seq, input, storedData);
    const line = encodeLine(record);
    // 这条事实现落在活动块的覆盖区间里 ⇒ 先在块尾写一个**事实标记帧**
    // （12 B，只声明「这个 seq 是事实、不在本块」，载荷仍然只进 `wal.log`）。
    await this.noteFactInBlock(seq);
    try {
      await this.writeWal(line);
    } catch (error) {
      const declared = await this.recordFailure(seq, seq, `wal_append_failed: ${messageOf(error)}`);
      if (declared) this.advanceWalHead(seq);
      throw new TimelineError('timeline_write_failed', `seq=${seq}`, { cause: error });
    }
    this.acceptRecord(record);
    return record;
  }

  private async chunkStep(input: TimelineAppendInput): Promise<ChunkStep> {
    // run 换人 ⇒ 上一个 run 的块收口（这就是「一个 run 一个块」的边界）。
    // 先封块再分配 seq：封块失败时这一条还没占号（与 `appendMany` 里「seq 在批量写之后
    // 才分配」同一条纪律）。
    const currentRun = this.blocks.currentRun();
    if (currentRun !== undefined && currentRun !== input.run_id) {
      await this.sealPendingBlock();
    }
    const seq = this.nextSeq;
    this.nextSeq += 1;
    if (this.dataBytes(input.data) > MAX_INLINE_BYTES) {
      // chunk 必须始终可内联（块帧是紧凑载体）；超大 chunk 是生产者 bug，显式拒绝。
      const declared = await this.recordFailure(seq, seq, 'chunk_record_too_large');
      if (declared) this.advanceWalHead(seq);
      throw new TimelineError(
        'timeline_record_too_large',
        `chunk data > ${MAX_INLINE_BYTES} bytes (seq=${seq})`,
      );
    }
    const record = this.buildRecord(seq, input);

    const durability = new Promise<TimelineRecord>((resolve, reject) => {
      this.pendingChunks.push({ record, resolve, reject });
    });
    this.blocks.push(record);
    if (this.blocks.shouldSeal()) {
      await this.sealPendingBlock();
    } else {
      this.scheduleIdleFlush();
    }
    return { record, durability };
  }

  private async appendManyNow(inputs: readonly TimelineAppendInput[]): Promise<TimelineRecord[]> {
    const results: TimelineRecord[] = [];
    const chunkDurabilities: Array<Promise<TimelineRecord | undefined>> = [];
    let chunkError: unknown;
    let batchRecords: TimelineRecord[] = [];
    let batchLines: string[] = [];

    const flushBatch = async (): Promise<void> => {
      if (batchRecords.length === 0) return;
      const records = batchRecords;
      const payload = batchLines.join('');
      batchRecords = [];
      batchLines = [];
      try {
        await this.writeWal(payload);
      } catch (error) {
        const from = records[0]?.seq ?? 0;
        const to = records[records.length - 1]?.seq ?? from;
        const declared = await this.recordFailure(
          from,
          to,
          `wal_append_failed: ${messageOf(error)}`,
        );
        if (declared) this.advanceWalHead(to);
        throw new TimelineError('timeline_write_failed', `batch from=${from} to=${to}`, {
          cause: error,
        });
      }
      for (const record of records) this.acceptRecord(record);
      results.push(...records);
    };

    try {
      for (const input of inputs) {
        if (isChunkEventType(input.type)) {
          // 先把更小 seq 的非 chunk 写掉，保证发布严格升序。
          await flushBatch();
          const step = await this.chunkStep(input);
          results.push(step.record);
          chunkDurabilities.push(
            step.durability.then(
              (record) => record,
              (error) => {
                chunkError ??= error;
                return undefined;
              },
            ),
          );
        } else {
          // 严格交错（不封块，只落盘 + 发布，见 `factStep`）。
          if (this.blocks.pendingCount() > 0) await this.flushPendingChunks();
          const oversized = this.dataBytes(input.data) > MAX_INLINE_BYTES;
          if (oversized) {
            // 大事件打断批量（blob 必须先落盘），但 seq 顺序不变。
            // seq 在 flushBatch 之后才分配：万一批量写失败，不能留下“号被消费、无记录、也没洞”。
            await flushBatch();
          }
          const seq = this.nextSeq;
          this.nextSeq += 1;
          let storedData = input.data;
          if (oversized) {
            try {
              storedData = await this.writeBlob(seq, input.data);
            } catch (error) {
              const declared = await this.recordFailure(
                seq,
                seq,
                `blob_write_failed: ${messageOf(error)}`,
              );
              if (declared) this.advanceWalHead(seq);
              throw new TimelineError('timeline_write_failed', `blob seq=${seq}`, {
                cause: error,
              });
            }
          }
          const record = this.buildRecord(seq, input, storedData);
          // 与 `factStep` 同一件事：这条事实落在活动块区间里 ⇒ 块尾补一个事实标记帧。
          await this.noteFactInBlock(seq);
          batchRecords.push(record);
          batchLines.push(encodeLine(record));
          if (oversized) await flushBatch();
        }
      }

      await flushBatch();
      // 批末只**落盘发布**、不封块：块留给 run 边界 / 硬上限 / flush / close 收口。
      if (this.blocks.pendingCount() > 0) await this.flushPendingChunks();
      await Promise.all(chunkDurabilities);
    } catch (error) {
      // 中途异常：已经缓冲的合法记录照常落盘（不能留下“seq 已分配、记录未写、也没洞”）。
      try {
        await flushBatch();
      } catch {
        // flushBatch 自己会把整批登记成洞。
      }
      try {
        if (this.blocks.pendingCount() > 0) await this.flushPendingChunks();
      } catch {
        // flushPendingChunks 自己会处理洞与拒绝。
      }
      throw error;
    }
    if (chunkError !== undefined) throw chunkError;
    return results.sort((a, b) => a.seq - b.seq);
  }

  /** WAL 追加 + fsync；失败时把文件回滚到写前偏移（半写行不留下）。 */
  private async writeWal(text: string): Promise<void> {
    const buffer = Buffer.from(text, 'utf8');
    const before = this.walSize;
    try {
      await writeAll(this.walHandle, buffer);
      this.options.beforeSync?.('wal');
      await this.walHandle.sync();
      this.walSize = before + buffer.length;
    } catch (error) {
      // append 句柄在 Windows 上 ftruncate 不可靠：用独立 r+ 句柄回滚半写行，
      // 保证「登记成洞的 seq」不会同时以可读记录存在（否则 holes 与数据重叠）。
      try {
        const truncateHandle = await open(this.walPath, 'r+');
        try {
          await truncateHandle.truncate(before);
        } finally {
          // benign: 回滚 truncate 句柄关闭，失败不掩盖回滚结果。
          await truncateHandle.close().catch(() => {});
        }
      } catch {
        // 回滚失败：保守地仍然登记洞（调用方会做），此处不掩盖 fsync 错误。
      }
      this.walSize = before;
      throw error;
    }
  }

  /** 一条事件已持久：进索引 → 推进 head → 发布（I2 的唯一发布点）。 */
  private acceptRecord(record: TimelineRecord): void {
    this.indexBuilder.add(record);
    this.advanceWalHead(record.seq);
    this.published = Math.max(this.published, record.seq);
    this.indexDirty = true;
    this.indexPendingRecords += 1;
    // 终态之后读侧可能马上依赖盘上索引（liveness / run→session 解析）⇒ 强制落盘。
    if (INDEX_FORCE_TERMINAL_TYPES.has(record.type)) this.indexForcePersist = true;
    this.publishRecord(record);
  }

  /** 一个块切片已持久：按 seq 顺序发布其中的全部 chunk，然后兑现等待中的 append。 */
  private completeBlock(seal: ChunkBlockSeal): void {
    for (const record of seal.records) this.indexBuilder.add(record);
    // 切片里的 seq 从 `walHead+1` 连续到 `end_seq`（严格交错保证片内不夹事实行），
    // 常见路径 O(1)；只有异常序号才回落到区间合并计算。
    if (seal.entry.start_seq === this.walHead + 1) {
      this.walHead = seal.entry.end_seq;
    } else {
      this.advanceWalHead(seal.entry.end_seq);
    }
    for (const record of seal.records) {
      this.published = Math.max(this.published, record.seq);
      this.publishRecord(record);
    }
    this.resolveChunks(seal.entry.start_seq, seal.entry.end_seq);
    this.indexDirty = true;
    this.indexPendingRecords += seal.records.length;
  }

  /**
   * 把活动块里**待落盘的 chunk** 追加进块文件并 fsync，然后发布（I2 的发布点）。
   *
   * 这是可追加块带来的第二个「发布点」（第一个是封块）：块不再攒满才发布，而是每次
   * 「落盘一段」就发布这一段 —— 发布延迟仍然 ≤ `chunk_flush_ms`（空闲定时器触发），
   * 但块文件不再因此被切碎。
   */
  private async flushPendingChunks(): Promise<void> {
    if (this.blocks.pendingCount() === 0) return;
    let seal: ChunkBlockSeal | undefined;
    try {
      seal = await this.blocks.flushActive();
    } catch (error) {
      await this.failPendingChunks(error);
      return;
    }
    if (seal !== undefined) this.completeBlock(seal);
  }

  /**
   * 封块（run 换人 / 撞硬上限 / `close()`）：把待落盘 chunk 追加落盘 → 发布 → 关块文件
   * → 写 `wal.manifest` 条目。
   *
   * 注意它**不是** `flush()` 的语义：`flush()` 只要求「已 append 的都 durable、可枚举」，
   * 那件事 `flushPendingChunks()` 就做到了。封块只在「这个 run 的 chunk 流到头了」时发生，
   * 否则又会退回「一个 run 被切成几十个块」。
   */
  private async sealPendingBlock(): Promise<void> {
    this.clearIdleTimer();
    if (!this.blocks.hasOpenBlock()) return;
    let seal: ChunkBlockSeal | undefined;
    try {
      seal = await this.blocks.seal();
    } catch (error) {
      await this.failPendingChunks(error);
      return;
    }
    if (seal !== undefined) this.completeBlock(seal);
  }

  /**
   * 让活动块「知道」有一条事实落到它的覆盖区间里（块尾补一个事实标记帧）。
   *
   * 失败 ⇒ **立刻封块**：这个块不能再追加（否则区间里有一件事实却没有标记，恢复时会把它
   * 判成丢帧 = 假洞）。封块的区间停在最后一个已落盘帧，这条事实因此在区间之外 ——
   * 一个标记都不缺。事实行本身照写（这里不抛）。
   */
  private async noteFactInBlock(seq: number): Promise<void> {
    try {
      await this.blocks.markFact(seq);
    } catch {
      await this.sealPendingBlock();
    }
  }

  /**
   * 封块失败：整块登记成洞、拒绝等待中的 append、把 `wal_head` 推过该区间。
   *
   * 「推过」只在洞真的落到 `holes.ndjson` 之后（见 `recordFailure` 的返回值）：登记失败
   * 时 head 停在坏 seq 之前 —— 少报是安全的，多报等于给读侧造一个说不出原因的缺口。
   */
  private async failPendingChunks(error: unknown): Promise<void> {
    const pending = this.blocks.takePending();
    if (pending.length > 0) {
      const first = pending[0];
      const last = pending[pending.length - 1];
      if (first !== undefined && last !== undefined) {
        const declared = await this.recordFailure(
          first.seq,
          last.seq,
          `chunk_block_write_failed: ${messageOf(error)}`,
        );
        if (declared) this.advanceWalHead(last.seq);
      }
    }
    const failure = new TimelineError('timeline_write_failed', 'chunk_block_write_failed', {
      cause: error,
    });
    for (const chunk of this.pendingChunks) chunk.reject(failure);
    this.pendingChunks = [];
  }

  private resolveChunks(fromSeq: number, toSeq: number): void {
    const remaining: PendingChunk[] = [];
    for (const chunk of this.pendingChunks) {
      if (chunk.record.seq >= fromSeq && chunk.record.seq <= toSeq) {
        chunk.resolve(chunk.record);
      } else {
        remaining.push(chunk);
      }
    }
    this.pendingChunks = remaining;
  }

  private advanceWalHead(candidate: number): void {
    if (candidate <= this.walHead) return;
    if (candidate === this.walHead + 1) {
      this.walHead = candidate;
      return;
    }
    this.walHead = contiguousHead(this.indexBuilder.seqs(), this.holes.list());
  }

  private publishRecord(record: TimelineRecord): void {
    const publish = this.options.publish;
    if (publish === undefined) return;
    try {
      const result = publish(record);
      // benign: 异步消费者失败只影响它自己（防未处理拒绝）；事实不回滚、发布不断。
      if (result !== undefined) void result.catch(() => {});
    } catch {
      // 消费者异常不能回滚事实，也不能打断后续发布。
    }
  }

  /**
   * 写失败后登记洞；返回「这条声明是否**已经落到 `holes.ndjson`**」。
   *
   * 返回值是 `wal_head` 的判据，不是装饰：ADR-105 §3 定义 `wal_head` 必须保证
   * `[1..wal_head]` 每条**要么可读、要么已在 holes 里声明**。洞只写进内存 / 只写进
   * manifest 的 `tainted` 行，对读侧（客户端 / 独立读器）都**不存在** —— 那种情况下
   * 把 head 推过这个 `seq` 就是撒谎（读侧看到一个说不出原因的缺口）。
   * 所以登记失败时调用方**不许**推进 head：宁可少报（head 停在坏 seq 之前，重启时
   * `missing_seq_on_recovery` 会补登记），也不多报。
   */
  private async recordFailure(fromSeq: number, toSeq: number, reason: string): Promise<boolean> {
    this.markTainted();
    try {
      await this.holes.add(fromSeq, toSeq, reason);
      return true;
    } catch (error) {
      try {
        await this.appendManifest({
          v: 1,
          kind: 'tainted',
          reason: `${reason} (holes write failed: ${messageOf(error)})`,
          from_seq: fromSeq,
          to_seq: toSeq,
          at: this.now(),
        });
      } catch {
        // 连 manifest 都写不进去：内存污点仍生效，重启后可能丢这条声明（已知边界）。
      }
      return false;
    }
  }

  private async declareRecoveryHole(fromSeq: number, toSeq: number, reason: string): Promise<void> {
    this.markTainted();
    try {
      await this.holes.add(fromSeq, toSeq, reason);
    } catch {
      // 恢复期登记失败：保持污点；下次打开若仍是空洞会再次尝试。
    }
  }

  // ---------------------------------------------------------------- archive

  /**
   * 归档：把 `wal.log` 里已 fsync 的事实行**抄一份**到 `timeline.ndjson`（I3：只做空间回收）。
   *
   * ## 「同一段绝不被抄两次」是这个方法的**首要不变量**（真实事故）
   *
   * 归档副本是 append-only 的：同一个 seq 出现两次就违反这条副本不变量（归档不再是
   * `wal.log` 事实行的副本）。**当下读路径对重复 seq 免疫** —— `readTimelineEvents` 的
   * `bySeq`、`timeline-dual-write#readPage` 的 `seen`、serve `selectTimelinePage` 的
   * `seen` 三处都按 seq 去重；但一旦归档成为唯一读源、或消费者按物理顺序把行喂给
   * `validateTimelineRange`，第 4 条（不得重复）会整段拒收（实测 10 行 vs 声明 5 行 ⇒
   * `merged=0`、左缘不动、`hasEarlier` 恒 true）。所以起点的判定**不许只依赖一次读盘**，
   * 也不许让任何一个来源把水位往下拉 —— 不能靠读侧去重兜这条账。这里四道闸门，缺一不可：
   *
   * | # | 闸门 | 挡的是 |
   * | --- | --- | --- |
   * | 1 | `archiveWatermark`（进程内只增） | 读盘失败被当成「归档是空的」⇒ 重抄整段 |
   * | 2 | `readNdjsonFileStrict`（只有 `ENOENT` 算空） | 同上（`EPERM`/`EBUSY`/`EMFILE` 一律失败） |
   * | 3 | 追加前重读**归档尾窗**并取 max | 第二个写者（另一进程 / 另一实例）刚抄完的那一段 |
   * | 4 | `assertAppendOnlyPayload`（逐条断言 `seq > 水位`、严格递增） | `wal.log` 自己带重复行等 |
   *
   * 另外两个写者之间靠 {@link withArchiveLock} 串行（闸门 3 的读 + 追加在锁内是原子的）。
   * 拿不到锁 / 读不出来 / 断言不过 ⇒ **这一次归档失败**（`ok:false` + `tainted` + 回调），
   * 事实一个字节都不动、`wal_head` 照常 —— 这正是 I3「归档失败只影响空间回收」。
   */
  private async archiveNow(): Promise<ArchiveResult> {
    if (this.closed) {
      throw new TimelineError('timeline_writer_closed', 'archive() after close()');
    }
    // 归档只关心事实行（chunk 不进 `timeline.ndjson`）：chunk 只要 durable + 已发布就够，
    // **不封块**（封块会把一个 run 的 chunk 流切碎，见 `sealPendingBlock` 的注释）。
    // jn-F2：归档已在独立链上，这次「顺手落盘 chunk」仍**经 append 队列**串行执行，
    // 不与 append 并发碰 blocks/indexBuilder；它只是归档链等一个队列槽，append 绝不等归档。
    if (this.blocks.pendingCount() > 0) {
      await this.enqueue(() => this.flushPendingChunks());
    }
    // 起点取「manifest 指针 + 自身水位」的大者：水位只增，所以它永远不会往回退。
    const from = Math.max(this.timelineHead + 1, this.archiveWatermark + 1);
    // `to`（seq 右端）与 `durableEnd`（WAL 已 fsync 字节右端）**同一时刻快照**：
    // 写者在同一个同步块里先更新 walSize 再推进 walHead，故 WAL 里的事实 seq 恒 ≤ walHead，
    // 增量段 [walValidatedBytes, durableEnd) 的记录必然都 ≤ to —— 抄完即可把校验边界推到
    // durableEnd，不会把「已校验未抄」的记录甩在边界之后（jn-F2 增量校验的正确性前提）。
    const to = this.walHead;
    const durableEnd = this.walSize;
    if (from > to) return { ok: true, from_seq: from, to_seq: to };
    // 记下本次尝试开始时的污点代际：成功后的清退只在代际未变时生效（见 clearTaint）。
    const epochAtStart = this.taintEpoch;

    let lastError: unknown;
    let advanced = false;
    for (const wait of [0, ...ARCHIVE_RETRY_DELAYS_MS]) {
      if (wait > 0) await delay(wait);
      try {
        // 事务体整体在归档锁内：读水位 → 追加段 → 提交 manifest 行，中间不许插进第二个写者。
        await withArchiveLock(this.sessionDir, () =>
          this.appendArchiveSegment(from, to, durableEnd),
        );
        this.timelineHead = to;
        advanced = true;
        break;
      } catch (error) {
        // 回滚在两个追加点各自完成（`appendArchiveSegment` / `appendManifest`），
        // 这里不再按「尝试开始时的文件长度」截断文件 —— 那会吃掉别人的行。
        lastError = error;
      }
    }

    if (advanced) {
      // 归档已经提交（段 + archive 行都落盘），先撤销污点再返回成功：
      // 清退行写不进去不影响「空间已回收」这个事实（best-effort，见方法注释）。
      await this.clearTaint('archive_recovered', from, to, epochAtStart);
      return { ok: true, from_seq: from, to_seq: to };
    }

    const reason = `archive_failed: ${messageOf(lastError)}`;
    this.markTainted();
    try {
      await this.appendManifest({
        v: 1,
        kind: 'tainted',
        reason,
        from_seq: from,
        to_seq: to,
        at: this.now(),
      });
    } catch {
      // manifest 也不可写：污点仍在内存里，回调仍会发。
    }
    this.options.onArchiveFailed?.({ from_seq: from, to_seq: to, reason });
    return { ok: false, from_seq: from, to_seq: to, reason };
  }

  /**
   * 一次归档尝试的**事务体**（只在 {@link withArchiveLock} 内跑）。
   *
   * 三个动作、一个提交点：① 算出「已经归档到哪」（四个来源取最大）；② 只抄
   * `seq > 水位` 的那一段并**逐条断言**；③ 提交 manifest 的 `archive` 行。
   *
   * 抛错 ⇒ 本次尝试作废（回滚各自完成，见 `rollbackTrailingAppend`）。
   */
  private async appendArchiveSegment(from: number, to: number, durableEnd: number): Promise<void> {
    // ① 已经归档到哪：**四个来源取最大**，任何一个都不许把水位往下拉。
    //    jn-F2：归档副本的「最大 seq + 无坏行」结论按 size:mtime 缓存（文件没变就复用，
    //    只读尾窗）；变了才整份 strict 读。读失败 ⇒ 抛（绝不能当「归档是空的」）。
    const existingMaxSeq = await this.archiveExistingMaxSeq();
    const tail = (await fileExists(this.timelinePath))
      ? await readNdjsonTail(this.timelinePath)
      : { lines: [] as string[], fromStart: true, size: 0 };
    if (tail === undefined) {
      throw new TimelineError('timeline_archive_failed', 'archive tail window unreadable');
    }
    let tailMax = 0;
    for (let index = tail.lines.length - 1; index >= 0; index -= 1) {
      const text = tail.lines[index];
      if (text === undefined) continue;
      const record = parseRecordLine(text);
      if (record === undefined) {
        // 尾窗里有坏行：这一段的事实只剩 `wal.log` 一份 ⇒ 不猜（退回全量恢复的口径）。
        throw new TimelineError('timeline_archive_failed', 'archive tail has unreadable line');
      }
      tailMax = record.seq;
      break;
    }
    const alreadyArchived = Math.max(this.archiveWatermark, existingMaxSeq, tailMax);
    const writeFrom = Math.max(from, alreadyArchived + 1);

    // ② 只抄「水位之后」的那一段；断言它是严格递增且都在水位之上。
    if (writeFrom > to) {
      // 水位已经覆盖到本次右端（第二个写者刚抄完 / manifest 指针滞后）：**什么都不写**。
      // 不写 payload、也不写 archive 行 —— 写一行「没有新段」的归档声明只会让审计更难读。
      this.archiveWatermark = Math.max(this.archiveWatermark, to);
      return;
    }
    {
      // jn-F2：WAL 增量校验 —— 只 strict 读「上次校验边界 → 本次 durable 右端」的新增段，
      // 不再整份重读 wal.log。首次（边界 0）或文件回退（边界 > durableEnd）才整份读。
      let walRecords: TimelineRecord[];
      if (this.walValidatedBytes > 0 && durableEnd >= this.walValidatedBytes) {
        const delta = await readNdjsonRangeStrict(this.walPath, this.walValidatedBytes, durableEnd);
        walRecords = delta.records;
      } else {
        const wal = await readNdjsonFileStrict(this.walPath);
        walRecords = wal.records;
      }
      const records = walRecords
        .filter((record) => record.seq >= writeFrom && record.seq <= to)
        .sort((a, b) => a.seq - b.seq);
      this.assertAppendOnlyPayload(records, alreadyArchived);
      if (records.length > 0) {
        const buffer = Buffer.from(records.map(encodeLine).join(''), 'utf8');
        const handle = await open(this.timelinePath, 'a', 0o600);
        let start = -1;
        try {
          start = (await handle.stat()).size;
          await writeAll(handle, buffer);
          this.options.beforeSync?.('timeline');
          await handle.sync();
        } catch (error) {
          // benign: 归档错误路径关闭句柄，失败不掩盖原始错误（回滚后重抛）。
          await handle.close().catch(() => {});
          await this.rollbackTrailingAppend(this.timelinePath, start, buffer.length);
          throw error;
        }
        // benign: 归档成功路径关闭句柄，失败不掩盖已 sync 的写入结果。
        await handle.close().catch(() => {});
        this.archiveWatermark = Math.max(
          this.archiveWatermark,
          records[records.length - 1]?.seq ?? alreadyArchived,
        );
        // 自己刚追加成功 ⇒ 主动刷新归档校验缓存（新戳 + 新最大 seq），免得下一次归档
        // 因为「文件变了」误判失效再整份读。坏行不可能出现（payload 已逐条断言 + CRC 编码）。
        await this.refreshArchiveCache();
      }
      // 校验边界只在「段已成功抄写」时前进到 durableEnd；上面任何一步抛错 ⇒ 不前进，
      // 下一次重试重读同一段（绝不把「已校验未抄」的记录甩在边界之后造成漏抄）。
      this.walValidatedBytes = durableEnd;
    }
    // ③ 提交点：manifest 的 `archive` 行（`to_seq` = 本次归档到的右端，读侧认这条）。
    await this.appendManifest({
      v: 1,
      kind: 'archive',
      from_seq: from,
      to_seq: to,
      at: this.now(),
    });
    this.archiveWatermark = Math.max(this.archiveWatermark, to);
  }

  /**
   * 归档副本（`timeline.ndjson`）的「最大 seq」结论，带 `size:mtime` 失效键缓存（jn-F2）。
   *
   * 文件没变 ⇒ 复用上次整份 strict 读的结论（无坏行 + 最大 seq）；变了才重新整份读。
   * 坏行 ⇒ 抛（与旧行为一致：归档副本不可信就不抄）。缓存只省「整份读」，尾窗（闸门 3）
   * 仍在 {@link appendArchiveSegment} 里每次读 —— 跨进程写者的那一段靠尾窗 + 归档锁兜。
   */
  private async archiveExistingMaxSeq(): Promise<number> {
    // benign: 缓存戳探针——stat 失败戳为空（强制重新整份读，保守）。
    const info = await stat(this.timelinePath).catch(() => undefined);
    const stamp = info === undefined ? '' : `${String(info.size)}:${String(info.mtimeMs)}`;
    if (this.archiveValidated && stamp === this.archiveStamp) {
      return this.archiveValidatedMaxSeq;
    }
    const existing = await readNdjsonFileStrict(this.timelinePath);
    if (existing.invalid.length > 0) {
      throw new TimelineError(
        'timeline_archive_failed',
        `archive has ${String(existing.invalid.length)} unreadable line(s)`,
      );
    }
    const maxSeq = maxRecordSeq(existing.records);
    this.archiveStamp = stamp;
    this.archiveValidatedMaxSeq = maxSeq;
    this.archiveValidated = true;
    return maxSeq;
  }

  /** 本进程刚成功追加归档段后刷新校验缓存（新戳 + 当前水位 = 归档副本最大 seq）。 */
  private async refreshArchiveCache(): Promise<void> {
    // benign: 缓存戳探针——stat 失败戳为空（下次强制重新校验，保守）。
    const info = await stat(this.timelinePath).catch(() => undefined);
    this.archiveStamp = info === undefined ? '' : `${String(info.size)}:${String(info.mtimeMs)}`;
    this.archiveValidatedMaxSeq = this.archiveWatermark;
    this.archiveValidated = true;
  }

  /** 点亮会话污点并推进代际（{@link taintEpoch}）；所有「置 tainted=true」都走这里。 */
  private markTainted(): void {
    this.taintedFlag = true;
    this.taintEpoch += 1;
  }

  /**
   * 本次要抄的段必须是**严格递增**且**全部大于已经归档的水位**。
   *
   * 这是「同一 seq 在 append-only 流里最多出现一次」的最后一道断言：只要它成立，
   * 追加本身就不可能造出重复。抛错 = 这一次归档失败（空间晚点回收），事实不动。
   */
  private assertAppendOnlyPayload(
    records: readonly TimelineRecord[],
    alreadyArchived: number,
  ): void {
    let previous = alreadyArchived;
    for (const record of records) {
      if (record.seq <= previous) {
        throw new TimelineError(
          'timeline_archive_failed',
          `archive payload would duplicate seq ${String(record.seq)} (already archived up to ${String(alreadyArchived)})`,
        );
      }
      previous = record.seq;
    }
  }

  /**
   * 撤销会话级污点（ADR-105 §3 I3 ④）：追加一条 `tainted_cleared`。
   *
   * 两个调用点，各自的**外部前提**由调用者保证「状态确实变好了」：
   * - 健康归档之后（`archiveNow()` 用 `advanced` 保证：`from > to` 的空归档不算清退，
   *   否则一次没有任何归档动作的调用就能把污点洗掉）；
   * - 洞退役自证通过之后（`retireHolesNow()`；退役行已经 fsync 落盘）。
   *
   * 三个前提缺一不可：
   * ① 调用点保证状态真的变好（见上）；
   * ② 当前**没有存活洞**（洞 = 真丢失；有洞的会话永远不写 cleared —— 保守方向，
   *    也不许「清一个洞就把所有污点洗掉」）；
   * ③ 当前**确实是 tainted**（否则每次健康归档都会多算一行噪声，且「连续多次失败后成功一次
   *    只追加一条 cleared」会被打破）。
   *
   * 历史行一条都不改：失败时写下的 `tainted` 行继续留着当审计，`tainted_cleared` 只是
   * 「物理顺序上的最后一条状态声明」，靠 last-wins 生效。
   *
   * 写失败 ⇒ 保持污点、下次再试（不把「空间已回收 / 洞已退役」改判成失败）。
   */
  private async clearTaint(
    reason: string,
    fromSeq: number,
    toSeq: number,
    epochAtStart?: number,
  ): Promise<void> {
    if (!this.taintedFlag) return;
    if (this.holes.list().length > 0) return;
    const epoch = epochAtStart ?? this.taintEpoch;
    try {
      await this.appendManifest({
        v: 1,
        kind: 'tainted_cleared',
        reason,
        from_seq: fromSeq,
        to_seq: toSeq,
        at: this.now(),
      });
      // jn-F2 并发护栏（归档已移出 append 队列）：清退行写盘期间若又有失败点亮污点
      // （代际前进）或新增存活洞，**保留污点**（保守方向，绝不洗掉一条刚发生的失败）。
      // 磁盘上这条 cleared 行通常会被随后那条 tainted 行 last-wins 盖过；即便物理序相反，
      // heads() 的 tainted 仍按「内存污点 || 存活洞」上报，不会少报，重启恢复也会重新判定。
      if (this.taintEpoch === epoch && this.holes.list().length === 0) {
        this.taintedFlag = false;
      }
    } catch {
      // 清退行写不进去：内存污点保持不变（安全方向），下次健康归档会再试一次。
    }
  }

  // ---------------------------------------------------------------- index / timer

  /**
   * 节流判定（只用于 `flush()` 路径；close/洞退役/open 恢复直接调 `persistIndex()`）。
   * 滞后上界 = 2 s 或 500 条，远小于 open 尾窗上界 ⇒ 正确性由既有自洽校验兜底。
   */
  private indexPersistDue(): boolean {
    return (
      this.indexForcePersist ||
      this.indexPendingRecords >= INDEX_PERSIST_MAX_PENDING_RECORDS ||
      Date.now() - this.lastIndexPersistAt >= INDEX_PERSIST_MIN_INTERVAL_MS
    );
  }

  private async persistIndex(): Promise<void> {
    const snapshot = this.indexBuilder.snapshot(this.holes.list().length);
    await writeIndexSnapshot(this.sessionDir, snapshot);
    this.indexDirty = false;
    this.indexPendingRecords = 0;
    this.indexForcePersist = false;
    this.lastIndexPersistAt = Date.now();
  }

  private scheduleIdleFlush(): void {
    // 定时器从「活动块里第一条待落盘 chunk」起算，**不随每条 chunk 重置**。
    // 重置会让持续流式（chunk 间隔 < chunk_flush_ms）永远等不到落盘，发布延迟退化为
    // 「填满块的时间」，直接违反 ADR-105 的 P95 ≤ chunk_flush_ms + 50ms。
    //
    // 0.57 起它触发的是 **flush**（落盘 + 发布）而不是**封块**：这正是「块从 150ms 一刀
    // 变成 run 级」的那一处 —— 发布延迟不变（还是 ≤ chunk_flush_ms），块却不再被切碎。
    if (this.timer !== undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (this.closed) return;
        void this.enqueue(async () => {
          await this.flushPendingChunks();
        }).catch(() => {}); // benign: 定时 flush 防未处理拒绝；失败经 flushPendingChunks→failPendingChunks 登记洞/污点可见。
      },
      Math.max(1, this.chunkFlushMs - CHUNK_FLUSH_LEAD_MS),
    );
    // 故意**不** unref：这个定时器是 chunk 落盘的唯一触发点（封块条件 ③）。
    // unref 会让进程在等待 chunk 落盘时提前退出 —— 那正是 ADR-105 I2 要消灭的“发布早于 WAL”。
  }

  private clearIdleTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
