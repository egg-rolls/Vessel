/**
 * 旧格式会话 → 时间线单源的一次性迁移（0.54 C2 / plan-054 §C2，方案 A：丢格式不丢历史）。
 *
 * ## 这个模块干什么
 *
 * 旧会话（只有 `events.ndjson`，口径见 `freeze.ts#isLegacyFrozenSessionDir`）升级成
 * 0.54 新格式：写 `timeline.manifest` / `wal.log` / `wal.manifest` / `wal.blocks/` /
 * `holes.ndjson` / `timeline.idx/`。落盘**只用 core 的公开写者**（`TimelineWriter`），
 * 本模块不手写 timeline 任何一行 —— 格式与不变量（CRC、manifest、索引）归写者所有。
 *
 * ## 四条硬纪律（每条对应一条验收要求）
 *
 * | # | 纪律 | 实现 |
 * | --- | --- | --- |
 * | D1 | **源文件只读**：`events.ndjson` 一个字节都不改 | 只 `readFile`；迁移前后各算一次 sha256 并比对 |
 * | D2 | **逐会话原子性**：失败 ⇒ 回到迁移前目录状态 | 先写到 `<session>/.timeline-migrating/`，**校验通过后**才 rename 就位；任何异常 ⇒ 删掉暂存区 + 删掉已就位的本次新增文件 |
 * | D3 | **幂等 + 可重入**：不产生第二份 timeline | 仍有 timeline 标记 ⇒ `skipped(already_timeline)`；中断残留的暂存区/半套文件在「无标记」时可安全清掉重来 |
 * | D4 | **内容等价**：迁移后逐条比对 | `readTimelineEvents()` 从磁盘读回暂存区，与源逐条比 `seq/type/ts/run_id/data/fencing_token`，不等 ⇒ 判失败并回滚 |
 *
 * ## 为什么 seq 不用「保留」而天然一致
 *
 * `TimelineWriter` 自己分配 seq（从 1 起、连续），不接受外部指定；旧日志的 seq 也满足
 * 「按 session 从 1 连续递增」（`session-event-log.ts` 的契约）。因此**只要按文件顺序
 * 逐条 append，两边 seq 必然逐条相同**。所以本模块先校验源 seq 恰好是文件顺序的 1..N：
 * 一旦有缺口就**拒绝迁移**（`skipped(seq_gap)`）—— 写者无法表达缺口，硬迁等于把后面的
 * seq 全部前移、把旧的洞洗掉。宁可留一个旧会话，不可悄悄改历史。
 *
 * ## 旧会话本来就没有的东西（不是丢失，别误报）
 *
 * 流式增量（`chunk` 家族）从不进 `events.ndjson`（0.54 chunk-slim 之前它们就是瞬时提示），
 * 正文与思考在 `llm.response` 里。迁移**不补**、也无法补这些瞬时事件。
 *
 * @module vessel/session-migrate
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isTransientChunkEvent } from '../packages/core/src/timeline/blocks';
import { isLegacyFrozenSessionDir, LEGACY_SESSION_LOG } from '../packages/core/src/timeline/freeze';
import type { TimelineRecord } from '../packages/core/src/timeline/types';
import { readHoles, readTimelineEvents } from '../packages/core/src/timeline/wal';
import { TimelineWriter } from '../packages/core/src/timeline/writer';

/** 迁移暂存目录（会话目录内；成功后整个消失）。 */
export const MIGRATE_STAGING_DIR = '.timeline-migrating';

/**
 * 本模块允许在会话目录里触碰的**全部**名字，顺序 = 就位顺序。
 *
 * 非标记先、标记后、`timeline.manifest` 最后 —— 因为 `freeze.ts#TIMELINE_MARKERS` 里
 * 任一标记出现，会话就「已经是新格式」，所以必须让读者在**看到标记时数据已经齐了**。
 * 这份白名单同时是回滚的删除范围：白名单之外的文件（`events.ndjson` / `index.json` /
 * 用户自己的东西）一律不碰。
 */
const TIMELINE_ARTIFACTS = [
  'holes.ndjson',
  'timeline.idx',
  'wal.blocks',
  'timeline',
  'timeline.ndjson',
  'wal.log',
  'wal.manifest',
  'timeline.manifest',
] as const;

