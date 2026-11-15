/**
 * 会话 timeline **双写旁路**（0.54 A 阶段，ADR-105 §11 / plan-054 A4）。
 *
 * ## 它是干什么的
 *
 * 旧链路（`SessionEventLog` → `events.ndjson` + `FileTraceRecorder` → `events/<run>.jsonl`）
 * **一个字节都不改**；本模块只在旁边多写一份 timeline（`packages/core/src/timeline/**`，
 * 写入侧已冻结）。读路径、协议、UI 全部照旧 —— 这一阶段只证明「新链路写出来的东西和旧链路
 * 一样」，不切换任何读者。
 *
 * ## 四条硬纪律（违反任何一条都应判红，不是「注意一下」）
 *
 * | # | 纪律 | 落点 |
 * | --- | --- | --- |
 * | 1 | 开关关 ⇒ 旁路**一次都不调**（不是「调了再丢弃」） | 装配层：`dual_write: false` 时**不装**端口（`createTimelineDualWrite` 仍可构造，但 `record` 直接返回） |
 * | 2 | 新链路任何失败 ⇒ 只记指标/日志 | `record()` / `endRun()` 返回 void，内部 `catch` 全吞；writer 打不开就把该会话标成 broken，不再重试 |
 * | 3 | 不改旧链路语义 | 本模块不改 `SessionEventLog`、不改 trace、不改事件流的发布顺序；`RunJournal` 在「已发布之后」才调 `record()` |
 * | 4 | 抽样不得影响 run 结果 | `verifySession()` 是纯读 + 一份 `timeline.divergence` 事件；任一步失败只记指标 |
 *
 * ## 为什么在这里而不在 core
 *
 * 一致性抽样要用**尺子**（`scripts/timeline-reference.ts` 的 `loadSessionReference` /
 * `multisetDiff`）。尺子依赖 `apps/web` 的 `payloadDigest`，core 是发布用的库，不能反向
 * 依赖 `scripts/` 与 `apps/`（`scripts/check-deps.ts` D3）。所以装配层（`src/`）是唯一
 * 同时看得到「core 写入侧」与「尺子」的地方。
 *
 * ## 抽样比什么
 *
 * 比 **`(run_id, type, ts, payload_digest)` 多重集**（尺子的口径），不是比 seq（三套 seq
 * 互不映射）。旧源只取**会话日志**那一路（`sources: ['session-log']`）：双写的数据源就是
 * `RunJournal` 的落盘点，与 `events.ndjson` 同源；trace 侧另有一套 trace-only 事件
 * （`hook.*` / `context.changed` / `run.checkpoint` …），它们本来就不经 journal，比进来
 * 只会造出假差异。
 *
 * 差集口径（ADR-105 §8.1 规则 ④）：
 *
 * - `missing` 只要**大于 0** 就是差异（旧链路有、timeline 没有）；
 * - `extra` 只允许 **chunk 家族**（`llm.stream.chunk` 与 `*.llm.stream.chunk`）——
 *   那是旧链路**故意不落盘**的一类，timeline 有它是对的。其它 extra 也算差异。
 *
 * @module vessel/timeline-dual-write
 */

import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger, RunEvent, TimelineDualWriteEvent } from '../packages/core/src/index';
import { atomicWrite, encodeSessionDirName, sessionDirPath } from '../packages/core/src/index';
import { loadIndexSnapshot } from '../packages/core/src/timeline/index';
import {
  CHUNK_FLUSH_MS,
  isChunkEventType,
  isExcludedEventType,
  TIMELINE_LAYOUT,
  type TimelineHeads,
  type TimelineHole,
} from '../packages/core/src/timeline/types';
import {
  readCrcNdjsonFile,
  readHoles,
  readTimelineEvents,
  withCrc,
} from '../packages/core/src/timeline/wal';
import { TimelineWriter } from '../packages/core/src/timeline/writer';
import {
  isTimelineOnlyType,
  loadSessionReference,
  multisetDiff,
  type RefEvent,
  refEventFromRaw,
} from '../scripts/timeline-reference';

/**
 * 进程退出时给 flush 留的上限（ms）。
 *
 * ADR-105 要求「尽力而为，不阻塞退出超过 300ms」：超时就放弃剩余部分（数据已在旧链路里，
 * timeline 少写几条不会让任何读者看到错的东西）。
 */
