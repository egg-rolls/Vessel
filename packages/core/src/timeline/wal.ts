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

import { open, readdir, readFile } from 'node:fs/promises';
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
 * 读出一个会话的全部 timeline 事件（按 `seq` 升序）。
 *
 * 三个来源合并、按 seq 去重（同一条在归档副本与 WAL 副本里逐字节相同）：
 * `timeline.ndjson`（归档）→ `wal.blocks/*.wblk`（chunk）→ `wal.log`（WAL 原文，最后覆盖）。
 * 坏行/坏帧**不在这里登记**（读侧无写权限）；写者打开会话时会登记。
 */
export async function readTimelineEvents(sessionDir: string): Promise<TimelineRecord[]> {
  const bySeq = new Map<number, TimelineRecord>();

  const archived = await readNdjsonFile(join(sessionDir, TIMELINE_LAYOUT.timeline));
  for (const record of archived.records) bySeq.set(record.seq, record);

  for (const block of await readAllBlocks(sessionDir)) {
    for (const record of block.decode.records) bySeq.set(record.seq, record);
  }

  const wal = await readNdjsonFile(join(sessionDir, TIMELINE_LAYOUT.walLog));
  for (const record of wal.records) bySeq.set(record.seq, record);

  const hydrated: TimelineRecord[] = [];
  for (const record of bySeq.values()) {
    hydrated.push(await hydrateBlob(sessionDir, record));
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
 */
async function hydrateBlob(sessionDir: string, record: TimelineRecord): Promise<TimelineRecord> {
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
