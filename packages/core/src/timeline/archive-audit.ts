/**
 * 归档副本（`timeline.ndjson`）的**重复 seq 检测器**。
 *
 * ## 为什么要有它
 *
 * 归档是 **append-only 的副本**（ADR-105 §11.1「复制不是搬移」）：同一个 `seq` 在一个副本里
 * 出现两次，这个副本就不再是「wal.log 事实行的一次复制」—— 它会持续膨胀，而且一旦有人按
 * 「物理顺序 + 严格递增」去消费它就会炸。这类损坏**不会报错、不会自愈、也不会因为重启消失**
 * （成因是重放时归档读失败被折成空文件 ⇒ 水位不前进 ⇒ 每次重试都从同一个 seq 再抄一遍；
 * 现场三个会话 `09f82ac6` 71194–71198 / `8f9d91e0` 604–605·693–695 / `c52a29cc` 747–2173
 * 就是这样攒出来的，已于 2026-11-17 按「保留首见行」裁掉，裁完与 `wal.log` 逐字节相同）。
 *
 * 所以：**启动时 / doctor 里扫一遍，扫到就 warn 一条**（会话 + seq 区间 + 计数 + 字节偏移）。
 *
 * ## 它有多严重：**当前读路径免疫，但别把这句读成「没事」**
 *
 * 下面这段结论来自 2026-11-17 的实测（同一份数据、同一批读数），别再把「可能」当「已经」写：
 *
 * - **现在的事实**：重复行**不会**让在跑的读路径卡住。理由是三处都按 `seq` 去重 ——
 *   `readTimelineEvents` 用 `bySeq` 归并；装订层 `timeline-dual-write.ts#readPage` 有 `seen`；
 *   serve 侧 `selectTimelinePage` 还有一层 `seen`。实测：`09f82ac6` 从尾部窗口连滚 12 段
 *   「加载更早」，修前修后都是每段 `fetched=2000 / count=2000 / merged=2000 / gap=null`。
 *   代价只是**膨胀**（`c52a29cc` 多出 225 行 / 217 138 B，占 19.9%）和「归档不再是忠实副本」
 *   这个**潜在雷**。
 * - **什么条件下才变成用户可见的故障**：归档成为**唯一读源**（`wal.log` 被裁到不再覆盖该
 *   区间），**且**消费者不去重、直接按物理顺序喂给 `validateTimelineRange`（它的第 4 条
 *   「不得重复」是硬的）。那时整段会被拒收：`merged=0`、左缘不动 ⇒ `hasEarlier` 恒 true，
 *   用户侧就是「往上加载更早」永久卡住。实测这份判据：把归档行（不去重）当某段应答喂进去，
 *   [71194, 71198] 收到 10 行、声明 5 行 ⇒ `rule=4 重复 seq=71194`、`merged=0`、左缘不动；
 *   裁完是 5 行 ⇒ `merged=5`、左缘 71199 → 71194。**今天不走这条路，所以今天不卡**。
 *
 * ## 它刻意**不**做的事
 *
 * - **不修数据、不自动改写**：留着还是裁掉要人来决定（裁掉哪一份、要不要先确认两份逐字节
 *   相同、`timeline.manifest` 要不要跟着动）。检测器只负责让这件事**不静默**。
 *   真要裁时的执行器是 `scripts/timeline-dedup-archive.ts`：一次只处理 `--dir` 指定的一个
 *   会话，按 `seq` 保留**第一次**出现的整行（原字节切片，不重算 CRC），写出走原子替换，
 *   裁完必须 0 重复；副本与保留行不逐字节相同 ⇒ 判为内容冲突、拒绝写。
 * - **不当判据**：读路径一个字都不用它（`readTimelineEvents` 本来就按 seq 去重），
 *   写路径也不用它（写侧靠 `archive-lock.ts` + `writer.ts#archiveNow` 的硬闸门）。
 *
 * ## 两种扫描精度
 *
 * | 模式 | 判据 | 成本 | 用在哪 |
 * | --- | --- | --- | --- |
 * | `fast`（缺省） | 行首 `{"v":1,"seq":N,` 前缀 | 不 `JSON.parse`、不算 CRC | `open()`（启动路径，有字节预算） |
 * | `strict` | `parseRecordLine`（JSON + CRC + 形状） | 每行一次 `JSON.parse` | doctor / 显式审计 |
 *
 * `fast` 只认写者自己的行首形状（`writer.ts#buildRecord` 的键序固定）；认不出的行记进
 * `unrecognized` 并让结果 `conclusive=false` —— **不许**把「我没看懂」说成「没有重复」。
 *
 * @module @vessel-agent/core/timeline
 */

import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { TIMELINE_LAYOUT } from './types.js';
import { parseRecordLine } from './wal.js';

