/**
 * chunk 块格式与写入（0.54 A 阶段，ADR-105 §4）。
 *
 * chunk 不逐条写 ndjson（一次长 run 上千条、~200 B/条编码开销），而是：
 *
 * ```
 * wal.blocks/000007.wblk   [u64 LE seq][u32 LE len][utf8 JSON record] × N
 * wal.manifest            {"v":1,"kind":"block","block":"000007.wblk","start_seq":…,…}\n
 * ```
 *
 * 封块即 `fsync`（块文件是 chunk 的 WAL 本体）；manifest 是**目录**，扫描块文件即可
 * 恢复，因此 manifest 追加失败不阻断正确性（只记一次告警）。
 *
 * 封块四个时机由 `writer.ts` 触发（块满 / 非 chunk 事件前 / 空闲 / 终态与 flush）；
 * 本模块只提供「加帧 / 封块 / 恢复」三件事，外加「**哪些 chunk 配进块**」的唯一判据
 * （{@link isTransientChunkEvent}，0.54 chunk-slim）。
 *
 * @module @vessel-agent/core/timeline
 */

import { type FileHandle, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BLOCK_MAX_BYTES,
  isChunkEventType,
  TIMELINE_LAYOUT,
  type TimelineBlockEntry,
  type TimelineRecord,
  type TimelineSyncKind,
  type WalManifestLine,
} from './types.js';
import {
  blockNumber,
  crc32Hex,
  decodeChunkBlock,
  encodeChunkFrame,
  fsyncDirectory,
  listBlockFiles,
  parseWithCrc,
  readCrcNdjsonFile,
  truncateFile,
  withCrc,
} from './wal.js';

/*
 * ── 路由政策：哪些 chunk 配进块（0.54 chunk-slim） ─────────────────────────
 *
 * 「chunk 家族」不是一个整体。按**有没有持久化价值**，它分两类：
 *
 * | 子类型 | 是什么 | 刷新后从哪复原 |
 * | --- | --- | --- |
 * | `text_delta` / `reasoning_delta` | 正文 / 思考的正文增量 | 没有别的地方有 ⇒ **必须进块** |
 * | `tool_call_delta` / `finish` | 工具参数的画图增量 / 本次响应的收口 | `tool.call.started` 的 `arguments` + `tool.call.completed` 的产物 / `llm.response` |
 *
 * 后两类是**瞬时 UI 提示**，不是时间线事实（web 侧也早就这么判：`producesTimelineItem()`
 * 对它们恒 false，连环都不进）。它们原本仍然照写进块，代价是实测 69,159 帧
 * `tool_call_delta` 只承载 208 KB 参数片段，却因为每帧固定元数据（`v/seq/session_id/
 * run_id×2/ts/type/crc` + 12 B 帧头）占了 23 MB —— 单会话 83% 的块字节。
 *
 * 于是它们**退回「非持久化」那一类**，但**不是**退回老口子（`NON_PERSISTED_EVENT_TYPES`
 * 那条「一行一条写进 `events.ndjson`」，`subagent.llm.stream.chunk` 曾经就那么漏进去过）：
 * 它们停留在**实时通道**（hub 环）里，**从不请求 `timeline_seq`**。
 *
 * 为什么判据放在这里（而不是 `types.ts`）：`types.ts` 的 `isChunkEventType()` 回答
 * 「是不是 chunk 家族」（ADR-105 §8.1 规则 ④ 的白名单口径，一条都不能多）；本判据回答
 * 「这个 chunk 该不该进块」——那是**块格式**自己的政策，判据跟着块走，两件事不混。
 */
export const TRANSIENT_CHUNK_SUBTYPES: ReadonlySet<string> = new Set(['tool_call_delta', 'finish']);

/** 取 `llm.stream.chunk` 载荷里的子类型（`data.chunk.type`）；取不到 ⇒ `undefined`。 */
export function chunkSubtypeOf(event: { type: string; data?: unknown }): string | undefined {
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const chunk = (data as { chunk?: unknown }).chunk;
  if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) return undefined;
  const subtype = (chunk as { type?: unknown }).type;
  return typeof subtype === 'string' ? subtype : undefined;
}

