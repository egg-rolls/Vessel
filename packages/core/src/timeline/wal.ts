/**
 * timeline 的低层编解码与安全读（0.54 A 阶段，ADR-105 §4）。
 *
 * 本模块只做三件事，不做调度、不做发布：
 *
 * 1. **行/帧格式**：非 chunk 一行一条 ndjson；chunk 是二进制帧 `[u64 seq][u32 len][utf8 payload]`。
 *    两种载荷都带行尾/记录尾 `crc` 字段（CRC32，8 位十六进制），读侧可逐条自证。
 * 2. **撕裂尾帧的识别**：`truncatePartialTail` 口径 —— 没有结尾换行的最后一行、或帧长越界，
 *    一律视为「从未完整写出」，由调用方截断；**已完整写出但 CRC 不符**的内行按坏行报告，
 *    由写者登记成 `holes`（ADR-105 §6：损坏必须可声明，不能静默跳过）。
 * 3. **可枚举读**：`readTimelineEvents()` 把 `timeline.ndjson` + `wal.log` + `wal.blocks/*.wblk`
 *    合成一份按 `seq` 升序的多重集；这是索引重建与自证脚本的唯一入口。
 *
 * 不变量提醒：本模块不分配 seq、不发布事件；`seq` 的唯一分配点在 `writer.ts`。
 *
 * @module @vessel-agent/core/timeline
 */

import { type FileHandle, open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ArrayNameSource,
  type BlockNameSource,
  blockFirstFrameSeq,
  type EnumeratedBlock,
  locateRangeAnchor,
  locateTailChainStart,
  ManifestForwardReader,
  ManifestUntrustedError,
  openManifestNameSource,
  verifyBlockAgainstManifest,
} from './blocks.js';
import { blockEnumerationCounters } from './enum-stats.js';
import { validateHoleDeclarationLine } from './holes.js';
import {
  isTimelineBlobRef,
  MAX_INLINE_BYTES,
  TIMELINE_LAYOUT,
  type TimelineBlockEntry,
  type TimelineHole,
  type TimelineHoleDeclarationLine,
  type TimelineManifestLine,
  type TimelineRecord,
} from './types.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC32（IEEE 802.3，与 zlib 同多项式）；返回 8 位小写十六进制。 */
export function crc32Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

/** 给任意可序列化对象追加尾 `crc`（键顺序稳定：crc 放最后）。 */
export function withCrc<T extends object>(body: T): T & { crc: string } {
  const crc = crc32Hex(JSON.stringify(body));
  return { ...body, crc };
}

/**
 * 解析并校验一个带 `crc` 的对象。
 *
 * 校验方式：剔除 `crc` 后重新序列化（`JSON.parse` 保留键顺序，`JSON.stringify` 对同一
 * 份数据是确定性的），与记录的 `crc` 比对。任何形状/CRC 不符返回 `undefined`。
 */
export function parseWithCrc<T extends object>(parsed: unknown): (T & { crc: string }) | undefined {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const crc = record.crc;
  if (typeof crc !== 'string' || crc.length === 0) return undefined;
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === 'crc') continue;
    body[key] = record[key];
  }
  if (crc32Hex(JSON.stringify(body)) !== crc) return undefined;
  return record as T & { crc: string };
}

/** 构造一条带 crc 的记录（写者已分配 seq）。 */
export function stampRecord(body: Omit<TimelineRecord, 'crc'>): TimelineRecord {
  return withCrc(body);
}

/** 一条记录序列化成 WAL 行（末尾换行）。 */
export function encodeLine(record: TimelineRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** 形状校验 + CRC 校验一条记录（供写者与读路径共用）。 */
function validateRecord(parsed: unknown): TimelineRecord | undefined {
  const record = parseWithCrc<TimelineRecord>(parsed);
  if (record === undefined) return undefined;
  if (record.v !== 1) return undefined;
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) return undefined;
  if (typeof record.session_id !== 'string' || record.session_id.length === 0) return undefined;
  if (typeof record.run_id !== 'string') return undefined;
  if (typeof record.type !== 'string' || record.type.length === 0) return undefined;
  if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) return undefined;
  return record;
}

/** 解析一条 WAL 行；形状/CRC 不符返回 `undefined`。 */
export function parseRecordLine(line: string): TimelineRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  return validateRecord(parsed);
}

/** chunk 帧头字节数：8B seq + 4B len。 */
export const CHUNK_FRAME_HEADER_BYTES = 12;

/** 一帧的编码：`[u64 LE seq][u32 LE payload length][utf8 JSON payload]`。 */
export function encodeChunkFrame(record: TimelineRecord): Uint8Array {
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) {
    throw new Error(`chunk_frame_invalid_seq: ${String(record.seq)}`);
  }
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  const frame = Buffer.allocUnsafe(CHUNK_FRAME_HEADER_BYTES + payload.length);
  frame.writeBigUInt64LE(BigInt(record.seq), 0);
  frame.writeUInt32LE(payload.length, CHUNK_FRAME_HEADER_BYTES - 4);
  payload.copy(frame, CHUNK_FRAME_HEADER_BYTES);
  return frame;
}

/** 块内坏帧（完整帧头但载荷不可用）：seq 可读，必须登记成洞。 */
export interface ChunkFrameInvalid {
  from_seq: number;
  to_seq: number;
  reason: string;
}

export interface ChunkBlockDecode {
  records: TimelineRecord[];
  invalid: ChunkFrameInvalid[];
  /** 最后一个完整帧的结束偏移；< 块长度 ⇒ 撕裂尾帧。 */
  validBytes: number;
  torn: boolean;
}

/**
 * 解码一个 chunk 块。
 *
 * - 帧头不完整 / 载荷越界 ⇒ **撕裂尾帧**（`torn=true`，`validBytes` 之前的帧仍有效）；
 * - 帧完整但 JSON/CRC/seq 不符 ⇒ 记 `invalid`，跳过该帧继续（内行损坏 = 洞，不是截断）。
 */
export function decodeChunkBlock(buffer: Uint8Array): ChunkBlockDecode {
  const buf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const records: TimelineRecord[] = [];
  const invalid: ChunkFrameInvalid[] = [];
  let offset = 0;
  while (offset + CHUNK_FRAME_HEADER_BYTES <= buf.length) {
    const seqBig = buf.readBigUInt64LE(offset);
    const length = buf.readUInt32LE(offset + 8);
    const payloadStart = offset + CHUNK_FRAME_HEADER_BYTES;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > buf.length) break; // 撕裂尾帧
    const seq = Number(seqBig);
    if (!Number.isSafeInteger(seq) || seq < 1 || length === 0) break; // 帧头不可信：按尾部截断
    const text = buf.subarray(payloadStart, payloadEnd).toString('utf8');
    const record = parseRecordLine(text);
    if (record === undefined || record.seq !== seq) {
      invalid.push({ from_seq: seq, to_seq: seq, reason: 'chunk_frame_invalid' });
    } else {
      records.push(record);
    }
    offset = payloadEnd;
  }
  return { records, invalid, validBytes: offset, torn: offset < buf.length };
}

/** 一行不可解析的 ndjson（可带从残缺行里捞到的 seq）。 */
export interface NdjsonInvalid {
  offset: number;
  /** 残缺行里能捞到 `"seq":N` 时给出，供写者登记洞。 */
  seq?: number;
  reason: string;
}

/** 带 crc 的 ndjson 通用读取结果。 */
export interface CrcLineReadResult<T extends object> {
  items: T[];
  invalid: NdjsonInvalid[];
  /**
   * 需要截断到的字节数：**仅当文件末尾没有换行**（最后一行从未完整写出）时给出。
   * 调用方负责真正 `truncate`；读函数本身不改文件。
   */
  truncateTo?: number;
  size: number;
  /**
   * 被 `skipLine` 跳过的**完整行数**（`0`/缺省 = 一行都没跳）。
   *
   * 与 `invalid` 的分工：跳过是**调用方已经证明「这一行在别处有同一份」**（见
   * {@link readNdjsonFile} 的水位去重），不是「这行坏了」—— 所以它不进 `invalid`，
   * 也不参与截断判定。计数存在只为让「跳过到底生效了没有」看得见。
   */
  skipped?: number;
}

/**
 * 读一个「每行都是带 crc 的 JSON」的 ndjson 文件。
 *
 * `validate` 缺省只做 CRC 校验；需要形状校验的调用方（时间线记录、洞登记）自带判定。
 *
 * `skipLine` 是**给水位去重留的唯一缝**：命中它的行只做行边界扫描，不 `JSON.parse`、
 * 不算 CRC、不进 `items` / `invalid`。它回答的是「这一行要不要解析」，**不是**
 * 「这一行要不要」—— 跳过必须由调用方自己证明（跳过 = 同一份事实已在别处读到），
 * 否则就是静默少给（0.56 设计 §9 点名的最坏实现）。参数是行内容的字节区间
 * `[start, end)`（不含行尾换行）。
 */
export async function readCrcNdjsonFile<T extends object>(
  path: string,
  validate: (parsed: unknown) => T | undefined = (parsed) => parseWithCrc<T>(parsed),
  skipLine?: (buffer: Buffer, start: number, end: number) => boolean,
): Promise<CrcLineReadResult<T>> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch {
    return { items: [], invalid: [], size: 0 };
  }
  return parseCrcNdjsonBuffer(buffer, validate, skipLine);
}

/** 文件不存在（`ENOENT`）—— 对 append-only 流来说这是「还没有这个文件」，不是读失败。 */
export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * {@link readCrcNdjsonFile} 的**严格版**：只把 `ENOENT` 当成空文件，其它读失败一律抛。
 *
 * ## 为什么必须有这一版（真实事故：同一段被归档两次）
 *
 * 宽容版把**任何** `readFile` 失败都折叠成「这个文件是空的」。对「读事实源」的调用方
 * （读口、读回可用性）那是对的：读不出来就说读不出来，别装成有内容。但对**写路径**它是
 * 一个反向谎言 —— `archiveNow()` 用「归档副本里最大的 seq」算「已经归档到哪」，把「读不到」
 *（Windows 上真实的 `EPERM`/`EBUSY`/`EMFILE`，杀软或索引器短暂占用就够）当成「一条都没有」
 * 之后，它会拿**内存里的 `timeline_head`** 当起点，把**已经落盘的整段再抄一遍**：
 *
 * - 现场三次（`09f82ac6` seq 71194–71198、`8f9d91e0` 604–695、`c52a29cc` 747–2134/2173）的
 *   重复段都恰好是「已归档区间」的原样重抄，而 `wal.log` 一条重复都没有；
 * - 读侧 `validateTimelineRange` 的第 1/4 条规则（严格递增、不得重复）因此整段拒绝该区间，
 *   「往上加载更早」永久卡住（`merged=0`、`hasEarlier` 恒 true）。
 *
 * 于是写路径只许用这一版：**读不出来 ⇒ 这次归档失败（只影响空间回收），绝不重抄**。
 * `holes` / `manifest` 这些「读不回来就登记成洞」的调用方也用同一套口径。
 */
export async function readCrcNdjsonFileStrict<T extends object>(
  path: string,
  validate: (parsed: unknown) => T | undefined = (parsed) => parseWithCrc<T>(parsed),
): Promise<CrcLineReadResult<T>> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (error) {
    if (isNotFoundError(error)) return { items: [], invalid: [], size: 0 };
    throw error;
  }
  return parseCrcNdjsonBuffer(buffer, validate);
}

