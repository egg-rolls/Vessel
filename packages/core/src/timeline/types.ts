/**
 * 会话 timeline 写入侧：接口与存储布局常量（ADR-105 §3 / §4，0.54 A 阶段）。
 *
 * 这里只有**类型与常量**，没有 IO。四个写入不变量（I1–I4）由
 * {@link import('./writer.js').TimelineWriter} 保证；本模块只固定它们用到的形状：
 *
 * - `timeline_seq` 是会话内唯一的持久序号，记录里字段名固定为 `seq`；
 * - 记录形状与旧 `SessionEventRecord` 同形（`v/seq/session_id/run_id/ts/type/data`），
 *   只追加一个行尾 `crc`（见 `wal.ts` 的 stamp/verify），所以旧解析器不用改；
 * - chunk 是块级二进制帧，帧头固定 8B seq + 4B len（见 `blocks.ts`）。
 *
 * 本模块**不读环境变量、不读配置层**：`chunk_flush_ms` / 块大小由装配层传入
 * （ADR-105 §11 的门禁要求它们只在配置层读一次）。
 *
 * @module @vessel-agent/core/timeline
 */

/** 记录格式版本（出现不兼容改动时 +1；读侧遇到更高版本拒读而不是猜）。 */
export const TIMELINE_FORMAT_VERSION = 1 as const;

/** 存储布局（ADR-105 §4）。目录相对**会话目录** `<sessions>/<session_id>/`。 */
export const TIMELINE_LAYOUT = {
  /** 非 chunk 事件一行一条（ndjson，行尾 crc32）。 */
  walLog: 'wal.log',
  /** chunk 块目录；块文件 `000007.wblk`，只写一次、永不重写。 */
  walBlocks: 'wal.blocks',
  /** WAL 的块目录：`[seq 起, 止] + 字节偏移 + 条数 + crc32`，只追加。 */
  walManifest: 'wal.manifest',
  /** 归档后的非 chunk 事件（与 wal.log 同格式）。 */
  timeline: 'timeline.ndjson',
  /** 超大 `data` 的外置目录（`<seq>.bin`，ADR-105 §4）。 */
  blobsDir: 'timeline/blobs',
  /** 主 manifest：创建标记 / 归档段 / 污点，只追加。 */
  timelineManifest: 'timeline.manifest',
  /** 洞登记区：append-only + crc32，跨重启可读。 */
  holes: 'holes.ndjson',
  /**
   * 归档锁（**只保护 `archiveNow()` 的「读水位 → 追加段 → 提交 manifest」这一小段**）。
   *
   * 为什么需要它：归档是「先读盘上已经有到哪、再决定抄哪一段」，读和写之间若插进第二个
   * 写者（另一个进程：CLI / node / 第二个 gateway —— 或者同进程里第二个 writer 实例），
   * 两个写者会各自按自己的快照把**同一段**抄进 `timeline.ndjson`，而 append-only 流里
   * 同一个 seq 出现两次就足以让读侧（`validateTimelineRange` 的「严格递增 / 不得重复」）
   * 整段拒绝，用户侧表现为「往上加载更早」永久卡住。
   *
   * 锁文件只是一个**门槛**（`open(…, 'wx')`），不装数据、不参与读侧任何判据；
   * 崩溃留下的锁靠 mtime 过期回收（见 `archive-lock.ts`），过期回收失败只会让归档
   * 这一次失败（空间晚点回收），不会影响任何事实的写入与读取。
   */
  archiveLock: 'timeline.archive.lock',
  /** 索引目录（派生数据，可整目录删掉重建）。 */
  indexDir: 'timeline.idx',
  indexSession: 'session.idx',
  indexRun: 'run.idx',
  indexType: 'type.idx',
} as const;

/** 活动 chunk 块的封块阈值：块字节数达到它就封块（ADR-105 §3 I2 ①）。 */
export const BLOCK_MAX_BYTES = 32 * 1024;

/** 空闲封块间隔（ADR-105 §3 I2 ③）；上限 1000 ms，超过按 1000 处理。 */
export const CHUNK_FLUSH_MS = 150;

/** `chunk_flush_ms` 的硬上限（不变量参数，不允许随手调大）。 */
export const CHUNK_FLUSH_MS_MAX = 1_000;