/** 旧格式单条记录（`session-event-log.ts` v1 形状，无 crc）。 */
export interface LegacyEventRecord {
  v: 1;
  session_id: string;
  run_id: string;
  seq: number;
  ts: number;
  type: string;
  data: unknown;
  fencing_token?: number;
}

/** 源日志扫描结果 */
export interface LegacyScan {
  /** 逐条（文件顺序） */
  records: LegacyEventRecord[];
  /** 非空行总数（含坏行） */
  totalLines: number;
  /** 行号从 1 起 */
  badLines: Array<{ line: number; reason: string }>;
  /** 源字节数（`events.ndjson` 大小） */
  bytes: number;
  /** 源 `events.ndjson` 的 sha256（十六进制） */
  sha256: string;
  /** seq 不是「文件顺序的 1..N」时给出的缺口（按数值排序后的区间） */
  seqGaps: Array<{ from_seq: number; to_seq: number }>;
  /** 文件顺序本身就乱序/重复（seq 增序被打断） */
  orderMismatch: boolean;
  /** 第一条 / 最后一条 seq（0 条时为 null） */
  firstSeq: number | null;
  lastSeq: number | null;
  /** 瞬时 chunk 事件条数（进不了 timeline；旧日志里通常为 0） */
  transientChunks: number;
}

/** 迁移结论 */
export type MigrateStatus = 'migrated' | 'would_migrate' | 'skipped' | 'failed';

/** 跳过原因（稳定机器码；人读输出另给中文说明） */
export type MigrateSkipReason =
  | 'already_timeline'
  | 'no_legacy_log'
  | 'session_not_found'
  | 'seq_gap'
  | 'seq_unsorted'
  | 'transient_chunk_events';

/** 失败原因（稳定机器码） */
export type MigrateFailReason =
  | 'read_failed'
  | 'parse_failed'
  | 'session_id_mismatch'
  | 'write_failed'
  | 'verify_failed';

/** 单个会话的迁移结果 */
export interface MigrateSessionOutcome {
  session_id: string;
  status: MigrateStatus;
  reason?: string;
  /** 迁移条数（`skipped`/`failed` 时为可读到的条数，读不到为 0） */
  events: number;
  first_seq: number | null;
  last_seq: number | null;
  /** 源日志的缺口（有 = 本会话不迁移，且这些段确实不在结果里） */
  holes: Array<{ from_seq: number; to_seq: number }>;
  /** 源 `events.ndjson` 字节数 */
  bytes_source: number;
  /** 实际新增字节（dry-run 为 0，另见 `est_bytes_added`） */
  bytes_added: number;
  /** dry-run 估算的新增字节 */
  est_bytes_added: number;
  /** 源 `events.ndjson` 迁移前后的 sha256（`migrated` 时两者必须相等） */
  source_sha256_before?: string;
  source_sha256_after?: string;
  /** 逐条等价自证是否通过 */
  verified: boolean;
  /** 本次新增 / 就位的文件（相对会话目录） */
  created: string[];
  detail?: string;
}

/** 迁移入参 */
export interface MigrateSessionInput {
  sessionId: string;
  sessionDir: string;
  dryRun: boolean;
  /** 注入时钟（测试缝） */
  now?: () => number;
}