/** 一份 ndjson 字节 → 行对象（{@link readCrcNdjsonFile} 的解析体，两个入口共用一份）。 */
function parseCrcNdjsonBuffer<T extends object>(
  buffer: Buffer,
  validate: (parsed: unknown) => T | undefined = (parsed) => parseWithCrc<T>(parsed),
  skipLine?: (buffer: Buffer, start: number, end: number) => boolean,
): CrcLineReadResult<T> {
  const items: T[] = [];
  const invalid: NdjsonInvalid[] = [];
  let skipped = 0;
  let lineStart = 0;
  let lastNewline = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    if (skipLine !== undefined && index > lineStart && skipLine(buffer, lineStart, index)) {
      // 只扫行边界：这一行的事实已由调用方在别处读到（水位去重），这里不解析、不校验。
      skipped += 1;
      lastNewline = index;
      lineStart = index + 1;
      continue;
    }
    const text = buffer.subarray(lineStart, index).toString('utf8').trim();
    if (text.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const item = parsed === undefined ? undefined : validate(parsed);
      if (item === undefined) {
        invalid.push({ offset: lineStart, seq: extractSeq(text), reason: 'ndjson_line_invalid' });
      } else {
        items.push(item);
      }
    }
    lastNewline = index;
    lineStart = index + 1;
  }
  const result: CrcLineReadResult<T> = { items, invalid, size: buffer.length };
  if (skipped > 0) result.skipped = skipped;
  if (lineStart < buffer.length) {
    // 末尾无换行：最后一行从未完整写出（write 与换行在同一次调用里），截掉。
    result.truncateTo = lastNewline + 1;
  }
  return result;
}

export interface NdjsonReadResult {
  records: TimelineRecord[];
  invalid: NdjsonInvalid[];
  truncateTo?: number;
  size: number;
  /** 见 {@link CrcLineReadResult.skipped}（水位去重跳过的行数）。 */
  skipped?: number;
}

/** `readNdjsonFile` 的选项。 */
export interface NdjsonReadOptions {
  /**
   * 水位：`seq <= skipParsedUpToSeq` 的**事实行**只扫行边界、不解析（见 {@link readCrcNdjsonFile}
   * 的 `skipLine`）。
   *
   * 只有一种调用配用它 —— 「同一批事实行已经被归档副本解析过一遍」的整份读
   * （{@link readTimelineEvents} 的水位去重）。传它之前**必须**先自证归档副本真的覆盖到
   * 这个水位（{@link resolveFactWatermark} 的 `trusted`），否则就是拿性能换静默丢数据。
   */
  skipParsedUpToSeq?: number;
}

/** 读一个时间线记录 ndjson 文件；不存在 ⇒ 空结果（缺文件不是错误）。 */
export async function readNdjsonFile(
  path: string,
  options: NdjsonReadOptions = {},
): Promise<NdjsonReadResult> {
  const watermark = options.skipParsedUpToSeq;
  const skipLine =
    typeof watermark === 'number' && Number.isSafeInteger(watermark) && watermark > 0
      ? (buffer: Buffer, start: number, end: number) =>
          recordSeqAtOrBelow(buffer, start, end, watermark)
      : undefined;
  const result = await readCrcNdjsonFile<TimelineRecord>(path, validateRecord, skipLine);
  return {
    records: result.items,
    invalid: result.invalid,
    size: result.size,
    ...(result.truncateTo !== undefined ? { truncateTo: result.truncateTo } : {}),
    ...(result.skipped !== undefined ? { skipped: result.skipped } : {}),
  };
}

/**
 * {@link readNdjsonFile} 的严格版（写路径专用）：**读不出来就说读不出来**。
 *
 * 只有 `ENOENT` 算「文件还不存在」；`EPERM` / `EBUSY` / `EMFILE` / 任何其它读失败都抛给
 * 调用方。理由见 {@link readCrcNdjsonFileStrict}：写路径拿这个结果当「已经落盘到哪」的
 * 判据，把读失败当成空文件就是重抄整段（那正是重复 seq 的来路）。
 */
export async function readNdjsonFileStrict(path: string): Promise<NdjsonReadResult> {
  const result = await readCrcNdjsonFileStrict<TimelineRecord>(path, validateRecord);
  return {
    records: result.items,
    invalid: result.invalid,
    size: result.size,
    ...(result.truncateTo !== undefined ? { truncateTo: result.truncateTo } : {}),
  };
}

/**
 * 行首前缀里能读到 `"seq":N` 的最大探测字节数。
 *
 * 事实行的键顺序由写者固定（`{v, seq, session_id, run_id, ts, type, data, crc}`，
 * `writer.ts#buildRecord`），所以 `"seq":` 恒在开头十来个字节内；64 B 是给
 * 「键顺序将来多了一个字段」留的余量，读不到就**不跳过**（回落到正常解析，安全方向）。
 */
const SEQ_PREFIX_PROBE_BYTES = 64;

/**
 * 这一行的 `seq` 是否 `<= watermark`（是 ⇒ 这一行可以跳过解析）。
 *
 * 三个「不猜」的诚实出口都返回 `false`（= 照常解析）：
 * ① 前缀里没有 `"seq":`；② 数字被前缀截断；③ 数字后面还是数字（说明截在号中间）。
 * 只多做一次 64 B 的 `toString` + 一次正则，换来的是省掉整行的 `JSON.parse` + CRC32。
 */
function recordSeqAtOrBelow(
  buffer: Buffer,
  start: number,
  end: number,
  watermark: number,
): boolean {
  const limit = Math.min(end, start + SEQ_PREFIX_PROBE_BYTES);
  const text = buffer.toString('utf8', start, limit);
  const match = /"seq":(\d+)/.exec(text);
  if (match === null) return false;
  const digitsEnd = match.index + match[0].length;
  if (digitsEnd >= text.length) return false; // 前缀切在数字中间：不猜
  const code = text.charCodeAt(digitsEnd);
  if (code >= 0x30 && code <= 0x39) return false;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq >= 1 && seq <= watermark;
}

/** 从残缺 JSON 文本里捞 `"seq":N`（仅用于把坏行登记成可声明的洞）。 */
function extractSeq(text: string): number | undefined {
  const match = /"seq"\s*:\s*(\d+)/.exec(text);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/** 截断文件到指定字节数（撕裂尾帧清理）。 */
export async function truncateFile(path: string, size: number): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

/*
 * ── 尾窗读（第十一条：启动路径不许 O(会话大小)） ────────────────────────────
 *
 * 写者 `open()` 恢复状态时的唯一读原语。三问回答：
 *
 * - **上界**：一次调用最多读 `maxBytes`（缺省 4 MiB），首窗 `firstBytes`（缺省 256 KiB）；
 *   行数上界 = 窗口字节数 / 最短行，两条都在常量里，不随会话长大；
 * - **谁在触发**：`TimelineWriter.open()`（进程启动 / 会话打开 / idle 压缩 / adopt）；
 * - **用户看得到吗**：看不到 —— 所以只读「回答问题所需要的最后一小段」：最后一条事实
 *   的 seq、最后一条归档行的 seq、最后一条状态声明。更早的内容属于**显式修复**路径
 *   （写者打开失败于自洽检查时才退回全量读）。
 */

/** 尾窗首读字节数（256 KiB ≈ 上百条事实行 / 上千条 manifest 行）。 */
export const TAIL_WINDOW_FIRST_BYTES = 256 * 1024;

/** 尾窗扩读上限（4 MiB = 单条内联 `data` 上限的 4 倍；超过它就不猜，交由调用方退回全量）。 */
export const TAIL_WINDOW_MAX_BYTES = 4 * 1024 * 1024;

/** 尾窗读结果；**只含完整行**，`truncateTo` 指需要截掉的撕裂残行。 */
export interface NdjsonTailWindow {
  /** 窗口里的完整行（文件顺序：旧 → 新）。窗口起点被切在半行时，那半行被丢掉。 */
  lines: string[];
  /** 窗口是否覆盖到**文件起点**（false ⇒ 更早的行没读，别把它当「全部」）。 */
  fromStart: boolean;
  /** 文件总字节数。 */
  size: number;
  /** 末尾撕裂残行的截断偏移（`undefined` = 文件以换行结尾，没有残行）。 */
  truncateTo?: number;
}

/**
 * 读 `[offset, offset+length)` 并读满；读不满（文件在读取期间变短 / 不存在）⇒ `undefined`。
 *
 * 与 `read-port.ts#readWindow` 同一口径，抽在这里是为了让「尾窗读」只有一份实现。
 */
export async function readFileWindow(
  path: string,
  offset: number,
  length: number,
): Promise<Buffer | undefined> {
  if (length <= 0) return undefined;
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
      if (bytesRead === 0) return undefined; // 文件变短了：不猜
      filled += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * 从一个 ndjson 文件的**尾部**读回完整行（不整份读）。
 *
 * 三条纪律：
 *
 * 1. **只返回完整行**：窗口起点切在一条记录中间时，那一段**丢掉**（不拼接、不猜）；
 * 2. **撕裂残行要报出来**：末尾没有换行 ⇒ 最后一行从未完整写出（`write` 与换行在同一次
 *    调用里），`truncateTo` 给调用方去截断 —— 与全量读 `readCrcNdjsonFile` 的口径逐字相同；
 * 3. **读不到就说不知道**：文件不存在 / 读取期间变短 / 预算内连一条完整行都拿不到 ⇒
 *    `undefined`。调用方必须把它当「不能用尾窗下结论」，退回全量路径。
 *
 * 本函数**不校验 CRC、不解析 JSON**：坏行留给调用方判定（写者要把它们登记成洞，读侧跳过）。
 */
export async function readNdjsonTail(
  path: string,
  firstBytes: number = TAIL_WINDOW_FIRST_BYTES,
  maxBytes: number = TAIL_WINDOW_MAX_BYTES,
): Promise<NdjsonTailWindow | undefined> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return undefined;
  }
  if (size <= 0) return { lines: [], fromStart: true, size: 0 };

  const budget = Math.max(1, Math.min(Math.floor(maxBytes), size));
  let window = Math.max(1, Math.min(Math.floor(firstBytes), budget));
  for (;;) {
    const start = Math.max(0, size - window);
    const buffer = await readFileWindow(path, start, size - start);
    if (buffer === undefined) return undefined;

    // ① 起点切在半行上 ⇒ 丢掉第一段（它缺前半截）。
    let regionStart = 0;
    if (start > 0) {
      const firstNewline = buffer.indexOf(0x0a);
      if (firstNewline === -1) {
        // 窗口里连一个换行都没有：窗口太小（一行很长），扩窗重来；预算用尽就不猜。
        if (window >= budget) return undefined;
        window = Math.min(window * 4, budget);
        continue;
      }
      regionStart = firstNewline + 1;
    }

    // ② 末尾撕裂残行：文件不以换行结尾 ⇒ 最后一段从未完整写出。
    let contentEnd = buffer.length;
    let truncateTo: number | undefined;
    if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        // 走到这里只可能是「整个文件就是一条残行」（start === 0 且没有换行）。
        return { lines: [], fromStart: true, size, truncateTo: 0 };
      }
      contentEnd = lastNewline + 1;
      truncateTo = start + contentEnd;
    }

    const text = buffer.toString('utf8', regionStart, contentEnd);
    const lines = text.length === 0 ? [] : text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const result: NdjsonTailWindow = {
      lines,
      fromStart: start === 0,
      size,
      ...(truncateTo !== undefined ? { truncateTo } : {}),
    };
    return result;
  }
}