/** 一次扫描的读块大小（64 KiB：行很少超过它，跨块残行由调用方拼接）。 */
const AUDIT_CHUNK_BYTES = 64 * 1024;

/** 写者行首形状：`{"v":1,"seq":123,`（键序由 `buildRecord` 固定）。 */
const RECORD_PREFIX = /^\{"v":1,"seq":(\d+),/;

/** 一段「同一个 seq 出现多次」的区间。 */
export interface ArchiveDuplicateRange {
  from_seq: number;
  to_seq: number;
  /** 区间里最多出现几次（≥ 2）。 */
  max_occurrences: number;
  /** 多出来的行数（`Σ(occurrences - 1)`）。 */
  extra_records: number;
  /** 第一份之外的副本从哪个字节开始（人工裁决「裁哪一份」时要用）。 */
  first_duplicate_offsets: number[];
}

/** 检测结果（doctor / 日志 / 自证脚本共用同一份形状）。 */
export interface ArchiveDuplicateAudit {
  session_id: string;
  path: string;
  /** 解析出的记录行数（`fast` 模式 = 行首形状认得出的行数）。 */
  records: number;
  /** 不同 seq 的个数。 */
  distinct: number;
  /** 重复出现的**行数**（`records - distinct`）。 */
  duplicate_records: number;
  /** 重复的 seq 个数。 */
  duplicate_seqs: number;
  /** 合并后的重复区间（升序；一次 warn 里就贴着它）。 */
  ranges: ArchiveDuplicateRange[];
  /** 第一 / 最后一个重复 seq（0 = 没有重复）。 */
  first_duplicate_seq: number;
  last_duplicate_seq: number;
  /** 认不出的行数（`fast` 模式）。 */
  unrecognized: number;
  /** 本次扫描的字节数。 */
  scanned_bytes: number;
  /** 文件总字节数。 */
  bytes: number;
  /** 是否只扫了尾部（有预算时）。 */
  truncated: boolean;
  /** `false` ⇒ 结果不可当结论用（有认不出的行 / 只扫了尾部）。 */
  conclusive: boolean;
}

export interface ArchiveAuditOptions {
  /** 最多扫尾部多少字节（缺省 = 整份）。 */
  maxBytes?: number;
  /** `strict` = 逐行 `parseRecordLine`（JSON + CRC）；缺省 `fast`。 */
  mode?: 'fast' | 'strict';
}

function auditPath(sessionDir: string): string {
  return join(sessionDir, TIMELINE_LAYOUT.timeline);
}

function baseNameOf(sessionDir: string): string {
  const parts = sessionDir.split(/[\\/]/u);
  return parts[parts.length - 1] ?? sessionDir;
}

function mergeDuplicates(
  occurrences: Map<number, { count: number; offsets: number[] }>,
): ArchiveDuplicateRange[] {
  const seqs = [...occurrences.keys()].sort((a, b) => a - b);
  const ranges: ArchiveDuplicateRange[] = [];
  for (const seq of seqs) {
    const hit = occurrences.get(seq);
    if (hit === undefined) continue;
    const last = ranges[ranges.length - 1];
    const extra = hit.count - 1;
    if (last !== undefined && last.to_seq + 1 === seq) {
      last.to_seq = seq;
      last.max_occurrences = Math.max(last.max_occurrences, hit.count);
      last.extra_records += extra;
      last.first_duplicate_offsets.push(...hit.offsets.slice(1));
      continue;
    }
    ranges.push({
      from_seq: seq,
      to_seq: seq,
      max_occurrences: hit.count,
      extra_records: extra,
      first_duplicate_offsets: hit.offsets.slice(1),
    });
  }
  return ranges;
}

/**
 * 扫一个会话的归档副本，找出重复 seq。
 *
 * 不抛：文件不存在 / 读不动 ⇒ 返回一个 `records: 0` 的结果（`type` 级的审计不该因为
 * 「这个会话没有 timeline」而报错）。真的想区分「读失败」时看 `bytes` 与 `conclusive`。
 */
export async function auditArchiveDuplicates(
  sessionDir: string,
  options: ArchiveAuditOptions = {},
): Promise<ArchiveDuplicateAudit> {
  const path = auditPath(sessionDir);
  const strict = options.mode === 'strict';
  const result: ArchiveDuplicateAudit = {
    session_id: baseNameOf(sessionDir),
    path,
    records: 0,
    distinct: 0,
    duplicate_records: 0,
    duplicate_seqs: 0,
    ranges: [],
    first_duplicate_seq: 0,
    last_duplicate_seq: 0,
    unrecognized: 0,
    scanned_bytes: 0,
    bytes: 0,
    truncated: false,
    conclusive: true,
  };
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
  } catch {
    return result;
  }
  try {
    const size = (await handle.stat()).size;
    result.bytes = size;
    const budget =
      options.maxBytes !== undefined && options.maxBytes > 0
        ? Math.min(Math.floor(options.maxBytes), size)
        : size;
    const start = size - budget;
    result.truncated = start > 0;
    result.conclusive = !result.truncated;
    const seen = new Set<number>();
    const occurrences = new Map<number, { count: number; offsets: number[] }>();
    let carry: Buffer = Buffer.alloc(0);
    let offset = start;
    let skipPartial = start > 0;
    while (offset < size) {
      const length = Math.min(AUDIT_CHUNK_BYTES, size - offset);
      const chunk = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(chunk, filled, length - filled, offset + filled);
        if (bytesRead <= 0) break;
        filled += bytesRead;
      }
      if (filled === 0) break;
      const buffer =
        carry.length > 0
          ? Buffer.concat([carry, chunk.subarray(0, filled)])
          : chunk.subarray(0, filled);
      const base = offset - carry.length;
      let lineStart = 0;
      for (;;) {
        const newline = buffer.indexOf(0x0a, lineStart);
        if (newline === -1) break;
        const lineOffset = base + lineStart;
        const text = buffer.toString('utf8', lineStart, newline);
        lineStart = newline + 1;
        if (skipPartial) {
          // 窗口起点切在半行上：那一段缺前半截，丢掉（不猜）。
          skipPartial = false;
          continue;
        }
        if (text.length === 0) continue;
        let seq: number | undefined;
        if (strict) {
          seq = parseRecordLine(text)?.seq;
          if (seq === undefined) result.unrecognized += 1;
        } else {
          const match = RECORD_PREFIX.exec(text);
          if (match === null) {
            result.unrecognized += 1;
          } else {
            const value = Number(match[1]);
            if (Number.isSafeInteger(value) && value > 0) seq = value;
            else result.unrecognized += 1;
          }
        }
        if (seq === undefined) continue;
        result.records += 1;
        if (seen.has(seq)) {
          const hit = occurrences.get(seq);
          if (hit === undefined) occurrences.set(seq, { count: 2, offsets: [0, lineOffset] });
          else {
            hit.count += 1;
            hit.offsets.push(lineOffset);
          }
        } else {
          seen.add(seq);
        }
      }
      carry = buffer.subarray(lineStart);
      offset += filled;
      result.scanned_bytes += filled;
    }
    // 末尾残行（没有换行）：从未完整写出，不算记录（与读侧 `truncateTo` 同口径）。
    if (carry.length > 0) result.conclusive = false;
    result.distinct = seen.size;
    result.ranges = mergeDuplicates(occurrences);
    result.duplicate_seqs = occurrences.size;
    result.duplicate_records = result.records - result.distinct;
    const first = result.ranges[0];
    const last = result.ranges[result.ranges.length - 1];
    result.first_duplicate_seq = first?.from_seq ?? 0;
    result.last_duplicate_seq = last?.to_seq ?? 0;
    if (result.unrecognized > 0) result.conclusive = false;
    return result;
  } finally {
    // benign: 审计读句柄关闭，失败不掩盖审计结果。
    await handle.close().catch(() => {});
  }
}

