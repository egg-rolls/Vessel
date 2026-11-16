/**
 * timeline 索引（0.54 A 阶段，ADR-105 §5）。
 *
 * 三类索引，全部**可重建**、全部**不是事实源**：
 *
 * | 文件 | 内容 | 用途 |
 * | --- | --- | --- |
 * | `timeline.idx/session.idx` | `{first_seq,last_seq,count,holes}` 摘要 | 体积/条数展示；**不得**当判据 |
 * | `timeline.idx/run.idx` | `run_id → [{start_seq,end_seq}]` | `events.list` 换源、Run 详情 |
 * | `timeline.idx/type.idx` | `type → 有序 seq 列表` | types 前缀过滤、审计检索 |
 *
 * 硬约束（ADR-105 §5 断言）：
 *
 * 1. 删掉整个 `timeline.idx/` ⇒ 读结果逐条相同（只有变慢）；
 * 2. 索引写入假区间 ⇒ 读结果不变 —— 因为**生产读路径恒整份读记录**，索引只用于求 `wal_head`
 *    与 `run_id → session_id` 快路径，没有任何"先信索引再校验"的读动作，也就不存在
 *    "索引不一致 ⇒ 回退全扫"这个环节。`timeline.index_mismatch` 事件随之在 0.54 未实现
 *    （漂移记在 ADR-105 §11.1）；
 * 3. `rebuild` 两次 ⇒ 字节相同。重建的真实路径只有一条：写者打开时读回记录喂进
 *    `TimelineIndexBuilder`（`writer.ts:558`）再用 `writeIndexSnapshot` 落盘（`writer.ts:1205`）；
 *    **不提供**rebuild 包装或"从记录整份构造"的便捷函数（零调用点的包装 = 会腐烂的第二套口径）；
 * 4. 写索引的位置只有本模块与 `writer.ts`（静态门禁在 C 阶段落地）。
 *
 * 原先还有一个"先信索引、逐条校验、不一致回退全扫"的独立**读器**，**已删除**：
 * 它零生产调用点，却让人以为断言 2 的"校验 + 回退"在生产里真的会发生。
 *
 * @module @vessel-agent/core/timeline
 */

import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { atomicWrite } from '../session/atomic-write.js';
import { assertTimelineWritable } from './freeze.js';
import { TIMELINE_LAYOUT, type TimelineRecord } from './types.js';
import { parseWithCrc, readCrcNdjsonFile, withCrc } from './wal.js';

export interface SeqRange {
  start_seq: number;
  end_seq: number;
}

export interface SessionIndexSummary {
  first_seq: number;
  last_seq: number;
  count: number;
  holes: number;
}

export interface TimelineIndexSnapshot {
  session: SessionIndexSummary;
  runs: Map<string, SeqRange[]>;
  types: Map<string, number[]>;
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function appendSeq(ranges: SeqRange[], seq: number): void {
  const last = ranges[ranges.length - 1];
  if (last !== undefined && last.end_seq + 1 === seq) {
    last.end_seq = seq;
    return;
  }
  ranges.push({ start_seq: seq, end_seq: seq });
}

/**
 * 增量索引构造器。
 *
 * 记录**必须按 seq 升序**加入（写者按分配顺序、恢复时按 seq 排序后加入）；
 * 乱序加入会让 run 区间被拆成多段（仍然正确，只是索引更大），不会丢记录。
 */
export class TimelineIndexBuilder {
  private readonly runs = new Map<string, SeqRange[]>();
  private readonly types = new Map<string, number[]>();
  private readonly seqSet = new Set<number>();
  private firstSeq = 0;
  private lastSeq = 0;
  private count = 0;

  add(record: TimelineRecord): void {
    if (this.firstSeq === 0 || record.seq < this.firstSeq) this.firstSeq = record.seq;
    if (record.seq > this.lastSeq) this.lastSeq = record.seq;
    this.count += 1;
    this.seqSet.add(record.seq);

    let ranges = this.runs.get(record.run_id);
    if (ranges === undefined) {
      ranges = [];
      this.runs.set(record.run_id, ranges);
    }
    appendSeq(ranges, record.seq);

    let seqs = this.types.get(record.type);
    if (seqs === undefined) {
      seqs = [];
      this.types.set(record.type, seqs);
    }
    seqs.push(record.seq);
  }

  /** 是否已收录该 seq（写者重启时用来算 `wal_head` 的连续性）。 */
  has(seq: number): boolean {
    return this.seqSet.has(seq);
  }

  /** 已收录的最大 seq（0 = 空）。 */
  maxSeq(): number {
    return this.lastSeq;
  }

  /** 已收录的 seq 升序副本（连续性计算用；不要改它）。 */
  seqs(): number[] {
    return [...this.seqSet].sort((a, b) => a - b);
  }

