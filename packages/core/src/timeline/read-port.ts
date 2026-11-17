/**
 * 时间线的**只读口**（0.54 stop-write，ADR-105 D2 / §11 的读侧半边）。
 *
 * ## 它为什么存在（这一刀的全部意义）
 *
 * 0.54 收官前，`events.ndjson` 同时是「写目标」和「读事实源」。于是读方（EU 的历史投影、
 * idle 压缩、读回可用性、`context_usage` / `system_context` 两张卡、`event_cursor`）
 * 拿着**同一个既能写又能读的对象**（`SessionEventLog`）—— 任何一次误调都是一条新的
 * 旧源读路径，且看不出来。
 *
 * 本模块给出**一个没有 `append` 的实现**：`read()` / `lastSeq()` / `readTailMatches()` /
 * `updateIndex()`。类型上没有 `append`，所以读方**写不进去**（不是「约定不写」）。
 * 写入只有一条路：`TimelineWriter`（`timeline/writer.ts`，唯一 seq 分配点 + 唯一 fsync 点）。
 *
 * ## 读的四个口径（与旧日志读口的差异写清楚，避免"看起来一样、边界不同"）
 *
 * | 方法 | 事实源 | 成本 |
 * | --- | --- | --- |
 * | `read()`（无 `sinceSeq`） | `readTimelineEvents`（归档 + 块 + WAL 归并、按 seq 去重、外置 blob 取回） | O(会话) —— 调用方本来就要整份 |
 * | `read()`（有 `sinceSeq` + `limit`） | `readTimelineRange`（0.56 范围读：只开窗口内那几个块） | O(页)：缺省一页 6 个块、首屏一段 120 个块 |
 * | `lastSeq()` | `wal.log` 尾窗 + 最后一个块文件的尾帧（**不读整份**） | O(64 KiB) |
 * | `readTailMatches()` | `wal.log` 尾窗（事实行） | 首窗 64 KiB，扩窗到 4 MiB 后放弃 |
 *
 * `readTailMatches` 只扫 `wal.log`：chunk 家族在**块**里，而那两张卡（用量 / 系统消息）
 * 要的类型全是事实行（`context.*` / `llm.request` / `llm.response` / `prompt.system_context`）。
 * 归档是「复制不是搬移」（ADR-105 §11.1），`wal.log` 恒覆盖 `1..wal_head`，
 * 所以事实行只扫 `wal.log` 就够，**不必**碰归档段与本就会漏掉在飞 chunk 的块目录。
 *
 * ## 读之前先等写落定
 *
 * 读口带一个可选的 `settle`（装配层接双写旁路的 drain + writer.flush）：块级 WAL 的活动块
 * 在内存里，不等它封块就读会**少一段在飞 chunk**。`settle` 失败一律吞掉并降级为「直接读磁盘」——
 * 读不出东西是可声明的（空页），把 `sessions.get` 打成 internal 不是。
 *
 * @module @vessel-agent/core/timeline
 */

import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { noopLogger } from '../logging.js';
import {
  readSessionIndex,
  type SessionLogIndex,
  writeSessionIndex,
} from '../session/session-index.js';
import { sessionDirPath } from '../tenant/index.js';
import type { SessionEventRecord, SessionIndexPatch } from '../types/event.js';
import type { Logger } from '../types/logging.js';
import { lastBlockName } from './blocks.js';
import { assertSessionFormatSupported } from './legacy-format.js';
import { isTimelineBlobRef, TIMELINE_LAYOUT, type TimelineRecord } from './types.js';
import {
  decodeChunkBlock,
  hydrateRecordData,
  parseRecordLine,
  readFileWindow,
  readTimelineEvents,
  readTimelineRange,
  TimelineRangeUndecidable,
} from './wal.js';

