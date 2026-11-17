#!/usr/bin/env bun
/**
 * 归档副本（`timeline.ndjson`）**重复行裁切**工具 —— 一次性数据修复，只接受一个 `--dir`。
 *
 * ## 它到底改什么
 *
 * 只改 `<sessionDir>/timeline.ndjson` 一个文件：按 `seq` **保留第一次出现的整行**，删掉
 * 后续出现的重复行。**原行一个字节都不重写**（不重新序列化、不重算行尾 CRC）：留下的行
 * 是输入文件里的原始切片，行尾 `crc` 与行内容因此仍然自洽；删掉的都是整行，不存在半行。
 *
 * ## 它不改什么（每条都有理由，不是"懒得动"）
 *
 * - `wal.log` / `wal.blocks`：事实源。重复只存在于归档副本，事实源不许碰。
 * - `timeline.manifest`：`archive` 行的 `from_seq` / `to_seq` 按 `types.ts` 的契约**只作审计**
 *   （会话级 tainted 判定只看 `tainted` / `tainted_cleared` 的**写入顺序**），且它不含字节
 *   偏移，所以裁行不需要它跟着动。
 * - `timeline.idx/`：派生数据。`session.idx` 的 `count` 是**不同 seq 的个数**，裁掉重复行
 *   不改这个数（`type.idx` 的并集大小同样不变），写者 `open()` 的自洽判据
 *   （`first_seq = 1 ∧ count = last_seq`）照样成立。
 * - 不动任何别的会话：目标目录只来自 `--dir`，**不扫全库**（误触的爆炸半径 = 一个会话）。
 *
 * ## 为什么是「保留第一次」
 *
 * 现场的形状是同一个：归档重放时**读失败被折成空文件**，于是从某个水位开始整段重抄了
 * 一遍。重抄段与已归档段的**重叠头**（几个 seq）逐字节相同 —— 它们是同一批事实的第二份
 * 副本。保留第一次 = 保留原文，删掉的是重放出来的那份。工具会把「删掉的副本是否与保留
 * 行逐字节相同」打出来；**只要有一份不同就拒绝写**（那是内容冲突，不是重复，裁掉会丢内容）。
 *
 * ## 用法
 *
 *   bun run scripts/timeline-dedup-archive.ts --dir "C:/Users/x/.vessel/data/sessions/<id>"
 *
 * 只接受 `--dir`：多余参数（含 `--all` 之类）一律拒绝，退出码 2。
 *
 * 退出码：0 = 已收敛（无重复）；1 = 写回后仍有重复（不该发生，看日志）；2 = 参数/前置条件
 * 不成立（没写任何东西）；3 = 重复副本内容不一致（没写任何东西）。
 *
 * @module scripts/timeline-dedup-archive
 */

import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWrite } from '../packages/core/src/session/atomic-write';
import {
  type ArchiveDuplicateAudit,
  auditArchiveDuplicates,
} from '../packages/core/src/timeline/archive-audit';
import { TIMELINE_LAYOUT } from '../packages/core/src/timeline/types';
import { parseRecordLine } from '../packages/core/src/timeline/wal';

/** 原始文件里的一行（`bytes` 含行尾换行符，原样切片）。 */
interface RawLine {
  /** 行号（1 起，给人看的）。 */
  readonly line: number;
  /** 行首在文件里的字节偏移。 */
  readonly offset: number;
  /** 原始字节（含 `\n`；末行可能没有）。 */
  readonly bytes: Buffer;
  /** 行首的 seq（`parseRecordLine` 认出来的；空行 / 认不出的行没有）。 */
  readonly seq: number | undefined;
}

/** 一行被判为「重复副本」。 */
interface DroppedLine {
  readonly line: number;
  readonly offset: number;
  readonly seq: number;
  readonly bytes: Buffer;
  /** 被保留的那一行（第一次出现）。 */
  readonly kept: RawLine;
}

function usage(message: string): never {
  console.error(JSON.stringify({ ok: false, reason: 'usage', message }));
  console.error(
    '用法: bun run scripts/timeline-dedup-archive.ts --dir "<sessionDir>"' +
      '（只接受 --dir，一次一个会话）',
  );
  process.exit(2);
}

/** 只认 `--dir <sessionDir>`；别的一律拒绝（这个工具不该有批量口）。 */
function parseArgs(argv: readonly string[]): string {
  if (argv.length !== 2) {
    usage('expects exactly 2 argv: --dir <sessionDir>, got ' + String(argv.length));
  }
  const flag = argv[0];
  const value = argv[1];
  if (flag !== '--dir' || value === undefined || value.trim() === '') {
    usage('only --dir <sessionDir> is accepted');
  }
  return resolve(value);
}

/**
 * 把整份文件切成行（保留原始字节）。
 *
 * 不做「解码再编码」的往返：`bytes` 直接是 `buffer.subarray(...)`，写回时字节相同。
 * **所有物理行都返回**（含空行 / 认不出的行）—— 只有带 seq 的行才参与去重，其余原样留着。
 */