/** 事件数 → 估算字节（`wal.log` 逐条多一个 `"crc":"xxxxxxxx"` + 索引约 8%） */
function estimateBytes(bytes: number, events: number): number {
  const wal = bytes + events * 16;
  return wal + Math.round(wal * 0.08) + 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 严格解析旧格式一条记录；不合法返回原因（迁移不接受「宽松跳过」）。 */
function parseLegacyLine(line: string): { record: LegacyEventRecord } | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return { reason: `json: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(parsed)) return { reason: 'not_an_object' };
  if (parsed.v !== 1) return { reason: `unsupported_v: ${String(parsed.v)}` };
  if (typeof parsed.session_id !== 'string' || parsed.session_id.length === 0) {
    return { reason: 'bad_session_id' };
  }
  if (typeof parsed.run_id !== 'string') return { reason: 'bad_run_id' };
  if (typeof parsed.seq !== 'number' || !Number.isFinite(parsed.seq)) return { reason: 'bad_seq' };
  if (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) return { reason: 'bad_ts' };
  if (typeof parsed.type !== 'string' || parsed.type.length === 0) return { reason: 'bad_type' };
  const record: LegacyEventRecord = {
    v: 1,
    session_id: parsed.session_id,
    run_id: parsed.run_id,
    seq: Math.floor(parsed.seq),
    ts: parsed.ts,
    type: parsed.type,
    data: parsed.data,
  };
  if (typeof parsed.fencing_token === 'number' && Number.isFinite(parsed.fencing_token)) {
    record.fencing_token = parsed.fencing_token;
  }
  return { record };
}

/** 从数值排序后的 seq 列表算缺口区间（1..last 里没出现的段）。 */
function computeGaps(seqs: readonly number[]): Array<{ from_seq: number; to_seq: number }> {
  const gaps: Array<{ from_seq: number; to_seq: number }> = [];
  const sorted = [...seqs].sort((a, b) => a - b);
  if (sorted.length === 0) return gaps;
  const first = sorted[0] ?? 1;
  if (first > 1) gaps.push({ from_seq: 1, to_seq: first - 1 });
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1] ?? 0;
    const current = sorted[index] ?? 0;
    if (current > previous + 1) gaps.push({ from_seq: previous + 1, to_seq: current - 1 });
  }
  return gaps;
}

/**
 * 只读扫描 `<sessionDir>/events.ndjson`：条数 / 首末 seq / 缺口 / 坏行 / sha256。
 *
 * 与运行期读路径（`SessionEventLog#read`）的**故意差异**：这里坏行**不静默跳过**，
 * 而是逐行登记原因 —— 迁移里「看不准」就等于改历史，必须把问题交回给人。
 */
export async function scanLegacyEvents(sessionDir: string): Promise<LegacyScan> {
  const raw = await readFile(join(sessionDir, LEGACY_SESSION_LOG));
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const records: LegacyEventRecord[] = [];
  const badLines: Array<{ line: number; reason: string }> = [];
  let totalLines = 0;
  let transientChunks = 0;

  const lines = raw.toString('utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '') continue;
    totalLines += 1;
    const parsed = parseLegacyLine(line);
    if ('reason' in parsed) {
      badLines.push({ line: index + 1, reason: parsed.reason });
      continue;
    }
    if (isTransientChunkEvent(parsed.record)) transientChunks += 1;
    records.push(parsed.record);
  }

  let orderMismatch = false;
  for (let index = 0; index < records.length; index += 1) {
    if ((records[index]?.seq ?? 0) !== index + 1) {
      orderMismatch = true;
      break;
    }
  }

  return {
    records,
    totalLines,
    badLines,
    bytes: raw.byteLength,
    sha256,
    seqGaps: computeGaps(records.map((record) => record.seq)),
    orderMismatch,
    firstSeq: records[0]?.seq ?? null,
    lastSeq: records.length > 0 ? (records[records.length - 1]?.seq ?? null) : null,
    transientChunks,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 目录树字节数（只统计白名单里的名字；不存在记 0）。 */
async function artifactBytes(sessionDir: string, names: readonly string[]): Promise<number> {
  let total = 0;
  const walk = async (path: string): Promise<number> => {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) return 0;
    if (!info.isDirectory()) return info.size;
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    let sum = 0;
    for (const entry of entries) sum += await walk(join(path, entry.name));
    return sum;
  };
  for (const name of names) total += await walk(join(sessionDir, name));
  return total;
}

/** 清掉会话目录里（白名单内的）timeline 残留 —— 只在「无任何标记」时调用。 */
async function clearStaleArtifacts(sessionDir: string): Promise<void> {
  for (const name of TIMELINE_ARTIFACTS) {
    await rm(join(sessionDir, name), { recursive: true, force: true });
  }
}

/** 逐条等价比对（源 vs 从磁盘读回），返回第一处不等。 */
function firstMismatch(
  source: readonly LegacyEventRecord[],
  migrated: readonly TimelineRecord[],
): { index: number; field: string; seq: number } | undefined {
  const length = Math.min(source.length, migrated.length);
  for (let index = 0; index < length; index += 1) {
    const left = source[index];
    const right = migrated[index];
    if (left === undefined || right === undefined) {
      return { index, field: 'missing_record', seq: left?.seq ?? right?.seq ?? index + 1 };
    }
    if (left.seq !== right.seq) return { index, field: 'seq', seq: left.seq };
    if (left.type !== right.type) return { index, field: 'type', seq: left.seq };
    if (left.ts !== right.ts) return { index, field: 'ts', seq: left.seq };
    if (left.run_id !== right.run_id) return { index, field: 'run_id', seq: left.seq };
    if ((left.fencing_token ?? null) !== (right.fencing_token ?? null)) {
      return { index, field: 'fencing_token', seq: left.seq };
    }
    if (JSON.stringify(left.data) !== JSON.stringify(right.data)) {
      return { index, field: 'data', seq: left.seq };
    }
  }
  if (source.length !== migrated.length) {
    return { index: length, field: 'count', seq: length + 1 };
  }
  return undefined;
}

/**
 * 把暂存区里本次写出的文件按安全顺序 rename 就位（同目录，不跨盘）。
 *
 * 返回**已就位**的名字 —— 中途失败时调用方只需删掉这些。
 */
async function promoteArtifacts(stagingDir: string, sessionDir: string): Promise<string[]> {
  const present = new Set(await readdir(stagingDir));
  const promoted: string[] = [];
  for (const name of TIMELINE_ARTIFACTS) {
    if (!present.has(name)) continue;
    await rename(join(stagingDir, name), join(sessionDir, name));
    promoted.push(name);
  }
  return promoted;
}

/**
 * 迁移（或 dry-run 评估）一个会话。
 *
 * 任何异常都被收敛成 `MigrateSessionOutcome`（不向调用方抛）：批量迁移里一个会话失败
 * 不能让整趟停下来，也不能污染别的会话。
 */
export async function migrateSession(input: MigrateSessionInput): Promise<MigrateSessionOutcome> {
  const { sessionId, sessionDir, dryRun } = input;
  const base: MigrateSessionOutcome = {
    session_id: sessionId,
    status: 'skipped',
    events: 0,
    first_seq: null,
    last_seq: null,
    holes: [],
    bytes_source: 0,
    bytes_added: 0,
    est_bytes_added: 0,
    verified: false,
    created: [],
  };

  if (!(await pathExists(sessionDir))) {
    return { ...base, status: 'skipped', reason: 'session_not_found', detail: sessionDir };
  }

  // 旧格式判据只有一份（freeze.ts）：有 events.ndjson 且没有任何 timeline 标记。
  if (!(await isLegacyFrozenSessionDir(sessionDir))) {
    return {
      ...base,
      status: 'skipped',
      reason: (await pathExists(join(sessionDir, 'timeline.manifest')))
        ? 'already_timeline'
        : 'no_legacy_log',
    };
  }

  let scan: LegacyScan;
  try {
    scan = await scanLegacyEvents(sessionDir);
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      reason: 'read_failed' satisfies MigrateFailReason,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const scanned: MigrateSessionOutcome = {
    ...base,
    events: scan.records.length,
    first_seq: scan.firstSeq,
    last_seq: scan.lastSeq,
    holes: scan.seqGaps,
    bytes_source: scan.bytes,
    est_bytes_added: estimateBytes(scan.bytes, scan.records.length),
    source_sha256_before: scan.sha256,
  };

  if (scan.badLines.length > 0) {
    const preview = scan.badLines
      .slice(0, 3)
      .map((item) => `line ${item.line}: ${item.reason}`)
      .join('; ');
    return {
      ...scanned,
      status: 'failed',
      reason: 'parse_failed' satisfies MigrateFailReason,
      detail: `${scan.badLines.length} bad line(s) — ${preview}`,
    };
  }

  const foreign = scan.records.find((record) => record.session_id !== sessionId);
  if (foreign !== undefined) {
    return {
      ...scanned,
      status: 'failed',
      reason: 'session_id_mismatch' satisfies MigrateFailReason,
      detail: `seq ${foreign.seq} belongs to ${foreign.session_id}`,
    };
  }

  if (scan.transientChunks > 0) {
    return {
      ...scanned,
      status: 'skipped',
      reason: 'transient_chunk_events' satisfies MigrateSkipReason,
      detail: `${scan.transientChunks} transient chunk event(s) — the timeline refuses them by design`,
    };
  }

  if (scan.seqGaps.length > 0 || scan.orderMismatch) {
    // 写者无法表达缺口（seq 由它从 1 连续分配），硬迁会把后面的 seq 前移、把洞洗掉。
    return {
      ...scanned,
      status: 'skipped',
      reason: (scan.seqGaps.length > 0 ? 'seq_gap' : 'seq_unsorted') satisfies MigrateSkipReason,
      detail:
        scan.seqGaps.length > 0
          ? `missing seq ${scan.seqGaps.map((gap) => `${gap.from_seq}..${gap.to_seq}`).join(', ')}`
          : 'events.ndjson is not in ascending seq order',
    };
  }

  if (dryRun) return { ...scanned, status: 'would_migrate' };

  const stagingDir = join(sessionDir, MIGRATE_STAGING_DIR);
  const promoted: string[] = [];
  try {
    // 残留的暂存区（上次中断）直接清掉：此刻会话仍是旧格式，不存在第二份 timeline。
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });

    const writer = await TimelineWriter.open({
      sessionId,
      sessionDir: stagingDir,
      ...(input.now ? { now: input.now } : {}),
    });
    try {
      await writer.appendMany(
        scan.records.map((record) => ({
          run_id: record.run_id,
          type: record.type,
          ts: record.ts,
          data: record.data,
          ...(record.fencing_token !== undefined ? { fencing_token: record.fencing_token } : {}),
        })),
      );
      await writer.flush();
    } finally {
      await writer.close();
    }

    // 自证：从**磁盘**读回暂存区（不看写者内存），逐条比 seq/type/ts/run_id/data/fencing_token。
    const readBack = await readTimelineEvents(stagingDir);
    const mismatch = firstMismatch(scan.records, readBack);
    if (mismatch !== undefined) {
      throw new Error(
        `verify_failed: seq ${mismatch.seq} field=${mismatch.field} ` +
          `(${readBack.length}/${scan.records.length} read back)`,
      );
    }
    const holes = await readHoles(stagingDir);
    if (holes.length > 0) {
      throw new Error(`verify_failed: the writer registered ${holes.length} hole(s)`);
    }

    const added = await artifactBytes(stagingDir, TIMELINE_ARTIFACTS);

    // 就位：先清残留（仍无标记 ⇒ 那些是中断残留），再按安全顺序 rename（标记最后）。
    await clearStaleArtifacts(sessionDir);
    promoted.push(...(await promoteArtifacts(stagingDir, sessionDir)));
    await rm(stagingDir, { recursive: true, force: true });

    const after = await scanLegacyEvents(sessionDir);
    if (after.sha256 !== scan.sha256) {
      // 源文件被动过：最严重的一类失败 —— 先删掉本次新增，再报。
      for (const name of promoted) {
        await rm(join(sessionDir, name), { recursive: true, force: true }).catch(() => {});
      }
      return {
        ...scanned,
        status: 'failed',
        reason: 'verify_failed' satisfies MigrateFailReason,
        detail: `events.ndjson changed during migration (${scan.sha256} -> ${after.sha256})`,
      };
    }

    return {
      ...scanned,
      status: 'migrated',
      bytes_added: added,
      verified: true,
      created: promoted,
      source_sha256_after: after.sha256,
    };
  } catch (error) {
    // D2：回到迁移前状态 —— 删掉已就位的本次新增文件 + 暂存区；源文件从来没被写过。
    for (const name of promoted) {
      await rm(join(sessionDir, name), { recursive: true, force: true }).catch(() => {});
    }
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return {
      ...scanned,
      status: 'failed',
      reason: 'write_failed' satisfies MigrateFailReason,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