/**
 * 范围读的进程内计数（review 三问的「有没有降级」信号；不落盘、不进 wire）。
 *
 * - `hits`：真的走了范围读的调用数；
 * - `degraded`：范围读不可判、退回整份读的调用数（每条都另有一条 `warn`）。
 *
 * 为什么要有它：`warn` 只有出事时才响，「范围读到底有没有生效」需要一眼能看；
 * 采集方（gateway 的 `stats()` / 自证脚本）拿它直接回答，不必去翻日志。
 */
const rangeReadCounters = { hits: 0, degraded: 0 };

/** 读一份范围读计数快照（见 {@link rangeReadCounters}）。 */
export function timelineRangeReadCounters(): Readonly<{ hits: number; degraded: number }> {
  return { ...rangeReadCounters };
}

/** 读 `read()` 的选项；`sinceSeq` 为**排他**游标（只返回 `seq > sinceSeq`）。 */
export interface TimelineReadOptions {
  sinceSeq?: number;
  limit?: number;
}

/** 尾窗读的结果（`records` 按文件顺序**新 → 旧**，即 seq 降序）。 */
export interface TimelineTailMatches {
  records: SessionEventRecord[];
  /** 本次调用实际读的字节数（成本说明用）。 */
  bytesRead: number;
}

/** 尾窗读的选项（口径与旧日志读口一致：命中够了就停、预算用完就说「不知道」）。 */
export interface TimelineTailMatchOptions {
  limit?: number;
  maxBytes?: number;
}

/** 尾窗回扫口径：首窗 / 上限（与已删除的旧日志读口 `SessionEventLog.readTailMatches` 同一组数字）。 */
const TAIL_FIRST_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 4 * 1024 * 1024;

export interface TimelineEventLogOptions {
  /** tenant 的 sessions 目录（`<tenant>/sessions`） */
  dir: string;
  logger?: Logger;
  /**
   * 读之前等写入落定（装配层接「双写旁路 drain + writer.flush」）。
   *
   * 不给 ⇒ 直接读磁盘（进程内没有写入者时就是正确行为：块 WAL 也已经封好了）。
   */
  settle?: (sessionId?: string) => Promise<void>;
}