/**
 * 这条事件是不是**瞬时 chunk**（`tool_call_delta` / `finish`）：不占 `timeline_seq`、
 * 不进块、不进 `events.ndjson`，只走实时通道。
 *
 * 必须**同时**满足「是 chunk 家族」+「子类型在 {@link TRANSIENT_CHUNK_SUBTYPES} 里」：
 * 只判子类型的话，将来别的事件类型里出现同名 `chunk.type` 会被误判成 chunk。
 *
 * 与 ADR-105 §3 I2 的关系（这是本判据存在的全部理由）：**不落盘 ⇒ 不许取 seq**。
 * 「照取 seq、只是不写进块」会让 `count` 里凭空多出被发布却不可读的 seq（= 洞），
 * 所以调用点必须在这条事件**进入 seq 分配之前**分叉（`run-journal.ts#appendFact`
 * 是第一刀，`writer.ts#validateInput` 是第二道闸门）。
 */
export function isTransientChunkEvent(event: { type: string; data?: unknown }): boolean {
  if (!isChunkEventType(event.type)) return false;
  const subtype = chunkSubtypeOf(event);
  return subtype !== undefined && TRANSIENT_CHUNK_SUBTYPES.has(subtype);
}

export interface ChunkBlockStoreOptions {
  maxBytes?: number;
  /** 测试缝：每次真正 fsync 之前调用；抛错 = 模拟 fsync 失败。 */
  beforeSync?: (kind: TimelineSyncKind) => void;
}

export interface ChunkBlockSeal {
  entry: TimelineBlockEntry;
  records: TimelineRecord[];
}

export interface ChunkBlockRecovery {
  records: TimelineRecord[];
  /** 完整但 CRC/形状不符的帧：seq 可读，写者必须登记成洞。 */
  invalid: Array<{ from_seq: number; to_seq: number; reason: string }>;
  /** 被截断过的块文件名（撕裂尾帧清理）。 */
  truncated: string[];
}

/** `wal.manifest` 一行的形状校验（crc 之外还要形状对，才配当「完整性证明」）。 */
function validateManifestLine(parsed: unknown): WalManifestLine | undefined {
  const line = parseWithCrc<WalManifestLine>(parsed);
  if (line === undefined || line.v !== 1 || line.kind !== 'block') return undefined;
  if (typeof line.block !== 'string' || line.block.length === 0) return undefined;
  if (!Number.isSafeInteger(line.start_seq) || line.start_seq < 1) return undefined;
  if (!Number.isSafeInteger(line.end_seq) || line.end_seq < line.start_seq) return undefined;
  if (!Number.isSafeInteger(line.count) || line.count < 1) return undefined;
  if (!Number.isSafeInteger(line.bytes) || line.bytes < 0) return undefined;
  if (typeof line.crc32 !== 'string' || line.crc32.length === 0) return undefined;
  return line;
}

/**
 * 把 `[from..to]` 里不在 `present` 的 seq 压成连续区间。
 *
 * 单块最多 `BLOCK_MAX_BYTES / 12` 个 seq（≈2.7k），逐 seq 扫一遍完全可以接受；只在
 * **恢复**路径上跑一次，不在写路径上。
 */
function missingRanges(
  from: number,
  to: number,
  present: ReadonlySet<number>,
): Array<{ from_seq: number; to_seq: number }> {
  const ranges: Array<{ from_seq: number; to_seq: number }> = [];
  let start: number | undefined;
  for (let seq = from; seq <= to; seq += 1) {
    if (present.has(seq)) {
      if (start !== undefined) {
        ranges.push({ from_seq: start, to_seq: seq - 1 });
        start = undefined;
      }
      continue;
    }
    start ??= seq;
  }
  if (start !== undefined) ranges.push({ from_seq: start, to_seq: to });
  return ranges;
}

/** chunk 块写入器（每会话一个，串行队列由 `TimelineWriter` 保证）。 */
export class ChunkBlockStore {
  private readonly pendingFrames: Buffer[] = [];
  private readonly pendingRecords: TimelineRecord[] = [];
  private readonly pendingManifests = new Set<Promise<void>>();
  private pendingBytes = 0;
  private nextBlockNumber: number;
  private closed = false;

  private constructor(
    private readonly blocksDir: string,
    private readonly manifestPath: string,
    private readonly maxBytes: number,
    private readonly options: ChunkBlockStoreOptions,
    nextBlockNumber: number,
  ) {
    this.nextBlockNumber = nextBlockNumber;
  }

