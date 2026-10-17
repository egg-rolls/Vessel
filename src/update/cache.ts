/**
 * REPL 后台检查的本地节流（每天最多一次）。
 * 读写失败一律静默——更新检查不能影响启动。
 */

import { mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface UpdateCheckCache {
  checkedAt: number;
  current: string;
  latest: string;
  channel: string;
}

/** 两次后台检查的最小间隔：24h */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 缓存文件：~/.vessel/update-check.json */
export function getUpdateCachePath(): string {
  return path.join(os.homedir(), '.vessel', 'update-check.json');
}

/** 是否该检查：无缓存或已过 24h */
export function shouldCheck(cache: UpdateCheckCache | null, now = Date.now()): boolean {
  if (!cache || typeof cache.checkedAt !== 'number') return true;
  return now - cache.checkedAt >= CHECK_INTERVAL_MS;
}

/** 读取缓存；不存在/损坏返回 null */
export async function readUpdateCache(
  filePath = getUpdateCachePath(),
): Promise<UpdateCheckCache | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const raw = (await file.json()) as Partial<UpdateCheckCache> | null;
    if (
      !raw ||
      typeof raw.checkedAt !== 'number' ||
      typeof raw.current !== 'string' ||
      typeof raw.latest !== 'string' ||
      typeof raw.channel !== 'string'
    ) {
      return null;
    }
    return {
      checkedAt: raw.checkedAt,
      current: raw.current,
      latest: raw.latest,
      channel: raw.channel,
    };
  } catch {
    return null;
  }
}

/** 写入缓存；失败静默 */
export async function writeUpdateCache(
  cache: UpdateCheckCache,
  filePath = getUpdateCachePath(),
): Promise<void> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await Bun.write(filePath, JSON.stringify(cache));
  } catch {
    // 静默：缓存失败不影响功能
  }
}
