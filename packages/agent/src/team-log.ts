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

import { appendFile, chmod, mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Logger, noopLogger } from '@vessel-agent/core';
import type { TeamLogEntry } from './types.js';

/** 有界读：最多读取的尾部字节数 */
export const MAX_LOG_READ_BYTES = 8 * 1024 * 1024;
/** 读取缺省条数 */
export const DEFAULT_LOG_READ_LIMIT = 100;
/** 读取最大条数 */
export const MAX_LOG_READ_LIMIT = 1000;

/** 半行恢复的初始尾窗 */
const TAIL_WINDOW_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

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
    const systemEvent = parsed.system_event;
    if (
      systemEvent === 'join' ||
      systemEvent === 'leave' ||
      systemEvent === 'rotate' ||
      systemEvent === 'archive'
    ) {
      entry.system_event = systemEvent;
    }
    return entry;
  } catch {
    return null;
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
    const limit = clampLimit(options.limit);
    if (limit === 0) return [];
    await this.writeChain.catch(() => {});

    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    if (size <= 0) return [];

    const start = Math.max(0, size - MAX_LOG_READ_BYTES);
    const length = size - start;
    const handle = await open(this.path, 'r');
    let text: string;
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      text = buffer.toString('utf8');
    } finally {
      await handle.close().catch(() => {});
    }

    // 窗口从文件中间开始时，首行可能被截断：丢弃到第一个换行之后。
    let body = text;
    if (start > 0) {
      const firstNewline = body.indexOf('\n');
      body = firstNewline >= 0 ? body.slice(firstNewline + 1) : '';
    }
    const lines = body.split('\n');
    // 最后一段要么是空串（文件以换行结尾），要么是没有换行的截断行：都丢弃。
    lines.pop();

    const entries: TeamLogEntry[] = [];
    let malformed = 0;
    for (const line of lines) {
      const entry = parseEntry(line);
      if (entry === null) {
        malformed += 1;
        continue;
      }
      entries.push(entry);
    }
    if (malformed > 0) {
      this.logger.warn('team.log.invalid_line', { path: this.path, count: malformed });
    }
    return entries.slice(-limit);
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
