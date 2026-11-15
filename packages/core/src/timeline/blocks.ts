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
 * 本模块只提供「加帧 / 封块 / 恢复」三件事。
 *
 * @module @vessel-agent/core/timeline
 */

import { type FileHandle, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BLOCK_MAX_BYTES,
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
  truncateFile,
  withCrc,
} from './wal.js';

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
    let maxNumber = 0;
    for (const name of names) {
      maxNumber = Math.max(maxNumber, blockNumber(name));
      const path = join(blocksDir, name);
      const buffer = await readFile(path).catch(() => undefined);
      if (buffer === undefined) continue;
      const decode = decodeChunkBlock(buffer);
      records.push(...decode.records);
      invalid.push(...decode.invalid);
      if (decode.torn) {
        await truncateFile(path, decode.validBytes);
        truncated.push(name);
      }
    }
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