/**
 * 检测结果 → 一条 warn 的**文字与字段**（写者 / doctor / 自证脚本共用一份，别各写一份）。
 *
 * 返回 `undefined` = 没有重复（不产出噪声 warn）。
 */
export function describeArchiveDuplicates(
  audit: ArchiveDuplicateAudit,
): { message: string; detail: Record<string, unknown> } | undefined {
  if (audit.duplicate_seqs === 0) return undefined;
  const ranges = audit.ranges
    .map((range) =>
      range.from_seq === range.to_seq
        ? String(range.from_seq)
        : `${String(range.from_seq)}-${String(range.to_seq)}`,
    )
    .join(', ');
  const message =
    'timeline archive has duplicate seq (读侧区间校验会拒绝这一段，「加载更早」会卡住；需人工裁决保留还是裁掉)';
  return {
    message,
    detail: {
      session_id: audit.session_id,
      seq_ranges: ranges,
      first_seq: audit.first_duplicate_seq,
      last_seq: audit.last_duplicate_seq,
      duplicate_seqs: audit.duplicate_seqs,
      duplicate_records: audit.duplicate_records,
      ranges: audit.ranges.map((range) => ({
        from_seq: range.from_seq,
        to_seq: range.to_seq,
        max_occurrences: range.max_occurrences,
        extra_records: range.extra_records,
      })),
      path: audit.path,
      conclusive: audit.conclusive,
      scanned_bytes: audit.scanned_bytes,
      bytes: audit.bytes,
    },
  };
}
