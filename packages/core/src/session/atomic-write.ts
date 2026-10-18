/**
 * 原子写（0.5 F1 / DECISION-010 §2.1、E3）
 *
 * 同目录 temp + rename；Windows rename 失败重试 3 次（10/20/40ms 退避）；
 * 仍失败则 best-effort 整文件直写（避免半截 JSON 字符串进入正式路径）。
 *
 * @module @vessel/core/session
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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
}

function resolveRetries(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return ATOMIC_WRITE_RENAME_ATTEMPTS;
  }
  return Math.max(0, Math.floor(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 原子写文件。
 *
 * 失败语义（冻结）：
 * - 成功返回时内容已 rename（或 fallback 直写）完成；
 * - 最终失败会抛错，并尽力删除 temp 文件；
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

  if (options.ensureDir) {
    await mkdir(dirname(filePath), { recursive: true });
  }

  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  const encoding = options.encoding ?? 'utf8';

  await writeFile(tmpPath, data, typeof data === 'string' ? encoding : undefined);
  const retries = resolveRetries(options.retries);
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await rename(tmpPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) {
        await delay(10 * 2 ** attempt);
      }
    }
  }

  try {
    await writeFile(filePath, data, typeof data === 'string' ? encoding : undefined);
    await unlink(tmpPath).catch(() => {});
  } catch (fallbackError) {
    await unlink(tmpPath).catch(() => {});
    throw lastError ?? fallbackError;
  }
}