/**
 * 封块定时器的提前量：实际在 `chunk_flush_ms - CHUNK_FLUSH_LEAD_MS` 触发。
 *
 * 理由（A 阶段实测）：ADR 的 P95 预算是 `chunk_flush_ms + 50ms`；150ms 定时器在 Windows
 * 上叠加事件循环 / 定时器抖动后 P95 会摸到 200ms 边缘。提前 25ms 封块是「缩间隔」的
 * 允许手段（ADR-105 §11 A-5），`chunk_flush_ms` 仍是配置上限，放松的不是 I2。
 */
export const CHUNK_FLUSH_LEAD_MS = 25;

/**
 * 单条 `data` 的内联上限（ADR-105 §4「超大事件」）。
 *
 * 超过它的非 chunk 事件把 `data` 原样写进 `timeline/blobs/<seq>.bin`（先 blob fsync、
 * 再写记录行），记录行里留 {@link TimelineBlobRef}；读侧由 `readTimelineEvents()` 还原。
 * chunk 不适用（块帧本身就是紧凑载体，超大 chunk 是生产者 bug，显式拒绝）。
 */
export const MAX_INLINE_BYTES = 1 * 1024 * 1024;

/** 超大 `data` 的外置引用（记录行里的 `data` 字段）。 */
export interface TimelineBlobRef {
  blob: true;
  bytes: number;
  crc32: string;
}

/** 判断一个 `data` 值是不是外置引用（要求恰好三个字段，避免误伤业务对象）。 */
export function isTimelineBlobRef(value: unknown): value is TimelineBlobRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 3 &&
    record.blob === true &&
    typeof record.bytes === 'number' &&
    typeof record.crc32 === 'string'
  );
}

/** 一条已落盘的 timeline 记录（WAL 行 / 块帧 / 归档行三者同形）。 */
export interface TimelineRecord {
  v: 1;
  /** 会话内持久单调序号。**唯一分配点**是 `TimelineWriter`。 */
  seq: number;
  session_id: string;
  run_id: string;
  /** 生产者在事件对象上盖的毫秒时间戳（与旧链路同一个值）。 */
  ts: number;
  type: string;
  data: unknown;
  /** ADR-098 C2：写入时持有的 lease fencing token（有就原样留下）。 */
  fencing_token?: number;
  /** `JSON.stringify(record without crc)` 的 CRC32，8 位小写十六进制。 */
  crc: string;
}

/** `append()` 的入参：seq / session_id / v / crc 都由写者填。 */
export interface TimelineAppendInput {
  run_id: string;
  type: string;
  ts: number;
  data: unknown;
  fencing_token?: number;
}

/** 洞：一段**被声明为不可读**的 seq 区间（ADR-105 §3 I3 补充条款）。 */
export interface TimelineHole {
  from_seq: number;
  to_seq: number;
  reason: string;
  /** 登记时刻（毫秒）。 */
  at: number;
}

/**
 * `holes.ndjson` 的**声明种类**（additive；ADR-105 §3 I3 补充条款 + §11.1）。
 *
 * - `'hole'`：登记一个不可读区间。**历史行没有 `kind` 字段**（等价于 `'hole'`），
 *   新登记行也**不加** `kind` —— 已有行一个字都不许改，新旧行必须逐字节同形；
 * - `'hole_retired'`：退役声明。**只有「区间重读逐条 CRC 通过」之后才允许追加**
 *   （`holes.ts#HoleRegistry.retire` 是唯一写点），所以「读到 retired」本身就等于
 *   「这段数据在某次显式命令里被逐条自证过」。
 *
 * 两种声明都是**追加**，都不回改历史行：某区间的当前状态 = **物理行序上最后一条**
 * 覆盖该区间的声明（last-wins，见 `holes.ts#HoleRegistry.declarations`）。
 */
export type TimelineHoleDeclarationKind = 'hole' | 'hole_retired';

/** 登记行（历史形状：`{v,from_seq,to_seq,reason,at,crc}`，`kind` 缺省）。 */
export interface TimelineHoleRegisteredLine {
  v: 1;
  kind?: 'hole';
  from_seq: number;
  to_seq: number;
  reason: string;
  at: number;
}

/**
 * 退役行（`kind:'hole_retired'`，additive）。
 *
 * `evidence` 是**自证摘要**（区间重读的条数与来源，`reread_ok:...`），不是自由文本：
 * 它让「凭什么退役」跟着声明一起落盘，事后不用去猜。`at` 只作审计，
 * **不参与定序**（物理行序才是写入顺序）。
 */
export interface TimelineHoleRetiredLine {
  v: 1;
  kind: 'hole_retired';
  from_seq: number;
  to_seq: number;
  reason: string;
  at: number;
  evidence?: string;
}

