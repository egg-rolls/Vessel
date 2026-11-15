/**
 * 洞登记区（0.54 A 阶段，ADR-105 §3 I3 补充条款）。
 *
 * 一条写失败的事件**必须落盘成可声明的洞**：
 *
 * ```
 * <sessions>/<sid>/holes.ndjson
 * {"v":1,"from_seq":7,"to_seq":7,"reason":"wal_append_failed: ...","at":...,"crc":"..."}\n
 * ```
 *
 * - append-only：只追加、不改历史行；
 * - 行尾 CRC32：坏行可识别，不会把半行当成洞；
 * - 跨重启可读：`TimelineWriter.open()` 用 `from_seq/to_seq` 重建 `wal_head` 的连续性，
 *   因此「模拟 fsync 失败 → 重启 → holes 包含该区间、tainted=true」可断言。
 *
 * 洞**不**自动修复、**不**回改旧行；清理属 0.55+（ADR-105 §10 第 3 项：0.54 只做被动声明）。
 *
 * @module @vessel-agent/core/timeline
 */

import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { TIMELINE_LAYOUT, type TimelineHole, type TimelineSyncKind } from './types.js';
import {
  type HoleLine,
  readCrcNdjsonFile,
  truncateFile,
  validateHoleLine,
  withCrc,
} from './wal.js';

export interface HoleRegistryOptions {
  /** 测试缝：每次真正 fsync 之前调用；抛错 = 模拟 fsync 失败。 */
  beforeSync?: (kind: TimelineSyncKind) => void;
  /** 测试缝：登记时刻。 */
  now?: () => number;
}

export class HoleRegistry {
  private constructor(
    private readonly entries: TimelineHole[],
    private readonly handle: FileHandle,
    private readonly options: HoleRegistryOptions,
  ) {}

  /**
   * 打开一个会话的洞登记区。
   *
   * 末尾无换行的半行会被截断（它从未完整写出，不构成声明）；坏行跳过。
   */
  static async open(sessionDir: string, options: HoleRegistryOptions = {}): Promise<HoleRegistry> {
    const path = join(sessionDir, TIMELINE_LAYOUT.holes);
    const result = await readCrcNdjsonFile<HoleLine>(path, validateHoleLine);
    if (result.truncateTo !== undefined) await truncateFile(path, result.truncateTo);
    const entries = result.items.map((line) => ({
      from_seq: line.from_seq,
      to_seq: line.to_seq,
      reason: line.reason,
      at: line.at,
    }));
    const handle = await open(path, 'a', 0o600);
    return new HoleRegistry(entries, handle, options);
  }

  /** 已声明的洞（登记顺序）。 */
  list(): readonly TimelineHole[] {
    return this.entries;
  }

  /** `seq` 是否落在某个已声明的洞内。 */
  covers(seq: number): boolean {
    for (const hole of this.entries) {
      if (seq >= hole.from_seq && seq <= hole.to_seq) return true;
    }
    return false;
  }

  /** 已声明的最大 seq（用于重启续号）。 */
  maxSeq(): number {
    let max = 0;
    for (const hole of this.entries) max = Math.max(max, hole.to_seq);
    return max;
  }

  /**
   * 登记一个洞并 fsync。
   *
   * 调用方（写者）只在写失败后调用；登记失败会把错误抛回，写者会同时置内存污点
   * 并尽力在主 manifest 里留 `tainted` 行（ADR-105 §3 I3）。
   */
  async add(fromSeq: number, toSeq: number, reason: string): Promise<TimelineHole> {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) {
      throw new Error(`invalid_hole_from_seq: ${String(fromSeq)}`);
    }
    if (!Number.isSafeInteger(toSeq) || toSeq < fromSeq) {
      throw new Error(`invalid_hole_to_seq: ${String(toSeq)}`);
    }
    const at = this.options.now?.() ?? Date.now();
    const body = { v: 1 as const, from_seq: fromSeq, to_seq: toSeq, reason, at };
    const line = withCrc(body);
    const buffer = Buffer.from(`${JSON.stringify(line)}\n`, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await this.handle.write(buffer, offset, buffer.length - offset);
      if (bytesWritten <= 0) throw new Error('holes_write_failed');
      offset += bytesWritten;
    }
    this.options.beforeSync?.('holes');
    await this.handle.sync();
    const hole: TimelineHole = { from_seq: fromSeq, to_seq: toSeq, reason, at };
    this.entries.push(hole);
    return hole;
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => {});
  }
}
