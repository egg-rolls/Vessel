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
 * ## 五条硬纪律（违反任何一条都应判红，不是「注意一下」）
 *
 * | # | 纪律 | 落点 |
 * | --- | --- | --- |
 * | 1 | 开关关 ⇒ 旁路**一次都不调**（不是「调了再丢弃」） | 装配层：`dual_write: false` 时**不装**端口（`createTimelineDualWrite` 仍可构造，但 `record` 直接返回） |
 * | 2 | 新链路任何失败 ⇒ 只记指标/日志 | `record()` / `endRun()` 返回 void，内部 `catch` 全吞；writer 打不开就把该会话标成 broken，不再重试 |
 * | 3 | 不改旧链路语义（**开关关**时） | `dual_write: false` ⇒ 本模块不装闸门、不传 `publish`、不碰事件流；开关开时旧链路广播降级为发送缓冲（见下节），落盘与 seq 语义仍逐字节不变 |
 * | 4 | 抽样不得影响 run 结果 | `verifySession()` 是纯读 + 一份 `timeline.divergence` 事件；任一步失败只记指标 |
 * | 5 | 归档不上 publish 路径、失败只影响空间回收 | 归档（`timeline_head` 推进）走会话级串行队列 fire-and-forget：`record()` 只 `maybeArchive()` 派发，永不 await；失败 ⇒ `timeline_head` 冻结、`wal_head` 照常、**不写洞**、标 `tainted` |
 *
 * ## 旧格式会话只读冻结（0.54 C1 / ADR-105 D4）——本模块的 adopt 边界
 *
 * 判据**只有一份**：`packages/core/src/timeline/freeze.ts`（有 `<sid>/events.ndjson`、且
 * `timeline.manifest` / `wal.manifest` / `wal.log` 三者皆无）。本模块只负责回答
 * core 问不出来的那半个问题：**「这个会话是不是本进程刚建的？」**
 *
 * 因为 `RunJournal` 是**先写 events.ndjson、再调 `record()`**，所以
 * 「0.53 遗留会话」与「0.54 新会话的第一次双写」在磁盘上**形状完全一样**。分辨只能靠时间：
 * manager 在**构造那一刻**对 `sessionsDir` 做一次快照（哪些会话已经带着日志），于是
 *
 * ```
 * core 说「旧格式」 ∧ 快照说「进程开始之前就在」  ⇒ 冻结：不 adopt、一个字节都不写、
 *                                                 flushSession() 抛 session_frozen_readonly
 * 其它（有标记 / 本进程才出现）                    ⇒ adopt（标记与写入都由写者做）
 * ```
 *
 * 保守方向是硬的：**重启后进程内没有任何登记**，所以「重启前就存在的旧会话」永远不可能被
 * adopt；宁可少 adopt（新链路缺席），绝不解冻（把旧会话写成半新半旧）。
 * 计数见 `stats().frozen_sessions`，与 `broken_sessions`（运行时故障）分开记。
 *
 * ## 发布点：ADR-105 §3 I2 的端到端接线（0.54 B）
 *
 * 写入侧（`packages/core/src/timeline/writer.ts#publishRecord`）只在**该 seq 的 WAL/块 fsync
 * 返回之后**调 `publish`。本模块把它接上，于是「UI 能看见什么」由这条链路决定：
 *
 * ```
 * journal.appendFact → 旧链路落盘 events.ndjson
 *                    → 旧链路广播  ………（闸门扣住，见下）
 *                    → 双写 record() → writer.append() → WAL fsync ✅
 *                                                     → publish(record)
 *                                                     → deliverPublication()
 *                                                        ├ 闸门里有这条被扣住的广播 ⇒ 现在放出（UI 这时才看见）
 *                                                        ├ 已被放出过一次            ⇒ 丢掉（同一条只发一次）
 *                                                        └ 旧链路压根没广播过        ⇒ onPublish() 自己发
 * ```
 *
 * 三个部件（都在本模块里，装配层只负责把 `onPublish` / `publicationGate` 接上）：
 *
 * | 部件 | 干什么 | 失败怎么办 |
 * | --- | --- | --- |
 * | `deliverPublication()` | **唯一**对外发布点：seq 严格递增 + 每条 seq 至多一次 | 订阅方抛错/拒绝一律吞掉、只记 `publishFailed` —— **绝不回滚已 fsync 的数据**（数据已持久，坏的只是「通知」） |
 * | `createTimelineLegacyBroadcastGate()` | 把**旧链路的广播**扣成发送缓冲：事件先入队，等 fsync 之后的 `settle()` 才放出；没被双写认领的（`context.changed` / `run.checkpoint` / `plugin.*` 这类不进 timeline 的事件）在**同一 tick 的微任务**里直通 | 写者打不开 / append 失败 ⇒ 立刻放出（旧链路行为不变）；超时（{@link DEFAULT_BROADCAST_HOLD_TIMEOUT_MS}）兜底放出；退出时 `flushAll()` |
 * | `publishedSeqs` 水位 | 每条 seq 只发一次（写入侧重开、块封块、重复回调都不许让同一条事件到 UI 两次） | —— |
 *
 * **开关关时这三件全不存在**：装配层不建闸门、不包事件流、不传 `onPublish`，写者也没有
 * `publish` ⇒ 旧链路就是唯一发布者，行为与 0.53 逐字节相同（这是默认安装路径）。
 *
 * ## 读面：`heads()` / `readPage()` / `onPublish()`（serve 的三个时间线端口）
 *
 * 同一条 `publish` 的下游还有三个**读侧**出口，serve 的 `timeline.hello` / 时间线 epoch 全靠它们：
 *
 * | 出口 | 对应 serve | 关键口径 |
 * | --- | --- | --- |
 * | `heads()` | `GatewayOptions.timelineHeads` | 对外四字段 **+ `published_head`**（`= writer.publishedHead()`，收紧到 `≤ wal_head`）。纯磁盘口径明确给 `wal_head`，不留 `undefined` 让上层兜底 —— 否则 `timeline.hello.published_head` 恒等于 `wal_head`，崩溃窗口那一段永远声明不出来 |
 * | `readPage()` | `GatewayOptions.timelineRead` | `afterSeq` **排他** / `untilSeq` 含 / 升序 / 去重 / 最多 `limit`（硬顶 {@link TIMELINE_PAGE_MAX}）。事实源是 core 的 `readTimelineEvents`（归档 + 块 + WAL 归并），装配层**只裁窗口**：不跳洞、不补占位、不另造 seq |
 * | `onPublish()` | 实时尾随的帧源 | 每条**放行的** `seq` 一次（含闸门放行旧广播的那些），严格递增、都在 fsync 之后、`seq` 就是 `timeline_seq`（ADR-105 §9 R7：不另造编号）。监听者异常各自隔离 |
 *
 * 「能读什么」由 `readPage` 决定，「能推到哪」由 `published_head` 决定 —— 两者是同一件事的
 * 两半：`count = (min(end_seq, published_head) - start_seq + 1) - Σ|holes ∩ 区间|`，帧只发到
 * `min(end_seq, published_head)`，`(published_head, wal_head]` 永不推送也不写成洞。
 *
 * ## 归档调度（`timeline_head` 为什么会动）
 *
 * 双写只写 `wal.log` + 块，`timeline_head` 要等**归档**才前进（写入侧 `archive()` 把非 chunk
 * 行固化进 `timeline.ndjson` 并落 manifest 指针）。不接线 ⇒ 观察期只会看到 `timeline_head`
 * 恒为 0、`wal_head` 一直涨。三条触发路径：
 *
 * | 触发 | 时机 | 约束 |
 * | --- | --- | --- |
 * | `run_end` | `journal.close()` → `endRun()` → `finishRun()` | 一次 run 一次，不 await |
 * | `periodic` | 每次成功 append 之后 + 一个 `unref` 的 interval 计时器 | 同一会话两次自动归档间隔 ≥ `archiveIntervalMs`（默认 5000ms） |
 * | `explicit` | `archiveSession()`（门禁 / 运维） | 绕过节流与退避，但仍排在同一条串行队列里 |
 *
 * 同一会话任何时刻在飞归档数 ≤ 1（`inFlight` 闸门 + 串行链）；失败计数达到
 * `ARCHIVE_BACKOFF_THRESHOLD`（3）后，自动归档按 100/500/2000ms 退避，成功一次即清零。
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

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  EventStream,
  Logger,
  RunEvent,
  TimelineDualWriteEvent,
} from '../packages/core/src/index';
import { encodeSessionDirName, sessionDirPath } from '../packages/core/src/index';
import { isLegacyFrozenSessionDir, LEGACY_SESSION_LOG } from '../packages/core/src/timeline/freeze';
import { loadIndexSnapshot } from '../packages/core/src/timeline/index';
import {
  CHUNK_FLUSH_MS,
  isChunkEventType,
  isExcludedEventType,
  TIMELINE_LAYOUT,
  TimelineError,
  type TimelineHeads,
  type TimelineHole,
  type TimelineRecord,
} from '../packages/core/src/timeline/types';
import {
  readCrcNdjsonFile,
  readHoles,
  readTimelineEvents,
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

/**
 * 归档周期保底间隔默认值（ms；配置键 `timeline.archive_interval_ms`）。
 *
 * 长 run 期间 `journal.close()` 不会发生，若只靠 run 终态触发，`timeline_head` 会在整个
 * run 期间停在 0 —— 观察期就看不到「归档真的推进」。这个间隔是**上限**（同一会话两次
 * 自动归档之间至少隔这么久），不是「必须等这么久」。
 */
export const DEFAULT_ARCHIVE_INTERVAL_MS = 5_000;

/** 连续归档失败达到该次数后开始退避（ADR-105 §3 I3 ③）。 */
export const ARCHIVE_BACKOFF_THRESHOLD = 3;

/** 退避阶梯（ms）：第 3 / 4 / 5+ 次连续失败后，下一次**自动**归档的最早时刻。 */
export const ARCHIVE_BACKOFF_DELAYS_MS = [100, 500, 2_000] as const;

/**
 * 发送缓冲的兜底上限（ms）：旧链路的广播被闸门扣住之后，最多扣这么久。
 *
 * 正常情况下「扣住」只持续一次 WAL fsync（个位数毫秒；chunk 最多等到封块，ADR-105 §3 I2
 * 给的上界是 `chunk_flush_ms + 50`）。这个常量是**故障兜底**：写者卡住、发布回调丢了、
 * 或者某个事件永远不会进 timeline（生产者 bug）时，宁可晚一点让 UI 看见，也**不许**把旧
 * 链路的事件扣丢。所以它是 fail-open 的定时器，不是「允许发布早于 WAL」的窗口。
 */
export const DEFAULT_BROADCAST_HOLD_TIMEOUT_MS = 5_000;

/** 兜底扫描周期（ms）：只做「扣太久了就放出来」，不参与正常释放路径。 */
const BROADCAST_SWEEP_INTERVAL_MS = 200;

/** 「已放出过的身份」台账上限（防止长跑进程里无界增长）。 */
const BROADCAST_LEDGER_LIMIT = 1_024;

/** 归档触发源（只用于日志/指标口径，不影响语义）。 */
export type TimelineArchiveTrigger = 'periodic' | 'run_end' | 'explicit';

/**
 * 一次**对外发布**（ADR-105 §3 I2）：这条记录所在 seq 的 WAL/块已经 fsync 返回。
 *
 * 它就是「UI 可以看见的事件」这一侧的形状：`seq` 是 timeline seq（会话内持久单调），
 * `data` 与旧链路广播的内容一致（`llm.request` 的正文裁剪只发生在落盘副本上，UI 拿到的
 * 仍是旧链路那份；见下面的闸门）。
 */
export interface TimelinePublication {
  session_id: string;
  seq: number;
  run_id: string;
  type: string;
  ts: number;
  data: unknown;
  fencing_token?: number;
}

/** 发送缓冲闸门的指标（只增不减；全在内存，进程重启归零）。 */
export interface TimelineBroadcastGateStats {
  /** 当前还扣着没放出的广播条数。 */
  held: number;
  /** 因为「timeline 已经 fsync」或「超时/失败兜底」而放出的广播条数。 */
  released: number;
  /** 其中因超出 `holdTimeoutMs` 被兜底放出的条数（正常应为 0）。 */
  timedOut: number;
  /** 被 `settle()` 压掉的**重复**投递次数（同一条事件 UI 只该看见一次）。 */
  dropped: number;
}

/**
 * 发送缓冲闸门（ADR-105 §3 I2 端到端 / §6「发送缓存」的装配层形态）。
 *
 * 装配层拿它把 **event stream 包一层**：`publish` 进来的事件先入队，等双写旁路在
 * **fsync 之后**调 {@link TimelineLegacyBroadcastGate.settle} 时才真正放出去。于是
 * 「UI 什么时候看见一条事实」由 timeline 的持久化决定，而不是由旧链路的广播顺序决定。
 *
 * 三条不含糊的边界：
 *
 * 1. **只扣双写认领的事件**：`record()` 同步调 {@link TimelineLegacyBroadcastGate.claim}
 *    把紧邻的那条广播标成「本次 timeline 拥有」。没被认领的（`context.changed` /
 *    `run.checkpoint` / `session.saved` / `plugin.*` / ask·权限回复 …）在当前 tick 的
 *    微任务里**直通**，行为与今天一致 —— 它们本来就不进 timeline，扣它们只会让 UI 卡住。
 * 2. **fail-open**：写者打不开、append 失败、扣太久、进程退出 ⇒ 一律把扣住的放出去。
 *    旧链路的事件**一条都不会因为双写坏了而消失**（ADR-105 §3 I2 只允许「晚一点看见」，
 *    不允许「看不见」）。
 * 3. **同一个身份只放一次**：放出去过的身份记在一张有界台账里，`settle()` 撞上第二次就
 *    丢掉并记 `dropped` —— 这就是「同一条事件 UI 只看到一次」的落点（超时先放、fsync 后到
 *    的那条序列也能对上）。
 */
export interface TimelineLegacyBroadcastGate {
  /** 包一层事件流：只有 `publish` 走闸门，`subscribe` / `getHistory` / `waitFor` / `clear` 直通。 */
  wrap(stream: EventStream): EventStream;
  /**
   * 认领「刚刚被旧链路广播的那条事件」（由 `record()` **同步**调用）。
   *
   * 用 `(run_id, type, ts)` 认身份：**不含 `data`** —— 落盘副本可能被裁剪
   * （`llm.request` 的正文只留在广播那一份里），比 `data` 会把同一条事件认成两条。
   */
  claim(sessionId: string, event: { run_id: string; type: string; ts: number }): void;
  /**
   * 一条记录已 fsync 并且被发布：放行它对应的那条广播。
   *
   * @returns `true` = 这次发布已经由闸门完成（放出 / 压掉重复），调用方**不要**再发；
   *          `false` = 旧链路从没广播过这条（例如 timeline 独有的 chunk），调用方自己发。
   */
  settle(publication: TimelinePublication): boolean;
  /** 该事件不会再进 timeline（append 失败）：立刻放行，旧链路行为不变。 */
  release(input: { session_id: string; run_id: string; type: string; ts: number }): void;
  /** 该会话的 writer 打不开：放行它扣住的一切，并把会话标成 broken（此后不再认领）。 */
  releaseSession(sessionId: string): void;
  /** 进程退出 / 关闭：把扣住的全部放出去（尽力而为，永不抛）。 */
  flushAll(): void;
  stats(): TimelineBroadcastGateStats;
}

/**
 * 一次归档失败的上报体（`onArchiveFailed` 的实参）。
 *
 * 与写入侧 `TimelineWriterOptions.onArchiveFailed` 同源，但**多带**会话、连续失败次数与
 * 退避时长 —— 后者只有调度侧知道。
 */
export interface TimelineArchiveFailure {
  session_id: string;
  from_seq: number;
  to_seq: number;
  reason: string;
  /** 连续失败次数（含本次；成功一次即归零）。 */
  consecutive: number;
  /** 本次失败后加给下一次**自动**归档的退避（ms；未到阈值 ⇒ 0）。 */
  backoff_ms: number;
  trigger: TimelineArchiveTrigger;
}

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
  /** **真的推进了指针**的归档次数（`from_seq <= to_seq`；无事可做的不计）。 */
  archiveCount: number;
  /** 归档失败次数（写入侧 3 次重试全部失败后才计一次 —— 只影响空间回收）。 */
  archiveFailed: number;
  /** 最近一次成功归档的时刻（ms；从未成功 ⇒ 0）。 */
  lastArchiveAt: number;
  /** 已**对外发布**的记录条数（= fsync 之后被放行的事件数；I2 端到端的计数器）。 */
  published: number;
  /** 被 seq 水位压掉的重复发布次数（同一条事件第二次到发布点 ⇒ 丢弃）。 */
  publishDeduped: number;
  /** 发布通道失败次数（`onPublish` 抛错/拒绝；数据已持久，只记不影响落盘）。 */
  publishFailed: number;
  /**
   * 因「旧格式会话只读冻结」而**跳过双写**的会话数（ADR-105 D4 / 0.54 C1）。
   *
   * 这不是失败：旧链路照常写、读路径一字节不变，只是新链路不 adopt 这个会话。
   * 与 `broken_sessions` 分开计数，是因为两者的用户可见后果完全不同：
   * 「写者坏了」是运行时故障（下一轮可恢复），「冻结」是**不该写**（永远不该）。
   */
  frozen_sessions: number;
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
  /**
   * 归档周期保底间隔（ms）；缺省 {@link DEFAULT_ARCHIVE_INTERVAL_MS}（5000）。
   *
   * `<= 0` ⇒ 关掉周期保底（只剩 run 终态 / 显式 `archiveSession()` 两条触发路径，
   * 门禁要确定性时用）。
   */
  archiveIntervalMs?: number;
  /**
   * 归档失败通知（ADR-105 §3 I3 ③）。写入侧 3 次重试都失败后才发一次；
   * 抛错被吞（通知通道坏了不能反过来影响归档调度）。
   */
  onArchiveFailed?: (info: TimelineArchiveFailure) => void;
  /** 发 `timeline.divergence` 的出口（装配层接 tenant 事件流；抛错被吞）。 */
  emit?: (event: RunEvent) => void;
  /**
   * **唯一的对外发布出口**（ADR-105 §3 I2）：写者在 WAL/块 fsync 之后回调它。
   *
   * 装配层接成 `events.publish(...)`（见 `tenant-runtime-factory`）。约束：
   *
   * - 抛错 / 返回被拒绝的 Promise **一律被吞掉**（只记 `publishFailed` + 一条 warn）：
   *   数据已经持久，坏掉的只是「通知」通道，不许因此回滚、也不许让 append 失败；
   * - 调用时该 `seq` 已 ≤ `wal_head`（写者保证），并且每条 `seq` 至多调一次（本模块保证）。
   */
  onPublish?: (publication: TimelinePublication) => void | Promise<void>;
  /**
   * 发送缓冲闸门（可选；装配层在双写开启时装上，见 {@link TimelineLegacyBroadcastGate}）。
   *
   * 装了它 ⇒ 旧链路广播由闸门扣住，`onPublish` 只在「旧链路没广播过这条」时才会被调用
   * （绝大多数事件是闸门放行旧广播，避免同一条事件出现两次）。不装 ⇒ 每条记录都走
   * `onPublish`（门禁 / 探针的口径）。
   */
  publicationGate?: TimelineLegacyBroadcastGate;
  logger?: Logger;
  /** 时刻 / 随机数 / writer 构造是**测试缝**：门禁强制造差异时用，生产不传。 */
  now?: () => number;
  random?: () => number;
  /**
   * writer 构造缝：`publish` 由本模块传入（**不许**自己另接一条发布路径，否则 I2 就绕过了）。
   *
   * 自定义实现必须把它原样交给 `TimelineWriter.open({... publish})`；典型的测试缝只在
   * `beforeSync` 上做手脚（见 `scripts/check-timeline-archive.ts`）。
   */
  openWriter?: (options: {
    sessionId: string;
    sessionDir: string;
    chunkFlushMs: number;
    publish: (record: TimelineRecord) => void;
    /**
     * 透传给 `TimelineWriter.open` 的**显式 adopt 断言**（见写者侧的说明）。
     *
     * 自定义实现**应当原样转发**（与 `publish` 同一条纪律）：不转发时本模块会先用一个
     * 一次性 writer 把标记落好再调你（结果一样，只是多一次 open）。
     */
    adoptLegacyShapedSession?: boolean;
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
  /**
   * 显式归档一次并等它结束（门禁 / 运维入口；永不抛）。
   *
   * 与自动触发的关系：显式调用**绕过**周期节流与退避闸门（调用方是故意要它现在跑），
   * 但仍走该会话的同一条串行队列 —— 同一会话任何时刻在飞归档数 ≤ 1。
   */
  archiveSession(sessionId: string): Promise<void>;
  /** 等所有在飞归档落定（门禁定序用；永不抛）。 */
  drainArchives(): Promise<void>;
  /** 关掉全部 writer（≤ `EXIT_FLUSH_BUDGET_MS`；尽力而为）。 */
  closeAll(): Promise<void>;
  /** 进程退出时 flush 一次（`beforeExit`；最多占 300ms）。 */
  installExitFlush(target?: NodeJS.Process): void;
  /**
   * `sessions.get.event_cursor` 的 timeline 四字段 **+ `published_head`**。
   *
   * 内存里有 writer ⇒ 直接读它；没有（新进程 / 只读面）⇒ 从 `timeline.idx` + manifest +
   * holes 读；两者都没有 ⇒ `undefined`（**字段缺省**，绝不报假零）。
   *
   * `published_head`（0.54 B/C 交界，pub-i2）：**一定被发布过**的最大 seq。写者的
   * `heads()` 只报对外四字段，`publishedHead()` 是另一个方法，所以必须在这里显式透传
   * —— 不透传时 `timeline.hello.published_head` 会被上游按 `wal_head` 兜底，
   * 「崩溃窗口里 `(published_head, wal_head]` 允许不被推送」这条声明就永远发不出来
   * （ADR-105 §3 I2 的唯一残余缺口）。
   */
  heads(sessionId: string): Promise<TimelineHeadsView | undefined>;
  /**
   * 时间线**分页读**（`packages/serve` 的 `timelineRead` 端口，0.54 B1/C）。
   *
   * `afterSeq` **排他**（只回 `seq > afterSeq`）、`untilSeq` 含、按 `seq` 升序、去重、
   * 最多 `limit` 条（硬顶 `TIMELINE_PAGE_MAX`）。读面用 core 的 `readTimelineEvents`
   * （归档 + 块 + WAL 三处归并、按 seq 去重、外置 blob 取回），装配层只做窗口裁剪 ——
   * 不拼第二套编号、不猜洞（洞是**声明**，由 `heads().holes` 报；读不到就是读不到）。
   */
  readPage(sessionId: string, options: TimelinePageQuery): Promise<readonly TimelinePageEvent[]>;
  /**
   * 订阅**发布点**（ADR-105 §3 I2 / §9 R7）：写者在 WAL/块 fsync 之后放行的每一条记录。
   *
   * 帧的 `seq` **就是** `timeline_seq`（不许另造），严格递增、每条至多一次 —— 与
   * `deliverPublication` 的 seq 水位同一套口径。serve 的时间线 epoch 应当拿它当实时尾随
   * 的帧源；`deliverPublication` 是同步调监听者的，所以监听者**必须**自己 try/catch
   * （本模块也兜了一层，异常不影响落盘）。
   *
   * 返回取消订阅函数（幂等）。
   */
  onPublish(listener: (publication: TimelinePublication) => void): () => void;
}

/**
 * `heads()` 的返回：对外四字段 + `published_head`（可结构类型直接喂给
 * `SessionTimelineHeadsPort.lookup`）。
 */
export interface TimelineHeadsView extends TimelineHeads {
  /**
   * **一定被发布过**的最大 seq（`<= wal_head`）。
   *
   * `published_head < wal_head` ⇒ `(published_head, wal_head]` 是「本进程里还没被放行」的
   * 尾部：它可能可读（页缓存里活下来了），但**从未**对外发布，客户端不得据它报
   * `timeline.gap_reported`，也不许算进期望条数（ADR-105 §9 R4 的语义分工）。
   */
  published_head: number;
}

/** `readPage` 的查询窗口（`afterSeq` 排他、`untilSeq` 含、`limit` 硬顶见端口实现）。 */
export interface TimelinePageQuery {
  afterSeq: number;
  untilSeq?: number;
  limit?: number;
}

/**
 * 时间线线上事件（与 `packages/serve/src/gateway/timeline-protocol.ts#TimelineWireEvent`
 * 同形；这里的结构类型对齐，不 import serve）。
 */
export interface TimelinePageEvent {
  seq: number;
  type: string;
  ts: number;
  run_id?: string;
  data?: unknown;
}

/** `readPage` 的单页硬顶（与 serve 的 `TIMELINE_PAGE_LIMIT` 同值；调用方可以更小）。 */
export const TIMELINE_PAGE_MAX = 500;

/**
 * 实时尾随的一条（`readPage` 的事件体 **+ `session_id`**）。
 *
 * 为什么要多一个 `session_id`：`readPage` 是「按会话读」，会话由入参给出；而发布点扇出是
 * **进程/租户级**的，serve 必须自己按连接的 `session_id` 过滤（见 `timelineTailPort`）。
 */
export interface TimelineTailEvent extends TimelinePageEvent {
  session_id: string;
}

/** 会话目录：与旧链路同一条口径（`encodeURIComponent`）。 */
function sessionDirOf(sessionsDir: string, sessionId: string): string {
  return sessionDirPath(sessionsDir, sessionId);
}

/**
 * 「本进程开始**之前**就已经带着 `events.ndjson` 的会话」——旧格式的唯一可分辨证据。
 *
 * ## 为什么需要它（而不是直接看目录形状）
 *
 * `packages/core/src/timeline/freeze.ts` 的判据是「有 `events.ndjson` 且无任何 timeline
 * 标记」。而 `RunJournal` 是**先写 `events.ndjson`、再调 `record()`** 的，所以：
 *
 * ```
 * 0.53 遗留会话           ：events.ndjson ✓、标记 ✗   ⇒ 旧格式（必须冻结）
 * 0.54 新会话的第一次双写 ：events.ndjson ✓、标记 ✗   ⇒ **形状一模一样**
 * ```
 *
 * 光看形状两边不可分辨。能分辨的只有**时间先后**：「这个目录在本进程创建这个 manager
 * 之前就有日志了吗」——有 ⇒ 不是本进程生的 ⇒ 旧格式；没有 ⇒ 本进程生的 ⇒ 可以 adopt。
 *
 * ## 为什么用「构造时快照」而不是「登记 sessions.create」
 *
 * 1. **不依赖任何创建入口**：`sessions.create` / CLI 起 run / 种子消息 / 子会话 / 重启续跑
 *    都走同一条 `SessionEventLog.append`，登记点漏一个就静默不 adopt（且很难发现）；
 *    快照只看盘，天然覆盖所有入口。
 * 2. **保守方向是硬的**：快照在**构造那一刻**取，所以「本进程之前就存在」一律判旧格式
 *    ——重启后进程内没有任何登记，也就永远不可能 adopt 一个重启前就存在的旧会话；
 *    这正是 ADR-105 D4 要的方向（宁可少 adopt，绝不解冻）。
 * 3. 代价只有构造时的一次 `readdir` + 每个既有会话一次 `stat`（异步、不阻塞）。
 *
 * 注意：**它不参与冻结判定** —— 冻结判据只有 `freeze.ts` 一份。这里只回答
 * 「能不能把这条 `freeze.ts` 的『旧格式』结论当成本进程不该 adopt 的会话」。
 */
function createPreexistingSessionSnapshot(sessionsDir: string): () => Promise<Set<string>> {
  const snapshot = (async (): Promise<Set<string>> => {
    const withLog = new Set<string>();
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await readdir(sessionsDir, { withFileTypes: true });
    } catch {
      // 目录还不存在 ⇒ 没有任何既有会话（全新安装）
      return withLog;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await stat(join(sessionsDir, entry.name, LEGACY_SESSION_LOG));
      } catch {
        continue; // 目录在、但还没写过日志 ⇒ 不算「带着日志存在过」
      }
      withLog.add(entry.name);
    }
    return withLog;
  })();
  return () => snapshot;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** 事件身份（旧链路广播 ↔ timeline 记录的共同键）：**不含 `data`**（落盘副本可能被裁剪）。 */
function broadcastKeyOf(parts: { run_id: string; type: string; ts: number }): string {
  return `${parts.run_id}\u0000${parts.type}\u0000${parts.ts}`;
}

/**
 * 创建发送缓冲闸门（ADR-105 §3 I2 / §6「发送缓存」；装配层只在双写开启时装它）。
 *
 * 语义全在 {@link TimelineLegacyBroadcastGate} 的文档里，这里只写清三处实现取舍：
 *
 * 1. **认领靠「同一个 tick」**：`RunJournal` 是 `publishRaw(event)` 之后**同步**调
 *    `record()` 的（`run-journal.ts:334-347`），所以「入队 → `claim()`」之间没有 await。
 *    没被认领的入队项在**微任务**里直通 —— 于是「不归 timeline 管的事件」最多多等一个
 *    微任务，不会因为闸门而卡住（ask / 权限回复这条链就靠它保证不被扣）。
 * 2. **放行是 fail-open**：`releaseSession` / `release` / `flushAll` / 超时扫描一律直接把
 *    扣住的旧广播发出去。旧链路的事件只会「晚一点」到 UI，不会消失。
 * 3. **先放过的身份留痕**：超时兜底先放出去的条目，等它的 fsync 尾巴后到时会撞上台账，
 *    被 `settle()` 压掉（记 `dropped`）—— 这就是「同一条事件 UI 只看到一次」。
 */
export function createTimelineLegacyBroadcastGate(options?: {
  logger?: Logger;
  /** 兜底上限（ms）；缺省 {@link DEFAULT_BROADCAST_HOLD_TIMEOUT_MS}。 */
  holdTimeoutMs?: number;
  now?: () => number;
}): TimelineLegacyBroadcastGate {
  const rawHold = options?.holdTimeoutMs;
  const holdTimeoutMs =
    typeof rawHold === 'number' && Number.isFinite(rawHold) && rawHold >= 0
      ? rawHold
      : DEFAULT_BROADCAST_HOLD_TIMEOUT_MS;
  const now = options?.now ?? (() => Date.now());

  const warn = (message: string, detail: Record<string, unknown>): void => {
    try {
      options?.logger?.warn(message, detail);
    } catch {
      // 日志通道自己炸了也不能反过来影响发布
    }
  };

  interface HeldBroadcast {
    event: RunEvent;
    key: string;
    /** 认领它的会话；`undefined` = 还没认领（微任务里直通）。 */
    sessionId?: string;
    at: number;
  }

  /** 扣住中的广播（FIFO；放行时可以中间抽走，跨会话的先后不作为语义）。 */
  const queue: HeldBroadcast[] = [];
  /** 已放出去过的身份计数（有界；`settle()` 用它压掉重复投递）。 */
  const delivered = new Map<string, number>();
  /** 写者打不开的会话：此后不再认领（事件直通，等价今天的旧链路）。 */
  const brokenSessions = new Set<string>();
  let raw: EventStream | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let flushScheduled = false;
  let released = 0;
  let timedOut = 0;
  let dropped = 0;

  function noteDelivered(key: string): void {
    const next = (delivered.get(key) ?? 0) + 1;
    delivered.delete(key);
    delivered.set(key, next);
    while (delivered.size > BROADCAST_LEDGER_LIMIT) {
      const oldest = delivered.keys().next();
      if (oldest.done === true) break;
      delivered.delete(oldest.value);
    }
  }

  /** 真正交给旧链路的下游（底层事件流自己会 try/catch 订阅者异常）。 */
  function emit(event: RunEvent): void {
    released += 1;
    noteDelivered(broadcastKeyOf(event));
    try {
      raw?.publish(event);
    } catch (error) {
      warn('legacy broadcast forward failed', {
        run_id: event.run_id,
        type: event.type,
        error: errorText(error),
      });
    }
  }

  function takeIndexOf(predicate: (entry: HeldBroadcast) => boolean): number {
    for (let index = 0; index < queue.length; index += 1) {
      const entry = queue[index];
      if (entry !== undefined && predicate(entry)) return index;
    }
    return -1;
  }

  function releaseAt(index: number): boolean {
    const entry = queue[index];
    if (entry === undefined) return false;
    queue.splice(index, 1);
    emit(entry.event);
    return true;
  }

  /** 把当前扣住的全部放出去（`clear()` / 退出路径；不停止兜底扫描）。 */
  function releaseAllHeld(): void {
    for (const entry of [...queue]) releaseAt(queue.indexOf(entry));
  }

  /** 微任务：把「没被双写认领」的入队项直通（不归 timeline 管的事件不能扣）。 */
  function scheduleFlushUnclaimed(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      try {
        for (const entry of [...queue]) {
          if (entry.sessionId !== undefined) continue;
          releaseAt(queue.indexOf(entry));
        }
      } catch (error) {
        warn('legacy broadcast gate flush failed', { error: errorText(error) });
      }
    });
  }

  function ensureSweep(): void {
    if (sweepTimer !== undefined || holdTimeoutMs <= 0) return;
    sweepTimer = setInterval(
      () => {
        try {
          const at = now();
          for (const entry of [...queue]) {
            if (at - entry.at < holdTimeoutMs) continue;
            timedOut += 1;
            releaseAt(queue.indexOf(entry));
          }
        } catch (error) {
          warn('legacy broadcast gate sweep failed', { error: errorText(error) });
        }
      },
      Math.max(25, Math.min(BROADCAST_SWEEP_INTERVAL_MS, holdTimeoutMs)),
    );
    const handle = sweepTimer as unknown as { unref?: () => void };
    try {
      handle.unref?.();
    } catch {
      // 宿主没有 unref：计时器仍可用（最多让进程多等一个周期）。
    }
  }

  function stopSweep(): void {
    if (sweepTimer === undefined) return;
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }

  const gate: TimelineLegacyBroadcastGate = {
    wrap(stream) {
      raw = stream;
      ensureSweep();
      return {
        subscribe: (handler) => stream.subscribe(handler),
        publish: (event) => {
          queue.push({ event, key: broadcastKeyOf(event), at: now() });
          scheduleFlushUnclaimed();
        },
        clear: () => {
          // 「清历史」之前先把扣着的放出去：它们已经被旧链路广播过，不能因为清历史丢掉。
          // 只放行、不停止兜底扫描 —— `clear()` 不是退出路径，闸门之后还要能兜住。
          releaseAllHeld();
          stream.clear();
        },
        getHistory: (runId) =>
          runId === undefined ? stream.getHistory() : stream.getHistory(runId),
        waitFor: (name, opts) => stream.waitFor(name, opts),
      };
    },

    claim(sessionId, event) {
      if (raw === undefined || sessionId.length === 0) return;
      if (brokenSessions.has(sessionId)) return;
      const key = broadcastKeyOf(event);
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const entry = queue[index];
        if (entry === undefined || entry.sessionId !== undefined) continue;
        if (entry.key !== key) continue;
        entry.sessionId = sessionId;
        return;
      }
    },

    settle(publication) {
      const key = broadcastKeyOf(publication);
      const index = takeIndexOf((entry) => entry.sessionId !== undefined && entry.key === key);
      if (index >= 0) {
        // 这一次发布就是那条旧广播：现在（fsync 之后）才让 UI 看见它。
        releaseAt(index);
        return true;
      }
      const seen = delivered.get(key) ?? 0;
      if (seen > 0) {
        // 已经放出去过一次（超时兜底 / 直通）⇒ 压掉，同一条事件不许第二次到 UI。
        if (seen === 1) delivered.delete(key);
        else delivered.set(key, seen - 1);
        dropped += 1;
        return true;
      }
      return false;
    },

    release(input) {
      const key = broadcastKeyOf(input);
      const index = takeIndexOf((entry) => entry.sessionId !== undefined && entry.key === key);
      if (index >= 0) releaseAt(index);
    },

    releaseSession(sessionId) {
      brokenSessions.add(sessionId);
      for (const entry of [...queue]) {
        if (entry.sessionId !== sessionId) continue;
        releaseAt(queue.indexOf(entry));
      }
    },

    flushAll() {
      releaseAllHeld();
      stopSweep();
    },

    stats() {
      return { held: queue.length, released, timedOut, dropped };
    },
  };

  return gate;
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
  const archiveIntervalMs = (() => {
    const raw = options.archiveIntervalMs;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_ARCHIVE_INTERVAL_MS;
    return Math.max(raw, 0);
  })();
  const openWriter =
    options.openWriter ??
    ((input: {
      sessionId: string;
      sessionDir: string;
      chunkFlushMs: number;
      publish: (record: TimelineRecord) => void;
      adoptLegacyShapedSession?: boolean;
    }) =>
      TimelineWriter.open({
        sessionId: input.sessionId,
        sessionDir: input.sessionDir,
        chunkFlushMs: input.chunkFlushMs,
        // ADR-105 §3 I2 的端到端接线：**必须**把发布回调交给写者。
        // 写者只在「该 seq 的 WAL/块 fsync 返回之后」调它，所以它是唯一合规的发布点。
        publish: input.publish,
        // 显式 adopt 断言（ADR-105 D4 / 0.54 C1）：只有「core 判形状像旧格式 ∧ 本进程
        // 才出现」时才会是 true。标记仍然由写者落 —— 本模块不写 timeline 目录已经很久了。
        ...(input.adoptLegacyShapedSession === true ? { adoptLegacyShapedSession: true } : {}),
      }));

  /**
   * 自定义 `openWriter` 缝（门禁/探针）没转发 `adoptLegacyShapedSession` 时，
   * 先让**写者**把标记落好，再让缝打开。
   *
   * 为什么要这一步：adopt 断言的语义是「跳过写者自己的冻结闸门」，它必须由打开写者的
   * 那个人传下去。缝是别人的代码，未必认识这个新字段（现有门禁的缝就只转发 `publish`）。
   * 而**标记只能由写者落**（`TimelineWriter.open` 的 `ensureManifest()`），所以这里用一个
   * 一次性 writer 走一遍合法的初始化 —— 装配层依旧一个字节都不直接写 timeline 目录。
   *
   * 两条纪律：
   * - **`publish` 必须一样接上**（I2 硬断言「每一个 `TimelineWriter.open` 都传 publish」；
   *   这条 writer 不 append 任何记录，正常情况下一次都不会触发，但通道不能留洞）；
   * - 只对自定义缝、只在本进程刚建的会话上做，且只做一次（`writers` 缓存）。
   *
   * 缝**应当**原样转发 `adoptLegacyShapedSession`（与 `publish` 同一条纪律）；都转发之后
   * 这一步就变成多余的 —— 那时可以直接删掉它。
   */
  const customWriterSeam = options.openWriter !== undefined;
  async function primeAdoptedWriter(sessionId: string, sessionDir: string): Promise<void> {
    const priming = await TimelineWriter.open({
      sessionId,
      sessionDir,
      chunkFlushMs,
      publish: (record) => deliverPublication(sessionId, record),
      adoptLegacyShapedSession: true,
    });
    await priming.close();
  }

  const counters: TimelineDualWriteStats = {
    appended: 0,
    failed: 0,
    sessions: 0,
    broken_sessions: 0,
    sampled_runs: 0,
    divergences: 0,
    archiveCount: 0,
    archiveFailed: 0,
    lastArchiveAt: 0,
    published: 0,
    publishDeduped: 0,
    publishFailed: 0,
    frozen_sessions: 0,
  };

  /** 发送缓冲闸门（装配层装了才有；不装 ⇒ 每条记录直接走 `onPublish`）。 */
  const gate = options.publicationGate;
  /**
   * 每个会话已发布到哪（I2 的「同一条 seq 只发一次」水位）。
   *
   * 写入侧本来就只在 fsync 之后、且按 seq 递增调 `publish`；这里再压一道是因为「闸门
   * 放行」与「`onPublish` 转发」是两条路，任何一条重复调用都不许让 UI 看见两次同一 seq。
   */
  const publishedSeqs = new Map<string, number>();
  /**
   * 发布点的进程内订阅者（实时尾随的帧源；`deliverPublication` 放行之后同步回调）。
   *
   * 与 `options.onPublish` 的分工：`onPublish` 是**装配层**把它投进事件流的出口；
   * 这里是**进程内**的扇出（serve 的时间线 epoch 要的就是「fsync 之后、seq =
   * timeline_seq」这一串，而不是再进一遍事件流）。两者都在 seq 水位之后，都不会重复。
   */
  const publishListeners = new Set<(publication: TimelinePublication) => void>();
  /**
   * 「本进程开始之前就带着 `events.ndjson` 的会话」快照（构造那一刻取，见
   * {@link createPreexistingSessionSnapshot}）。它只用来解释 `freeze.ts` 的结论：
   * 「旧格式 + 本进程之前就在」⇒ 这个会话不是本进程生的 ⇒ **不 adopt**。
   */
  const preexistingSessions = createPreexistingSessionSnapshot(options.sessionsDir);
  /**
   * 被判定为「旧格式 ⇒ 只读冻结」的会话（本进程内已裁决过，不再重复判、也不再试写）。
   *
   * 命中它的会话：`record()` 一个字节都不写、`flushSession()` 抛 `session_frozen_readonly`、
   * 生命周期钩子（`endRun` / 抽样）安静跳过 —— 旧链路与读路径完全不受影响。
   */
  const frozenSessions = new Set<string>();

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

  /**
   * 会话级归档调度状态（ADR-105 §3 I3 的调度侧）。
   *
   * `chain` 是**同一会话**的串行队列：`archive()` 只能一个一个跑，门禁 ④ 用外部计数器
   * 断言「同一时刻在飞归档数 ≤ 1」。
   */
  interface ArchiveState {
    /** 串行队列尾；每个归档都挂在它后面（前一个失败也不断链）。 */
    chain: Promise<void>;
    /** 当前在飞归档数（同一会话恒 ≤ 1；用来挡住排队的堆积）。 */
    inFlight: number;
    /** 上次**自动**派发时刻（周期节流的起点；显式调用也刷新它）。 */
    lastDispatchAt: number;
    /** 连续失败次数（成功一次归零）。 */
    consecutiveFailures: number;
    /** 退避闸门：早于该时刻**自动**归档一律跳过。 */
    nextAllowedAt: number;
    /** 失败之后成功过一次 ⇒ 归档污点可清除（ADR I3「保留 tainted 直到成功一次」）。 */
    recovered: boolean;
  }
  const archiveStates = new Map<string, ArchiveState>();
  /** 在飞的归档任务（`drainArchives` / `closeAll` 必须等它们）。 */
  const archiveTasks = new Set<Promise<void>>();
  let archiveTimer: ReturnType<typeof setInterval> | undefined;

  function archiveStateOf(sessionId: string): ArchiveState {
    let state = archiveStates.get(sessionId);
    if (state === undefined) {
      state = {
        chain: Promise.resolve(),
        inFlight: 0,
        lastDispatchAt: 0,
        consecutiveFailures: 0,
        nextAllowedAt: 0,
        recovered: false,
      };
      archiveStates.set(sessionId, state);
    }
    return state;
  }

  const warn = (message: string, detail: Record<string, unknown>): void => {
    try {
      options.logger?.warn(message, detail);
    } catch {
      // logger 自己炸了也不能影响调用方
    }
  };

  /**
   * 这个会话在本进程里该怎么处理：`frozen`（旧格式只读）/ `adopt`（本进程刚建）/ `plain`（照常）。
   *
   * - **形状**只有一处判据：`isLegacyFrozenSessionDir`（core `freeze.ts`）；
   * - **时间**只有一个来源：`preexistingSessions`（manager 构造那一刻的快照）。
   *
   * ```
   * core 说「旧格式」      ∧ 快照说「本进程开始之前就在」  ⇒ frozen
   * 快照说「本进程才出现」                                  ⇒ adopt（向写者下断言，标记仍由写者落）
   * 其它（有标记的既有 0.54 会话）                          ⇒ plain（写者自己会放行）
   * ```
   *
   * 为什么 `adopt` 只看时间、不再叠「core 判旧格式」：第一条事件的 `record()` 与
   * `events.ndjson` 的落盘是**并发**的（`RunJournal` 侧 fire-and-forget），所以
   * 「此刻形状像不像旧格式」随时会变 —— 拿它当 adopt 条件会漏掉「判的时候文件还没落、
   * 写者打开时文件已经在了」这一窗口（实测：`check-timeline-dualwrite` 掉 13 条）。
   * 形状该由**写者**在自己 open 的那一刻问 `freeze.ts`；装配层只提供它问不出来的时间事实。
   *
   * 为什么不能只看形状（不叠时间）：0.54 新会话的第一次双写形状与 0.53 遗留会话完全一样
   * （有 `events.ndjson`、无标记）—— 只看形状会把每个新会话判死（双写全灭，实测掉 8 条）。
   */
  async function decideAdoption(
    sessionId: string,
    sessionDir: string,
  ): Promise<'frozen' | 'adopt' | 'plain'> {
    const preexisting = (await preexistingSessions()).has(encodeSessionDirName(sessionId));
    if (preexisting) {
      // 既有会话：形状由 core 判；形状是旧格式 ⇒ 冻结（本进程之前就存在，不可能是新会话）。
      return (await isLegacyFrozenSessionDir(sessionDir)) ? 'frozen' : 'plain';
    }
    // 本进程才出现的会话：断言「是我建的」——写者据此跳过冻结闸门，标记仍由写者落。
    return 'adopt';
  }

  async function writerFor(sessionId: string): Promise<TimelineWriter | undefined> {
    const existing = writers.get(sessionId);
    if (existing !== undefined) return existing;
    const sessionDir = sessionDirOf(options.sessionsDir, sessionId);
    const opening = (async () => {
      try {
        // 0.54 C1（ADR-105 D4）：旧格式会话**只读冻结** —— 不 adopt、不写一个字节、不抛。
        const decision = await decideAdoption(sessionId, sessionDir);
        if (decision === 'frozen') {
          counters.frozen_sessions += 1;
          frozenSessions.add(sessionId);
          warn('timeline dual-write skipped (legacy session is frozen read-only)', {
            session_id: sessionId,
            reason: 'legacy_events_ndjson_without_timeline_marker',
          });
          // 这个会话不会再有 timeline 发布了 ⇒ 把闸门扣住的旧广播立刻放出去
          // （旧链路行为不变：UI 一条都不少）。
          gate?.releaseSession(sessionId);
          return undefined;
        }
        // 本进程刚建的会话 ⇒ 向写者下 adopt 断言（标记仍由写者落，本模块一个字节都不写
        // timeline 目录）。既有会话不传，写者按 `freeze.ts` 自己判。
        const adopt = decision === 'adopt';
        if (adopt && customWriterSeam) await primeAdoptedWriter(sessionId, sessionDir);
        const writer = await openWriter({
          sessionId,
          sessionDir,
          chunkFlushMs,
          publish: (record) => deliverPublication(sessionId, record),
          ...(adopt ? { adoptLegacyShapedSession: true } : {}),
        });
        counters.sessions += 1;
        // 周期保底：writer 出现的第一刻起开计时（长 run 期间也要有归档）。
        ensureArchiveTimer();
        return writer;
      } catch (error) {
        counters.failed += 1;
        counters.broken_sessions += 1;
        warn('timeline dual-write writer open failed (legacy path unaffected)', {
          session_id: sessionId,
          error: errorText(error),
        });
        // 这个会话不会再有 timeline 发布了 ⇒ 把它扣住的旧广播立刻放出去
        // （旧链路行为不变：UI 一条都不少，只是不再等一条永远不会来的 fsync）。
        gate?.releaseSession(sessionId);
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

  /**
   * 把一条发布扇出给进程内订阅者（实时尾随）。**每个监听者自己隔离**：一个监听者抛错
   * 不许拖累其它监听者，更不许冒泡进写者（那会把已 fsync 的 append 变成失败）。
   */
  function notifyPublishListeners(publication: TimelinePublication): void {
    for (const listener of [...publishListeners]) {
      try {
        listener(publication);
      } catch (error) {
        counters.publishFailed += 1;
        warn('timeline publish listener failed (record already durable)', {
          session_id: publication.session_id,
          seq: publication.seq,
          error: errorText(error),
        });
      }
    }
  }

  /**
   * **唯一的对外发布点**（ADR-105 §3 I2）：由写者在 WAL/块 fsync 之后调用。
   *
   * 三件事，顺序不能换：
   *
   * 1. **seq 水位去重**：`seq <= 已发布` ⇒ 丢掉（记 `publishDeduped`）。同一条事件只到 UI
   *    一次；`seq` 严格递增 ⇒ 可见顺序 = timeline seq 顺序；
   * 2. **闸门结算 + 进程内扇出**：旧链路那条广播可能正被扣着（`gate.settle()` 放它出来 =
   *    这次发布），或者已经放出去过（压掉，避免二次投递）；无论哪条路，`onPublish` 的
   *    进程内订阅者都收到一次（serve 的时间线 epoch 拿它当实时尾随帧源）；
   * 3. **转发给 `onPublish`**：装配层接 `events.publish`。**异常一律吞掉** —— 数据已经
   *    fsync，坏的只是通知通道，绝不能让写者回滚或让 append 失败。
   */
  function deliverPublication(sessionId: string, record: TimelineRecord): void {
    if (!enabled) return;
    try {
      const last = publishedSeqs.get(sessionId) ?? 0;
      if (record.seq <= last) {
        counters.publishDeduped += 1;
        warn('timeline publish skipped (seq already published; UI must not see it twice)', {
          session_id: sessionId,
          seq: record.seq,
          published_head: last,
        });
        return;
      }
      publishedSeqs.set(sessionId, record.seq);
      counters.published += 1;
      const publication: TimelinePublication = {
        session_id: sessionId,
        seq: record.seq,
        run_id: record.run_id,
        type: record.type,
        ts: record.ts,
        data: record.data,
        ...(record.fencing_token !== undefined ? { fencing_token: record.fencing_token } : {}),
      };
      // 闸门：能放行旧链路那条广播就别再发一份（同一条事件 UI 只看到一次）。
      const releasedByGate = gate?.settle(publication) === true;
      // 进程内扇出（实时尾随的帧源）：**每一条放行的 seq 都要通知**，与闸门是否放行
      // 旧广播无关 —— 闸门解决「UI 只看到一次」，这里解决「新事件能追上来」。
      notifyPublishListeners(publication);
      if (releasedByGate) return;
      const sink = options.onPublish;
      if (sink === undefined) return;
      try {
        const result = sink(publication);
        if (result !== undefined && typeof result.then === 'function') {
          void Promise.resolve(result).catch((error: unknown) => {
            counters.publishFailed += 1;
            warn('timeline publish sink failed (record already durable; publication skipped)', {
              session_id: sessionId,
              seq: record.seq,
              error: errorText(error),
            });
          });
        }
      } catch (error) {
        counters.publishFailed += 1;
        warn('timeline publish sink failed (record already durable; publication skipped)', {
          session_id: sessionId,
          seq: record.seq,
          error: errorText(error),
        });
      }
    } catch (error) {
      // 发布路径上的任何意外都不许冒泡进写者（那会让已 fsync 的 append 变成失败）。
      counters.publishFailed += 1;
      warn('timeline publish failed (record already durable)', {
        session_id: sessionId,
        seq: record.seq,
        error: errorText(error),
      });
    }
  }

  function record(sessionId: string, event: TimelineDualWriteEvent): void {
    if (!enabled) return;
    try {
      if (sessionId.length === 0 || !shouldWrite(event)) return;
      // 同步认领「刚刚被旧链路广播的那一条」（`RunJournal` 是 publish 之后立刻调 record 的）：
      // 它在 fsync 之前不许出现在 UI 上，所以先扣在闸门里，等 deliverPublication() 放行。
      gate?.claim(sessionId, event);
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
          // 周期保底：不 await（归档永不落在 publish 路径上）。门禁 ⑥ 断言这一点。
          maybeArchive(sessionId, 'periodic');
        } catch (error) {
          counters.failed += 1;
          warn('timeline dual-write append failed (legacy path unaffected)', {
            session_id: sessionId,
            run_id: event.run_id,
            type: event.type,
            error: errorText(error),
          });
          // 这条永远不会有 fsync 后的发布 ⇒ 立刻把扣住的旧广播放出去（旧链路行为不变）。
          gate?.release({
            session_id: sessionId,
            run_id: event.run_id,
            type: event.type,
            ts: event.ts,
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
      gate?.release({
        session_id: sessionId,
        run_id: event.run_id,
        type: event.type,
        ts: event.ts,
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
    // 旧格式会话（ADR-105 D4）：这里**明确拒绝**而不是「悄悄没有 writer」。
    // 理由：静默返回会让调用方以为「刷完了」，而真相是「这个会话永远不会有 timeline」；
    // 冻结状态必须能被上层稳定识别成 `session_frozen_readonly`（与写者、索引重建同一个码）。
    if (frozenSessions.has(sessionId)) {
      // 文案里不复述文件名（旧链路那次写只属于 core）：用 core 的常量拼，
      // 免得同一句话在装配层变成第二份「文件名口径」。
      throw new TimelineError(
        'session_frozen_readonly',
        `${sessionId} has legacy ${LEGACY_SESSION_LOG} and no timeline marker`,
      );
    }
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

  // ---------------------------------------------------------------- archive 调度

  /** 第 n 次连续失败（n ≥ 阈值）对应的退避时长；未到阈值 ⇒ 0。 */
  function backoffFor(consecutive: number): number {
    if (consecutive < ARCHIVE_BACKOFF_THRESHOLD) return 0;
    const index = Math.min(
      consecutive - ARCHIVE_BACKOFF_THRESHOLD,
      ARCHIVE_BACKOFF_DELAYS_MS.length - 1,
    );
    return ARCHIVE_BACKOFF_DELAYS_MS[index] ?? ARCHIVE_BACKOFF_DELAYS_MS[0];
  }

  /** 周期保底计时器（`unref`：它只是空间回收，不是进程活着的理由）。 */
  function ensureArchiveTimer(): void {
    if (!enabled || archiveIntervalMs <= 0 || archiveTimer !== undefined) return;
    if (writers.size === 0) return;
    archiveTimer = setInterval(() => {
      for (const sessionId of [...writers.keys()]) maybeArchive(sessionId, 'periodic');
    }, archiveIntervalMs);
    const handle = archiveTimer as unknown as { unref?: () => void };
    try {
      handle.unref?.();
    } catch {
      // 宿主没有 unref：计时器仍可用（最多让进程多等一个 interval）。
    }
  }

  function stopArchiveTimer(): void {
    if (archiveTimer === undefined) return;
    clearInterval(archiveTimer);
    archiveTimer = undefined;
  }

  /**
   * **自动**触发一次归档（run 终态 / 周期保底）。同步返回，绝不 await、绝不抛。
   *
   * 三道闸门（顺序有讲究）：
   * 1. 同会话已有归档在飞 ⇒ 跳过（不许排队堆积，自动降级为「有进展再试」）；
   * 2. `periodic` 还要满足周期节流（同一会话两次自动归档间隔 ≥ `archiveIntervalMs`）；
   * 3. 连续失败 ≥ 3 次的会话要让退避时间过去（100/500/2000ms）才允许下一次自动归档。
   *
   * 任何一道闸门拦住都**不是**错误：`wal_head` 照常前进，`timeline_head` 只是晚一点追上。
   */
  function maybeArchive(
    sessionId: string,
    trigger: Exclude<TimelineArchiveTrigger, 'explicit'>,
  ): void {
    if (!enabled || sessionId.length === 0) return;
    try {
      const state = archiveStateOf(sessionId);
      if (state.inFlight > 0) return;
      const at = now();
      if (trigger === 'periodic') {
        if (archiveIntervalMs <= 0) return;
        if (state.lastDispatchAt !== 0 && at - state.lastDispatchAt < archiveIntervalMs) return;
      }
      if (at < state.nextAllowedAt) return;
      state.lastDispatchAt = at;
      void enqueueArchive(sessionId, trigger).catch(() => {
        // `enqueueArchive` 内部已把所有失败记进 counters，这里只防未处理拒绝。
      });
    } catch (error) {
      counters.archiveFailed += 1;
      warn('timeline archive dispatch failed (space reclaim only)', {
        session_id: sessionId,
        trigger,
        error: errorText(error),
      });
    }
  }

  /** 挂到该会话的串行归档队列尾部；返回本次归档的完成 Promise（永不 reject）。 */
  function enqueueArchive(sessionId: string, trigger: TimelineArchiveTrigger): Promise<void> {
    const state = archiveStateOf(sessionId);
    const run = state.chain.then(() => runArchive(sessionId, trigger, state));
    state.chain = run.then(
      () => undefined,
      () => undefined,
    );
    archiveTasks.add(run);
    void run.finally(() => {
      archiveTasks.delete(run);
    });
    return run;
  }

  /**
   * 真正归档一次：先把派出去的双写落定，再让写入侧 `archive()`。
   *
   * 失败语义严格按 ADR-105 §3 I3：`timeline_head` 不动、`wal_head` 照常、**不写洞**、
   * 记 `archiveFailed` + 退避；`tainted` 由 `heads()` 按「失败过一次且尚未恢复」上报。
   */
  async function runArchive(
    sessionId: string,
    trigger: TimelineArchiveTrigger,
    state: ArchiveState,
  ): Promise<void> {
    state.inFlight += 1;
    try {
      const pending = writers.get(sessionId);
      // 没有 writer（新进程 / 只读面 / 编译期开关关）：没有可归档的内存 writer。
      // 磁盘上的 `timeline_head` 由 `heads()` 的磁盘口径给出，不需要这里补。
      if (pending === undefined) return;
      const writer = await pending;
      if (writer === undefined) return; // writer 打不开 ⇒ 已标 broken，归档也无从谈起
      // 先等派出去的 append 落定，否则归档会漏掉刚派发的尾巴。
      await drainInflight();
      const result = await writer.archive();
      if (result.ok) {
        if (result.from_seq <= result.to_seq) {
          counters.archiveCount += 1;
          counters.lastArchiveAt = now();
        }
        if (state.consecutiveFailures > 0) state.recovered = true;
        state.consecutiveFailures = 0;
        state.nextAllowedAt = 0;
        return;
      }
      noteArchiveFailure(sessionId, trigger, state, {
        from_seq: result.from_seq,
        to_seq: result.to_seq,
        reason: result.reason ?? 'archive_failed',
      });
    } catch (error) {
      // `archive()` 自己不该抛（写入侧把失败变成 ok:false）；真抛了也按失败处理。
      noteArchiveFailure(sessionId, trigger, state, {
        from_seq: 0,
        to_seq: 0,
        reason: errorText(error),
      });
    } finally {
      state.inFlight -= 1;
    }
  }

  function noteArchiveFailure(
    sessionId: string,
    trigger: TimelineArchiveTrigger,
    state: ArchiveState,
    detail: { from_seq: number; to_seq: number; reason: string },
  ): void {
    counters.archiveFailed += 1;
    state.consecutiveFailures += 1;
    // 又失败了 ⇒ 归档污点重新生效（清过的 tainted 要能再亮起来）。
    state.recovered = false;
    const backoff = backoffFor(state.consecutiveFailures);
    if (backoff > 0) state.nextAllowedAt = now() + backoff;
    const info: TimelineArchiveFailure = {
      session_id: sessionId,
      from_seq: detail.from_seq,
      to_seq: detail.to_seq,
      reason: detail.reason,
      consecutive: state.consecutiveFailures,
      backoff_ms: backoff,
      trigger,
    };
    // 归档失败**只影响空间回收**：旧链路、publish、run 结果一律不受影响。
    warn('timeline archive failed (space reclaim only; timeline_head frozen)', { ...info });
    try {
      options.onArchiveFailed?.(info);
    } catch {
      // 通知通道坏了不能反过来影响调度
    }
  }

  async function archiveSession(sessionId: string): Promise<void> {
    if (!enabled || sessionId.length === 0) return;
    try {
      const state = archiveStateOf(sessionId);
      // 显式调用刷新节流起点（避免与紧随其后的自动归档重复做同一件事）。
      state.lastDispatchAt = now();
      await enqueueArchive(sessionId, 'explicit');
    } catch (error) {
      counters.archiveFailed += 1;
      warn('timeline archive (explicit) failed (space reclaim only)', {
        session_id: sessionId,
        error: errorText(error),
      });
    }
  }

  /** 等所有在飞归档落定（不抛）。 */
  async function drainArchives(): Promise<void> {
    while (archiveTasks.size > 0) {
      await Promise.allSettled([...archiveTasks]);
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
    // 旧格式会话：没有 timeline 可比（与 writer 打不开同一条出口：`compared:false`）。
    if (frozenSessions.has(sessionId)) return empty;
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
    // 旧格式会话：没有 timeline 可 flush/归档/抽样。生命周期钩子**安静跳过**
    // （不记失败、不制造噪音）—— 冻结不是故障，是「这个会话不该有 timeline」。
    if (frozenSessions.has(sessionId)) return undefined;
    await flushSession(sessionId);
    // run 终态（journal.close / endRun）触发一次归档：不 await（fire-and-forget），
    // 归档失败只影响空间回收 —— run 结果与旧链路都不看它。
    maybeArchive(sessionId, 'run_end');
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
    stopArchiveTimer();
    await drainInflight();
    // 归档也是「该落的东西」：先让在飞的归档跑完（同样受 300ms 上限约束）。
    await Promise.race([
      drainArchives(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, EXIT_FLUSH_BUDGET_MS);
        void timer;
      }),
    ]);
    const pending = [...writers.values()];
    writers.clear();
    if (pending.length === 0) {
      gate?.flushAll();
      return;
    }
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
    // 退出前把闸门里剩下的放出去（writer.close() 会 flush 掉活动块，绝大多数已经放行过了；
    // 剩下的要么是坏会话、要么超时兜底 —— 一条都不许因为双写坏掉而从 UI 消失）。
    gate?.flushAll();
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

  async function heads(sessionId: string): Promise<TimelineHeadsView | undefined> {
    // 开关关 ⇒ **四个字段一起缺省**（哪怕磁盘上留着上次开启时写的 timeline）：
    // 「有没有 timeline」不能由旧数据决定，否则关掉开关后 UI 还在报新链路的两指针。
    if (!enabled) return undefined;
    if (sessionId.length === 0) return undefined;
    const pending = writers.get(sessionId);
    if (pending !== undefined) {
      try {
        const writer = await pending;
        if (writer !== undefined) {
          // `published_head` 必须显式补：core 的 `heads()` 只报对外四字段，
          // `publishedHead()` 是另一个方法（凸出来的「未发布尾部」只有调度侧知道）。
          return {
            ...withArchiveTaint(sessionId, writer.heads()),
            published_head: clampPublishedHead(writer.publishedHead(), writer.heads().wal_head),
          };
        }
      } catch {
        // 落到磁盘口径
      }
    }
    try {
      const onDisk = await readHeadsOnDisk(sessionDirOf(options.sessionsDir, sessionId));
      if (onDisk === undefined) return undefined;
      // 纯磁盘口径：没有进程内写入者 ⇒ 写者 open 时已把 `published` 折成 `wal_head`
      // （`writer.ts:486`），两者必然相等。这里**明确给值**，不留 `undefined` 让上层兜底
      // 假装是「未发布」。
      return { ...onDisk, published_head: onDisk.wal_head };
    } catch {
      return undefined;
    }
  }

  /**
   * 时间线分页读（`timelineRead` 端口的装配实现）。
   *
   * 事实源是 core 的 `readTimelineEvents`：归档 `timeline.ndjson` + 块文件 + `wal.log`
   * 三处按 `seq` 归并去重、外置 blob 取回。**装配层只做窗口裁剪**：
   * - `afterSeq` 排他 / `untilSeq` 含（与 `sessions.events` 的 `since_seq` 同一口径）；
   * - 升序、按 `seq` 去重（归档是「复制不是搬移」，同一条可能两处都有）；
   * - 最多 `limit`（缺省且硬顶 `TIMELINE_PAGE_MAX`）。
   *
   * **不跳过洞**：洞（`heads().holes`）是「声明不可读」，不是「读侧过滤条件」；
   * 落盘里本来就没有那些 seq 的记录，所以跳过是自动的。反过来，读侧也**不许**替
   * 丢失的 seq 编一条占位 —— 那会让 `count` 与实收对不上。
   *
   * 成本：一次整份读（`readTimelineEvents` 是 core 唯一的读面，没有按区间下推）。
   * 调用频次是「每个 epoch 一次」（`sendTimelineEpoch`），不是每帧一次。
   */
  async function readPage(
    sessionId: string,
    query: TimelinePageQuery,
  ): Promise<readonly TimelinePageEvent[]> {
    if (!enabled) return [];
    if (sessionId.length === 0) return [];
    const after = Number.isFinite(query.afterSeq) ? Math.max(0, Math.floor(query.afterSeq)) : 0;
    const until =
      query.untilSeq === undefined || !Number.isFinite(query.untilSeq)
        ? Number.POSITIVE_INFINITY
        : Math.floor(query.untilSeq);
    const requested =
      query.limit === undefined || !Number.isFinite(query.limit)
        ? TIMELINE_PAGE_MAX
        : Math.floor(query.limit);
    const limit = Math.max(1, Math.min(TIMELINE_PAGE_MAX, requested));
    const records = await readTimelineEvents(sessionDirOf(options.sessionsDir, sessionId));
    const page: TimelinePageEvent[] = [];
    const seen = new Set<number>();
    for (const record of records) {
      if (record.seq <= after || record.seq > until) continue;
      if (seen.has(record.seq)) continue;
      seen.add(record.seq);
      page.push({
        seq: record.seq,
        type: record.type,
        ts: record.ts,
        ...(record.run_id !== undefined ? { run_id: record.run_id } : {}),
        ...(record.data !== undefined ? { data: record.data } : {}),
      });
      if (page.length >= limit) break;
    }
    page.sort((a, b) => a.seq - b.seq);
    return page;
  }

  /**
   * 订阅发布点（实时尾随的装配侧半边）。
   *
   * 回调里的 `seq` **就是** `timeline_seq`（ADR-105 §9 R7：不另造编号）；顺序与
   * `deliverPublication` 的放行顺序一致（严格递增、每条至多一次），并且一定发生在该
   * seq 的 fsync 之后 —— 所以拿它当帧源不需要二次校验。
   */
  function onPublish(listener: (publication: TimelinePublication) => void): () => void {
    publishListeners.add(listener);
    return () => {
      publishListeners.delete(listener);
    };
  }

  /**
   * 把**归档污点**按 ADR I3 的口径合并进四字段：失败过且还没成功过 ⇒ `tainted=true`；
   * 失败之后成功过一次 ⇒ 归档那一份污点清除。
   *
   * 为什么要在调度侧做这一层：写入侧冻结、且它的 `taintedFlag` 一旦置位就不再复位
   * （`packages/core/src/timeline/**` 不许改）。而 I3 要求「保留 tainted 直到成功一次」——
   * 这份「已恢复」的知识只有调度侧有。
   *
   * **不掩盖真正的丢失**：`holes` 非空时 `tainted` 恒为 true（洞只属于真丢失，归档不写洞）。
   *
   * 已知边界：重启后磁盘口径仍会看到历史 `tainted` manifest 行（写入侧不写 untaint 行），
   * 所以「恢复后的 tainted=false」只在同一进程内成立；`timeline_head` 不回退不受影响。
   */
  function withArchiveTaint(sessionId: string, heads: TimelineHeads): TimelineHeads {
    if (heads.holes.length > 0) return heads;
    const state = archiveStates.get(sessionId);
    if (state === undefined) return heads;
    if (!state.recovered) return heads;
    // 恢复过且没有洞 ⇒ 归档污点可以撤掉（真正的数据丢失只会以 holes 出现）。
    return { ...heads, tainted: false };
  }

  return {
    enabled,
    stats: () => ({ ...counters }),
    record,
    endRun,
    finishRun,
    flushSession,
    archiveSession,
    drainArchives,
    closeAll,
    installExitFlush,
    heads,
    readPage,
    onPublish,
  };
}

/**
 * `published_head` 收紧到 `<= wal_head`：写入侧的 `publishedHead()` 本来就只会 ≤
 * `wal_head`，这里防的是「读到的两个值来自两个时刻」（先读 `wal_head`、再读
 * `publishedHead()` 之间块封了）—— 越界的值不往线上发，取 `wal_head` 是唯一安全收敛。
 */
function clampPublishedHead(publishedHead: number, walHead: number): number {
  const published = Number.isFinite(publishedHead) ? Math.floor(publishedHead) : 0;
  const wal = Number.isFinite(walHead) ? Math.floor(walHead) : 0;
  if (published < 0) return 0;
  return Math.min(published, wal);
}

/**
 * 实时尾随端口（装配层半边）：把 `TimelineDualWrite.onPublish` 装成 serve 的帧源形状。
 *
 * 帧源与 `readPage()` 返回**同一个事件形状**（`TimelinePageEvent`），所以 serve 里
 * 「历史页」与「实时尾随」走同一个 `timelineEventFrame(record)`，不会出现两套映射；
 * `seq` 仍然是 `timeline_seq`（不另造编号，ADR-105 §9 R7）。
 *
 * 多带一个 **`session_id`**：`readPage` 的入参就是会话，不需要它；而进程内扇出是**全租户**
 * 的，serve 必须按连接自己的 `session_id` 过滤，否则多会话并发时会把 B 会话的帧发进
 * A 会话的连接（两套区间叠在一个游标上，客户端四条校验必红）。
 *
 * 用法（等 serve 侧那个 hook 落地后，装配层一行）：
 *
 * ```ts
 * timelineTail: bundle.timelineDualWrite === undefined
 *   ? undefined
 *   : timelineTailPort(bundle.timelineDualWrite),
 * ```
 *
 * 注意：**不做游标过滤**（那是连接的 `afterTimeline` 的事，只有 serve 知道），也不重发
 * 历史页 —— 端口只负责「fsync 之后、逐条、严格递增」这一串。
 */
export function timelineTailPort(
  manager: TimelineDualWrite,
): (listener: (event: TimelineTailEvent) => void) => () => void {
  return (listener) =>
    manager.onPublish((publication) => {
      listener({
        session_id: publication.session_id,
        seq: publication.seq,
        type: publication.type,
        ts: publication.ts,
        ...(publication.run_id !== undefined ? { run_id: publication.run_id } : {}),
        ...(publication.data !== undefined ? { data: publication.data } : {}),
      });
    });
}

/** 会话目录名（门禁与探针拼路径用；与旧链路同一条 `encodeURIComponent` 口径）。 */
export function timelineSessionDirName(sessionId: string): string {
  return encodeSessionDirName(sessionId);
}