/** 列出一个 chunk 块目录里的块文件名（按数字升序；`000007.wblk`）。 */
export async function listBlockFiles(blocksDir: string): Promise<string[]> {
  // 单 A 的核心指标：这个函数就是「每页一次 readdir」的那一次。
  blockEnumerationCounters.readdirCalls += 1;
  const entries = await readdir(blocksDir, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return [];
  return entries
    .filter((entry) => entry.isFile() && /^\d{6}\.wblk$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** 块文件名 → 数值（用于分配下一个块号）。 */
export function blockNumber(name: string): number {
  return Number.parseInt(name.slice(0, 6), 10);
}

/** 一个块文件的解码结果 + manifest 条目。 */
export interface DecodedBlock {
  name: string;
  entry: TimelineBlockEntry;
  decode: ChunkBlockDecode;
}

/** 扫描并解码全部 chunk 块（读路径；不截断、不改文件）。 */
export async function readAllBlocks(sessionDir: string): Promise<DecodedBlock[]> {
  const blocksDir = join(sessionDir, TIMELINE_LAYOUT.walBlocks);
  const names = await listBlockFiles(blocksDir);
  const out: DecodedBlock[] = [];
  for (const name of names) {
    const buffer = await readFile(join(blocksDir, name)).catch(() => undefined);
    if (buffer === undefined) continue;
    const decode = decodeChunkBlock(buffer);
    const first = decode.records[0];
    const last = decode.records[decode.records.length - 1];
    out.push({
      name,
      entry: {
        block: name,
        start_seq: first?.seq ?? 0,
        end_seq: last?.seq ?? 0,
        offset: 0,
        bytes: buffer.length,
        count: decode.records.length,
        crc32: crc32Hex(buffer),
      },
      decode,
    });
  }
  return out;
}

/**
 * 折出「本趟快照的事实边界」：归档副本 + `wal.log` 里最大的 `seq`。
 *
 * 它只由**事实行**（`wal.log` / 归档副本，两者同格式）决定，所以它一定是一条事实的
 * `seq`；块里只有 chunk，因此边界不会落在某个块的区间内部（见
 * {@link selectBlocksForSnapshot}）。
 */
function factBoundaryOf(records: Iterable<TimelineRecord>): number {
  let max = 0;
  for (const record of records) if (record.seq > max) max = record.seq;
  return max;
}

/**
 * 从磁盘上「现在能看见的块」里挑出**与本趟快照自洽**的那些。
 *
 * 为什么需要挑：{@link readAllBlocks} 的目录快照与 `wal.log` 的读取时刻不同，一次读
 * 横跨几秒（实测活写会话 11k 块 ≈ 2.9 s）。块目录先列、`wal.log` 后读的话，一次读会
 * 拿到「新的事实 + 旧的块」，中间凭空少掉一段时间里封的 chunk —— `count` 与实收不再
 * 相等，客户端只能判缺口，尾部终态事件永远等不到。
 *
 * 反过来（**先事实、后块**，即本模块现在的顺序）就有硬保证：写者 `factStep` 先封
 * 活动块再分配事实 seq（`writer.ts`），所以「`seq < B` 的 chunk 所在的块」必然在写
 * 第 `B` 行事实之前就已 fsync 落盘 —— 只要块目录是在读完事实之后列的，它们一定可见。
 * 于是 `end_seq <= B` 的块**无条件纳入**（这段区间属于本趟快照）。
 *
 * `start_seq > B` 的块是「读事实之后才封的」：它前面那条事实（`B+1..start-1` 里那条）
 * 不在本趟快照里，整块纳入就会在 `count` 里造一个**读侧自己造的洞**。所以它只在
 * **紧接当前最大可读 `seq`**（`start_seq <= cursor + 1`）时纳入 —— 连续尾块，不造洞；
 * 一旦断链就停下（快照就到此为止，下一次读自然接上）。
 *
 * 注意「纳入」不等于「挑好的」：这里不做全量一致性判定，会话真有的洞（坏帧、丢块）
 * 该出现还是会出现，由写者登记、由 `heads().holes` 声明。
 */
function selectBlocksForSnapshot(
  blocks: readonly DecodedBlock[],
  factBoundary: number,
): DecodedBlock[] {
  const ordered = [...blocks].sort((a, b) => a.entry.start_seq - b.entry.start_seq);
  const selected: DecodedBlock[] = [];
  let cursor = factBoundary;
  for (const block of ordered) {
    const start = block.entry.start_seq;
    const end = block.entry.end_seq;
    if (start < 1 || end < start) continue;
    // 边界之内的块：无条件纳入（封块早于边界那条事实，必然已完整落盘）。
    if (end <= factBoundary) {
      selected.push(block);
      if (end > cursor) cursor = end;
      continue;
    }
    // 边界之外的块：只有连续尾块才纳入，断链即停。
    if (start > cursor + 1) continue;
    selected.push(block);
    if (end > cursor) cursor = end;
  }
  return selected;
}

/*
 * ── 事实行水位去重（整份读的「同一批事实只解析一份」） ──────────────────────
 *
 * ## 它解决什么
 *
 * 归档是**复制不是搬移**（`writer.ts#archiveNow` 只把 `wal.log` 的行 append 到
 * `timeline.ndjson`，从不截断 `wal.log`）—— 所以 `seq <= timeline_head` 的那批事实行
 * **同时存在于两个文件里**，整份读把它们逐字节解析了两遍（0.56 设计 §1 实测：
 * 8.4 MB / 5,001 行 / 106 ms + 97 ms，md5 相同）。
 *
 * 这条缝让第二份**不解析**：`wal.log` 里 `seq <= timeline_head` 的行只扫行边界
 * （{@link readNdjsonFile} 的 `skipParsedUpToSeq`）。事实仍然在 `bySeq` 里 —— 由归档副本
 * 提供（它先读）。
 *
 * ## 为什么必须**先自证才敢跳**（否则就是静默丢数据）
 *
 * 「归档副本有这一行」不是物理定律，它依赖三条写侧行为：① 归档只 append（不搬移、不截断
 * `wal.log`）；② 按 seq 升序复制；③ manifest 的 `timeline_head` 不会超前于归档落盘。
 * 任何一条被破坏（归档被截 / 中间坏一行 / manifest 被改大），跳过就会**把一条事实从
 * 读结果里拿掉，而且没有任何报错** —— 0.56 设计 §9 点名的最坏实现。
 *
 * 所以只有**归档尾部自证**成立时才信任水位：
 *
 * ```
 * trusted ⇔ head > 0 ∧ 归档副本最大 seq >= head ∧ 归档副本里一条坏行都没有
 * ```
 *
 * 不成立 ⇒ `skipParsedUpToSeq = 0`，老老实实**读两份**（重叠靠 `Map` 的 seq 去重）。
 * 降级的代价只是那 97 ms 的重复解析，不是正确性。
 *
 * ## 为什么只作用在整份读
 *
 * 范围读（{@link readTimelineRange}）的事实行**只从 `wal.log` 读一份**（归档段根本不读，
 * 前提由 `checkArchiveTripline` 证明：`archive ⊆ wal.log`）。它本来就是「只解析一份」，
 * 没有第二份可省，也就没有水位跳过可用 —— 在这里跳会直接丢掉 `seq <= head` 的事实。
 * 两条路的等价性由这一点保证：整份读跳掉的每一行都由归档副本补上（且被上面的自证保证），
 * 范围读则从 `wal.log` 直接读到同一行；任何一侧不可信都退回「读两份/整份读」。
 */

/** 水位不可信的原因（稳定 code；只有观测用途，判定只看 `trusted`）。 */
export type FactWatermarkReason =
  /** 没有归档过（`timeline_head` = 0 或 manifest 里没有 `archive` 行）⇒ 没有可省的那一份 */
  | 'no_archive_head'
  /** manifest 的 `timeline_head` 读不出来（尾窗只有坏行 / 文件读不动）⇒ 不知道水位在哪 */
  | 'head_unreadable'
  /** 归档副本里最大 seq < `timeline_head`：归档被截 / manifest 超前 ⇒ 归档不覆盖水位 */
  | 'archive_tail_behind_head'
  /** 归档副本里有坏行：那几行的事实只剩 `wal.log` 一份 ⇒ 不许跳过 */
  | 'archive_line_invalid';

/**
 * 「同一批事实行只解析一份」的水位快照。
 *
 * `trusted` 是**唯一**被读侧使用的字段（{@link readTimelineEvents}）；其余三个是让它可
 * 复查的答案（哪个水位、归档自证到哪、为什么不信）。
 */
export interface FactWatermark {
  /** `timeline.manifest` 里最后一条 `archive` 行的 `to_seq`（`0` = 从未归档） */
  head: number;
  /** 调用方已解析的归档副本里最大的 seq（`0` = 归档副本不存在/空） */
  archive_tail: number;
  /** 归档尾部自证是否成立（成立才允许跳过 `wal.log` 水下那一段的解析） */
  trusted: boolean;
  /** `trusted=false` 的原因 */
  reason?: FactWatermarkReason;
}

/** 进程内的水位去重计数（`timelineFactWatermarkCounters()` 读它；不落盘、不进 wire）。 */
const factWatermarkCounters = {
  /** 走了「只解析一份」的整份读次数 */
  trusted: 0,
  /** 水位不可信、老老实实读两份的整份读次数 */
  degraded: 0,
  /** 累计跳过解析的 `wal.log` 行数（= 归档副本已经提供的那一批） */
  lines_skipped: 0,
};

/**
 * 一次水位去重的进程内计数快照。
 *
 * 为什么要它：`trusted` 恒为 0 而 `degraded` 在涨，说明自证从来没通过（水位去重等于白做）；
 * 两者都在涨则说明「有的会话归档落后」—— 这两种情况都不该靠翻日志才发现。
 */
export function timelineFactWatermarkCounters(): Readonly<{
  trusted: number;
  degraded: number;
  lines_skipped: number;
}> {
  return { ...factWatermarkCounters };
}

/** 主 manifest 尾窗的首读字节（只找「最后一条 archive 行」，一段就够）。 */
const WATERMARK_MANIFEST_FIRST_BYTES = 64 * 1024;
const WATERMARK_MANIFEST_MAX_BYTES = 1024 * 1024;

/**
 * `timeline.manifest` 一行的形状校验（读侧**最小一份**：只要 `v` 与 `kind`/`to_seq`）。
 *
 * 为什么不复用 `writer.ts#validateManifestLine`：那个是私有的（写者自己恢复状态用），
 * 而本模块不许为了复用去改 writer。判据强弱在这里**不改变安全性**：水位只被当**上界**用，
 * 且必须再被「归档副本最大 seq >= head」这一条独立自证复核 —— 形状被放宽的后果只有两种，
 * 都落在安全方向：上界偏大 ⇒ 自证不过 ⇒ 读两份；上界偏小 ⇒ 少跳一些 ⇒ 仍等价。
 * CRC 仍然必查（`parseWithCrc`）：坏行的 `to_seq` 不可信，跳过它去找更早的 `archive` 行。
 */
function readManifestForWatermark(parsed: unknown): TimelineManifestLine | undefined {
  const line = parseWithCrc<TimelineManifestLine>(parsed);
  if (line === undefined || line.v !== 1) return undefined;
  if (line.kind === 'archive') {
    return Number.isSafeInteger(line.to_seq) && Number.isSafeInteger(line.from_seq)
      ? line
      : undefined;
  }
  if (line.kind === 'open') return typeof line.at === 'number' ? line : undefined;
  if (line.kind === 'tainted' || line.kind === 'tainted_cleared') {
    return typeof line.reason === 'string' && Number.isSafeInteger(line.to_seq) ? line : undefined;
  }
  return undefined;
}

/**
 * `timeline.manifest` 里**文件序最后一条** `archive` 行的 `to_seq`（= `timeline_head`）。
 *
 * 尾窗读（64 KiB → 1 MiB）：`archive` 行的 `to_seq` 单调（`from = timelineHead + 1`、
 * `to = walHead`），所以文件序最后一条就是最大的一条，与写者
 * `readManifestTail()` 的 `archivedTo` 同一口径。
 *
 * `0` = 没归档过（文件不存在 / 读到文件起点都没有 `archive` 行；
 * `undefined` = 答不准（尾窗只有坏行 / 文件读不动 / 尾窗没覆盖到起点又找不到 `archive` 行）。
 */
async function readTimelineHeadForWatermark(manifestPath: string): Promise<number | undefined> {
  // 没有主 manifest = 这个会话从没归档过（`timeline_head` 就是 0），不是「读不出来」。
  const exists = await stat(manifestPath).catch(() => undefined);
  if (exists === undefined) return 0;
  let firstBytes = WATERMARK_MANIFEST_FIRST_BYTES;
  for (;;) {
    const window = await readNdjsonTail(manifestPath, firstBytes, WATERMARK_MANIFEST_MAX_BYTES);
    if (window === undefined) return undefined;
    for (let index = window.lines.length - 1; index >= 0; index -= 1) {
      const text = window.lines[index];
      if (text === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue; // 坏行：与全量读同口径忽略
      }
      const line = readManifestForWatermark(parsed);
      if (line === undefined) continue;
      if (line.kind === 'archive') return line.to_seq;
    }
    if (window.fromStart) return 0; // 读到了文件起点：一行 archive 都没有
    if (firstBytes >= WATERMARK_MANIFEST_MAX_BYTES) return undefined;
    firstBytes = Math.min(firstBytes * 4, WATERMARK_MANIFEST_MAX_BYTES);
  }
}

/**
 * 判这次整份读能不能「只解析一份」（0.56 · 事实行水位去重，见上面的长注释）。
 *
 * `evidence` 是调用方**已经**拿到手的归档副本解析结果 —— 这个函数不重复读归档
 * （整份读刚把它整份解析过；让一个判据函数再整份读一遍就是白花钱）。
 * 唯一的额外 IO 是主 manifest 的尾窗（一条 `to_seq`）。
 */
export async function resolveFactWatermark(
  sessionDir: string,
  evidence: { archiveInvalid: number; archiveMaxSeq: number },
): Promise<FactWatermark> {
  const headValue = await readTimelineHeadForWatermark(
    join(sessionDir, TIMELINE_LAYOUT.timelineManifest),
  ).catch(() => undefined);
  const head = headValue !== undefined && headValue > 0 ? headValue : 0;
  const archiveTail = evidence.archiveMaxSeq > 0 ? evidence.archiveMaxSeq : 0;
  if (head === 0) {
    return {
      head,
      archive_tail: archiveTail,
      trusted: false,
      reason: headValue === undefined ? 'head_unreadable' : 'no_archive_head',
    };
  }
  if (evidence.archiveInvalid > 0) {
    return { head, archive_tail: archiveTail, trusted: false, reason: 'archive_line_invalid' };
  }
  if (archiveTail < head) {
    return { head, archive_tail: archiveTail, trusted: false, reason: 'archive_tail_behind_head' };
  }
  return { head, archive_tail: archiveTail, trusted: true };
}

/**
 * 读出一个会话的全部 timeline 事件（按 `seq` 升序），**作为一次自洽快照**。
 *
 * 来源仍是三处，按 seq 去重（同一条在归档副本与 WAL 副本里逐字节相同），坏行/坏帧
 * 不在这里登记（读侧无写权限）；但**读取顺序有硬性要求**：
 *
 * 1. 先读事实源：`timeline.ndjson`（归档副本）+ `wal.log`（WAL 原文，同 seq 覆盖归档）；
 * 2. 再读 chunk 块：`wal.blocks/*.wblk`，并且只取 `selectBlocksForSnapshot` 认可的块。
 *
 * 顺序不是性能选择，是**一致性**要求（ADR-105 §3「`[1..wal_head]` 每条要么可读、要么
 * 已在 holes 里声明」）：块目录必须在事实之后列，否则这段窗口里封的块会缺席，而
 * 窗口里写下的事实还在 —— 读出来就是一个**中间洞**，`count` 因此大于实收，客户端
 * 只能停在缺口处（用户看到的是永远「正在思考」）。实测（活写会话，11k 块 / 一次读
 * 2.9 s）：一次读缺 3 个块 / 102 条，全部是窗口内封的 chunk。
 *
 * 代价：「边界之外」的连续尾块之外的部分不参与本趟快照，所以**正在被写着的**最新
 * 记录可能要等到下一次读。这不是丢数据：reader 的历史窗口由 `heads()` 声明，读到的
 * 永远是「声明之内、且完整」的那一段。
 *
 * ## 0.56 · 事实行只解析一份
 *
 * 读归档副本时顺手拿到的两个事实（坏行数 / 最大 seq）就是水位自证的**全部证据**：
 * 成立 ⇒ `wal.log` 里 `seq <= timeline_head` 的行只扫行边界、不解析（那批事实已经在
 * `bySeq` 里了）；不成立 ⇒ 读两份（`skipParsedUpToSeq = 0`，与本次改动前逐字节同一条
 * 代码路径）。判据、理由与「为什么只作用在整份读」都写在
 * {@link resolveFactWatermark} 上面那段长注释里 —— **输出必须与改动前逐条等价**，
 * 这个函数没有第二个变体。
 */
export async function readTimelineEvents(sessionDir: string): Promise<TimelineRecord[]> {
  const bySeq = new Map<number, TimelineRecord>();

  // ① 事实源先读：这两处决定了本趟快照的边界（`factBoundaryOf`）。
  const archived = await readNdjsonFile(join(sessionDir, TIMELINE_LAYOUT.timeline));
  for (const record of archived.records) bySeq.set(record.seq, record);
  // 水位自证用刚解析出来的归档副本证据 —— 不为了判据再整份读一遍归档。
  const watermark = await resolveFactWatermark(sessionDir, {
    archiveInvalid: archived.invalid.length,
    archiveMaxSeq: factBoundaryOf(archived.records),
  });
  factWatermarkCounters[watermark.trusted ? 'trusted' : 'degraded'] += 1;
  const wal = await readNdjsonFile(join(sessionDir, TIMELINE_LAYOUT.walLog), {
    skipParsedUpToSeq: watermark.trusted ? watermark.head : 0,
  });
  if (wal.skipped !== undefined) factWatermarkCounters.lines_skipped += wal.skipped;
  for (const record of wal.records) bySeq.set(record.seq, record);
  const factBoundary = factBoundaryOf(bySeq.values());

  // ② 块目录后列：此时「边界之内封的块」必然已经在目录里（见 selectBlocksForSnapshot）。
  for (const block of selectBlocksForSnapshot(await readAllBlocks(sessionDir), factBoundary)) {
    for (const record of block.decode.records) bySeq.set(record.seq, record);
  }

  const hydrated: TimelineRecord[] = [];
  for (const record of bySeq.values()) {
    hydrated.push(await hydrateRecordData(sessionDir, record));
  }
  return hydrated.sort((a, b) => a.seq - b.seq);
}

/** 外置 blob 的路径：`<session>/timeline/blobs/<seq>.bin`。 */
export function blobPath(sessionDir: string, seq: number): string {
  return join(sessionDir, TIMELINE_LAYOUT.blobsDir, `${seq}.bin`);
}

/**
 * 把记录里的 `{blob:true,bytes,crc32}` 还原成原 `data`。
 *
 * blob 缺失/损坏时**保留引用**返回（而不是猜一个空值）：调用方能看到“这条记录的外置
 * 数据不可读”，与 holes 的“损坏可声明”口径一致。写入侧保证 blob 先于记录行 fsync。
 *
 * 导出原因：读口（`timeline/read-port.ts`）的**尾窗读**不走 `readTimelineEvents` 的整份
 * 归并（那是 O(全库)），但它读到的记录同样可能带外置 blob 引用 —— 同一个还原口径不能
 * 抄第二份（抄了就会分叉出「整份读能还原、尾窗读不能」这种只有长会话才碰到的洞）。
 */
export async function hydrateRecordData(
  sessionDir: string,
  record: TimelineRecord,
): Promise<TimelineRecord> {
  if (!isTimelineBlobRef(record.data)) return record;
  const ref = record.data;
  const buffer = await readFile(blobPath(sessionDir, record.seq)).catch(() => undefined);
  if (buffer === undefined) return record;
  if (buffer.length !== ref.bytes || crc32Hex(buffer) !== ref.crc32) return record;
  try {
    return { ...record, data: JSON.parse(buffer.toString('utf8')) };
  } catch {
    return record;
  }
}

/**
 * 读出一个会话的洞登记区（容错版；坏行跳过）。
 *
 * 写者打开会话时用 `HoleRegistry`（会截断撕裂尾行并补登记坏行），这里只给只读
 * 工具（自证脚本 / 未来读侧）用。
 */
/** `holes.ndjson` 的一行（带 crc）。 */
export interface HoleLine extends TimelineHole {
  v: 1;
  crc: string;
}

export function validateHoleLine(parsed: unknown): HoleLine | undefined {
  const line = parseWithCrc<HoleLine>(parsed);
  if (line === undefined || line.v !== 1) return undefined;
  if (!Number.isSafeInteger(line.from_seq) || line.from_seq < 1) return undefined;
  if (!Number.isSafeInteger(line.to_seq) || line.to_seq < line.from_seq) return undefined;
  if (typeof line.reason !== 'string' || typeof line.at !== 'number') return undefined;
  return line;
}

export async function readHoles(sessionDir: string): Promise<TimelineHole[]> {
  const result = await readCrcNdjsonFile<HoleLine>(
    join(sessionDir, TIMELINE_LAYOUT.holes),
    validateHoleLine,
  );
  return result.items.map((line) => ({
    from_seq: line.from_seq,
    to_seq: line.to_seq,
    reason: line.reason,
    at: line.at,
  }));
}

/**
 * 尽力 fsync 目录（让新建文件的目录项落盘）。
 *
 * Windows 上打开目录通常会失败；失败不影响正确性（文件本身已 fsync），因此全部吞掉。
 */
export async function fsyncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // 平台不支持目录 fsync：忽略。
  }
}

/*
 * ── 范围读（0.56 · 只开窗口内那几十个块） ────────────────────────────────────
 *
 * ## 它解决的问题
 *
 * 读侧今天把 `wal.manifest`（块目录）当不存在：任何一页都靠「整份归档 + 整份 WAL +
 * 全部块文件」凑出来。`d813eaea`（209,835 条 / 13,177 块 / 69 MB）实测整份读 4.2 s
 * （同进程第 3 次 16 s），其中 92% 花在「解全部块」。而一页 100 条只要 6 个块、
 * 一页 2000 条只要 120 个块。
 *
 * ## 这一刀的三条纪律（违反任何一条就是比现状更差的实现）
 *
 * 1. **枚举走 `readdir`，`readdir` 才是「有哪些块」的权威**。`wal.manifest` 的追加是
 *    best-effort（`blocks.ts` 里 `.catch(() => {})`），它**落后于块目录是设计允许的**，
 *    拿它枚举 ⇒ 尾部一整段 chunk 静默消失。它只配当**锚点**（`locateRangeAnchor`）。
 * 2. **不可信只许两种行为**：明确声明洞，或者降级整份读。**绝对禁止静默少给**。
 * 3. **输出必须与整份读逐条等价**：同一个 `sinceSeq`，返回的 seq 集合完全相等。
 *
 * ## 凭什么证明「没少给」（这是本模块唯一的硬保证）
 *
 * 序号空间是**精确二分覆盖**的：`1..max(seq)` 每个号恰好在一个位置（要么是一条事实行，
 * 要么是某个块里的一帧）—— 这是写侧「唯一 seq 分配点 + 块只写一次」的推论，也是
 * 0.56 设计 §1 实测的性质（204,834 帧 + 5,001 事实行 = 209,835 = `max(seq)`，零缺口）。
 *
 * 于是「窗口 `(since, hi]` 里一个都不许少」可以机械校验：
 *
 * ```
 * ∀ seq ∈ (since, hi]:  seq ∈ 本次收上来的记录  ∪  已声明且未退役的洞
 * ```
 *
 * 不成立 ⇒ **降级整份读**（{@link TimelineRangeUndecidable}），绝不允许「跳过这个块」
 * 「凑够 limit 就停」把结果变窄。`hi` 是**本次证明到的右端**：拿满 `limit` 条时它就是
 * 第 `limit` 条的 seq；没拿满时它必须是「真的没有更多可读记录」的那个右端（事实行读到
 * 文件尾 + 块目录枚举完 / 连续尾块断链）。
 *
 * ## 覆盖的三段与「归档段为什么不读」
 *
 * | 段 | 范围读怎么处理 | 为什么 |
 * | --- | --- | --- |
 * | `timeline.ndjson`（归档副本） | **不读**，但先验两条绊线 | 归档是「复制不是搬移」：`archiveNow()` 只 append、从不截断 `wal.log`（实测两者 md5 相同） |
 * | `wal.log`（事实行） | 行二分定位 + 从前向后顺读（有界） | 尾窗 256 KiB 只够尾页；中段用行二分（11 探针 / 3 ms） |
 * | `wal.blocks/*`（chunk） | 锚点 + 顺序开块 + 连续尾块规则 | 这里就是那 92% 的耗时 |
 *
 * 「归档段不读」的**前提检查**（{@link readArchiveTripline}）：① `wal.log` 首行 seq 必须
 * 是 1（搬移会截掉头部，首行 seq 立刻 > 1）；② 归档末 seq 必须 `<=` `wal.log` 末 seq
 * （归档里出现 WAL 没有的号 = 归档不是副本）。任一不成立 ⇒ 降级，**不是**无条件跳过。
 * 这两条是给「哪天归档改成搬移 + 截断」那次改动设的绊线：一改就降级，而不是静默丢掉
 * 一整段历史（丢得还特别有规律：越老的会话丢得越多）。
 *
 * ## 上界（第十一条「有界」三问）
 *
 * - **上界**：块 ≤ 窗口 seq 跨度里的块数（`RANGE_WINDOW_MAX_SEQ_SPAN = 64 × limit`，
 *   超了降级）；事实行 ≤ `RANGE_FACT_SCAN_MAX_BYTES`（4 MiB）；连续尾块重验 ≤
 *   `RANGE_TAIL_CHAIN_MAX_BLOCKS`（256 块）。三条都是常量，不随会话长大；
 * - **谁在触发**：`TimelineEventLog.read({sinceSeq, limit})`（一页一次，客户端翻页时）；
 * - **用户看得到吗**：看得到 —— 就是他正在翻的那一页。
 *
 * ## 不改什么
 *
 * 落盘格式一个字不动、不新增文件、不加新 RPC；`read()` 仍是唯一读口；
 * `readTimelineEvents()`（整份读）不删、不降级 —— 索引重建、显式修复和**本模块的降级
 * 路径**都还用它。
 */

/** 范围读的块数门槛：块数低于它时整份读只是 100 ms 量级，多一条分支只会多一处会漂的口径。 */
export const RANGE_READ_MIN_BLOCKS = 256;

/**
 * 扩窗上界（`× limit`）：`sinceSeq` 之后可能夹着洞，`limit` 条记录要跨更多 seq。
 *
 * 取 64：健康会话一页 `limit` 条记录恰好跨约 `limit` 个 seq（每个 seq 都是一条记录），
 * 留 64 倍余量给「大片已声明洞」。超过它说明定位或数据已经病到不可判，降级整份读。
 */
export const RANGE_WINDOW_MAX_SEQ_SPAN = 64;

/**
 * 事实行顺读的首窗（64 KiB ≈ 40 条事实行；不够就 ×4 扩窗，上限见下）。
 *
 * 缺省页只要几十条记录：首窗开 1 MiB 是白读（实测同一页：1 MiB 首窗读 1.94 MB / 24 ms，
 * 64 KiB 首窗读约 150 KB / 7 ms）。窗口随需要增长，总量仍受
 * {@link RANGE_FACT_SCAN_MAX_BYTES} 约束。
 */
export const RANGE_FACT_SCAN_FIRST_BYTES = 64 * 1024;

/**
 * 事实行顺读总预算（4 MiB，与 `TAIL_WINDOW_MAX_BYTES` 同一量级与含义）。
 *
 * 超过它就不猜：窗口还没覆盖满 ⇒ 降级整份读（`window_incomplete`）。
 */
export const RANGE_FACT_SCAN_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 连续尾块重验的块数上界（第十一条：任何一次 IO 都要有显式上界）。
 *
 * 为什么需要重验：`selectBlocksForSnapshot` 对 `start_seq > factBoundary` 的块只认
 * 「紧接 `cursor + 1`」的连续尾块。如果一页从**尾链中段**开始，链就必须从
 * `factBoundary` 那一端重新验一遍（否则会把「链早就断了」的块当成可读 —— 那是多给）。
 * 链上没有任何索引可借（seq → 块号只能顺序走），所以这段成本就是链长 × 单块耗时。
 *
 * 1024 块的来由：单块打开 ≈ 0.2 ms ⇒ 上界 ≈ 200 ms，仍比一次整份读（实测 6–18 s）便宜
 * 两个数量级；而 1024 块 ≈ 1.6 万帧，比「一个正在流式输出、还没写终态事实的 run」长得多。
 * 超过它说明尾部形状反常，直接降级整份读（**不许**为了快而把链的中段当成可读）。
 */
export const RANGE_TAIL_CHAIN_MAX_BLOCKS = 1024;

/**
 * 一页的绝对上界（条）。
 *
 * 超过它就不做范围读（降级整份读）：一页要 10 万条的场景本来就没有「按窗口读」的意义，
 * 顺手把 `limit × RANGE_WINDOW_MAX_SEQ_SPAN` 的算术关在安全整数范围内。
 */
export const RANGE_READ_MAX_LIMIT = 100_000;

/** 一行的物理上限（`MAX_INLINE_BYTES` 的 `data` + 元数据）：二分探针最多扩到这么大。 */
const FACT_LINE_MAX_BYTES = MAX_INLINE_BYTES + 16 * 1024;

/**
 * 二分探针次数上限与总字节上限（两次都说「不知道」就降级，不在这上面耗）。
 *
 * 次数：`log2(64 MiB / 1 B) ≈ 26`，给 64 已是两倍余量；字节：每次探针读 8–16 KiB 的窗口
 * （长行会扩窗），实测一次定位读不到 300 KiB。
 */
const FACT_PROBE_LIMIT = 64;
const FACT_PROBE_TOTAL_MAX_BYTES = 8 * 1024 * 1024;

/** `wal.log` 头部检查窗口（首行 seq 是不是 1）。 */
const WAL_HEAD_BYTES = 64 * 1024;

/** 归档副本尾窗（取「归档末 seq」）；归档行与事实行同形、同尺寸。 */
const ARCHIVE_TAIL_FIRST_BYTES = 64 * 1024;
const ARCHIVE_TAIL_MAX_BYTES = 1024 * 1024;

/** 范围读为什么会「不可判」（稳定 code；上层只按它决定要不要留痕/告警）。 */
export type TimelineRangeUndecidableReason =
  | 'invalid_cursor'
  | 'invalid_limit'
  | 'blocks_below_threshold'
  | 'archive_not_copy'
  | 'read_failed'
  | 'anchor_unavailable'
  | 'window_too_wide'
  | 'coverage_gap'
  | 'window_incomplete'
  | 'order_broken'
  | 'block_spans_fact_boundary';

/**
 * 范围读「这次不可判，请降级整份读」。
 *
 * 它**不是错误处理**，是设计的一部分（0.56 设计 §3.4 的 A 路）：调用方必须退回
 * `readTimelineEvents()`（输出与今天逐条相同）并**留痕**。把输出变窄（少给几条、
 * 跳过一个块、返回空数组）都是错的。
 */
export class TimelineRangeUndecidable extends Error {
  readonly reason: TimelineRangeUndecidableReason;

  constructor(reason: TimelineRangeUndecidableReason, detail: string) {
    super(`timeline_range_undecidable: ${reason}: ${detail}`);
    this.name = 'TimelineRangeUndecidable';
    this.reason = reason;
  }
}

/** 范围读的一次调用统计（review 三问的答案；`deb` 日志与自证脚本都看它）。 */
export interface TimelineRangeStats {
  /** 本次打开的块文件数 */
  blocks_opened: number;
  /** 本次读的块文件字节数 */
  block_bytes: number;
  /** 本次读的 `wal.log` 字节数（含定位探针） */
  fact_bytes: number;
  /** 锚点来源：`manifest` 行二分 / `first_frame` 文件名二分 */
  anchor_source: 'manifest' | 'first_frame';
  /** **块名枚举**走的是哪条路（0.56 尾部读固定开销那一单的核心指标） */
  enumeration_source: 'manifest' | 'readdir';
  /** 枚举没用 manifest 快路径时的原因（稳定 code；走了快路径 ⇒ 缺省） */
  enumeration_fallback?: string;
  /** 窗口左端（排他游标本身） */
  since_seq: number;
  /** 本次**证明到**的右端（`hi`）：`(since, hi]` 内一个都不许少 */
  window_to: number;
  /** 窗口内落在已声明（未退役）洞里的 seq 数 */
  declared_holes: number;
  /** 自证不通过的块名（这些块**照样被读**，只是它的 manifest 记账不可信） */
  unverified_blocks: string[];
  /** 命中并返回的记录数 */
  count: number;
}

/** `readTimelineRange` 的入参。 */
export interface TimelineRangeQuery {
  /** 排他游标：只返回 `seq > sinceSeq` 的记录 */
  sinceSeq: number;
  /** 页上限（上限，不是「必须给满」；真给不满必须能被覆盖算术证明） */
  limit: number;
}

/** 一次窗口内的「洞」区间（存活声明，last-wins 折叠后的）。 */
interface LiveHole {
  from_seq: number;
  to_seq: number;
}

/**
 * 读**存活**洞区间（只读；不截断、不追加 —— 读侧没有声明权）。
 *
 * 判据与折叠口径复用 `holes.ts`：`validateHoleDeclarationLine`（认 `kind:'hole_retired'`）
 * + 「同区间 last-wins，按物理行序，不看 `at`」。
 *
 * **为什么不能直接用 `readHoles`**：那个函数（`wal.ts` 的老读器）不认退役行，会把已退役
 * 的区间仍当成洞 —— 已退役意味着「这段数据逐条 CRC 通过、可读」，把它算成洞就会把
 * 「本窗口少给了一条」误判成「正常」，正是 0.56 设计最禁止的那种静默少给。
 */
async function readLiveHoles(sessionDir: string): Promise<LiveHole[]> {
  const result = await readCrcNdjsonFile<TimelineHoleDeclarationLine>(
    join(sessionDir, TIMELINE_LAYOUT.holes),
    validateHoleDeclarationLine,
  );
  const states = new Map<string, { from_seq: number; to_seq: number; retired: boolean }>();
  for (const line of result.items) {
    states.set(`${String(line.from_seq)}:${String(line.to_seq)}`, {
      from_seq: line.from_seq,
      to_seq: line.to_seq,
      retired: line.kind === 'hole_retired',
    });
  }
  const live: LiveHole[] = [];
  for (const state of states.values()) {
    if (state.retired) continue;
    live.push({ from_seq: state.from_seq, to_seq: state.to_seq });
  }
  return live;
}

/** `wal.log` 第一条完整事实行的 seq（`0` = 文件不存在/为空）。 */
async function firstFactSeqOf(path: string, size: number): Promise<number> {
  if (size <= 0) return 0;
  let window = Math.min(size, WAL_HEAD_BYTES);
  for (;;) {
    const buffer = await readFileWindow(path, 0, window);
    if (buffer === undefined) {
      throw new TimelineRangeUndecidable('read_failed', 'wal.log 头部读不出来');
    }
    const newline = buffer.indexOf(0x0a);
    if (newline !== -1) {
      const record = parseRecordLine(buffer.toString('utf8', 0, newline));
      if (record === undefined) {
        throw new TimelineRangeUndecidable(
          'archive_not_copy',
          'wal.log 首行不可解析（无法确认头部未被搬移）',
        );
      }
      return record.seq;
    }
    if (window >= size) {
      throw new TimelineRangeUndecidable('read_failed', 'wal.log 没有一行完整事实行');
    }
    if (window >= FACT_LINE_MAX_BYTES) {
      throw new TimelineRangeUndecidable('read_failed', 'wal.log 首行超过单行上限');
    }
    window = Math.min(size, Math.min(window * 4, FACT_LINE_MAX_BYTES));
  }
}

/** `wal.log` 最后一条完整事实行的 seq（尾窗读；读不出来 ⇒ 不可判）。 */
async function lastFactSeqOf(path: string, size: number): Promise<number> {
  if (size <= 0) return 0;
  const window = await readNdjsonTail(path, TAIL_WINDOW_FIRST_BYTES, TAIL_WINDOW_MAX_BYTES);
  if (window === undefined) {
    throw new TimelineRangeUndecidable('read_failed', 'wal.log 尾窗读不出来（边界不知道）');
  }
  for (let index = window.lines.length - 1; index >= 0; index -= 1) {
    const line = window.lines[index];
    if (line === undefined) continue;
    const record = parseRecordLine(line);
    if (record !== undefined) return record.seq;
  }
  throw new TimelineRangeUndecidable('read_failed', 'wal.log 尾窗里没有一条完整事实行');
}

/** 归档副本（`timeline.ndjson`）最后一条记录的 seq（`0` = 没有归档）。 */
async function lastArchivedSeqOf(sessionDir: string): Promise<number> {
  const path = join(sessionDir, TIMELINE_LAYOUT.timeline);
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || info.size <= 0) return 0;
  const window = await readNdjsonTail(path, ARCHIVE_TAIL_FIRST_BYTES, ARCHIVE_TAIL_MAX_BYTES);
  if (window === undefined) {
    throw new TimelineRangeUndecidable('read_failed', 'timeline.ndjson 尾窗读不出来');
  }
  for (let index = window.lines.length - 1; index >= 0; index -= 1) {
    const line = window.lines[index];
    if (line === undefined) continue;
    const record = parseRecordLine(line);
    if (record !== undefined) return record.seq;
  }
  throw new TimelineRangeUndecidable('read_failed', 'timeline.ndjson 尾窗里没有一条完整记录');
}

