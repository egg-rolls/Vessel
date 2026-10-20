/**
 * 原子写（0.5 F1 / DECISION-010 §2.1、E3）
 *
 * - 同一 resolved filePath 的进程内写入串行化；
 * - 同目录 temp + rename；Windows rename 失败重试 3 次（10/20/40ms 退避）；
 * - rename 全部失败 → 删除 temp 并抛 `AtomicWriteError`，**绝不直写最终路径**
 *   （直写会让并发读者看到半截内容）。
 * - 0.8.1：`durable`（默认 true）时 temp 文件先 fsync、rename 后尽力 fsync 目录；
 *   文件 fsync 失败抛 `AtomicWriteError`，目录 fsync 失败忽略。
 *
 * @module @vessel-agent/core/session
 */

import { randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/** rename 尝试次数（含第一次） */
export const ATOMIC_WRITE_RENAME_ATTEMPTS = 3;

/** atomicWrite 选项 */
export interface AtomicWriteOptions {
  /** rename 尝试次数；缺省 3（含第一次） */
  retries?: number;
  /** 写入前创建父目录；缺省 false（调用方通常已 ensureDir） */
  ensureDir?: boolean;
  /** 字符串内容的编码；缺省 utf8 */
  encoding?: BufferEncoding;
  /**
   * 写入后 fsync 与目录 fsync；缺省 `true`。
   *
   * `false` 保留 0.5 的旧行为（仅 writeFile + rename），用于对持久性要求
   * 不高的临时文件或测试。文件 fsync 失败会抛 `AtomicWriteError`；
   * 目录 fsync 是尽力而为（Windows 上常不可用）。
   */
  durable?: boolean;
}

/** 原子写失败（稳定错误码，供上层映射 internal） */
export class AtomicWriteError extends Error {
  readonly code = 'atomic_write_failed' as const;
  readonly path: string;

  constructor(path: string, cause?: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    super(`atomic_write_failed: ${path}${detail}`);
    this.name = 'AtomicWriteError';
    this.path = path;
  }
}

/** 进程内按 resolved filePath 串行化；值为永不 reject 的 tail */
const pendingWrites = new Map<string, Promise<void>>();

function resolveRetries(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return ATOMIC_WRITE_RENAME_ATTEMPTS;
  }
  return Math.max(0, Math.floor(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * 原子写文件。
 *
 * 失败语义（冻结）：
 * - 同一路径并发调用按调用顺序排队；成功返回时 rename 已完成；
 * - rename 重试耗尽 → 删除 temp 并抛 `AtomicWriteError`；
 * - 不会留下同目录 `.tmp` 垃圾（删除失败除外）。
 */
export async function atomicWrite(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  if (typeof filePath !== 'string' || filePath === '') {
    throw new Error('invalid_path: filePath must be a non-empty string');
  }

  const target = resolve(filePath);
  const previous = pendingWrites.get(target) ?? Promise.resolve();
  const task = () => writeAtomically(target, data, options);
  const current = previous.then(task, task);
  const tail = current.then(
    () => {},
    () => {},
  );
  pendingWrites.set(target, tail);

  try {
    await current;
  } finally {
    if (pendingWrites.get(target) === tail) pendingWrites.delete(target);
  }
}

/**
 * 写临时文件；`durable` 时在关闭前 fsync。
 *
 * 文件 fsync 失败 → 清理 temp 并抛 `AtomicWriteError`（绝不 rename）。
 */
async function writeTemp(
  tmpPath: string,
  data: string | Uint8Array,
  encoding: BufferEncoding,
  durable: boolean,
  targetPath: string,
): Promise<void> {
  if (!durable) {
    try {
      await writeFile(tmpPath, data, typeof data === 'string' ? encoding : undefined);
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
    return;
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(tmpPath, 'w');
    if (typeof data === 'string') {
      await handle.writeFile(data, encoding);
    } else {
      await handle.writeFile(data);
    }
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw new AtomicWriteError(targetPath, error);
  }

  try {
    await handle.close();
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw new AtomicWriteError(targetPath, error);
  }
}

/**
 * rename 后尽力 fsync 父目录，使目录项变更持久化。
 *
 * Windows 上目录通常不能以 `r` 打开或 fsync，常见 `EPERM` / `EISDIR` / `EBADF`；
 * 目录 fsync 始终是尽力而为，任何失败都不影响写入结果。
 */
async function fsyncDirectory(dirPath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dirPath, 'r');
    await handle.sync();
  } catch {
    // 目录 fsync 不可用：降级为 rename 已提供的可见性保证
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeAtomically(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions,
): Promise<void> {
  if (options.ensureDir) {
    await mkdir(dirname(filePath), { recursive: true });
  }

  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  const encoding = options.encoding ?? 'utf8';
  const durable = options.durable ?? true;

  await writeTemp(tmpPath, data, encoding, durable, filePath);

  const retries = resolveRetries(options.retries);
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await rename(tmpPath, filePath);
      if (durable) await fsyncDirectory(dirname(filePath));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) {
        await delay(10 * 2 ** attempt);
      }
    }
  }

  await unlink(tmpPath).catch(() => {});
  throw new AtomicWriteError(filePath, lastError);
}
