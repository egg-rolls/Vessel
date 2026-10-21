/**
 * gateway 权限交互记录的实例隔离（0.15）。
 *
 * default 实例沿用 `<dataDir>` 与旧文件名 `interactions-<tenant>.json`；
 * 命名实例写到 `<dataDir>/instances/<instance>/`，避免同 dataDir 多实例互相覆盖。
 *
 * @module vessel/interactions-dir
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GATEWAY_INSTANCE } from './gateway/pid';

/** 选目录；不创建 */
export function resolveInteractionsDir(dataDir: string, instance?: string): string {
  if (instance === undefined || instance === '' || instance === DEFAULT_GATEWAY_INSTANCE) {
    return dataDir;
  }
  return join(dataDir, 'instances', instance);
}

/** 选目录并确保命名实例目录存在（default 不额外建目录）。 */
export function ensureInteractionsDir(dataDir: string, instance?: string): string {
  const dir = resolveInteractionsDir(dataDir, instance);
  if (dir !== dataDir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