  /**
   * 打开块目录并恢复。
   *
   * - 每个块都解码；撕裂尾帧截断到最后一个完整帧（这些 seq 从未发布，可重新分配）；
   * - 完整但坏掉的帧进 `invalid`，由写者登记为洞；
   * - **manifest 是完整性证明**：`wal.manifest` 的行只在块文件 fsync **之后**才写，
   *   所以「有 manifest 行、seq 却读不到」= 发布过的数据真的丢了（归 manifest 或
   *   外部损坏），必须登记成洞（ADR-105 §3 I4：回退区间必须出现在 `holes` 里）。
   *   没有 manifest 行 = 崩在「块已 fsync、manifest 还没写」之间，帧本身都在，
   *   因此不参与这条判定（避免把正常崩溃误判成丢数据）；
   * - 下一个块号从现有最大块号 + 1 开始（崩溃留下的半块不会被续写）。
   */
  static async open(
    sessionDir: string,
    options: ChunkBlockStoreOptions = {},
  ): Promise<{ store: ChunkBlockStore; recovery: ChunkBlockRecovery }> {
    const blocksDir = join(sessionDir, TIMELINE_LAYOUT.walBlocks);
    await mkdir(blocksDir, { recursive: true });
    const names = await listBlockFiles(blocksDir);
    const records: TimelineRecord[] = [];
    const invalid: ChunkBlockRecovery['invalid'] = [];
    const truncated: string[] = [];
    /** 每个块里「可读或已声明坏帧」的 seq（manifest 比对用）。 */
    const coveredByBlock = new Map<string, Set<number>>();
    let maxNumber = 0;
    for (const name of names) {
      maxNumber = Math.max(maxNumber, blockNumber(name));
      const path = join(blocksDir, name);
      const buffer = await readFile(path).catch(() => undefined);
      if (buffer === undefined) continue;
      const decode = decodeChunkBlock(buffer);
      records.push(...decode.records);
      invalid.push(...decode.invalid);
      const covered = new Set<number>();
      for (const record of decode.records) covered.add(record.seq);
      // 坏帧自己已经登记进 `invalid`（写者会为它建洞），不重复算成「丢了」。
      for (const item of decode.invalid) {
        for (let seq = item.from_seq; seq <= item.to_seq; seq += 1) covered.add(seq);
      }
      coveredByBlock.set(name, covered);
      if (decode.torn) {
        await truncateFile(path, decode.validBytes);
        truncated.push(name);
      }
    }

    // manifest ↔ 块文件互相校验（I4 对块内丢帧同样适用）。
    const manifestPath = join(sessionDir, TIMELINE_LAYOUT.walManifest);
    const manifest = await readCrcNdjsonFile<WalManifestLine>(
      manifestPath,
      validateManifestLine,
    ).catch(() => undefined);
    // 崩在「manifest 追加中途」会留下半行；截掉它，否则下一次追加的行会接在半行后面
    // 变成一行坏 JSON —— 一条条目丢失就等于一条完整性证明丢失（目录是派生数据，可截）。
    if (manifest?.truncateTo !== undefined) await truncateFile(manifestPath, manifest.truncateTo);
    for (const entry of manifest?.items ?? []) {
      const covered = coveredByBlock.get(entry.block);
      if (covered === undefined) {
        // manifest 说这个块写完了，块文件却不在 ⇒ 整段丢失（块只写一次、永不重写）。
        invalid.push({
          from_seq: entry.start_seq,
          to_seq: entry.end_seq,
          reason: 'chunk_block_file_missing',
        });
        continue;
      }
      for (const range of missingRanges(entry.start_seq, entry.end_seq, covered)) {
        invalid.push({ ...range, reason: 'chunk_block_short_of_manifest' });
      }
    }
    invalid.sort((a, b) => a.from_seq - b.from_seq);

    const store = new ChunkBlockStore(
      blocksDir,
      join(sessionDir, TIMELINE_LAYOUT.walManifest),
      options.maxBytes ?? BLOCK_MAX_BYTES,
      options,
      maxNumber + 1,
    );
    return { store, recovery: { records, invalid, truncated } };
  }

  /** 当前活动块里的记录数（0 = 没有待封块）。 */
  pendingCount(): number {
    return this.pendingRecords.length;
  }

  /** 当前活动块的字节数。 */
  pendingSize(): number {
    return this.pendingBytes;
  }