/** `wal.log` 与归档副本的重叠关系（「归档段可以不读」的两条前提）。 */
interface ArchiveTripline {
  /** `wal.log` 第一条事实行的 seq（`0` = 没有事实行） */
  walFirstSeq: number;
  /** `wal.log` 最后一条事实行的 seq（`0` = 没有事实行） */
  walLastSeq: number;
}

/**
 * 归档段「不读」的前提检查（0.56 设计 §4.1）。
 *
 * ① `wal.log` 首行 seq == 1：归档是**复制**（`archiveNow()` 只 append、从不截断 wal.log）
 *    时恒成立；改成「搬移 + 截断」之后首行 seq 立刻 > 1；
 * ② 归档末 seq <= `wal.log` 末 seq：归档里出现 WAL 已经没有的号 ⇒ 归档不是副本。
 *
 * 任一不成立 ⇒ **降级**（`archive_not_copy`）：这时「不读归档」会静默丢一整段历史。
 */
async function checkArchiveTripline(
  sessionDir: string,
  walPath: string,
  walSize: number,
): Promise<ArchiveTripline> {
  const walFirstSeq = await firstFactSeqOf(walPath, walSize);
  const walLastSeq = await lastFactSeqOf(walPath, walSize);
  const archivedLastSeq = await lastArchivedSeqOf(sessionDir);
  if (walFirstSeq > 1) {
    throw new TimelineRangeUndecidable(
      'archive_not_copy',
      `wal.log 首行 seq=${String(walFirstSeq)}（> 1：头部可能被搬移，归档段必须读）`,
    );
  }
  if (archivedLastSeq > walLastSeq) {
    throw new TimelineRangeUndecidable(
      'archive_not_copy',
      `归档末 seq=${String(archivedLastSeq)} > wal 末 seq=${String(walLastSeq)}（归档不是 wal.log 的前缀）`,
    );
  }
  return { walFirstSeq, walLastSeq };
}

