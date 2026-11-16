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
  isTimelineBlobRef,
  TIMELINE_LAYOUT,
  type TimelineBlockEntry,
  type TimelineHole,
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
}

/**
 * 读一个「每行都是带 crc 的 JSON」的 ndjson 文件。
 *
 * `validate` 缺省只做 CRC 校验；需要形状校验的调用方（时间线记录、洞登记）自带判定。
 */
export async function readCrcNdjsonFile<T extends object>(
  path: string,
  validate: (parsed: unknown) => T | undefined = (parsed) => parseWithCrc<T>(parsed),
): Promise<CrcLineReadResult<T>> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch {
    return { items: [], invalid: [], size: 0 };
  }
  const items: T[] = [];
  const invalid: NdjsonInvalid[] = [];
  let lineStart = 0;
  let lastNewline = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
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
}

/** 读一个时间线记录 ndjson 文件；不存在 ⇒ 空结果（缺文件不是错误）。 */
export async function readNdjsonFile(path: string): Promise<NdjsonReadResult> {
  const result = await readCrcNdjsonFile<TimelineRecord>(path, validateRecord);
  return {
    records: result.items,
    invalid: result.invalid,
    size: result.size,
    ...(result.truncateTo !== undefined ? { truncateTo: result.truncateTo } : {}),
  };
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
 */
export async function readTimelineEvents(sessionDir: string): Promise<TimelineRecord[]> {
  const bySeq = new Map<number, TimelineRecord>();

  // ① 事实源先读：这两处决定了本趟快照的边界（`factBoundaryOf`）。
  const archived = await readNdjsonFile(join(sessionDir, TIMELINE_LAYOUT.timeline));
  for (const record of archived.records) bySeq.set(record.seq, record);
  const wal = await readNdjsonFile(join(sessionDir, TIMELINE_LAYOUT.walLog));
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
