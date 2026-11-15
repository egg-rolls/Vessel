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
 * **状态声明只有两种**：`tainted` / `tainted_cleared`。会话级「当前是否污点」= **物理顺序上
 * 最后一条状态声明**的值（last-wins，读侧从后往前扫，见 `writer.ts#readManifest`）：
 *
 * - 排序依据**只能是写入顺序**（append-only 文件的行序）。`at` 仅作审计：时钟回退
 *   （NTP / 改系统时间 / 跨机器）会把「按 `at` 排序」的结果搞反，读侧一次都不许用它定序；
 * - `from_seq` / `to_seq` 同样**只作审计**，不参与会话级判定：本版（0.54）不做区间级
 *   `tainted`，只要 `holes.ndjson` 里还有任何洞，会话级 `tainted` 就恒为 true（保守方向）；
 * - `tainted` 行与 `tainted_cleared` 行都**永久保留**，它们是「曾经发生过什么」的审计历史，
 *   不是当前状态；任何实现都不许回改或删除历史行；
 * - `tainted_cleared` 是 0.54 之后**新增（additive）**的行：旧 reader 对未知 `kind` 返回
 *   `undefined` ⇒ 忽略它、保守地认为仍 tainted（安全方向），既不抛错也不截断文件。
 *   因此**存量会话升级后、第一次健康归档之前仍是 tainted=true，不会自动洗白**。
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
  | 'session_frozen_readonly'
  | 'timeline_writer_closed'
  | 'timeline_index_invalid';

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
 * chunk 判定：**恰好两条**（ADR-105 §8.1 规则 ④ 的镜像）。
 *
 * 与 `scripts/timeline-reference.ts#isTimelineOnlyType` 的白名单逐字一致：
 * `llm.stream.chunk` 与其子 agent 后缀形态 `*.llm.stream.chunk`。写成「包含」
 * 或加第三条都会被 `check-timeline-conformance` 的差集判据打红。
 */
export function isChunkEventType(type: string): boolean {
  return type === 'llm.stream.chunk' || type.endsWith('.llm.stream.chunk');
}

/**
 * 不进 timeline 的类型（两份旧源同样没有/不该有；ADR-105 §8.1 规则 ④）：
 *
 * - `trace.*` / `replay.*`：trace recorder 的防自激行，不是会话事实；
 * - `session.deleted`：目录已删，写了也读不回来。
 *
 * 注意 `trace.overflow` 属于 `trace.*`，不必单列。
 */
export function isExcludedEventType(type: string): boolean {
  return type === 'session.deleted' || type.startsWith('trace.') || type.startsWith('replay.');
}

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