/** 事实行顺读的进度（生成器没法「返回」值，所以状态写在对象里）。 */
interface FactScanState {
  bytes: number;
  /** 读到文件尾了（`true` 才能说「后面没有更多事实行」） */
  eof: boolean;
  /** 事实行 seq 是否严格升序（`false` ⇒ 顺序不可信） */
  ascending: boolean;
  /** 上一条已收的 seq（升序校验用） */
  lastSeq: number;
}

/** 一条被定位到的行（偏移 + 文本）。 */
export interface NdjsonLineAt {
  /** 行首字节偏移 */
  start: number;
  /** 行尾（含换行）之后的偏移 */
  next: number;
  /** 行文本（不含换行） */
  text: string;
}

/** 行读取的字节记账：范围读必须能说出「这次读了多少字节」。 */
export interface LineReadBudget {
  bytes: number;
  /** 总预算；超过 ⇒ `undefined`（不猜） */
  maxBytes: number;
}

// 行读取的首窗（典型事实行约 1.7 KB、manifest 行约 150 B；2 KiB 通常已含一整行）。
const LINE_FIRST_BYTES = 2 * 1024;

/**
 * 读 `offset` 处或之后的**一条完整行**。
 *
 * `skipPartial` 为 `true` 时先跳过 `offset` 落在其中的那半行，再取一整行（二分探针用：
 * 中点是随机字节，几乎不可能正好落在行首）。
 *
 * 行长超过 `maxLineBytes`（缺省 {@link FACT_LINE_MAX_BYTES} = 单条内联 `data` 上限 + 元数据；
 * `wal.manifest` 的行用 64 KiB）⇒ `undefined`：那不是这个文件该有的形状，不猜。每次真正读
 * 的字节记进 `budget`。
 */