/** `holes.ndjson` 的一行（两种声明，都是 append-only）。 */
export type TimelineHoleDeclarationLine = TimelineHoleRegisteredLine | TimelineHoleRetiredLine;

/** 对外可上报的四个字段（ADR-105 §3 I4；字段名固定，不许改名）。 */
export interface TimelineHeads {
  timeline_head: number;
  wal_head: number;
  holes: readonly TimelineHole[];
  tainted: boolean;
}

/** 一个 chunk 块在 manifest 里的条目（ADR-105 §4 `wal.manifest`）。 */
export interface TimelineBlockEntry {
  block: string;
  start_seq: number;
  end_seq: number;
  /** 块内起始字节偏移（0.54 每块从 0 开始）。 */
  offset: number;
  bytes: number;
  count: number;
  /** 整块字节的 CRC32（块文件与 manifest 互相校验）。 */
  crc32: string;
}

/** `wal.manifest` 的一行。 */
export type WalManifestLine = { v: 1; kind: 'block' } & TimelineBlockEntry;

/**
 * `timeline.manifest` 的一行（只追加；归档失败也不回改历史行）。
 *
 * **状态声明只有两种**：`tainted` / `tainted_cleared`。会话级「当前是否污点」= 「`holes.ndjson`
 * 里还有**未退役**的洞」**或**「**物理顺序上最后一条状态声明**是 `tainted`」（last-wins，
 * 读侧从后往前扫，见 `writer.ts#readManifest` / `lastTaintedState`）：
 *
 * - 排序依据**只能是写入顺序**（append-only 文件的行序）。`at` 仅作审计：时钟回退
 *   （NTP / 改系统时间 / 跨机器）会把「按 `at` 排序」的结果搞反，读侧一次都不许用它定序；
 * - `from_seq` / `to_seq` 同样**只作审计**，不参与会话级判定：本版（0.54）不做区间级
 *   `tainted`，只要有**存活洞**（未被 `hole_retired` 退役的区间），会话级 `tainted` 就恒为
 *   true（保守方向）；
 * - `tainted` 行与 `tainted_cleared` 行都**永久保留**，它们是「曾经发生过什么」的审计历史，
 *   不是当前状态；任何实现都不许回改或删除历史行；
 * - `tainted_cleared` 是 0.54 之后**新增（additive）**的行：旧 reader 对未知 `kind` 返回
 *   `undefined` ⇒ 忽略它、保守地认为仍 tainted（安全方向），既不抛错也不截断文件。
 *   因此**存量会话升级后、第一次健康归档之前仍是 tainted=true，不会自动洗白**。
 *
 * 同理，`holes.ndjson` 的 `kind:'hole_retired'` 也是 additive：旧 reader（`wal.ts` 的
 * `validateHoleLine`，本单**逐字节未改**）不认 `kind`、只校验 `from_seq/to_seq/reason/at`，
 * 于是把退役行当成**又一条洞登记** ⇒ 保守地认为洞仍在。这是设计上的安全方向。
 */
export type TimelineManifestLine =
  | { v: 1; kind: 'open'; at: number }
  | { v: 1; kind: 'archive'; from_seq: number; to_seq: number; at: number }
  | { v: 1; kind: 'tainted'; reason: string; from_seq: number; to_seq: number; at: number }
  | {
      v: 1;
      kind: 'tainted_cleared';
      reason: string;
      from_seq: number;
      to_seq: number;
      at: number;
    };

/** 写者测试缝：在这些位置真正 fsync 之前调用；抛错 = 模拟 fsync/写失败。 */
export type TimelineSyncKind = 'wal' | 'block' | 'manifest' | 'holes' | 'timeline' | 'blob';

/** 稳定错误码（上层按 code 映射，不解析 message）。 */
export type TimelineErrorCode =
  | 'timeline_write_failed'
  | 'timeline_record_too_large'
  | 'timeline_event_type_excluded'
  /**
   * 0.55：**0.54 之前的旧格式会话不再被支持**（只有 `events.ndjson`、没有任何 timeline
   * 标记）。读、写、索引三条路都抛它，**绝不**当成空会话 —— 那会让人以为历史丢了却查不出
   * 原因。取代 0.54 的 `session_frozen_readonly`：那套文件格式已经没有代码能解析，
   * 「只读」这个中间态不复存在。判据与出路（用 0.54 导出）见 `legacy-format.ts`。
   */
  | 'legacy_session_unsupported'
  | 'timeline_writer_closed'
  | 'timeline_index_invalid'
  /**
   * 归档这一次没做成（**只影响空间回收**，数据没丢）：归档副本读不出来、尾窗答不准、
   * 归档锁拿不到，或「本次要抄的段」与已经落盘的内容重叠（重复 seq 的硬闸门）。
   *
   * 单独给一个 code 是为了让这条失败在日志/统计里与「写事实失败」区分开：
   * 前者照常推进 `wal_head`，后者会把该 seq 登记成洞。
   */
  | 'timeline_archive_failed';