/** timeline 记录 → 会话事件记录（丢掉写入侧的行尾 `crc`；形状与旧日志同形）。 */
export function toSessionEventRecord(record: TimelineRecord): SessionEventRecord {
  return {
    v: 1,
    session_id: record.session_id,
    run_id: record.run_id,
    seq: record.seq,
    ts: record.ts,
    type: record.type,
    data: record.data,
    ...(record.fencing_token !== undefined ? { fencing_token: record.fencing_token } : {}),
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * 把 `[offset, offset+length)` 读满；读不满返回 `undefined`（文件在读取期间变短了）。
 *
 * 实现搬到 `wal.ts#readFileWindow`（写者的尾窗恢复也要用同一份）：本模块只保留这个名字，
 * 免得两处各写一份「读不满怎么办」。
 */
const readWindow = readFileWindow;

/**
 * 在一个尾窗里**从后往前**收集命中 `types` 的记录（新 → 旧）。
 *
 * 只解析**完整行**：窗口起点切在一条记录中间时（`completeFromStart === false`），
 * buffer 偏移 0 起的那一段丢弃（不拼接、不猜）。坏行 / 撕裂残行跳过 —— 与
 * `readTimelineEvents` 的容错口径一致，差别只是这里不登记（读侧无写权限）。
 */
function scanTailWindow(
  buffer: Buffer,
  completeFromStart: boolean,
  types: ReadonlySet<string>,
  limit: number,
): TimelineRecord[] {
  const found: TimelineRecord[] = [];
  let cursor = buffer.length;
  while (cursor > 0) {
    let stop = cursor;
    while (stop > 0 && buffer[stop - 1] === 0x0a) stop -= 1; // 跳过行尾换行
    if (stop === 0) break;
    const newline = buffer.lastIndexOf(0x0a, stop - 1);
    if (newline === -1 && !completeFromStart) break;
    const lineStart = newline + 1;
    const record = parseRecordLine(buffer.toString('utf8', lineStart, stop));
    cursor = lineStart;
    if (record === undefined) continue;
    if (!types.has(record.type)) continue;
    found.push(record);
    if (found.length >= limit) break;
  }
  return found;
}

/**
 * 时间线的只读口：`read()` / `lastSeq()` / `readTailMatches()` / `updateIndex()`。
 *
 * **没有 `append`**（也不接受 writer）：想写只能走 `TimelineWriter`。
 */
export class TimelineEventLog {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly settle?: (sessionId?: string) => Promise<void>;

  constructor(options: TimelineEventLogOptions) {
    if (typeof options.dir !== 'string' || options.dir === '') {
      throw new Error('TimelineEventLog requires a non-empty dir');
    }
    this.dir = options.dir;
    this.logger = options.logger ?? noopLogger;
    this.settle = options.settle;
  }

  /** 会话目录（读口自己拼路径；调用方不拼）。 */
  sessionDir(sessionId: string): string {
    return sessionDirPath(this.dir, sessionId);
  }

  /**
   * 读一个会话的全部事件（按 seq 升序）；`sinceSeq` 是**排他**游标。
   *
   * 两条路，**输出逐条等价**（同一个 `sinceSeq` 返回的 seq 集合完全相等）：
   *
   * | 情况 | 走哪条 | 成本 |
   * | --- | --- | --- |
   * | 没有 `sinceSeq`（索引重建 / 显式修复 / `read()` 的整份语义） | `readTimelineEvents` | O(会话) |
   * | 有 `sinceSeq` + 有 `limit`（翻页） | `readTimelineRange`（0.56 范围读） | O(页) + 固定探针 |
   *
   * 范围读不可判时**降级整份读并留痕**（`timeline range read degraded` 告警 + 计数）——
   * 绝不把不可判吞成空数组或「少给几条的正常返回」（0.56 设计 §3.4：那是最坏的实现）。
   *
   * 整份读那一路的三个口径不变：事实源是三处归并、按 seq 去重、外置 blob 取回，并且
   * **先事实后块**（`wal.ts` 的一致快照顺序），所以一次读的返回永远自洽。
   *
   * **0.55：旧格式会话在这里抛 `legacy_session_unsupported`**（`legacy-format.ts`）。
   * 不报空数组：那等于把「这套文件没人能解析了」说成「这个会话没有事件」。
   */
  async read(sessionId: string, options: TimelineReadOptions = {}): Promise<SessionEventRecord[]> {
    const limit =
      typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Math.max(0, Math.floor(options.limit))
        : undefined;
    if (limit === 0) return [];
    await this.settled(sessionId);
    const dir = this.sessionDir(sessionId);
    await assertSessionFormatSupported(dir, sessionId);
    const since =
      typeof options.sinceSeq === 'number' && Number.isFinite(options.sinceSeq)
        ? Math.floor(options.sinceSeq)
        : undefined;
    // 第十一条：只有「排他游标 + 页上限」这一种调用才有窗口可开。没有 sinceSeq 的调用方
    // 本来就要整份（索引重建、`execution-unit` 的历史投影），范围读对它没有收益。
    if (since !== undefined && limit !== undefined) {
      const ranged = await this.readRange(dir, sessionId, since, limit);
      if (ranged !== undefined) return ranged;
    }
    const records = await readTimelineEvents(dir);
    const selected = since !== undefined ? records.filter((record) => record.seq > since) : records;
    const windowed = limit !== undefined ? selected.slice(0, limit) : selected;
    return windowed.map(toSessionEventRecord);
  }

  /**
   * 磁盘上的最后 seq（读不出 ⇒ `undefined`，**不报 0**）。
   *
   * 只看两处**事实**：`wal.log` 的最后一条事实行、最后一个块文件的最后一个完整帧。
   * 不读索引（索引是派生物，ADR-105 §5 明确不得当判据）也不读整份会话。
   */
  async lastSeq(sessionId: string): Promise<number | undefined> {
    await this.settled(sessionId);
    const dir = this.sessionDir(sessionId);
    const [factSeq, blockSeq] = await Promise.all([
      lastWalFactSeq(join(dir, TIMELINE_LAYOUT.walLog)),
      lastBlockSeq(dir),
    ]);
    const max = Math.max(factSeq, blockSeq);
    return max > 0 ? max : undefined;
  }

  /**
   * 从 `wal.log` 尾部回扫，取 `type ∈ types` 的最近若干条事实（新 → 旧）。
   *
   * 与旧日志读口同一组预算（首窗 64 KiB、×4 扩窗、上限 4 MiB），**不回退全量扫盘**：
   * 目标事件离尾部太远时宁可说「不知道」，也不让 `sessions.get` 变成整份读。
   */
  async readTailMatches(
    sessionId: string,
    types: readonly string[],
    options: TimelineTailMatchOptions = {},
  ): Promise<TimelineTailMatches> {
    const wanted = new Set(types);
    const limit =
      typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Math.max(0, Math.floor(options.limit))
        : 8;
    if (wanted.size === 0 || limit === 0) return { records: [], bytesRead: 0 };

    await this.settled(sessionId);
    const dir = this.sessionDir(sessionId);
    const path = join(dir, TIMELINE_LAYOUT.walLog);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if (isNotFound(error)) return { records: [], bytesRead: 0 };
      throw error;
    }
    if (size <= 0) return { records: [], bytesRead: 0 };

    const requested =
      typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
        ? Math.floor(options.maxBytes)
        : TAIL_MAX_BYTES;
    const maxBytes = Math.max(1, Math.min(requested, size));
    let window = Math.min(TAIL_FIRST_BYTES, maxBytes);
    let bytesRead = 0;
    for (;;) {
      const start = Math.max(0, size - window);
      const length = size - start;
      const buffer = await readWindow(path, start, length);
      // 读取期间文件变短：不猜，按「没有数据」处理。
      if (buffer === undefined) return { records: [], bytesRead };
      bytesRead += length;
      const hits = scanTailWindow(buffer, start === 0, wanted, limit);
      if (hits.length > 0) {
        const records: SessionEventRecord[] = [];
        for (const hit of hits) {
          // 外置 blob（> 1 MiB 的 data）靠同一个还原口径取回，否则读到的只是引用。
          const hydrated = isTimelineBlobRef(hit.data) ? await hydrateRecordData(dir, hit) : hit;
          records.push(toSessionEventRecord(hydrated));
        }
        return { records, bytesRead };
      }
      if (start === 0) return { records: [], bytesRead }; // 整份文件都看过了
      if (window >= maxBytes) return { records: [], bytesRead }; // 预算用完：不扫全盘
      window = Math.min(window * 4, maxBytes);
    }
  }

  /** 读 `index.json`；缺失/损坏 = `null`（索引是缓存，不是事实）。 */
  async readIndex(sessionId: string): Promise<SessionLogIndex | null> {
    return readSessionIndex(this.dir, sessionId, (detail) => {
      this.logger.warn('session index corrupt', detail);
    });
  }

  /**
   * 该会话的**尾水位**（派生读的缓存键：水位不变 ⇒ 派生结果不可能变）。
   *
   * 口径（0.54 stop-write，替代旧的 `stat events.ndjson` 那次读）：
   * `wal.log` 的 `大小:mtime` + **尾块名**。三处都要看，因为三类写入各自只动其中一处：
   *
   * | 写入 | 动的是 | 只 stat 它会漏掉 |
   * | --- | --- | --- |
   * | 事实行 | `wal.log` 大小 / mtime | —— |
   * | chunk 封块 | 新增 `wal.blocks/NNNNNN.wblk`（`wal.log` 不动） | 长 run 的正文/思考增量 |
   * | 归档 | `timeline.ndjson`（只复制已存在的事实） | 不影响「可派生到什么」 |
   *
   * 归档那一行故意**不**进水位：归档是复制不是搬移，它不产生新的可派生内容；把它算进
   * 水位只会让缓存无谓失效（每次 `sessions.get` 都重算一遍尾窗）。
   *
   * `undefined` = 这个会话还没有任何事件（连 `wal.log` 都没建）—— 调用方据此「不带
   * `event_cursor`」，不是 `0`。
   */
  async watermark(sessionId: string): Promise<string | undefined> {
    const dir = this.sessionDir(sessionId);
    const wal = await stat(join(dir, TIMELINE_LAYOUT.walLog)).catch(() => undefined);
    // 0.56：只要「最后一块是谁」，不值得为它 readdir 整个块目录（见 `lastBlockName`）。
    const lastBlock = await lastBlockName(dir);
    if (wal === undefined && lastBlock === undefined) return undefined;
    const size = wal?.size ?? 0;
    const mtime = wal === undefined ? 0 : Math.floor(wal.mtimeMs);
    return `${String(size)}:${String(mtime)}:${lastBlock ?? '-'}`;
  }

  /**
   * 合并写 `index.json`（元数据：title / preview / status / 时间戳 / 计数）。
   *
   * 这是读口唯一的写：它写的是**元数据缓存**，不是事件（事件只有 `TimelineWriter` 能写）。
   * 计数缺省取磁盘上的最后 seq —— 与会话壳「投影覆盖到哪」无关（ADR-105 D2：投影是
   * 纯读侧视图，写侧不宣布覆盖）。
   */
  async updateIndex(sessionId: string, patch: SessionIndexPatch): Promise<void> {
    const existing = await this.readIndex(sessionId);
    const persisted = (await this.lastSeq(sessionId)) ?? 0;
    await writeSessionIndex(
      this.dir,
      sessionId,
      patch,
      { event_count: persisted, derived_upto_seq: persisted },
      existing,
    );
  }

  /** 等写入落定（口径见模块头的「读之前先等写落定」）。 */
  async flush(sessionId?: string): Promise<void> {
    await this.settled(sessionId);
  }

  /** 会话目录是否存在（删除一致性检查用）。 */
  async hasSession(sessionId: string): Promise<boolean> {
    try {
      return (await stat(this.sessionDir(sessionId))).isDirectory();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * 删掉整个会话目录（index + timeline + 块 + blob）。
   *
   * **不关写入句柄**：那是写入侧的职责（装配层先 `closeSession`）。这里只做目录删除，
   * 与已删除的旧日志读口 `SessionEventLog.deleteSession` 的口径一致（目录不存在 ⇒ false）。
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const existed = await this.hasSession(sessionId);
    if (!existed) return false;
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
    return true;
  }

  /**
   * 尝试走范围读（0.56）；不可判 / 失败 ⇒ `undefined`（调用方退回整份读）。
   *
   * 三条纪律：
   *
   * 1. **不把不可判吞成答案**：这里返回 `undefined` 只是「换一条路」，绝不返回空数组或
   *    一个短页 —— 那正是 0.56 设计 §9 点名的最坏实现（真机复现过：2000 条页只回 1971
   *    条、零报错）；
   * 2. **降级必须留痕**：一次 `warn`（`reason` 是稳定 code）+ 一次进程内计数
   *    （{@link timelineRangeReadCounters}）—— 静默降级 = 下次没人知道范围读一直没生效；
   * 3. **阈值不是降级**：块数 < `RANGE_READ_MIN_BLOCKS`、`limit` 不适用这类「设计好的直路」
   *    只走整份读、不告警（否则每个小会话每页一条 warn，日志就成了噪音）。
   */
  private async readRange(
    dir: string,
    sessionId: string,
    since: number,
    limit: number,
  ): Promise<SessionEventRecord[] | undefined> {
    try {
      const { records, stats } = await readTimelineRange(dir, { sinceSeq: since, limit });
      rangeReadCounters.hits += 1;
      // 第十一条 review 三问的答案：这次开了几个块、读了几字节、有没有降级。
      this.logger.debug('timeline range read', {
        session_id: sessionId,
        since_seq: stats.since_seq,
        count: stats.count,
        opened_blocks: stats.blocks_opened,
        block_bytes: stats.block_bytes,
        fact_bytes: stats.fact_bytes,
        anchor: stats.anchor_source,
        enumerated_by: stats.enumeration_source,
        ...(stats.enumeration_fallback === undefined
          ? {}
          : { enumeration_fallback: stats.enumeration_fallback }),
        window_to: stats.window_to,
        declared_holes: stats.declared_holes,
      });
      if (stats.unverified_blocks.length > 0) {
        // 块照样读出来了（窗口是覆盖算术证明过的），只是它的 manifest 记账对不上 —— 值得一条 warn。
        this.logger.warn('timeline range read block unverified', {
          session_id: sessionId,
          since_seq: since,
          blocks: stats.unverified_blocks.slice(0, 8),
          blocks_total: stats.unverified_blocks.length,
        });
      }
      return records.map(toSessionEventRecord);
    } catch (error) {
      const reason = error instanceof TimelineRangeUndecidable ? error.reason : 'read_failed';
      if (
        reason === 'blocks_below_threshold' ||
        reason === 'invalid_cursor' ||
        reason === 'invalid_limit'
      ) {
        return undefined;
      }
      rangeReadCounters.degraded += 1;
      this.logger.warn('timeline range read degraded', {
        session_id: sessionId,
        since_seq: since,
        limit,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async settled(sessionId?: string): Promise<void> {
    if (this.settle === undefined) return;
    try {
      await this.settle(sessionId);
    } catch (error) {
      // 写入侧坏了不该让读变成 internal：照磁盘读，读不到就是「读不到」。
      this.logger.warn('timeline settle before read failed', {
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** `wal.log` 最后一条**事实行**的 seq（撕裂残行 / 坏行跳过）；读不出 ⇒ 0。 */
async function lastWalFactSeq(path: string): Promise<number> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return 0;
  }
  if (size <= 0) return 0;
  let window = Math.min(TAIL_FIRST_BYTES, size);
  for (;;) {
    const start = Math.max(0, size - window);
    const buffer = await readWindow(path, start, size - start);
    if (buffer === undefined) return 0;
    let cursor = buffer.length;
    while (cursor > 0) {
      let stop = cursor;
      while (stop > 0 && buffer[stop - 1] === 0x0a) stop -= 1;
      if (stop === 0) break;
      const newline = buffer.lastIndexOf(0x0a, stop - 1);
      if (newline === -1 && start > 0) break; // 窗口切在行中间：扩窗重来
      const lineStart = newline + 1;
      const record = parseRecordLine(buffer.toString('utf8', lineStart, stop));
      cursor = lineStart;
      if (record !== undefined) return record.seq;
    }
    if (start === 0) return 0;
    window = Math.min(window * 8, size);
  }
}

/** 最后一个块文件里最后一个完整帧的 seq（含完整但坏 CRC 的帧：它已占 seq）；读不出 ⇒ 0。 */
async function lastBlockSeq(sessionDir: string): Promise<number> {
  // 0.56：最后一块的名字从 manifest 尾 + 块号探测拿（不 readdir 整个目录）。
  const last = await lastBlockName(sessionDir);
  if (last === undefined) return 0;
  const buffer = await readFile(join(sessionDir, TIMELINE_LAYOUT.walBlocks, last)).catch(
    () => undefined,
  );
  if (buffer === undefined) return 0;
  const decode = decodeChunkBlock(buffer);
  let max = 0;
  for (const record of decode.records) if (record.seq > max) max = record.seq;
  for (const invalid of decode.invalid) if (invalid.to_seq > max) max = invalid.to_seq;
  return max;
}