export async function readNdjsonLineAt(
  path: string,
  offset: number,
  size: number,
  budget: LineReadBudget,
  skipPartial: boolean,
  maxLineBytes: number = FACT_LINE_MAX_BYTES,
): Promise<NdjsonLineAt | undefined> {
  let window = Math.min(LINE_FIRST_BYTES, maxLineBytes);
  for (;;) {
    const length = Math.min(window, size - offset);
    if (length <= 0) return undefined;
    const chunk = await readFileWindow(path, offset, length);
    if (chunk === undefined) return undefined;
    budget.bytes += length;
    if (budget.bytes > budget.maxBytes) return undefined;
    let from = 0;
    if (skipPartial) {
      const firstNewline = chunk.indexOf(0x0a);
      from = firstNewline === -1 ? chunk.length : firstNewline + 1;
    }
    if (from < chunk.length) {
      const newline = chunk.indexOf(0x0a, from);
      if (newline !== -1) {
        return {
          start: offset + from,
          next: offset + newline + 1,
          text: chunk.toString('utf8', from, newline),
        };
      }
    }
    // 这一窗里没有完整行（一行比窗口还长）：扩窗重读；扩到单行上限还不成就说「不知道」。
    if (offset + length >= size) return undefined; // 到文件尾仍未换行 ⇒ 残行，不是完整行
    if (window >= maxLineBytes) return undefined;
    window = Math.min(window * 4, maxLineBytes);
  }
}

/**
 * 找一个字节偏移**所在的那一行的行首**（二分探针用：中点几乎不可能正好落在行首）。
 *
 * `floor` 必须是一个已知的行首；退到它还找不到换行 ⇒ 返回 `floor`（不变式：行首之前的
 * 那一行的换行就在 `floor - 1`）。窗口从 8 KiB 起、×4 扩到 `maxLineBytes` 上限，
 * 超过 ⇒ `undefined`（不猜）。
 */
export async function findLineStartBefore(
  path: string,
  floor: number,
  mid: number,
  budget: LineReadBudget,
  maxLineBytes: number = FACT_LINE_MAX_BYTES,
): Promise<number | undefined> {
  if (mid <= floor) return floor;
  let window = Math.min(LINE_FIRST_BYTES, maxLineBytes);
  for (;;) {
    const from = Math.max(floor, mid - window);
    const length = mid - from;
    if (length <= 0) return floor;
    const chunk = await readFileWindow(path, from, length);
    if (chunk === undefined) return undefined;
    budget.bytes += length;
    if (budget.bytes > budget.maxBytes) return undefined;
    const newline = chunk.lastIndexOf(0x0a);
    if (newline !== -1) return from + newline + 1;
    if (from === floor) return floor;
    if (window >= maxLineBytes) return undefined;
    window = Math.min(window * 4, maxLineBytes);
  }
}

/**
 * 在 `wal.log` 里二分出一个**安全起点**：它之前的行，seq 全部 `<= afterSeq`。
 *
 * 与整份读的关系：整份读把 `wal.log` 从头解析到尾。这里只解析「从某个安全起点往后」的
 * 那一小段 —— 只要起点安全（它之前的行都 `<= afterSeq`），窗口内的事实行就一条都不会漏。
 *
 * 两半都必须**严格推进**，否则会在这里空转（第一版就踩过：候选行的行首被当成新的右界，
 * 而中点仍落在同一条跨行的长行里，右界再也不动 —— 探针用尽后返回了「当前最好的那一行」，
 * 于是 1..49 这几条事实行被静默跳过，最后只剩一个 `coverage_gap` 降级）：
 *
 * - 往右：`lo = 行尾`（严格大于中点）；
 * - 往左：`hi = 行首`；若行首 `<= lo`，它已经是「第一条」，直接返回；
 * - 收窄到一窗以内改用**顺序扫**（个位到几十行），彻底避开「中点卡在同一条长行里」的退化。
 */
