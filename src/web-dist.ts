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

export interface EnsureWebDistOptions extends InspectWebDistOptions {
  /** 显式关闭自动构建；缺省读 `VESSEL_NO_WEB_AUTOBUILD` */
  autoBuild?: boolean;
  /** 进度 / 失败信息出口；缺省写 stderr */
  warn?: (line: string) => void;
  /** 构建超时（ms）；缺省 180_000 */
  buildTimeoutMs?: number;
}

/** Web 源码工程根（`apps/web`），由 `apps/web/src` 反推。 */
const DEFAULT_WEB_ROOT = path.dirname(DEFAULT_WEB_SRC_DIR);

/**
 * 自动构建的前提：源码工程在、且它有**自己的** `node_modules`
 * （`apps/web` 用 npm + package-lock，不在 bun workspaces 里，根依赖不够）。
 */
async function canAutoBuild(): Promise<boolean> {
  const hasPackage = (await fileMtime(path.join(DEFAULT_WEB_ROOT, 'package.json'))) !== undefined;
  if (!hasPackage) return false;
  try {
    const modules = await stat(path.join(DEFAULT_WEB_ROOT, 'node_modules'));
    return modules.isDirectory();
  } catch {
    return false;
  }
}

/** 进行中的构建；重复调用共用同一个 promise，避免并发起两份。 */
let inFlightBuild: Promise<void> | undefined;

/**
 * 静态产物过期/缺失时**后台重建**，立即返回当前状态（不阻塞启动）。
 *
 * 为什么后台：`bun run build` 实测约 19 秒（`tsc --noEmit && vite build`），
 * 放在启动路径上会让每次「改过 web 源码后启动」都慢 19 秒。
 *
 * 为什么不阻塞也能接受：gateway 静态资源是**每次请求读盘**的，重建完成后
 * 下一次加载就拿到新产物 —— 不需要重启。已打开的页面靠 `RefreshBanner`
 * 轮询 `dist/build.json` 自行发现并提示刷新。
 *
 * 只在**仓库内默认目录**下生效（自定义 `VESSEL_STATIC_DIR` 不碰）。任何失败都只告警、
 * 不改退出码，继续以现有产物提供服务。
 */
export async function ensureWebDist(options: EnsureWebDistOptions = {}): Promise<WebDistStatus> {
  const warn = options.warn ?? ((line: string) => console.error(line));
  const status = await inspectWebDist(options);
  const enabled = options.autoBuild ?? (process.env.VESSEL_NO_WEB_AUTOBUILD ?? '').trim() !== '1';
  if (!enabled) return status;
  if (status.exists && !status.stale) return status;
  // 只构建仓库内的默认产物；显式 staticDir / VESSEL_STATIC_DIR 指向的目录不归我们管。
  const explicitDir = options.staticDir ?? process.env.VESSEL_STATIC_DIR;
  if (explicitDir !== undefined && explicitDir.trim() !== '') return status;
  if (!(await canAutoBuild())) return status;

  if (inFlightBuild !== undefined) return status;
  warn(t('gateway.webDistBuilding', { path: DEFAULT_WEB_ROOT }));
  inFlightBuild = (async (): Promise<void> => {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)(process.execPath, ['run', 'build'], {
        cwd: DEFAULT_WEB_ROOT,
        timeout: options.buildTimeoutMs ?? 180_000,
        encoding: 'utf8',
      });
      warn(t('gateway.webDistBuilt'));
    } catch (error) {
      warn(
        t('gateway.webDistBuildFailed', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      inFlightBuild = undefined;
    }
  })();
  return status;
}
