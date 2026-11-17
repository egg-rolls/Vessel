/**
 * 压缩索引的物化store（`<sessionDir>/compactions.ndjson`，append-only）
 * @module @vessel-agent/core/session
 *
 * ## 为什么需要一份物化索引（两个读方，两个不同的成本约束）
 *
 * | 读方 | 想要的 | 不想要的 |
 * | --- | --- | --- |
 * | `recall` 工具（无参列表） | 这条会话有哪些压缩段、各段的区间 | 解析 1.8 MB 的会话壳 / 扫 8 MB 的 `wal.log` |
 * | 会话壳（`SessionState.compactions`） | 重启后不必重扫 | 每次 run 起点多读一个文件 |
 *
 * 事件的 `context.compacted.data.compaction` 是**事实源**，但按事件找它有两个硬伤：
 * 尾窗回扫（`readTailMatches`）有 4 MB 上界 —— 真实会话里第一次压缩（seq 93052）落在
 * 8.2 MB 日志的前半段，回扫**够不到**，于是列表会静默少一段；整份读又太贵。
 *
 * 所以索引另存一份**可从事件重建**的小文件：一条压缩一行（~300 B），append-only，
 * 读它就是 `readFile` + 按行 `JSON.parse`。它不是事实 —— 丢了 / 坏了都只意味着
 * 「这次列表少了内容」，可由事件重建（`deriveCompactionIndex`），永不作为判据。
 *
 * 与 `holes.ndjson` 同目录同风格（会话目录下的旁挂事实文件），但语义相反：洞声明
 * 「这段写不出来」，这里声明「这段被换成了摘要，原文还在日志里」。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CompactionIndexEntry, CompactionRange } from '../context/compaction-index.js';

/** 索引文件名（与 `index.json` / `holes.ndjson` 并列）。 */
export const COMPACTION_INDEX_FILE = 'compactions.ndjson';

/** 一份索引文件的硬上界（字节）：超过就按「读不出来」处理，不把整份塞进内存。 */
export const COMPACTION_INDEX_MAX_BYTES = 4 * 1024 * 1024;

/** 一段压缩最多允许的区间数（防手改 / 脏数据把一份索引撑爆读侧）。 */
const MAX_RANGES_PER_ENTRY = 10_000;

/** 索引文件路径。 */
export function compactionIndexPath(sessionDir: string): string {
  return join(sessionDir, COMPACTION_INDEX_FILE);
}

/** 宽松校验一条索引行（认不出 ⇒ `undefined`，绝不编一条）。 */
function readEntry(raw: unknown): CompactionIndexEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const compactionId = record.compaction_id;
  if (typeof compactionId !== 'number' || !Number.isInteger(compactionId) || compactionId <= 0) {
    return undefined;
  }
  const at = record.at;
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  const reason = record.reason;
  if (reason !== 'auto' && reason !== 'overflow' && reason !== 'manual') return undefined;
  const removed = record.removed;
  if (typeof removed !== 'number' || !Number.isInteger(removed) || removed < 0) return undefined;
  const ranges = readRanges(record.removed_ranges);
  if (ranges === undefined) return undefined;
  const replaced = record.replaced_by;
  if (typeof replaced !== 'object' || replaced === null) return undefined;
  const summaryChars = (replaced as Record<string, unknown>).summary_chars;
  const summarySha8 = (replaced as Record<string, unknown>).summary_sha8;
  if (typeof summaryChars !== 'number' || !Number.isFinite(summaryChars)) return undefined;
  if (typeof summarySha8 !== 'string' || summarySha8.length === 0) return undefined;
  const summaryHead = typeof record.summary_head === 'string' ? record.summary_head : '';
  const unmapped = record.unmapped_messages;
  return {
    compaction_id: compactionId,
    at,
    reason,
    removed,
    removed_ranges: ranges,
    unmapped_messages:
      typeof unmapped === 'number' && Number.isInteger(unmapped) && unmapped >= 0 ? unmapped : 0,
    replaced_by: { summary_chars: summaryChars, summary_sha8: summarySha8 },
    summary_head: summaryHead,
    tokens_before: readCount(record.tokens_before),
    tokens_after: readCount(record.tokens_after),
  };
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function readRanges(value: unknown): CompactionRange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_RANGES_PER_ENTRY) return undefined;
  const ranges: CompactionRange[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    const from = record.from_seq;
    const to = record.to_seq;
    const messages = record.messages;
    if (typeof from !== 'number' || !Number.isInteger(from) || from <= 0) return undefined;
    if (typeof to !== 'number' || !Number.isInteger(to) || to < from) return undefined;
    if (typeof messages !== 'number' || !Number.isInteger(messages) || messages <= 0) {
      return undefined;
    }
    ranges.push({ from_seq: from, to_seq: to, messages });
  }
  return ranges;
}

/**
 * 读一条会话的压缩索引（按 `compaction_id` 升序）。
 *
 * 坏行**跳过并保留其余**（与 `holes.ndjson` 的读侧不同：那里一行坏就整段不可判，
 * 因为洞关乎「有没有少给」；这里坏一行只影响「能不能读回那一段」，其它段照旧可读）。
 * 重复的 `compaction_id` 取**后写的那条**（append-only 语义：后写的更新）。
 *
 * 文件不存在 ⇒ 空数组（不是错误：老会话没有这份索引）。
 */
export async function readCompactionIndex(sessionDir: string): Promise<CompactionIndexEntry[]> {
  let text: string;
  try {
    const buffer = await readFile(compactionIndexPath(sessionDir));
    if (buffer.byteLength > COMPACTION_INDEX_MAX_BYTES) return [];
    text = buffer.toString('utf8');
  } catch {
    return [];
  }
  const byId = new Map<number, CompactionIndexEntry>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = readEntry(parsed);
    if (entry === undefined) continue;
    byId.set(entry.compaction_id, entry);
  }
  return [...byId.values()].sort((left, right) => left.compaction_id - right.compaction_id);
}

/**
 * 追加一条索引（append-only：不读旧内容、不重写文件）。
 *
 * 幂等由 `compaction_id` 保证：重复追加同一段时读侧取胜出的最后一条，不会出现两段。
 * 写失败**不抛**：调用点在压缩收尾路径上，索引丢一条的代价是「这段读不回来」，
 * 而抛出去会让一次已经成功的压缩变成一次失败的压缩 —— 代价不对称。
 *
 * @returns 是否写成功（调用方只用于日志，不作判据）
 */
export async function appendCompactionIndex(
  sessionDir: string,
  entry: CompactionIndexEntry,
): Promise<boolean> {
  const line = `${JSON.stringify(entry)}\n`;
  try {
    await mkdir(dirname(compactionIndexPath(sessionDir)), { recursive: true });
    await appendFile(compactionIndexPath(sessionDir), line, 'utf8');
    return true;
  } catch {
    return false;
  }
}