async function locateFactStart(
  path: string,
  size: number,
  afterSeq: number,
  state: FactScanState,
): Promise<number | undefined> {
  const budget: LineReadBudget = {
    bytes: state.bytes,
    maxBytes: state.bytes + FACT_PROBE_TOTAL_MAX_BYTES,
  };
  // 游标在 0（或更早）时，事实行的起点就是文件头 —— 不必二分。
  if (afterSeq < 1) {
    state.bytes = budget.bytes;
    return 0;
  }
  let lo = 0;
  let hi = size;
  let best = size;
  let probes = 0;
  while (lo < hi) {
    if (probes >= FACT_PROBE_LIMIT) {
      state.bytes = budget.bytes;
      // 探针用尽还不收敛：不猜（调用方降级整份读）。**绝不**把当前 `best` 当起点 ——
      // 它不一定是第一条 `seq > afterSeq` 的行，那会静默跳过中间几条事实行。
      return undefined;
    }
    probes += 1;
    const mid = lo + Math.floor((hi - lo) / 2);
    // 探的是**中点所在的那一行**（而不是「中点之后的第一行」）：后者在「一行跨过中点又
    // 跨过后界」时会原地打转（实测 `wal.log` 里真有 500 KB 的长行），这里两半都严格推进。
    const lineStart = await findLineStartBefore(path, lo, mid, budget);
    if (lineStart === undefined) {
      state.bytes = budget.bytes;
      return undefined;
    }
    const line = await readNdjsonLineAt(path, lineStart, size, budget, false);
    if (line === undefined) {
      state.bytes = budget.bytes;
      return undefined;
    }
    const record = parseRecordLine(line.text);
    if (record === undefined || record.seq <= afterSeq) {
      lo = Math.max(line.next, lo + 1);
      continue;
    }
    best = line.start;
    if (line.start <= lo) {
      state.bytes = budget.bytes;
      return best;
    }
    hi = line.start;
  }
  state.bytes = budget.bytes;
  return best;
}

/**
 * 从 `[offset, size)` **顺序**读出 `seq > afterSeq` 的事实行（有界：总字节 ≤ 4 MiB）。
 *
 * 只做一件事：把窗口里的事实行按 seq 升序吐出来。**不判 read 的其它口径**（洞、块、
 * 快照自洽）—— 那些由调用方的覆盖算术与连续尾块规则决定。
 *
 * 三个「不猜」的出口都让 `state.eof` 保持 `false`：读不满、碰到超过单行上限的长行、
 * 预算用完。那时调用方**不能说「后面没有事实行了」**，只能降级整份读。
 */
async function* iterateFactsFrom(args: {
  path: string;
  size: number;
  offset: number;
  sinceSeq: number;
  maxSeq: number;
  state: FactScanState;
}): AsyncGenerator<TimelineRecord> {
  const { path, size, sinceSeq, maxSeq, state } = args;
  let position = args.offset;
  let window = RANGE_FACT_SCAN_FIRST_BYTES;
  while (position < size) {
    const length = Math.min(window, size - position);
    const buffer = await readFileWindow(path, position, length);
    if (buffer === undefined) return; // 读不满（文件变短）：`eof` 保持 false ⇒ 上层降级
    state.bytes += length;
    let cursor = 0;
    let consumed = 0;
    while (cursor < buffer.length) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline === -1) break;
      const text = buffer.toString('utf8', cursor, newline);
      cursor = newline + 1;
      consumed = cursor;
      const record = parseRecordLine(text);
      if (record === undefined) continue; // 坏行：与整份读同口径忽略
      if (record.seq <= sinceSeq) continue; // 起点稍微偏左：无害
      if (record.seq > maxSeq) return; // 窗口右端已过（再多也没有意义）
      if (record.seq <= state.lastSeq) {
        state.ascending = false;
        return;
      }
      state.lastSeq = record.seq;
      yield record;
    }
    if (consumed === 0) {
      // 整个窗口没有一行完整（一行比窗口还长）：扩窗；到上限就 `eof` 保持 false ⇒ 降级。
      if (position + length >= size) return;
      if (window >= FACT_LINE_MAX_BYTES) return;
      window = Math.min(window * 4, FACT_LINE_MAX_BYTES);
      continue;
    }
    position += consumed;
    if (position >= size) {
      state.eof = true;
      return;
    }
    if (state.bytes >= RANGE_FACT_SCAN_MAX_BYTES) return; // 预算用完：`eof` 保持 false
    // 这一窗还不够（消费者又向下一项）：扩窗再读（总量仍受 RANGE_FACT_SCAN_MAX_BYTES 约束）。
    window = Math.min(window * 4, RANGE_FACT_SCAN_MAX_BYTES);
  }
  state.eof = true;
}

/** 顺序开块时的进度（同上：状态写在对象里）。 */
interface BlockScanState {
  opened: number;
  bytes: number;
  /** 自证不通过的块名（照样读，只是记账不可信） */
  unverified: string[];
  /** 枚举完了 / 连续尾块断链 ⇒ 没有更多**参与本趟快照**的块了 */
  exhausted: boolean;
}

/**
 * 从 `source` 的 `startIndex` 起**顺序**开块，按 `selectBlocksForSnapshot` 的同一口径吐出窗口内的帧。
 *
 * 纳入规则逐条对齐 `wal.ts#selectBlocksForSnapshot`（全文最重要的两行）：
 *
 * - `end_seq <= factBoundary` 的块**无条件纳入**（封块早于那条事实，必然已完整落盘）；
 * - `start_seq > factBoundary` 的块只认**紧接 `cursor + 1`** 的连续尾块，断链即止
 *   （否则会给出比事实还新的 chunk，破坏「先事实后块」的自洽快照，客户端当场报假缺口）。
 *
 * 与整份读的差别只有一处、且更严：块内帧必须 seq 升序、块的 `start_seq` 必须随文件名
 * 递增，否则抛 `order_broken` 降级（整份读对此不做判定，因为它本来就在读全部）。
 *
 * 块的**名字从哪来**由 `source` 决定（0.56 manifest 快路径 / readdir 兜底）：
 * 这里只按下标要名字，不认识 manifest —— 「枚举」与「开块」是两件事，别混。
 */
async function* iterateBlocksFrom(args: {
  blocksDir: string;
  source: BlockNameSource;
  startIndex: number;
  sinceSeq: number;
  maxSeq: number;
  factBoundary: number;
  /** 本次最多开几个块（第十一条：显式上界，见 `readTimelineRange`） */
  blockOpenMax: number;
  reader: ManifestForwardReader | undefined;
  state: BlockScanState;
}): AsyncGenerator<TimelineRecord> {
  const { blocksDir, source, sinceSeq, maxSeq, factBoundary, blockOpenMax, reader, state } = args;
  let cursor = factBoundary;
  let lastStart = 0;
  for (let index = args.startIndex; ; index += 1) {
    const enumerated: EnumeratedBlock | undefined = await source.at(index);
    if (enumerated === undefined) {
      // 「枚举完了」只有在 `tailProven` 时才等于「后面真的没有块」；
      // 没据（manifest 尾部核对没能给出结论）⇒ 不许声称到尾，留给覆盖算术降级。
      state.exhausted = source.tailProven;
      return;
    }
    const name = enumerated.name;
    if (state.opened >= blockOpenMax) {
      throw new TimelineRangeUndecidable(
        'window_too_wide',
        `开了 ${String(state.opened)} 个块还没覆盖满窗口`,
      );
    }
    const buffer = await readFile(join(blocksDir, name)).catch(() => undefined);
    if (buffer === undefined) {
      // 文件读不出来（被删 / 权限）：与整份读同口径「这个块不在」，但记账上留痕。
      state.unverified.push(name);
      continue;
    }
    const decode = decodeChunkBlock(buffer);
    state.opened += 1;
    state.bytes += buffer.length;

    // 块内帧必须 seq 升序（解码序 = 写入序）。不升序 ⇒ 顺序不可信，不猜。
    let previous = 0;
    for (const record of decode.records) {
      if (record.seq <= previous) {
        throw new TimelineRangeUndecidable('order_broken', `块 ${name} 内帧 seq 不升序`);
      }
      previous = record.seq;
    }
    // 逐块自证（①首末 seq ②条数 ③整块 crc ④完整性）：**证据，不是过滤条件**。
    //
    // 条目从两处来：manifest 快路径的条目由枚举顺手给（`enumerated.entry`）；
    // readdir 兜底路沿用 `ManifestForwardReader` 的顺序游标（锚点命中 manifest 时才有）。
    const entry =
      enumerated.entry ?? (reader === undefined ? undefined : await reader.entryFor(name));
    if (entry !== undefined && !verifyBlockAgainstManifest(buffer, decode, entry).ok) {
      state.unverified.push(name);
    }

    const first = decode.records[0];
    const last = decode.records[decode.records.length - 1];
    const start = first?.seq ?? 0;
    const end = last?.seq ?? 0;
    if (start < 1 || end < start) continue; // 与 selectBlocksForSnapshot 同口径：空块/全坏块不参与
    if (lastStart > 0 && start <= lastStart) {
      throw new TimelineRangeUndecidable(
        'order_broken',
        `块 ${name} 的 start_seq 没有随文件名递增`,
      );
    }
    if (start <= factBoundary && end > factBoundary) {
      // 块跨越事实边界：写侧「先封块、再分配事实 seq」不成立 ⇒ 快照口径不可判。
      throw new TimelineRangeUndecidable(
        'block_spans_fact_boundary',
        `块 ${name} 覆盖 ${String(start)}–${String(end)}，事实边界 ${String(factBoundary)} 落在其中`,
      );
    }
    if (end <= factBoundary) {
      // 边界之内：无条件纳入。
    } else if (start <= cursor + 1) {
      if (end > cursor) cursor = end;
    } else {
      // 连续尾块断链：后面都不参与本趟快照（与 selectBlocksForSnapshot 的 continue 等价）。
      state.exhausted = true;
      return;
    }
    lastStart = start;
    if (start > maxSeq) {
      throw new TimelineRangeUndecidable(
        'window_too_wide',
        `窗口右端已过（块 ${name} 从 ${String(start)} 起，上限 ${String(maxSeq)}）`,
      );
    }
    for (const record of decode.records) {
      if (record.seq <= sinceSeq) continue;
      // 窗口右端之外（一段块可以比窗口尾部多出几帧）：不再往下给，也不宣称「已到尾」。
      if (record.seq > maxSeq) return;
      yield record;
    }
  }
}

/**
 * 一次范围读的块名枚举 + 起点定位（0.56 尾部读的固定开销）。
 *
 * 两条路，**输出逐条等价**：
 *
 * | 路 | 什么时候走 | 枚举成本 |
 * | --- | --- | --- |
 * | `manifest` | manifest 存在、够长、锚点 / 邻域 / 首帧 / 链首全部可判 | 只读窗口内那几条（几个 8 KiB 窗），**0 次 readdir** |
 * | `readdir` | 上面任一条不成立（manifest 缺失 / 落后 / 坏 / 小会话） | 今天的 `listBlockFiles` + 文件名二分，**1 次 readdir** |
 *
 * 快路径为什么可以「不枚举全量」：见 `blocks.ts` 顶部「块名枚举」那段长注释（枚举不是
 * 判据，覆盖算术才是）。这里只负责**决定走哪条**并把「起点」翻译成各自的下标 / 偏移。
 *
 * 六条判据全在 `blocks.ts#openManifestNameSource` 里；这里只保证**任何一条不成立就整条
 * 退回 readdir**，不做「差不多就行」的中间态。
 */