  snapshot(holeCount: number): TimelineIndexSnapshot {
    return {
      session: {
        first_seq: this.firstSeq,
        last_seq: this.lastSeq,
        count: this.count,
        holes: holeCount,
      },
      runs: new Map(this.runs),
      types: new Map(this.types),
    };
  }
}

interface SessionIndexLine extends SessionIndexSummary {
  v: 1;
  crc: string;
}

interface RunIndexLine extends SeqRange {
  v: 1;
  run_id: string;
  crc: string;
}

interface TypeIndexFile {
  v: 1;
  types: Array<[string, number[]]>;
  crc: string;
}

function validateSessionIndex(parsed: unknown): SessionIndexLine | undefined {
  const line = parseWithCrc<SessionIndexLine>(parsed);
  if (line === undefined || line.v !== 1) return undefined;
  for (const key of ['first_seq', 'last_seq', 'count', 'holes'] as const) {
    if (typeof line[key] !== 'number' || !Number.isFinite(line[key])) return undefined;
  }
  return line;
}

function validateRunIndex(parsed: unknown): RunIndexLine | undefined {
  const line = parseWithCrc<RunIndexLine>(parsed);
  if (line === undefined || line.v !== 1) return undefined;
  if (typeof line.run_id !== 'string') return undefined;
  if (!Number.isSafeInteger(line.start_seq) || !Number.isSafeInteger(line.end_seq)) {
    return undefined;
  }
  if (line.end_seq < line.start_seq) return undefined;
  return line;
}

function validateTypeIndex(parsed: unknown): TypeIndexFile | undefined {
  const file = parseWithCrc<TypeIndexFile>(parsed);
  if (file === undefined || file.v !== 1) return undefined;
  if (!Array.isArray(file.types)) return undefined;
  for (const entry of file.types) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    if (typeof entry[0] !== 'string' || !Array.isArray(entry[1])) return undefined;
    for (const seq of entry[1]) {
      if (!Number.isSafeInteger(seq) || seq < 1) return undefined;
    }
  }
  return file;
}

function indexPaths(sessionDir: string): {
  dir: string;
  session: string;
  run: string;
  type: string;
} {
  const dir = join(sessionDir, TIMELINE_LAYOUT.indexDir);
  return {
    dir,
    session: join(dir, TIMELINE_LAYOUT.indexSession),
    run: join(dir, TIMELINE_LAYOUT.indexRun),
    type: join(dir, TIMELINE_LAYOUT.indexType),
  };
}

/**
 * 写索引（确定性：run 按码点排序、type 按键排序、seq 升序、无时间戳）。
 *
 * 三个文件都走 `atomicWrite`（临时文件 + rename），读者不会看到半截索引。
 *
 * **`timeline.idx/` 也是 timeline 文件**：用旧格式会话目录调用它，会在一个只读冻结的会话里
 * 凭空造出 `timeline.idx/`（C1 之前的真实口子：已删除的那个离线读器 `open` 建索引就走
 * 这条路，而它看起来「只是读」）。因此这里与写者用**同一个闸门** `assertTimelineWritable`：
 * 旧格式会话一律 `session_frozen_readonly`，不是「静默不写」——静默会让人以为索引已经建好。
 */
export async function writeIndexSnapshot(
  sessionDir: string,
  snapshot: TimelineIndexSnapshot,
): Promise<void> {
  await assertTimelineWritable(sessionDir, basename(sessionDir));
  const paths = indexPaths(sessionDir);
  await mkdir(paths.dir, { recursive: true });

  const sessionLine = withCrc({ v: 1 as const, ...snapshot.session });
  await atomicWrite(paths.session, `${JSON.stringify(sessionLine)}\n`, {
    mode: 0o600,
    durable: true,
  });

  const runIds = [...snapshot.runs.keys()].sort(compareText);
  const runLines: string[] = [];
  for (const runId of runIds) {
    const ranges = snapshot.runs.get(runId) ?? [];
    for (const range of ranges) {
      const line = withCrc({
        v: 1 as const,
        run_id: runId,
        start_seq: range.start_seq,
        end_seq: range.end_seq,
      });
      runLines.push(`${JSON.stringify(line)}\n`);
    }
  }
  await atomicWrite(paths.run, runLines.join(''), { mode: 0o600, durable: true });

  const typeKeys = [...snapshot.types.keys()].sort(compareText);
  const types: Array<[string, number[]]> = typeKeys.map((type) => [
    type,
    [...(snapshot.types.get(type) ?? [])].sort((a, b) => a - b),
  ]);
  const typeFile = withCrc({ v: 1 as const, types });
  await atomicWrite(paths.type, `${JSON.stringify(typeFile)}\n`, {
    mode: 0o600,
    durable: true,
  });
}

/** 读索引；任一文件缺失/损坏 ⇒ `undefined`（调用方应重建）。 */
export async function loadIndexSnapshot(
  sessionDir: string,
): Promise<TimelineIndexSnapshot | undefined> {
  const paths = indexPaths(sessionDir);
  const sessionRead = await readCrcNdjsonFile<SessionIndexLine>(
    paths.session,
    validateSessionIndex,
  );
  const session = sessionRead.items[0];
  if (session === undefined) return undefined;

  const runRead = await readCrcNdjsonFile<RunIndexLine>(paths.run, validateRunIndex);
  const typeRead = await readCrcNdjsonFile<TypeIndexFile>(paths.type, validateTypeIndex);
  const typeFile = typeRead.items[0];
  if (typeFile === undefined) return undefined;

  const runs = new Map<string, SeqRange[]>();
  for (const line of runRead.items) {
    let ranges = runs.get(line.run_id);
    if (ranges === undefined) {
      ranges = [];
      runs.set(line.run_id, ranges);
    }
    ranges.push({ start_seq: line.start_seq, end_seq: line.end_seq });
  }
  for (const ranges of runs.values()) {
    ranges.sort((a, b) => a.start_seq - b.start_seq);
  }

  const types = new Map<string, number[]>();
  for (const [type, seqs] of typeFile.types) types.set(type, seqs);

  return {
    session: {
      first_seq: session.first_seq,
      last_seq: session.last_seq,
      count: session.count,
      holes: session.holes,
    },
    runs,
    types,
  };
}
