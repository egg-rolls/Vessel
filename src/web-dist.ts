/**
 * Web 控制台静态产物检查（gateway 启动诊断；只读）。
 *
 * @module vessel/web-dist
 */

import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './i18n';

/** 仓库内默认静态目录（与 `src/cli.ts` 的 `resolveStaticDir` 一致） */
export const DEFAULT_WEB_DIST_DIR = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
/** Web 源码目录；用于判断 dist 是否过期 */
export const DEFAULT_WEB_SRC_DIR = fileURLToPath(new URL('../apps/web/src', import.meta.url));
const DEFAULT_WEB_INDEX = fileURLToPath(new URL('../apps/web/index.html', import.meta.url));
const DEFAULT_WEB_VITE_CONFIG = fileURLToPath(
  new URL('../apps/web/vite.config.ts', import.meta.url),
);

const DEFAULT_MAX_FILES = 5_000;

export interface WebDistStatus {
  /** 静态目录（绝对路径） */
  staticDir: string;
  /** `<staticDir>/index.html` */
  indexFile: string;
  exists: boolean;
  stale: boolean;
  /** 比 index.html 新的最新源文件；仅 stale 时有值 */
  newestSource?: { path: string; mtimeMs: number };
}

export interface InspectWebDistOptions {
  /** 显式静态目录；缺省读 `VESSEL_STATIC_DIR`，再缺省仓库内 `apps/web/dist` */
  staticDir?: string;
  /** 源码目录；缺省仓库内 `apps/web/src` */
  webSrcDir?: string;
  /** 额外参与过期比较的文件；缺省 `apps/web/index.html` + `vite.config.ts` */
  extraSourceFiles?: string[];
  maxFiles?: number;
  /** 缺省：使用默认静态目录时比较过期，自定义目录只查存在性 */
  checkStale?: boolean;
}

async function fileMtime(file: string): Promise<number | undefined> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/** 有界递归找最新源文件；跳过 tests、符号链接与 node_modules */
async function newestSourceMtime(
  root: string,
  extraFiles: string[],
  maxFiles: number,
): Promise<{ path: string; mtimeMs: number } | undefined> {
  let newest: { path: string; mtimeMs: number } | undefined;
  let visited = 0;

  const consider = (file: string, mtimeMs: number): void => {
    if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { path: file, mtimeMs };
  };

  for (const file of extraFiles) {
    const mtimeMs = await fileMtime(file);
    if (mtimeMs !== undefined) consider(file, mtimeMs);
  }

  const walk = async (dir: string): Promise<void> => {
    if (visited >= maxFiles) return;
    let entries: Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        await walk(target);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.includes('.test.')) continue;
      visited += 1;
      const mtimeMs = await fileMtime(target);
      if (mtimeMs !== undefined) consider(target, mtimeMs);
    }
  };

  await walk(root);
  return newest;
}

/**
 * 检查静态产物；任何读取失败都降级为“不存在/不过期”，不抛错。
 * 只读，无副作用；可在 gateway 启动前同步报告。
 */
export async function inspectWebDist(options: InspectWebDistOptions = {}): Promise<WebDistStatus> {
  const envDir = process.env.VESSEL_STATIC_DIR;
  const staticDir = path.resolve(options.staticDir ?? (envDir ? envDir : DEFAULT_WEB_DIST_DIR));
  const usingDefault = staticDir === path.resolve(DEFAULT_WEB_DIST_DIR);
  const indexFile = path.join(staticDir, 'index.html');
  const indexMtime = await fileMtime(indexFile);

  if (indexMtime === undefined) {
    return { staticDir, indexFile, exists: false, stale: false };
  }

  const checkStale = options.checkStale ?? (options.staticDir === undefined && usingDefault);
  if (!checkStale) return { staticDir, indexFile, exists: true, stale: false };

  const webSrcDir = options.webSrcDir ?? DEFAULT_WEB_SRC_DIR;
  const extraFiles =
    options.extraSourceFiles ??
    (options.webSrcDir === undefined ? [DEFAULT_WEB_INDEX, DEFAULT_WEB_VITE_CONFIG] : []);
  const newest = await newestSourceMtime(
    webSrcDir,
    extraFiles,
    Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES),
  );
  if (newest === undefined || indexMtime >= newest.mtimeMs) {
    return { staticDir, indexFile, exists: true, stale: false };
  }
  return { staticDir, indexFile, exists: true, stale: true, newestSource: newest };
}

/** 生成一行 stderr 提示；无需提示时返回 null。 */
export function webDistWarning(status: WebDistStatus): string | null {
  if (!status.exists) {
    return t('gateway.webDistMissing', { path: status.staticDir });
  }
  if (status.stale && status.newestSource) {
    return t('gateway.webDistStale', {
      index: status.indexFile,
      source: status.newestSource.path,
    });
  }
  return null;
}