/** timeline 写入错误。 */
export class TimelineError extends Error {
  readonly code: TimelineErrorCode;

  constructor(code: TimelineErrorCode, message: string, options?: { cause?: unknown }) {
    const detail = options?.cause instanceof Error ? `: ${options.cause.message}` : '';
    super(`${code}: ${message}${detail}`);
    this.name = 'TimelineError';
    this.code = code;
  }
}

/**
 * chunk 判定：**恰好两条**（ADR-105 §8.1 规则 ④）。
 *
 * 白名单逐字只有 `llm.stream.chunk` 与其子 agent 后缀形态 `*.llm.stream.chunk`：
 * 写成「包含」会让 `foo.llm.stream.chunkx` 这类名字混进来，加第三条会把「旧链路故意
 * 不落盘」的一类扩大到没有依据的范围。
 */
export function isChunkEventType(type: string): boolean {
  return type === 'llm.stream.chunk' || type.endsWith('.llm.stream.chunk');
}

/**
 * **写者入口硬拒绝**的类型（`TimelineWriter#validateInput` 用它）：这些名字进 timeline 就是
 * 自激 / 已删除的事实，没有任何正常路径会写它们。
 *
 * - `trace.*` / `replay.*`：trace recorder 的防自激行（`trace.overflow` 属于 `trace.*`，不必单列）；
 * - `session.deleted`：目录已删，写了也读不回来。
 */
export function isExcludedEventType(type: string): boolean {
  return type === 'session.deleted' || type.startsWith('trace.') || type.startsWith('replay.');
}

/**
 * **不算会话事实**的类型（journal 的派发点用它：这些事件不交给写者）。
 *
 * 0.54 stop-write 之前这份名单叫 `NON_PERSISTED_EVENT_TYPES`，住在 `runtime/run-journal.ts`，
 * 只回答「不要写 `events.ndjson`」；旁路侧另有自己的取舍 —— 两份名单漂一次就会多出一个谁也
 * 不知道的写入口。现在 `events.ndjson` 停写，问题只剩一个：**什么不值得落盘**。所以它搬到
 * 这里，与写者的硬拒绝同一文件、同一段文档。
 *
 * 与 {@link isExcludedEventType} 的区别（**故意不是同一个谓词**）：
 * `context.changed` / `run.checkpoint` / `session.saved` 这类派生事件**可以被直接写**
 * （门禁与自证脚本要造它们来验写者行为），只是 journal 不会派发它们。
 *
 * 三类，理由不同：
 *
 * | 类别 | 例 | 为什么不落盘 |
 * | --- | --- | --- |
 * | 派生快照 | `context.changed` | 每条注入上下文的全量镜像；叙事已由 `context.pressure` / `context.compacted` 承担，落盘等于同一事实两份 |
 * | 自带另一份 durable 记录 | `run.checkpoint` / `session.saved` | `RunRecord` 与 `SessionState` 自己就是 durable 的 |
 * | 进程内观测 / 生命周期 | `plugin.*` / `session.log.failed` | 不是会话叙事 |
 */
export function isNonFactEventType(type: string): boolean {
  if (isExcludedEventType(type)) return true;
  if (type.startsWith('plugin.')) return true;
  return DERIVED_EVENT_TYPES.has(type);
}

/** 派生 / 同步类（见 {@link isNonFactEventType} 的表）；列举而不是前缀，免误伤同名业务事件。 */
const DERIVED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'context.changed',
  'run.checkpoint',
  'session.saved',
  'session.log.failed',
]);

/** 把 `chunk_flush_ms` 收进 [1, CHUNK_FLUSH_MS_MAX]。 */
export function clampChunkFlushMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return CHUNK_FLUSH_MS;
  return Math.min(CHUNK_FLUSH_MS_MAX, Math.max(1, Math.floor(value)));
}

/** 判断一段区间是否落在某个洞内（含端点）。 */
export function holeCovers(holes: readonly TimelineHole[], seq: number): boolean {
  for (const hole of holes) {
    if (seq >= hole.from_seq && seq <= hole.to_seq) return true;
  }
  return false;
}
