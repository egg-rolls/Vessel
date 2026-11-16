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
 * 封块四个时机（I2 之内的延迟来源）：
 * ① 活动块 ≥ `BLOCK_MAX_BYTES`；② 非 chunk 事件先封块再写该行（严格交错）；
 * ③ 空闲 `chunk_flush_ms`；④ `flush()` / `close()`。
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
import { atomicWrite } from '../session/atomic-write.js';
import { type ChunkBlockSeal, ChunkBlockStore, isTransientChunkEvent } from './blocks.js';
import { assertTimelineWritable } from './freeze.js';
import { HoleRegistry, type HoleRetirementResult } from './holes.js';
import { TimelineIndexBuilder, writeIndexSnapshot } from './index.js';
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
  parseWithCrc,
  readCrcNdjsonFile,
  readNdjsonFile,
  readTimelineEvents,
  stampRecord,
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
  /**
   * 显式 adopt：调用方**断言**「这个会话是我自己刚建的，不是 0.53 遗留」。
   *
   * 唯一作用是**跳过旧格式冻结闸门**（{@link assertTimelineWritable}）；标记（`timeline.manifest`）
   * 仍然由写者自己落 —— 所以「谁可以写 timeline 目录」这条纪律不变。
   *
   * ## 三条使用边界（违反任何一条都是后门，不是便利）
   *
   * 1. **判据不许在调用侧再写一份**：旧格式的定义只有 `freeze.ts` 一份。调用侧能提供的
   *    额外信息只能是「这个会话在**本进程开始之前**是否存在过」这种时间事实；
   *    一旦这里出现「有没有 `events.ndjson`」之类的第二套判定，就该判红。
   * 2. **这个开关不许来自外部输入**：不许做成配置键（`config.timeline.*`）、不许读环境变量、
   *    不许由 RPC 参数/请求体透传。它只能是装配层**自己算出来的结论**（当前唯一调用点：
   *    `src/timeline-dual-write.ts`，条件是「core 判旧格式 ∧ 构造时快照说本进程才出现」）。
   *    否则等于给了一个「客户端指定解冻任意旧会话」的入口。
   * 3. **默认必须是 false**：不传 ⇒ 闸门照旧（有 `events.ndjson` 且无任何 timeline 标记 ⇒
   *    `session_frozen_readonly`）。「忘了传」的方向必须是安全的。
   */
  adoptLegacyShapedSession?: boolean;
  /** 归档重试耗尽后的通知（ADR-105 §3 I3 ③；不进 timeline 自身）。 */
  onArchiveFailed?: (info: { from_seq: number; to_seq: number; reason: string }) => void;
  /** 测试缝：时刻来源。 */
  now?: () => number;
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
  private readonly indexBuilder = new TimelineIndexBuilder();

  private nextSeq = 1;
  private walHead = 0;
  private timelineHead = 0;
  private published = 0;
  private taintedFlag = false;
  private walSize = 0;

  private queue: Promise<void> = Promise.resolve();
  private pendingChunks: PendingChunk[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private indexDirty = false;

  private constructor(options: TimelineWriterOptions) {
    this.options = options;
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
   * 旧格式会话（有 `events.ndjson`、没有 timeline 标记）抛 `session_frozen_readonly`
   * （ADR-105 D4：0.54 不做迁移）。
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

  /** 封活动块、落索引；返回后所有已 append 的事件都可枚举。 */
  flush(): Promise<void> {
    return this.enqueue(async () => {
      await this.sealPendingBlock();
      await this.blocks.flushManifests();
      if (this.indexDirty) await this.persistIndex();
    });
  }

  /** 关闭：flush → 关句柄。重复调用幂等。 */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    this.clearIdleTimer();
    this.blocks.close();
    await this.holes.close();
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
    return this.enqueue(() => this.archiveNow());
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

  private async initialize(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
    // 旧格式会话只读冻结（ADR-105 D4）。判据与错误码在 `freeze.ts` 一处定义：
    // 索引写回、读器建索引也都走同一个闸门，所以「哪条写路径忘了判」在结构上不成立。
    //
    // 唯一的例外是调用方的**显式 adopt 断言**（`adoptLegacyShapedSession`）：装配层在
    // 「core 判旧格式 ∧ 这个会话是本进程才出现的」时才会传 —— 因为新会话的第一次双写
    // 发生时 `events.ndjson` 已经写好，形状与 0.53 遗留会话完全一样，只能靠时间分辨。
    // 标记仍然由下面的 `ensureManifest()` 落（本类之外无人写 timeline 目录）。
    if (this.options.adoptLegacyShapedSession !== true) {
      await assertTimelineWritable(this.sessionDir, this.sessionId);
    }
    await this.ensureManifest();

    this.holes = await HoleRegistry.open(this.sessionDir, {
      beforeSync: this.options.beforeSync,
      now: this.options.now,
    });
    const blockOpen = await ChunkBlockStore.open(this.sessionDir, {
      maxBytes: this.options.blockMaxBytes ?? BLOCK_MAX_BYTES,
      beforeSync: this.options.beforeSync,
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
    for (const range of invalidRanges) {
      if (records.has(range.from_seq) || this.holes.covers(range.from_seq)) continue;
      await this.declareRecoveryHole(range.from_seq, range.to_seq, range.reason);
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
    // 两个来源，任一为真即污点：盘上还有**未退役**的洞（真丢失），或 manifest 的
    // last-wins 状态是 `tainted`。`holes.list()` 已是存活口径，退役区间不再压制污点。
    // 打开时**不重读区间**：退役声明只在自证通过后才被写出（`retireHoles()`）。
    this.taintedFlag = this.holes.list().length > 0 || manifest.tainted;

    const info = await stat(this.walPath).catch(() => undefined);
    this.walSize = info?.size ?? 0;
    this.walHandle = await open(this.walPath, 'a', 0o600);

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

  private async appendManifest(line: TimelineManifestLine): Promise<void> {
    const stamped = withCrc(line);
    const buffer = Buffer.from(`${JSON.stringify(stamped)}\n`, 'utf8');
    const handle = await open(this.manifestPath, 'a', 0o600);
    try {
      await writeAll(handle, buffer);
      this.options.beforeSync?.('manifest');
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
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
      await handle?.close().catch(() => {});
      await unlink(path).catch(() => {});
      throw error;
    }
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
    // 严格交错：任何非 chunk 事件落盘前先封活动块（封块条件 ②）。
    if (this.blocks.pendingCount() > 0) await this.sealPendingBlock();

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
          if (this.blocks.pendingCount() > 0) await this.sealPendingBlock();
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
          batchRecords.push(record);
          batchLines.push(encodeLine(record));
          if (oversized) await flushBatch();
        }
      }

      await flushBatch();
      if (this.blocks.pendingCount() > 0) await this.sealPendingBlock();
      await Promise.all(chunkDurabilities);
    } catch (error) {
      // 中途异常：已经缓冲的合法记录照常落盘（不能留下“seq 已分配、记录未写、也没洞”）。
      try {
        await flushBatch();
      } catch {
        // flushBatch 自己会把整批登记成洞。
      }
      try {
        if (this.blocks.pendingCount() > 0) await this.sealPendingBlock();
      } catch {
        // sealPendingBlock 自己会处理洞与拒绝。
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
    this.publishRecord(record);
  }

  /** 一个块已持久：按 seq 顺序发布块内全部 chunk，然后兑现等待中的 append。 */
  private completeBlock(seal: ChunkBlockSeal): void {
    for (const record of seal.records) this.indexBuilder.add(record);
    // 块的 seq 从 `walHead+1` 连续到 `end_seq`（封块条件 ② 保证块内不夹非 chunk），
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
  }

  private async sealPendingBlock(): Promise<void> {
    this.clearIdleTimer();
    if (this.blocks.pendingCount() === 0) return;
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
    this.taintedFlag = true;
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
    this.taintedFlag = true;
    try {
      await this.holes.add(fromSeq, toSeq, reason);
    } catch {
      // 恢复期登记失败：保持污点；下次打开若仍是空洞会再次尝试。
    }
  }

  // ---------------------------------------------------------------- archive

  private async archiveNow(): Promise<ArchiveResult> {
    if (this.blocks.pendingCount() > 0) await this.sealPendingBlock();
    const from = this.timelineHead + 1;
    const to = this.walHead;
    if (from > to) return { ok: true, from_seq: from, to_seq: to };

    let lastError: unknown;
    let advanced = false;
    for (const wait of [0, ...ARCHIVE_RETRY_DELAYS_MS]) {
      if (wait > 0) await delay(wait);
      // 归档是「数据 + manifest 指针」的原子动作：任一步失败都回滚本次新增的段行，
      // 保证重启后不会出现「manifest 说没归档、段文件里却有」的半成品。
      const preSize = (await stat(this.timelinePath).catch(() => undefined))?.size ?? 0;
      const preManifestSize = (await stat(this.manifestPath).catch(() => undefined))?.size ?? 0;
      try {
        const existing = await readNdjsonFile(this.timelinePath);
        const alreadyArchived = maxRecordSeq(existing.records);
        const writeFrom = Math.max(from, alreadyArchived + 1);
        if (writeFrom <= to) {
          const wal = await readNdjsonFile(this.walPath);
          const lines = wal.records
            .filter((record) => record.seq >= writeFrom && record.seq <= to)
            .sort((a, b) => a.seq - b.seq)
            .map(encodeLine)
            .join('');
          if (lines.length > 0) {
            const handle = await open(this.timelinePath, 'a', 0o600);
            try {
              await writeAll(handle, Buffer.from(lines, 'utf8'));
              this.options.beforeSync?.('timeline');
              await handle.sync();
            } finally {
              await handle.close().catch(() => {});
            }
          }
        }
        await this.appendManifest({
          v: 1,
          kind: 'archive',
          from_seq: from,
          to_seq: to,
          at: this.now(),
        });
        this.timelineHead = to;
        advanced = true;
        break;
      } catch (error) {
        try {
          const truncateHandle = await open(this.timelinePath, 'r+');
          try {
            await truncateHandle.truncate(preSize);
          } finally {
            await truncateHandle.close().catch(() => {});
          }
        } catch {
          // 回滚失败：保留 lastError；下次重试会重新读段并只补 seq > max 的部分。
        }
        // manifest 的 archive 行是提交点：同步失败时它可能已写进页缓存，必须一并回滚，
        // 否则重启后“段文件已截断、manifest 却声称归档成功”。
        try {
          const truncateManifest = await open(this.manifestPath, 'r+');
          try {
            await truncateManifest.truncate(preManifestSize);
          } finally {
            await truncateManifest.close().catch(() => {});
          }
        } catch {
          // 同上：留给重启的 gap/timeline_head 计算兜底。
        }
        lastError = error;
      }
    }

    if (advanced) {
      // 归档已经提交（段 + archive 行都落盘），先撤销污点再返回成功：
      // 清退行写不进去不影响「空间已回收」这个事实（best-effort，见方法注释）。
      await this.clearTaint('archive_recovered', from, to);
      return { ok: true, from_seq: from, to_seq: to };
    }

    const reason = `archive_failed: ${messageOf(lastError)}`;
    this.taintedFlag = true;
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
  private async clearTaint(reason: string, fromSeq: number, toSeq: number): Promise<void> {
    if (!this.taintedFlag) return;
    if (this.holes.list().length > 0) return;
    try {
      await this.appendManifest({
        v: 1,
        kind: 'tainted_cleared',
        reason,
        from_seq: fromSeq,
        to_seq: toSeq,
        at: this.now(),
      });
      this.taintedFlag = false;
    } catch {
      // 清退行写不进去：内存污点保持不变（安全方向），下次健康归档会再试一次。
    }
  }

  // ---------------------------------------------------------------- index / timer

  private async persistIndex(): Promise<void> {
    const snapshot = this.indexBuilder.snapshot(this.holes.list().length);
    await writeIndexSnapshot(this.sessionDir, snapshot);
    this.indexDirty = false;
  }

  private scheduleIdleFlush(): void {
    // 定时器从「活动块里第一条待封 chunk」起算，**不随每条 chunk 重置**。
    // 重置会让持续流式（chunk 间隔 < chunk_flush_ms）永远等不到封块，发布延迟退化为
    // 「填满 32 KiB 的时间」，直接违反 ADR-105 的 P95 ≤ chunk_flush_ms + 50ms。
    if (this.timer !== undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (this.closed) return;
        void this.enqueue(async () => {
          await this.sealPendingBlock();
        }).catch(() => {});
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