export const EXIT_FLUSH_BUDGET_MS = 300;

/** 默认抽样率（plan-054 A-2：`0.01` = 1% 的 run 结束比一次）。 */
export const DEFAULT_VERIFY_SAMPLE_RATE = 0.01;

/** 双写指标（只增不减；`record()` 内部这样记，门禁照着断言）。 */
export interface TimelineDualWriteStats {
  /** 成功交给 writer（不保证已经落盘）。 */
  appended: number;
  /** 新链路失败次数（打不开 writer / append 抛错 / 抽样本身抛错）。 */
  failed: number;
  /** 成功打开的 writer 数（= 参与双写的会话数）。 */
  sessions: number;
  /** 打开 writer 失败后被标成 broken 的会话数（不再重试，避免每条事件都撞一遍）。 */
  broken_sessions: number;
  /** 被抽样比对的 run 数。 */
  sampled_runs: number;
  /** 比出差异的 run 数（发过 `timeline.divergence`）。 */
  divergences: number;
}

/** 一次抽样比对的结果（门禁直接读，不做二次解释）。 */
export interface TimelineVerifyResult {
  /** 是否真的比了（时间线空 / 端口关 / 未抽样 ⇒ false）。 */
  compared: boolean;
  missing: number;
  /** 白名单内的 chunk 差集条数（不算差异）。 */
  allowed_extra: number;
  /** 非 chunk 的 extra 条数（算差异）。 */
  unexpected_extra: number;
  missing_types: string[];
  unexpected_extra_types: string[];
}

export interface TimelineDualWriteOptions {
  /** 数据根（尺子读旧源用的口径：`<dataDir>/sessions/<sid>/events.ndjson`）。 */
  dataDir: string;
  /** 会话目录根（`<dataDir>/sessions`）。 */
  sessionsDir: string;
  /** 开关；`false` ⇒ 本对象所有方法都是空操作（装配层还会选择根本不装端口）。 */
  dualWrite: boolean;
  /** chunk 空闲封块间隔；缺省 150（写入侧还会 clamp 到 1..1000）。 */
  chunkFlushMs?: number;
  /** 抽样率 [0,1]；缺省 0.01。`>= 1` 恒抽样，`<= 0` 从不抽样。 */
  verifySampleRate?: number;
  /** 发 `timeline.divergence` 的出口（装配层接 tenant 事件流；抛错被吞）。 */
  emit?: (event: RunEvent) => void;
  logger?: Logger;
  /** 时刻 / 随机数 / writer 构造是**测试缝**：门禁强制造差异时用，生产不传。 */
  now?: () => number;
  random?: () => number;
  openWriter?: (options: {
    sessionId: string;
    sessionDir: string;
    chunkFlushMs: number;
  }) => Promise<TimelineWriter>;
}

/** 对外面（装配层 + 门禁 + `sessions.get.event_cursor`）暴露的双写句柄。 */
export interface TimelineDualWrite {
  /** 开关（`false` 时 `record` / `endRun` 都是空操作）。 */
  readonly enabled: boolean;
  /** 指标快照（副本；调用方随便改）。 */
  stats(): TimelineDualWriteStats;
  /** journal 的旁路入口（实现自吞异常，永不抛）。 */
  record(sessionId: string, event: TimelineDualWriteEvent): void;
  /** journal.close 的旁路入口（fire-and-forget；`finishRun` 是它的可等待版本）。 */
  endRun(sessionId: string, runId: string): void;
  /** flush +（可能）抽样；可等待，门禁用它定序。永不抛。 */
  finishRun(sessionId: string, runId: string): Promise<TimelineVerifyResult | undefined>;
  /** flush 一个会话的 writer（尽力而为）。 */
  flushSession(sessionId: string): Promise<void>;
  /** 关掉全部 writer（≤ `EXIT_FLUSH_BUDGET_MS`；尽力而为）。 */
  closeAll(): Promise<void>;
  /** 进程退出时 flush 一次（`beforeExit`；最多占 300ms）。 */
  installExitFlush(target?: NodeJS.Process): void;
  /**
   * `sessions.get.event_cursor` 的 timeline 四字段。
   *
   * 内存里有 writer ⇒ 直接读它；没有（新进程 / 只读面）⇒ 从 `timeline.idx` + manifest +
   * holes 读；两者都没有 ⇒ `undefined`（**字段缺省**，绝不报假零）。
   */
  heads(sessionId: string): Promise<TimelineHeads | undefined>;
}

