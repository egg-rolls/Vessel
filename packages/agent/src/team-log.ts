/**
 * Team 只追加日志（`log.ndjson`，0.19 S3）。
 *
 * - 每个 Team 一个文件、进程内一条串行写链；append 顺序 = 行顺序；
 * - 首次写入前修复崩溃残留半行（截断到最后一个完整换行）；
 * - 只用 `appendFile` 追加，**不用 atomicWrite**（只追加，不重写整文件）；
 * - 读有界（尾部窗口 ≤ 8 MiB）、坏行 / 半行跳过并 warning；
 * - 不做跨进程互斥：同一 dataDir 只允许一个写者（见计划 §4.3）。
 *
 * @module @vessel-agent/agent
 */

import { appendFile, chmod, type FileHandle, mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Logger, noopLogger } from '@vessel-agent/core';
import { normalizeRefs } from './refs.js';
import type { TeamLogEntry, TeamLogReadWindow } from './types.js';

/** 有界读：单次最多读取的字节数（尾读窗口 / 回扫分块大小） */
export const MAX_LOG_READ_BYTES = 8 * 1024 * 1024;
/** `before` 游标回扫上限：超过即认为历史超出本地保留窗口。 */
export const TEAM_LOG_BACKSCAN_MAX_BYTES = 64 * 1024 * 1024;
/** 读取缺省条数 */
export const DEFAULT_LOG_READ_LIMIT = 100;
/** 读取最大条数 */
export const MAX_LOG_READ_LIMIT = 1000;

/** 半行恢复的初始尾窗 */
const TAIL_WINDOW_BYTES = 64 * 1024;
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

/**
 * `teams.get` 的 `before` 在回扫上限内找不到。
 *
 * gateway 把它映射为 `conflict` + `details.reason = "cursor_out_of_window"`；
 * 不能用 `not_found`，后者只表示 Team 本身不存在。
 */
export class TeamLogCursorOutOfWindowError extends Error {
  readonly code = 'cursor_out_of_window';

  constructor(message = 'team log cursor is outside the readable window') {
    super(message);
    this.name = 'TeamLogCursorOutOfWindowError';
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 宽松结构校验：坏行 / 截断行 / 非 JSON 行一律返回 null */
function parseEntry(line: string): TeamLogEntry | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.message_id !== 'string' || parsed.message_id === '') return null;
    if (typeof parsed.team_id !== 'string' || parsed.team_id === '') return null;
    if (typeof parsed.from !== 'string') return null;
    if (!isStringArray(parsed.to)) return null;
    if (!isStringArray(parsed.mentions)) return null;
    if (typeof parsed.content !== 'string') return null;
    if (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) return null;
    const kind = parsed.kind;
    if (kind !== 'post' && kind !== 'mention' && kind !== 'system' && kind !== 'reply') return null;
    const entry: TeamLogEntry = {
      message_id: parsed.message_id,
      team_id: parsed.team_id,
      from: parsed.from,
      to: parsed.to,
      mentions: parsed.mentions,
      content: parsed.content,
      ts: parsed.ts,
      kind,
    };
    // 旧行没有 conversation_id → 读成 undefined，不报错。
    if (typeof parsed.conversation_id === 'string' && parsed.conversation_id !== '') {
      entry.conversation_id = parsed.conversation_id;
    }
    const systemEvent = parsed.system_event;
    if (
      systemEvent === 'join' ||
      systemEvent === 'leave' ||
      systemEvent === 'rotate' ||
      systemEvent === 'archive' ||
      systemEvent === 'budget_override' ||
      systemEvent === 'create' ||
      systemEvent === 'fork' ||
      systemEvent === 'retract'
    ) {
      entry.system_event = systemEvent;
    }
    // 撤回 tombstone 的目标；只接受非空 string，其它值忽略。
    if (typeof parsed.retracted_message_id === 'string' && parsed.retracted_message_id !== '') {
      entry.retracted_message_id = parsed.retracted_message_id;
    }
    // 附件引用（0.52）：旧行没有该键 → 不赋值（`undefined`），不报错。
    // 读侧再归一一次（丢弃坏条目 / 超条数），不因单条脏 refs 判整行为坏行。
    const refs = normalizeRefs(parsed.refs);
    if (refs.length > 0) entry.refs = refs;
    return entry;
  } catch {
    return null;
  }
}