  /**
   * 把一帧放进活动块缓冲（同步；不落盘）。
   *
   * 写者必须在**同一个串行队列里**接着检查 {@link shouldSeal} 并在需要时 `await seal()`，
   * 这样不会有两个封块并发（`seal()` 本身不是可重入的）。
   */
  push(record: TimelineRecord): void {
    if (this.closed) throw new Error('chunk_block_store_closed');
    const frame = encodeChunkFrame(record);
    this.pendingFrames.push(Buffer.from(frame));
    this.pendingRecords.push(record);
    this.pendingBytes += frame.length;
  }

  /** 活动块是否达到 `BLOCK_MAX_BYTES`（封块时机 ①）。 */
  shouldSeal(): boolean {
    return this.pendingRecords.length > 0 && this.pendingBytes >= this.maxBytes;
  }

  /**
   * 封块：写文件 + fsync（块数据是 WAL 本体），再尽力追加 manifest。
   *
   * 写/fsync 失败：删除**本次新建**的块文件（避免“洞”与可读数据重叠），保留
   * `pendingRecords` 供写者 `takePending()` 登记洞，然后把错误抛回。
   */
  async seal(): Promise<ChunkBlockSeal | undefined> {
    if (this.closed) throw new Error('chunk_block_store_closed');
    if (this.pendingRecords.length === 0) return undefined;
    const name = `${String(this.nextBlockNumber).padStart(6, '0')}.wblk`;
    const path = join(this.blocksDir, name);
    const buffer = Buffer.concat(this.pendingFrames);
    const records = this.pendingRecords.slice();
    const entry: TimelineBlockEntry = {
      block: name,
      start_seq: records[0]?.seq ?? 0,
      end_seq: records[records.length - 1]?.seq ?? 0,
      offset: 0,
      bytes: buffer.length,
      count: records.length,
      crc32: crc32Hex(buffer),
    };

    let handle: FileHandle | undefined;
    try {
      handle = await open(path, 'wx', 0o600);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
        if (bytesWritten <= 0) throw new Error('chunk_block_write_failed');
        offset += bytesWritten;
      }
      this.options.beforeSync?.('block');
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(path).catch(() => {});
      throw error;
    }
    await handle.close().catch(() => {});
    await fsyncDirectory(this.blocksDir);

    this.pendingFrames.length = 0;
    this.pendingRecords.length = 0;
    this.pendingBytes = 0;
    this.nextBlockNumber += 1;
    // 注意：块文件是 `wx`（只写一次）；manifest 是目录、可扫描重建。

    // manifest 是目录、可由扫描重建：**不进入发布关键路径**（否则每块多一次 fsync，
    // 把 chunk 发布延迟顶到 chunk_flush_ms + 2×fsync）。追加失败不影响正确性。
    const manifestWrite = this.appendManifest(entry).catch(() => {});
    this.pendingManifests.add(manifestWrite);
    void manifestWrite.then(() => this.pendingManifests.delete(manifestWrite));
    return { entry, records };
  }

  /** 等所有后台 manifest 追加落盘（flush / close 时调用）。 */
  async flushManifests(): Promise<void> {
    while (this.pendingManifests.size > 0) {
      const pending = [...this.pendingManifests];
      this.pendingManifests.clear();
      await Promise.allSettled(pending);
    }
  }

  /**
   * 放弃当前活动块（写失败后调用）：返回尚未落盘的记录并清空缓冲。
   *
   * 调用方负责把这些 seq 登记成洞、拒绝等待中的 append promise。
   */
  takePending(): TimelineRecord[] {
    const records = this.pendingRecords.slice();
    this.pendingFrames.length = 0;
    this.pendingRecords.length = 0;
    this.pendingBytes = 0;
    return records;
  }

  /** 关闭（不再写；未封的块由调用方先 `seal()` 或 `takePending()`）。 */
  close(): void {
    this.closed = true;
  }

  private async appendManifest(entry: TimelineBlockEntry): Promise<void> {
    const line: WalManifestLine = withCrc({ v: 1 as const, kind: 'block' as const, ...entry });
    const buffer = Buffer.from(`${JSON.stringify(line)}\n`, 'utf8');
    const handle = await open(this.manifestPath, 'a', 0o600);
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
        if (bytesWritten <= 0) throw new Error('wal_manifest_write_failed');
        offset += bytesWritten;
      }
      this.options.beforeSync?.('manifest');
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
  }
}