/** 会话目录：与旧链路同一条口径（`encodeURIComponent`）。 */
function sessionDirOf(sessionsDir: string, sessionId: string): string {
  return sessionDirPath(sessionsDir, sessionId);
}

/**
 * 打开 writer **之前**先把 `timeline.manifest`（`kind: 'open'`）放好。
 *
 * 为什么必须这么做（这不是可选的洁癖）：`TimelineWriter.open` 的第一条判定是
 * 「有 `events.ndjson`、却没有任何 timeline 标记 ⇒ 旧格式会话 ⇒ `session_frozen_readonly`」
 * （ADR-105 D4：0.54 不做迁移）。而双写发生时旧链路**必然**已经写了 `events.ndjson`
 * —— 不先落标记，每个双写会话第一次打开 writer 都会被判成旧会话。先落的这条标记
 * 表达的就是「这个会话有 timeline 了」这一条事实本身，内容与写入侧 `ensureManifest()`
 * 完全一致（同一份 `withCrc` 行），不是第二套格式。
 *
 * 幂等：文件已存在就直接返回（写入侧自己会在缺失时补）。
 */
async function ensureTimelineMarker(sessionDir: string): Promise<void> {
  const path = join(sessionDir, TIMELINE_LAYOUT.timelineManifest);
  try {
    await stat(path);
    return;
  } catch {
    // 不存在 ⇒ 落一条 open 标记
  }
  await mkdir(sessionDir, { recursive: true });
  const line = withCrc({ v: 1 as const, kind: 'open' as const, at: Date.now() });
  await atomicWrite(path, `${JSON.stringify(line)}\n`, { mode: 0o600, durable: true });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** `timeline.manifest` 里我们关心的一行（只读；写入归 core）。 */
interface ManifestLineLike {
  v: 1;
  kind: string;
  from_seq?: number;
  to_seq?: number;
  at?: number;
  reason?: string;
  crc: string;
}

function validateManifestLine(parsed: unknown): ManifestLineLike | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const line = parsed as Record<string, unknown>;
  if (line.v !== 1 || typeof line.kind !== 'string' || typeof line.crc !== 'string')
    return undefined;
  return line as unknown as ManifestLineLike;
}

/**
 * 从磁盘算 timeline 的两个 head（没有内存 writer 时用）。
 *
 * 口径与写入侧的 `heads()` 一致：`timeline_head` = 已归档到的最大 seq（manifest 的
 * `archive` 行），`wal_head` = 索引里的最大 seq（没有索引就退回全量读记录 —— 索引是
 * 派生数据，删了不能让我报「没有 timeline」）。
 */
async function readHeadsOnDisk(sessionDir: string): Promise<TimelineHeads | undefined> {
  const holes = await readHoles(sessionDir).catch((): TimelineHole[] => []);
  const manifest = await readCrcNdjsonFile<ManifestLineLike>(
    join(sessionDir, TIMELINE_LAYOUT.timelineManifest),
    validateManifestLine,
  ).catch(() => undefined);

  let walHead = 0;
  let hasTimeline = false;
  const snapshot = await loadIndexSnapshot(sessionDir).catch(() => undefined);
  if (snapshot !== undefined) {
    walHead = snapshot.session.last_seq;
    hasTimeline = true;
  } else {
    const records = await readTimelineEvents(sessionDir).catch(() => []);
    for (const record of records) walHead = Math.max(walHead, record.seq);
    hasTimeline = records.length > 0;
  }

  let archivedTo = 0;
  let manifestTainted = false;
  const manifestLines = manifest?.items ?? [];
  for (const line of manifestLines) {
    if (line.kind === 'archive' && typeof line.to_seq === 'number') {
      archivedTo = Math.max(archivedTo, line.to_seq);
    }
    if (line.kind === 'tainted') manifestTainted = true;
  }
  // 注意：缺文件时 `readCrcNdjsonFile` 返回的是「空结果」而不是 `undefined`，
  // 所以「有没有 manifest」只能按**行数**判断（不能按对象是否存在）。
  if (!hasTimeline && manifestLines.length === 0 && holes.length === 0) return undefined;

  return {
    timeline_head: Math.min(archivedTo, walHead),
    wal_head: walHead,
    holes: holes.slice(),
    tainted: holes.length > 0 || manifestTainted,
  };
}