function splitLines(buffer: Buffer): RawLine[] {
  const lines: RawLine[] = [];
  let start = 0;
  let line = 0;
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start);
    const end = newline === -1 ? buffer.length : newline;
    const bytes = buffer.subarray(start, newline === -1 ? end : end + 1);
    const text = buffer.toString('utf8', start, end);
    const record = text.length > 0 ? parseRecordLine(text) : undefined;
    lines.push({ line: line + 1, offset: start, bytes, seq: record?.seq });
    line += 1;
    start = end + 1;
  }
  return lines;
}

function summarize(audit: ArchiveDuplicateAudit): Record<string, unknown> {
  return {
    session_id: audit.session_id,
    path: audit.path,
    records: audit.records,
    distinct: audit.distinct,
    duplicate_records: audit.duplicate_records,
    duplicate_seqs: audit.duplicate_seqs,
    ranges: audit.ranges.map((range) => ({
      from_seq: range.from_seq,
      to_seq: range.to_seq,
      max_occurrences: range.max_occurrences,
      extra_records: range.extra_records,
      first_duplicate_offsets: range.first_duplicate_offsets,
    })),
    unrecognized: audit.unrecognized,
    bytes: audit.bytes,
    conclusive: audit.conclusive,
  };
}

async function main(): Promise<number> {
  const dir = parseArgs(process.argv.slice(2));
  const path = join(dir, TIMELINE_LAYOUT.timeline);
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    console.error(JSON.stringify({ ok: false, reason: 'missing_timeline', path }));
    return 2;
  }

  const before = await auditArchiveDuplicates(dir, { mode: 'strict' });
  console.log(JSON.stringify({ phase: 'before', ...summarize(before) }));

  if (before.bytes !== size) {
    // 扫描期间文件被改（有写者在跑）⇒ 不敢修。用户机器上 gateway 可能正开着这个会话。
    console.error(
      JSON.stringify({
        ok: false,
        reason: 'file_changing',
        audit_bytes: before.bytes,
        stat_bytes: size,
        hint: '会话正在被写（gateway 在跑？），等写者停下再修',
      }),
    );
    return 2;
  }
  if (!before.conclusive) {
    console.error(
      JSON.stringify({
        ok: false,
        reason: 'audit_inconclusive',
        unrecognized: before.unrecognized,
        hint: '有认不出的行 ⇒ 不敢把「没看懂」当「没有重复」',
      }),
    );
    return 2;
  }

  const raw = readFileSync(path);
  const lines = splitLines(raw);
  const kept = new Map<number, RawLine>();
  const dropped: DroppedLine[] = [];
  for (const line of lines) {
    if (line.seq === undefined) continue;
    const first = kept.get(line.seq);
    if (first === undefined) {
      kept.set(line.seq, line);
      continue;
    }
    dropped.push({
      line: line.line,
      offset: line.offset,
      seq: line.seq,
      bytes: line.bytes,
      kept: first,
    });
  }

  if (dropped.length === 0) {
    console.log(JSON.stringify({ ok: true, phase: 'noop', path, message: 'no duplicate seq' }));
    return 0;
  }

  const conflicts = dropped.filter((drop) => !drop.bytes.equals(drop.kept.bytes));
  if (conflicts.length > 0) {
    console.error(
      JSON.stringify({
        ok: false,
        reason: 'duplicate_content_differs',
        path,
        conflicts: conflicts.map((conflict) => ({
          seq: conflict.seq,
          line: conflict.line,
          offset: conflict.offset,
          kept_line: conflict.kept.line,
          kept_offset: conflict.kept.offset,
        })),
        hint: '两份不同的内容 = 冲突不是重复，裁掉会丢内容，必须人来裁决',
      }),
    );
    return 3;
  }

  // 写回内容 = 除被删行之外的**原始字节拼接**（空行、末行无换行都原样保留）。
  const dropLines = new Set(dropped.map((drop) => drop.line));
  const keptChunks: Buffer[] = [];
  for (const line of lines) {
    if (!dropLines.has(line.line)) keptChunks.push(line.bytes);
  }
  const out = Buffer.concat(keptChunks);
  const droppedBytes = dropped.reduce((total, drop) => total + drop.bytes.length, 0);
  if (out.length !== raw.length - droppedBytes) {
    console.error(
      JSON.stringify({
        ok: false,
        reason: 'size_mismatch',
        expected: raw.length - droppedBytes,
        produced: out.length,
      }),
    );
    return 2;
  }

  await atomicWrite(path, out, { durable: true });

  const after = await auditArchiveDuplicates(dir, { mode: 'strict' });
  console.log(JSON.stringify({ phase: 'after', ...summarize(after) }));
  const droppedReport = dropped.map((drop) => ({
    seq: drop.seq,
    line: drop.line,
    offset: drop.offset,
    kept_line: drop.kept.line,
    kept_offset: drop.kept.offset,
    bytes: drop.bytes.length,
    identical_to_kept: true,
  }));
  console.log(
    JSON.stringify({
      ok: after.duplicate_records === 0 && after.conclusive,
      phase: 'repair',
      path,
      before_bytes: raw.length,
      after_bytes: out.length,
      dropped_records: dropped.length,
      dropped_bytes: droppedBytes,
      dropped: droppedReport,
      after_duplicate_records: after.duplicate_records,
      after_conclusive: after.conclusive,
    }),
  );
  return after.duplicate_records === 0 && after.conclusive ? 0 : 1;
}

process.exit(await main());