async function locateRangeBlocks(
  sessionDir: string,
  sinceSeq: number,
  factBoundary: number,
  /** `true` = 跳过 manifest 快路径（manifest 已被判定不可信时的兜底重来） */
  forceReaddir = false,
): Promise<{
  source: BlockNameSource;
  reader: ManifestForwardReader | undefined;
  anchorSource: 'manifest' | 'first_frame';
  /** 快路径没走成的原因（稳定 code；只进 debug 日志） */
  fallback?: string;
}> {
  const fast = forceReaddir
    ? ({ ok: false, reason: 'manifest_untrusted' } as const)
    : await openManifestNameSource({
        sessionDir,
        sinceSeq,
        factBoundary,
        minBlocks: RANGE_READ_MIN_BLOCKS,
      });
  if (fast.ok) {
    blockEnumerationCounters.manifest += 1;
    return { source: fast.source, reader: undefined, anchorSource: 'manifest' };
  }

  blockEnumerationCounters.readdirFallback += 1;
  const blocksDir = join(sessionDir, TIMELINE_LAYOUT.walBlocks);
  // 兜底：枚举**只走 readdir**（manifest 会落后于块目录，拿它枚举会静默丢掉尾部一整段 chunk）。
  const names = await listBlockFiles(blocksDir);
  if (names.length < RANGE_READ_MIN_BLOCKS) {
    throw new TimelineRangeUndecidable(
      'blocks_below_threshold',
      `${String(names.length)} < ${String(RANGE_READ_MIN_BLOCKS)}`,
    );
  }
  const anchor = await locateRangeAnchor(sessionDir, names, sinceSeq);
  if (anchor === undefined) {
    throw new TimelineRangeUndecidable('anchor_unavailable', 'manifest 与文件名二分都定位不到起点');
  }
  // 起点若落在「事实边界之后」的**尾链中段**，链必须从边界那一端重新验：
  // 否则会把「链早就断了」的块当成可读（那是多给，与整份读不等价）。
  let startIndex = anchor.index;
  const anchorFirstSeq = await blockFirstFrameSeq(sessionDir, anchor.block);
  if (anchorFirstSeq === undefined) {
    throw new TimelineRangeUndecidable('anchor_unavailable', `块 ${anchor.block} 首帧读不出来`);
  }
  if (anchorFirstSeq > factBoundary + 1) {
    const tailStart = await locateTailChainStart(sessionDir, names, factBoundary);
    if (tailStart === undefined) {
      throw new TimelineRangeUndecidable('anchor_unavailable', '连续尾块的链首定位不到');
    }
    startIndex = Math.min(startIndex, tailStart);
  }
  return {
    source: new ArrayNameSource(names, startIndex),
    reader:
      anchor.source === 'manifest' && anchor.manifestPosition !== undefined
        ? new ManifestForwardReader(
            join(sessionDir, TIMELINE_LAYOUT.walManifest),
            anchor.manifestPosition,
            (await stat(join(sessionDir, TIMELINE_LAYOUT.walManifest)).catch(() => undefined))
              ?.size,
          )
        : undefined,
    anchorSource: anchor.source,
    fallback: fast.reason,
  };
}

/**
 * 读一个会话的**一页**（`seq > sinceSeq` 的前 `limit` 条），只开窗口内那几个块。
 *
 * 返回 `records` 与整份读 `readTimelineEvents()` **逐条等价**（同一个 `sinceSeq`，
 * seq 集合完全相等）；不可判时抛 {@link TimelineRangeUndecidable}，调用方降级整份读
 * + 留痕（**不许**把异常吞成空数组，那就是静默少给）。
 *
 * 不做的事：不写任何文件（不截断撕裂尾帧、不登记洞 —— 读侧没有声明权）、
 * 不新增落盘格式、不读 `timeline.idx`（索引永不当判据）。
 */
export async function readTimelineRange(
  sessionDir: string,
  query: TimelineRangeQuery,
): Promise<{ records: TimelineRecord[]; stats: TimelineRangeStats }> {
  try {
    return await readTimelineRangeAttempt(sessionDir, query, false);
  } catch (error) {
    if (!(error instanceof ManifestUntrustedError)) throw error;
    // manifest 在被枚举到的那一段里出现了**过不了校验的行** ⇒ 整条改走 readdir
    // 兜底重来（**只重试一次**，且只在 manifest 快路径上才可能走到这里）。
    //
    // 为什么不是「跳过着这一条继续」：坏行意味着「这条 manifest 的记账不可信」，
    // 跳过后无法知道它是否本来就该有一条、覆盖了哪些 seq —— 那正是静默少给的入口。
    // 重来一次花的是本页那点时间，不是整份读。
    blockEnumerationCounters.readdirFallback += 1;
    return readTimelineRangeAttempt(sessionDir, query, true);
  }
}

/** {@link readTimelineRange} 的一次尝试（`forceReaddir` 用于 manifest 不可信时的兜底重来）。 */
async function readTimelineRangeAttempt(
  sessionDir: string,
  query: TimelineRangeQuery,
  forceReaddir: boolean,
): Promise<{ records: TimelineRecord[]; stats: TimelineRangeStats }> {
  const since = Number.isFinite(query.sinceSeq) ? Math.floor(query.sinceSeq) : Number.NaN;
  const limit = Number.isFinite(query.limit) ? Math.floor(query.limit) : Number.NaN;
  if (!Number.isSafeInteger(since) || since < 0) {
    throw new TimelineRangeUndecidable('invalid_cursor', String(query.sinceSeq));
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TimelineRangeUndecidable('invalid_limit', String(query.limit));
  }
  // 离谱的 `limit`（一页要 10 万条以上）本来就没有范围读的意义，直接让上层整份读 ——
  // 顺手把 `limit × 64` 的算术关在安全整数范围内。
  if (limit > RANGE_READ_MAX_LIMIT) {
    throw new TimelineRangeUndecidable(
      'invalid_limit',
      `${String(limit)} > ${String(RANGE_READ_MAX_LIMIT)}`,
    );
  }
  // 第十一条：这次调用的三条上界（块数 / seq 跨度 / 字节）——
  // 块数由 `names.length` 决定（低于门槛整份读更快），seq 跨度由 `maxSeq` 收口，
  // 开块数由 `blockOpenMax` 收口（每块至少 1 帧 ⇒ 健康会话远小于它）。
  const maxSeq = since + limit * RANGE_WINDOW_MAX_SEQ_SPAN;
  const blockOpenMax = RANGE_TAIL_CHAIN_MAX_BLOCKS + limit * 2;

  const blocksDir = join(sessionDir, TIMELINE_LAYOUT.walBlocks);
  const walPath = join(sessionDir, TIMELINE_LAYOUT.walLog);
  const walSize = (await stat(walPath).catch(() => undefined))?.size ?? 0;
  const tripline = await checkArchiveTripline(sessionDir, walPath, walSize);
  const factBoundary = tripline.walLastSeq;

  // ── 枚举 + 定位：manifest 快路径（**不 readdir**）→ readdir 兜底（今天的行为）
  const located = await locateRangeBlocks(sessionDir, since, factBoundary, forceReaddir);
  const source = located.source;
  const startIndex = 0;
  const reader = located.reader;
  const anchorSource = located.anchorSource;

  const factState: FactScanState = { bytes: 0, eof: walSize <= 0, ascending: true, lastSeq: since };
  const factOffset = walSize <= 0 ? 0 : await locateFactStart(walPath, walSize, since, factState);
  if (factOffset === undefined) {
    throw new TimelineRangeUndecidable('anchor_unavailable', 'wal.log 行二分定位不到安全起点');
  }

  const blockState: BlockScanState = { opened: 0, bytes: 0, unverified: [], exhausted: false };

  const facts = iterateFactsFrom({
    path: walPath,
    size: walSize,
    offset: factOffset,
    sinceSeq: since,
    maxSeq,
    state: factState,
  });
  const blocks = iterateBlocksFrom({
    blocksDir,
    source,
    startIndex,
    sinceSeq: since,
    maxSeq,
    factBoundary,
    blockOpenMax,
    reader,
    state: blockState,
  });

  // ── 归并：两路都按 seq 升序，同 seq 时**块帧胜**（与 readTimelineEvents 的覆盖顺序一致：
  // `Map.set` 的先后是「归档副本 → wal.log → 块帧」，所以同 seq 时最后写进去的块帧赢）。
  const collected = new Map<number, TimelineRecord>();
  let fact = await nextOrUndefined(facts);
  let block = await nextOrUndefined(blocks);
  let high = 0;
  while (collected.size < limit) {
    if (fact === undefined && block === undefined) break;
    const factRecord = fact;
    const blockRecord = block;
    if (
      factRecord !== undefined &&
      blockRecord !== undefined &&
      factRecord.seq === blockRecord.seq
    ) {
      collected.set(blockRecord.seq, blockRecord);
      high = blockRecord.seq;
      fact = await nextOrUndefined(facts);
      block = await nextOrUndefined(blocks);
      continue;
    }
    if (
      blockRecord === undefined ||
      (factRecord !== undefined && factRecord.seq < blockRecord.seq)
    ) {
      const record = factRecord as TimelineRecord;
      collected.set(record.seq, record);
      high = record.seq;
      fact = await nextOrUndefined(facts);
      continue;
    }
    collected.set(blockRecord.seq, blockRecord);
    high = blockRecord.seq;
    block = await nextOrUndefined(blocks);
  }

  // ── 覆盖算术：「拿满 limit」时证明到第 limit 条；「没拿满」时必须证明后面真的没有了。
  if (collected.size < limit) {
    if (!factState.ascending || factState.eof !== true || !blockState.exhausted) {
      throw new TimelineRangeUndecidable(
        'window_incomplete',
        `只收到 ${String(collected.size)} 条：事实行=${factState.eof ? '已到尾' : '未到尾'}、块=${blockState.exhausted ? '已枚举完' : '未枚举完'}`,
      );
    }
  }
  if (!factState.ascending) {
    throw new TimelineRangeUndecidable('order_broken', 'wal.log 事实行 seq 不升序');
  }

  const holes = await readLiveHoles(sessionDir);
  let declaredHoles = 0;
  if (high > since) {
    const holeSeqs = new Set<number>();
    for (const hole of holes) {
      const from = Math.max(hole.from_seq, since + 1);
      const to = Math.min(hole.to_seq, high);
      for (let seq = from; seq <= to; seq += 1) holeSeqs.add(seq);
    }
    for (let seq = since + 1; seq <= high; seq += 1) {
      if (collected.has(seq)) continue;
      if (holeSeqs.has(seq)) {
        declaredHoles += 1;
        continue;
      }
      // 窗口里有一个 seq 既没有记录、也没被声明成洞 ⇒ 本次窗口不可信，**不许少给**。
      throw new TimelineRangeUndecidable(
        'coverage_gap',
        `seq ${String(seq)} 在窗口 (${String(since)}, ${String(high)}] 内既无记录也未声明为洞`,
      );
    }
  }

  const records: TimelineRecord[] = [];
  for (const record of collected.values()) {
    if (records.length >= limit) break;
    records.push(await hydrateRecordData(sessionDir, record));
  }

  return {
    records,
    stats: {
      blocks_opened: blockState.opened,
      block_bytes: blockState.bytes,
      fact_bytes: factState.bytes,
      anchor_source: anchorSource,
      enumeration_source: source.kind,
      enumeration_fallback: located.fallback,
      since_seq: since,
      window_to: high,
      declared_holes: declaredHoles,
      unverified_blocks: blockState.unverified,
      count: records.length,
    },
  };
}

/** 取生成器的下一项；`done` ⇒ `undefined`。 */
async function nextOrUndefined<T>(iterator: AsyncGenerator<T>): Promise<T | undefined> {
  const result = await iterator.next();
  return result.done === true ? undefined : result.value;
}