/**
 * 创建一个 tenant 的双写旁路。
 *
 * `dualWrite: false` 时不产生任何磁盘副作用、`record()` 直接返回 —— 这是「开关关」那
 * 一侧的第二道保险（第一道在装配层：根本不把端口交给 `RunJournal`）。
 */
export function createTimelineDualWrite(options: TimelineDualWriteOptions): TimelineDualWrite {
  const enabled = options.dualWrite === true;
  const chunkFlushMs = options.chunkFlushMs ?? CHUNK_FLUSH_MS;
  const rawRate = options.verifySampleRate ?? DEFAULT_VERIFY_SAMPLE_RATE;
  const verifySampleRate = Number.isFinite(rawRate)
    ? Math.min(1, Math.max(0, rawRate))
    : DEFAULT_VERIFY_SAMPLE_RATE;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const openWriter =
    options.openWriter ??
    ((input: { sessionId: string; sessionDir: string; chunkFlushMs: number }) =>
      TimelineWriter.open({
        sessionId: input.sessionId,
        sessionDir: input.sessionDir,
        chunkFlushMs: input.chunkFlushMs,
      }));

  const counters: TimelineDualWriteStats = {
    appended: 0,
    failed: 0,
    sessions: 0,
    broken_sessions: 0,
    sampled_runs: 0,
    divergences: 0,
  };

  /** sessionId → 打开中的 writer（打开失败时 map 里留下 `undefined`，表示已标 broken）。 */
  const writers = new Map<string, Promise<TimelineWriter | undefined>>();
  /**
   * 在飞的双写任务（`record()` 的 fire-and-forget 体）。
   *
   * `flushSession` / `closeAll` / 抽样**必须先等它们**：`record()` 是同步返回的，若不等
   * 在飞任务就 `flush()`，刚派出去的那条还没 `writer.append`，flush 会「什么也没刷」，
   * 抽样就会拿一份缺尾巴的 timeline 去比对 —— 那会造出假差异。
   */
  const inflight = new Set<Promise<void>>();
  /** 已进入抽样队列的 run（`endRun` 与 `finishRun` 可能对同一 run 各调一次）。 */
  const finishedRuns = new Set<string>();
  let exitFlushInstalled = false;

  const warn = (message: string, detail: Record<string, unknown>): void => {
    try {
      options.logger?.warn(message, detail);
    } catch {
      // logger 自己炸了也不能影响调用方
    }
  };

  async function writerFor(sessionId: string): Promise<TimelineWriter | undefined> {
    const existing = writers.get(sessionId);
    if (existing !== undefined) return existing;
    const sessionDir = sessionDirOf(options.sessionsDir, sessionId);
    const opening = (async () => {
      try {
        await ensureTimelineMarker(sessionDir);
        const writer = await openWriter({ sessionId, sessionDir, chunkFlushMs });
        counters.sessions += 1;
        return writer;
      } catch (error) {
        counters.failed += 1;
        counters.broken_sessions += 1;
        warn('timeline dual-write writer open failed (legacy path unaffected)', {
          session_id: sessionId,
          error: errorText(error),
        });
        return undefined;
      }
    })();
    writers.set(sessionId, opening);
    return opening;
  }

  /** 一条事件是否值得进 timeline（旁路的取舍，写在实现侧）。 */
  function shouldWrite(event: TimelineDualWriteEvent): boolean {
    if (isExcludedEventType(event.type)) return false;
    // 抽样告警自身绝不回写 timeline（否则「比对发现差异」会改输入，递归）。
    if (event.type.startsWith('timeline.')) return false;
    // 旧链路没落盘的事件里，只补 chunk 家族（ADR-105 §8.1 规则 ④ 白名单的两条）。
    if (!event.persisted) return isChunkEventType(event.type);
    return true;
  }

  function record(sessionId: string, event: TimelineDualWriteEvent): void {
    if (!enabled) return;
    try {
      if (sessionId.length === 0 || !shouldWrite(event)) return;
      const task = (async () => {
        const writer = await writerFor(sessionId);
        if (writer === undefined) return;
        try {
          await writer.append({
            run_id: event.run_id,
            type: event.type,
            ts: event.ts,
            // 与旧链路**同一个值**（`undefined` 就是「没有 data 字段」，不要改成 null：
            // 那会让两侧的 payload digest 无缘无故不同）。
            data: event.data,
            ...(event.fencing_token !== undefined ? { fencing_token: event.fencing_token } : {}),
          });
          counters.appended += 1;
        } catch (error) {
          counters.failed += 1;
          warn('timeline dual-write append failed (legacy path unaffected)', {
            session_id: sessionId,
            run_id: event.run_id,
            type: event.type,
            error: errorText(error),
          });
        }
      })();
      inflight.add(task);
      void task.finally(() => {
        inflight.delete(task);
      });
    } catch (error) {
      counters.failed += 1;
      warn('timeline dual-write dispatch failed (legacy path unaffected)', {
        session_id: sessionId,
        type: event.type,
        error: errorText(error),
      });
    }
  }

  /** 等所有在飞的双写任务落定（不抛；失败已计入 counters）。 */
  async function drainInflight(): Promise<void> {
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight]);
    }
  }

  async function flushSession(sessionId: string): Promise<void> {
    // 先等派出去的那几条真正 `writer.append()`（否则 flush 会「什么也没刷」）。
    await drainInflight();
    const pending = writers.get(sessionId);
    if (pending === undefined) return;
    try {
      const writer = await pending;
      await writer?.flush();
    } catch (error) {
      counters.failed += 1;
      warn('timeline dual-write flush failed', { session_id: sessionId, error: errorText(error) });
    }
  }

  function shouldSample(): boolean {
    if (verifySampleRate >= 1) return true;
    if (verifySampleRate <= 0) return false;
    try {
      return random() < verifySampleRate;
    } catch {
      return false;
    }
  }

  /**
   * 尺子对拍：`loadSessionReference(sid)`（只取会话日志那一路）vs 该会话 timeline。
   *
   * 纯读：不改 timeline、不改旧日志、不碰 writer 状态（flush 之后只 `readTimelineEvents`）。
   */
  async function verifySession(sessionId: string): Promise<TimelineVerifyResult> {
    const empty: TimelineVerifyResult = {
      compared: false,
      missing: 0,
      allowed_extra: 0,
      unexpected_extra: 0,
      missing_types: [],
      unexpected_extra_types: [],
    };
    await flushSession(sessionId);
    const sessionDir = sessionDirOf(options.sessionsDir, sessionId);
    const records = await readTimelineEvents(sessionDir).catch(() => []);
    // timeline 还不存在（例如 writer 打不开）⇒ 没有可比的东西，不报差异（不制造噪音）。
    if (records.length === 0) return empty;

    const actual: RefEvent[] = [];
    for (const record of records) {
      // 记录形状与旧链路同形（v/seq/session_id/run_id/ts/type/data/crc），尺子直接吃。
      const event = refEventFromRaw({
        run_id: record.run_id,
        type: record.type,
        ts: record.ts,
        data: record.data,
      });
      if (event !== undefined) actual.push(event);
    }
    const expected = await loadSessionReference(sessionId, {
      dataDir: options.dataDir,
      sources: ['session-log'],
    });
    const diff = multisetDiff(expected, actual);
    const unexpectedExtra = diff.extra.filter((event) => !isTimelineOnlyType(event.type));
    const result: TimelineVerifyResult = {
      compared: true,
      missing: diff.missing.length,
      allowed_extra: diff.extra.length - unexpectedExtra.length,
      unexpected_extra: unexpectedExtra.length,
      missing_types: uniqueSorted(diff.missing.map((event) => event.type)),
      unexpected_extra_types: uniqueSorted(unexpectedExtra.map((event) => event.type)),
    };
    return result;
  }

  async function finishRun(
    sessionId: string,
    runId: string,
  ): Promise<TimelineVerifyResult | undefined> {
    if (!enabled) return undefined;
    const key = `${sessionId}\u0000${runId}`;
    if (finishedRuns.has(key)) return undefined;
    finishedRuns.add(key);
    await flushSession(sessionId);
    if (!shouldSample()) return undefined;
    counters.sampled_runs += 1;
    let result: TimelineVerifyResult;
    try {
      result = await verifySession(sessionId);
    } catch (error) {
      counters.failed += 1;
      warn('timeline dual-write verify failed (run result unaffected)', {
        session_id: sessionId,
        run_id: runId,
        error: errorText(error),
      });
      return undefined;
    }
    if (result.compared && (result.missing > 0 || result.unexpected_extra > 0)) {
      counters.divergences += 1;
      // 发 `timeline.divergence`：**additive** 观测事件，不进 timeline 自身（`shouldWrite`）。
      // payload 只带类型/计数/时间戳 —— 不带任何正文，审计事件不携带内容。
      try {
        options.emit?.({
          type: 'timeline.divergence',
          run_id: runId,
          ts: now(),
          data: {
            session_id: sessionId,
            run_id: runId,
            missing_count: result.missing,
            allowed_extra_count: result.allowed_extra,
            unexpected_extra_count: result.unexpected_extra,
            missing_types: result.missing_types,
            unexpected_extra_types: result.unexpected_extra_types,
            verify_sample_rate: verifySampleRate,
            at: now(),
          },
        });
      } catch (error) {
        counters.failed += 1;
        warn('timeline.divergence emit failed', {
          session_id: sessionId,
          run_id: runId,
          error: errorText(error),
        });
      }
    }
    return result;
  }

  function endRun(sessionId: string, runId: string): void {
    if (!enabled) return;
    try {
      void finishRun(sessionId, runId).catch((error: unknown) => {
        counters.failed += 1;
        warn('timeline dual-write endRun failed', {
          session_id: sessionId,
          run_id: runId,
          error: errorText(error),
        });
      });
    } catch (error) {
      counters.failed += 1;
      warn('timeline dual-write endRun dispatch failed', {
        session_id: sessionId,
        error: errorText(error),
      });
    }
  }

  async function closeAll(): Promise<void> {
    await drainInflight();
    const pending = [...writers.values()];
    writers.clear();
    if (pending.length === 0) return;
    const closing = Promise.all(
      pending.map(async (entry) => {
        try {
          const writer = await entry;
          await writer?.close();
        } catch (error) {
          counters.failed += 1;
          warn('timeline dual-write close failed', { error: errorText(error) });
        }
      }),
    );
    await Promise.race([
      closing,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, EXIT_FLUSH_BUDGET_MS);
        // 不 unref：这个 race 的计时器必须能触发，否则退出会等满所有 writer。
        void timer;
      }),
    ]);
  }

  function installExitFlush(target: NodeJS.Process = process): void {
    if (!enabled || exitFlushInstalled) return;
    exitFlushInstalled = true;
    try {
      target.once('beforeExit', () => {
        // beforeExit 里启动的异步工作会让事件循环继续转；`closeAll` 自带 300ms 上限。
        void closeAll();
      });
    } catch {
      // 某些宿主（测试运行器 / 嵌入选装）没有 process.once：放弃退出 flush，不影响功能。
    }
  }

  async function heads(sessionId: string): Promise<TimelineHeads | undefined> {
    // 开关关 ⇒ **四个字段一起缺省**（哪怕磁盘上留着上次开启时写的 timeline）：
    // 「有没有 timeline」不能由旧数据决定，否则关掉开关后 UI 还在报新链路的两指针。
    if (!enabled) return undefined;
    if (sessionId.length === 0) return undefined;
    const pending = writers.get(sessionId);
    if (pending !== undefined) {
      try {
        const writer = await pending;
        if (writer !== undefined) return writer.heads();
      } catch {
        // 落到磁盘口径
      }
    }
    try {
      return await readHeadsOnDisk(sessionDirOf(options.sessionsDir, sessionId));
    } catch {
      return undefined;
    }
  }

  return {
    enabled,
    stats: () => ({ ...counters }),
    record,
    endRun,
    finishRun,
    flushSession,
    closeAll,
    installExitFlush,
    heads,
  };
}

/** 会话目录名（门禁与探针拼路径用；与旧链路同一条 `encodeURIComponent` 口径）。 */
export function timelineSessionDirName(sessionId: string): string {
  return encodeSessionDirName(sessionId);
}
