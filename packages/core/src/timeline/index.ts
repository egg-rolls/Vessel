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
 * 2. 索引写入假区间 ⇒ 读结果不变（逐条校验记录后回退全扫）并发 `timeline.index_mismatch`；
 * 3. `rebuild` 两次 ⇒ 索引文件字节相同（键排序、无时间戳、无哈希顺序抖动）；
 * 4. 写索引的位置只有本模块与 `writer.ts`（静态门禁在 C 阶段落地）。
 *
 * `TimelineIndexReader` 是给自证脚本与未来读侧的**独立读器**：它先信索引、再逐条校验，
 * 不一致就回退全扫。这就是「索引可重建」的可执行判据。
 *
 * @module @vessel-agent/core/timeline
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../session/atomic-write.js';
import { TIMELINE_LAYOUT, type TimelineHole, type TimelineRecord } from './types.js';
import { parseWithCrc, readCrcNdjsonFile, readHoles, readTimelineEvents, withCrc } from './wal.js';

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

export interface IndexMismatch {
  source: 'run' | 'type';
  key: string;
  detail: string;
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

/** 从一份已按 seq 升序的记录构造索引。 */
export function buildIndex(
  records: readonly TimelineRecord[],
  holes: readonly TimelineHole[] | number,
): TimelineIndexSnapshot {
  const builder = new TimelineIndexBuilder();
  for (const record of records) builder.add(record);
  return builder.snapshot(typeof holes === 'number' ? holes : holes.length);
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
 */
export async function writeIndexSnapshot(
  sessionDir: string,
  snapshot: TimelineIndexSnapshot,
): Promise<void> {
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

/** 从记录重建并写回索引（自证判据 3：两次重建字节相同）。 */
export async function rebuildIndexFiles(
  sessionDir: string,
  records?: readonly TimelineRecord[],
  holes?: readonly TimelineHole[],
): Promise<TimelineIndexSnapshot> {
  const actualRecords = records ?? (await readTimelineEvents(sessionDir));
  const actualHoles = holes ?? (await readHoles(sessionDir));
  const snapshot = buildIndex(actualRecords, actualHoles);
  await writeIndexSnapshot(sessionDir, snapshot);
  return snapshot;
}

export interface TimelineIndexReaderOptions {
  /** 索引与记录不一致时调用（ADR-105 §5；不阻断读）。 */
  onMismatch?: (mismatch: IndexMismatch) => void;
}

/**
 * 独立读器：索引只是加速，**结果永远以记录为准**。
 *
 * 每次查询都逐条校验索引指向的记录；任何不一致（假区间、漏区间、类型不符）都会
 * 回退到全扫并回调 `onMismatch`。
 */
export class TimelineIndexReader {
  private constructor(
    private readonly records: TimelineRecord[],
    private readonly bySeq: Map<number, TimelineRecord>,
    private readonly snapshot: TimelineIndexSnapshot,
    private readonly options: TimelineIndexReaderOptions,
  ) {}

  /**
   * 打开读器：优先读已落盘索引；缺失则从记录重建并写回。
   *
   * 注意：**不**校验索引是否过期（记录是事实源）；查询时逐条校验会兜住一切不一致。
   */
  static async open(
    sessionDir: string,
    options: TimelineIndexReaderOptions = {},
  ): Promise<TimelineIndexReader> {
    const records = await readTimelineEvents(sessionDir);
    const bySeq = new Map(records.map((record) => [record.seq, record]));
    let snapshot = await loadIndexSnapshot(sessionDir);
    if (snapshot === undefined) {
      const holes = await readHoles(sessionDir);
      snapshot = buildIndex(records, holes);
      await writeIndexSnapshot(sessionDir, snapshot);
    }
    return new TimelineIndexReader(records, bySeq, snapshot, options);
  }

  /** 当前索引快照（自证脚本用来做逐条比较）。 */
  currentSnapshot(): TimelineIndexSnapshot {
    return this.snapshot;
  }

  /** 按 run 查询（逐条校验 `record.run_id`；不一致 ⇒ 全扫回退）。 */
  readByRun(runId: string): TimelineRecord[] {
    const expected = this.records.filter((record) => record.run_id === runId);
    const ranges = this.snapshot.runs.get(runId);
    if (ranges === undefined) {
      if (expected.length === 0) return [];
      this.report('run', runId, 'missing_index_entry');
      return expected;
    }
    const selected: TimelineRecord[] = [];
    for (const range of ranges) {
      for (let seq = range.start_seq; seq <= range.end_seq; seq += 1) {
        const record = this.bySeq.get(seq);
        if (record === undefined || record.run_id !== runId) {
          this.report('run', runId, `seq=${seq} record_mismatch`);
          return expected;
        }
        selected.push(record);
      }
    }
    if (selected.length !== expected.length) {
      this.report(
        'run',
        runId,
        `count_mismatch selected=${selected.length} actual=${expected.length}`,
      );
      return expected;
    }
    return selected.sort((a, b) => a.seq - b.seq);
  }

  /** 按 type 查询（逐条校验 `record.type`；不一致 ⇒ 全扫回退）。 */
  readByType(type: string): TimelineRecord[] {
    const expected = this.records.filter((record) => record.type === type);
    const seqs = this.snapshot.types.get(type);
    if (seqs === undefined) {
      if (expected.length === 0) return [];
      this.report('type', type, 'missing_index_entry');
      return expected;
    }
    const selected: TimelineRecord[] = [];
    for (const seq of seqs) {
      const record = this.bySeq.get(seq);
      if (record === undefined || record.type !== type) {
        this.report('type', type, `seq=${seq} record_mismatch`);
        return expected;
      }
      selected.push(record);
    }
    if (selected.length !== expected.length) {
      this.report(
        'type',
        type,
        `count_mismatch selected=${selected.length} actual=${expected.length}`,
      );
      return expected;
    }
    return selected.sort((a, b) => a.seq - b.seq);
  }

  private report(source: 'run' | 'type', key: string, detail: string): void {
    this.options.onMismatch?.({ source, key, detail });
  }
}