/** 读满指定字节区间；文件缩短时返回实际读到的前缀。 */
async function readRange(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

/**
 * 文件最后一个完整行结束的位置（含换行）。
 *
 * 崩溃可能留下无换行的半行；读侧与 `repairPartialTail` 一致地忽略它。
 * 没有任何完整行时返回 0。
 */
async function findCompleteEnd(handle: FileHandle, size: number): Promise<number> {
  if (size <= 0) return 0;
  const lastByte = await readRange(handle, size - 1, 1);
  if (lastByte.length === 1 && lastByte[0] === NEWLINE) return size;
  let window = Math.min(TAIL_WINDOW_BYTES, size);
  for (;;) {
    const start = size - window;
    const buffer = await readRange(handle, start, window);
    const lastNewline = buffer.lastIndexOf(NEWLINE);
    if (lastNewline >= 0) return start + lastNewline + 1;
    if (start === 0) return 0;
    window = Math.min(window * 8, size);
  }
}

/**
 * 若文件末尾不是换行，截断到最后一个完整换行。
 * @returns 截断后的文件大小（文件不存在返回 0）
 */
async function repairPartialTail(path: string): Promise<number> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
  if (size <= 0) return size;

  const handle = await open(path, 'r+');
  try {
    let window = Math.min(TAIL_WINDOW_BYTES, size);
    for (;;) {
      const start = size - window;
      const buffer = Buffer.alloc(window);
      await handle.read(buffer, 0, window, start);
      // 窗口覆盖到文件尾且最后一字节是换行：文件完整。
      if (start + window === size && buffer[window - 1] === NEWLINE) return size;
      const lastNewline = buffer.lastIndexOf(NEWLINE);
      if (lastNewline >= 0) {
        const truncateTo = start + lastNewline + 1;
        await handle.truncate(truncateTo);
        return truncateTo;
      }
      // 整个窗口没有换行：单条记录可能超过窗口，扩大；到底则清空。
      if (start === 0) {
        await handle.truncate(0);
        return 0;
      }
      window = Math.min(window * 8, size);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

/** 构造选项 */
export interface TeamLogWriterOptions {
  /** `log.ndjson` 绝对路径 */
  path: string;
  logger?: Logger;
  /** 每次 append 后 fsync；缺省 true（测试可关） */
  durable?: boolean;
}

/** 读选项 */
export interface TeamLogReadOptions {
  /** 返回最后 N 条；缺省 100，最大 1000，0 返回空 */
  limit?: number;
}

/**
 * 单个 `log.ndjson` 的串行追加写者。
 *
 * 同一实例上的 append 严格按调用顺序落盘；read 先等待已入队写入排空。
 */
export class TeamLogWriter {
  readonly path: string;
  private readonly logger: Logger;
  private readonly durable: boolean;
  /** 首次写入前的初始化（mkdir + 半行修复 + 建文件） */
  private ready?: Promise<void>;
  /** 永不 reject 的串行尾链 */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: TeamLogWriterOptions) {
    if (typeof options.path !== 'string' || options.path === '') {
      throw new Error('TeamLogWriter requires a non-empty path');
    }
    this.path = options.path;
    this.logger = options.logger ?? noopLogger;
    this.durable = options.durable ?? true;
  }

  /** 追加一行；顺序即调用顺序，失败向调用方 reject */
  append(entry: TeamLogEntry): Promise<void> {
    let line: string;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch (error) {
      return Promise.reject(error);
    }
    const run = async (): Promise<void> => {
      await this.ensureReady();
      await appendFile(this.path, line, { encoding: 'utf8', mode: 0o600 });
      if (this.durable) await this.sync();
    };
    const task = this.writeChain.then(run, run);
    this.writeChain = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  /**
   * 有界尾读：只读文件尾部 ≤ 8 MiB，返回文件顺序的最后 `limit` 条。
   * 坏行 / 截断行跳过；文件不存在返回空。
   */
  async read(options: TeamLogReadOptions = {}): Promise<TeamLogEntry[]> {
    return (await this.readWindow(options)).entries;
  }

  /**
   * 有界分页读：从文件尾部向前按块扫描。
   *
   * - 无 `before`：只读尾部 8 MiB（与旧 `read` 一致），返回最后 `limit` 条；
   * - 有 `before`：跳过更新的条目，定位 `message_id` 后继续取更早的 `limit` 条；
   *   最多回扫 `TEAM_LOG_BACKSCAN_MAX_BYTES`，找不到抛
   *   `TeamLogCursorOutOfWindowError`。
   * - `hasMore` 表示窗口之前是否还有日志；一页可以因回扫预算少于 `limit`。
   *
   * 按字节分块、按换行切分，避免多字节字符被块边界截断。
   */
  async readWindow(
    options: TeamLogReadOptions & { before?: string } = {},
  ): Promise<TeamLogReadWindow> {
    const limit = clampLimit(options.limit);
    if (limit === 0) return { entries: [], hasMore: false };
    await this.writeChain.catch(() => {});

    const before = options.before;
    const empty: TeamLogReadWindow = { entries: [], hasMore: false };

    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch (error) {
      if (isNotFound(error)) {
        if (before !== undefined) throw new TeamLogCursorOutOfWindowError();
        return empty;
      }
      throw error;
    }
    if (size <= 0) {
      if (before !== undefined) throw new TeamLogCursorOutOfWindowError();
      return empty;
    }

    const handle = await open(this.path, 'r');
    try {
      const end = await findCompleteEnd(handle, size);
      if (end <= 0) {
        if (before !== undefined) throw new TeamLogCursorOutOfWindowError();
        return empty;
      }

      // 尾读只允许一个 8 MiB 窗口；游标翻页可按 8 MiB 分块回扫到 64 MiB。
      const scanBudget = before === undefined ? MAX_LOG_READ_BYTES : TEAM_LOG_BACKSCAN_MAX_BYTES;
      const targetCount = limit + 1; // 多取一条判断窗口前是否还有日志
      // 按新 → 旧收集；最后反转成文件顺序。
      const collected: TeamLogEntry[] = [];
      let cursorFound = before === undefined;
      let reachedStart = false;
      let scanned = 0;
      let pos = end;
      let pendingSuffix: Buffer | undefined;
      let stop = false;
      let malformed = 0;

      const consider = (line: Buffer): void => {
        if (stop) return;
        const entry = parseEntry(line.toString('utf8'));
        if (entry === null) {
          malformed += 1;
          return;
        }
        if (!cursorFound) {
          if (entry.message_id === before) cursorFound = true;
          return;
        }
        collected.push(entry);
        if (collected.length >= targetCount) stop = true;
      };

      while (pos > 0 && scanned < scanBudget && !stop) {
        const start = Math.max(pos - MAX_LOG_READ_BYTES, end - scanBudget, 0);
        const length = pos - start;
        if (length <= 0) break;
        const buffer = await readRange(handle, start, length);
        scanned += buffer.length;
        if (buffer.length === 0) {
          if (start === 0) reachedStart = true;
          break;
        }

        const firstNewline = buffer.indexOf(NEWLINE);
        const lastNewline = buffer.lastIndexOf(NEWLINE);
        if (firstNewline < 0) {
          // 整块落在同一条超长行内：接在右侧片段前面，等左侧块补全。
          pendingSuffix = Buffer.concat([buffer, pendingSuffix ?? EMPTY]);
          pos = start;
          if (start === 0) reachedStart = true;
          continue;
        }

        // 右边界行：本块尾部片段 + 右侧已扫描片段。
        if (pos < end && !stop) {
          const boundary = Buffer.concat([
            buffer.subarray(lastNewline + 1),
            pendingSuffix ?? EMPTY,
          ]);
          if (boundary.length > 0) consider(boundary);
        }

        // 本块内完整行（按新 → 旧处理）。
        const middleStart = start > 0 ? firstNewline + 1 : 0;
        if (lastNewline >= middleStart && !stop) {
          const middle = buffer.subarray(middleStart, lastNewline);
          const lines: Buffer[] = [];
          let lineStart = 0;
          for (;;) {
            const newline = middle.indexOf(NEWLINE, lineStart);
            if (newline < 0) {
              if (lineStart < middle.length) lines.push(middle.subarray(lineStart));
              break;
            }
            lines.push(middle.subarray(lineStart, newline));
            lineStart = newline + 1;
          }
          for (let i = lines.length - 1; i >= 0 && !stop; i--) {
            const line = lines[i];
            if (line !== undefined) consider(line);
          }
        }

        // 左边界片段：交给左侧块拼接成完整行。
        pendingSuffix = start > 0 ? buffer.subarray(0, firstNewline) : undefined;
        pos = start;
        if (start === 0) reachedStart = true;
      }

      if (malformed > 0) {
        this.logger.warn('team.log.invalid_line', { path: this.path, count: malformed });
      }
      if (!cursorFound) throw new TeamLogCursorOutOfWindowError();
      if (before !== undefined && collected.length === 0 && !reachedStart) {
        // 游标恰好落在回扫预算边缘：找不到更早条目就无法给出下一页游标，
        // 按「超出保留窗口」终止翻页，避免空页 + hasMore 让客户端原地打转。
        throw new TeamLogCursorOutOfWindowError();
      }
      // stop = 多取到一条；!reachedStart = 回扫预算用完，保守认为还有更早日志。
      // 空窗口不再声称 hasMore：没有 messages[0] 就没有继续翻页的游标。
      const hasMore = collected.length > 0 && (stop || !reachedStart);
      return { entries: collected.slice(0, limit).reverse(), hasMore };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /** 等待已入队的 append 落盘 */
  async flush(): Promise<void> {
    await this.writeChain.catch(() => {});
  }

  private ensureReady(): Promise<void> {
    if (this.ready === undefined) {
      const ready = this.init();
      this.ready = ready;
      // 初始化失败时允许下一次 append 重试（磁盘可能已恢复）。
      ready.catch(() => {
        if (this.ready === ready) this.ready = undefined;
      });
    }
    return this.ready;
  }

  private async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await repairPartialTail(this.path);
    // 创建（或原地打开）文件并收紧权限；mode 只在新建时生效。
    await appendFile(this.path, '', { encoding: 'utf8', mode: 0o600 });
    try {
      await chmod(this.path, 0o600);
    } catch {
      // Windows 无 POSIX mode
    }
  }

  private async sync(): Promise<void> {
    const handle = await open(this.path, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
  }
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LOG_READ_LIMIT;
  return Math.min(MAX_LOG_READ_LIMIT, Math.max(0, Math.floor(value)));
}
