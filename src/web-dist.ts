/**
 * Web 控制台静态产物检查（gateway 启动诊断；只读）。
 *
 * @module vessel/web-dist
 */

import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
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

export interface EnsureWebDistOptions extends InspectWebDistOptions {
  /** 显式关闭自动构建；缺省读 `VESSEL_NO_WEB_AUTOBUILD` */
  autoBuild?: boolean;
  /** 进度 / 失败信息出口；缺省写 stderr */
  warn?: (line: string) => void;
  /** 构建超时（ms）；缺省 180_000 */
  buildTimeoutMs?: number;
  /**
   * 产物**完全缺失**时等构建结束再返回（默认 false：后台建、立即返回）。
   *
   * 为什么要两种：静态资源是**每请求读盘**的，所以「过期但还在」值得后台重建；
   * 但「缺失」时宿主没有可服务的降级形态（平台 gateway 在 `index.html` 缺失时
   * 直接失败退出，见 `runPlatformGatewayForeground` 的 fail-fast），只能等它建出来。
   */
  waitWhenMissing?: boolean;
}

/** Web 源码工程根（`apps/web`），由 `apps/web/src` 反推。 */
const DEFAULT_WEB_ROOT = path.dirname(DEFAULT_WEB_SRC_DIR);

/**
 * 自动构建的前提：源码工程在、且它有**自己的** `node_modules`
 * （`apps/web` 用 npm + package-lock，不在 bun workspaces 里，根依赖不够）。
 */
function canAutoBuild(): boolean {
  return (
    existsSync(path.join(DEFAULT_WEB_ROOT, 'package.json')) &&
    existsSync(path.join(DEFAULT_WEB_ROOT, 'node_modules'))
  );
}

/**
 * 「自修复」会不会接管这个静态目录（同步；提示函数用它决定要不要说话）。
 *
 * 三条同时成立才算接管：没被 `VESSEL_NO_WEB_AUTOBUILD=1` 关掉、用的是仓库内
 * 默认目录（`VESSEL_STATIC_DIR` 指向的产物不归我们管）、源码工程自带 node_modules。
 */
export function autoBuildManaged(options: { staticDir?: string } = {}): boolean {
  if ((process.env.VESSEL_NO_WEB_AUTOBUILD ?? '').trim() === '1') return false;
  const explicitDir = options.staticDir ?? process.env.VESSEL_STATIC_DIR;
  if (explicitDir !== undefined && explicitDir.trim() !== '') return false;
  return canAutoBuild();
}

/** 生成一行 stderr 提示；无需提示时返回 null。 */
export function webDistWarning(
  status: WebDistStatus,
  options: { autoBuildManaged?: boolean } = {},
): string | null {
  // 自修复会接管时，「缺失 / 过期」都不是用户的事：进度行（`webDistBuilding`）
  // 已经说过一遍，紧接着就自己修好了 —— 再把「缺失 + 命令教学」糊到启动输出里
  // 只是噪声。只有真的修不了（关了自动构建 / 不是默认目录 / 没装依赖 / 构建失败）
  // 才值得占一行终端。
  if (options.autoBuildManaged ?? autoBuildManaged()) return null;
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

const ANSI_ESCAPE = /\u001B\[[0-9;]*[A-Za-z]/g;

/**
 * 把一次失败的构建压成**一句**人话。
 *
 * `bun run build`（= `tsc --noEmit && vite build`）出错时 stdout/stderr 里可能有
 * 几百行 vite 进度、chunk 体积表和 tsc 报错；`execFile` 的 error.message 还会把
 * 整段 stderr 拼进来。用户要的只是一句「哪坏了」，所以这里取：优先含
 * error/failed/cannot 的**最后一行**，否则最后一行非空输出；ANSI 全去、截到 200 字。
 */
function summarizeBuildFailure(error: unknown): string {
  const raw: string[] = [];
  if (typeof error === 'object' && error !== null) {
    const { stdout, stderr, message } = error as Record<string, unknown>;
    for (const part of [stderr, stdout, message]) {
      if (typeof part === 'string') raw.push(part);
    }
  } else {
    raw.push(String(error));
  }
  const lines = raw
    .join('\n')
    .replace(ANSI_ESCAPE, '')
    .split('\n')
    .map((line) => line.trim())
    // vite 的 chunk 体积警告不是「失败原因」，别让它顶掉真错误。
    .filter((line) => line !== '' && !/Some chunks are larger than/i.test(line));
  // `execFile` 自己拼的包装行（"Command failed: …" / 超时）信息量最低，
  // 只能在没有真实报错行时兜底，别让它抢在 tsc/vite 的报错前面。
  const isWrapper = (line: string): boolean =>
    /^Command failed:/i.test(line) || /timed out after/i.test(line);
  const candidates = lines.filter((line) => !isWrapper(line));
  const keyword = [...candidates]
    .reverse()
    .find((line) => /error|failed|cannot|not found|ENOENT/i.test(line));
  const picked =
    keyword ??
    candidates[candidates.length - 1] ??
    lines[lines.length - 1] ??
    (error instanceof Error ? error.message : 'unknown error');
  return picked.length > 200 ? `${picked.slice(0, 200)}…` : picked;
}

/** 进行中的构建；重复调用共用同一个 promise，避免并发起两份。 */
let inFlightBuild: Promise<void> | undefined;

/** 起一次 `bun run build`（或复用在飞的那次）；输出全部捕获，只报一行进度/结果。 */
function startBuild(options: EnsureWebDistOptions, warn: (line: string) => void): Promise<void> {
  if (inFlightBuild !== undefined) return inFlightBuild;
  warn(t('gateway.webDistBuilding', { path: DEFAULT_WEB_ROOT }));
  const task = (async (): Promise<void> => {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      // stdout/stderr 一律捕获：vite 的进度条、chunk 体积表、体积警告都不该泼到
      // 用户终端 —— 构建在这里只是「把产物弄出来」，不是用户敲的动作。
      await promisify(execFile)(process.execPath, ['run', 'build'], {
        cwd: DEFAULT_WEB_ROOT,
        timeout: options.buildTimeoutMs ?? 180_000,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      warn(t('gateway.webDistBuilt'));
    } catch (error) {
      // 失败也只留一句（见 summarizeBuildFailure）；不改退出码。
      warn(t('gateway.webDistBuildFailed', { detail: summarizeBuildFailure(error) }));
    } finally {
      inFlightBuild = undefined;
    }
  })();
  inFlightBuild = task;
  return task;
}

/**
 * 静态产物过期/缺失时**后台重建**，默认立即返回当前状态（不阻塞启动）。
 *
 * 为什么后台：`bun run build` 实测约 19 秒（`tsc --noEmit && vite build`），
 * 放在启动路径上会让每次「改过 web 源码后启动」都慢 19 秒。
 *
 * 为什么不阻塞也能接受：gateway 静态资源是**每次请求读盘**的，重建完成后
 * 下一次加载就拿到新产物 —— 不需要重启。已打开的页面靠 `RefreshBanner`
 * 轮询 `dist/build.json` 自行发现并提示刷新。
 *
 * 反过来，产物**完全缺失**时没有可服务的东西，调用方可以传 `waitWhenMissing`
 * 等它建完再继续（平台 gateway 的 fail-fast 不接受「先起来再修」）。
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
  if (!canAutoBuild()) return status;

  const task = startBuild(options, warn);
  if (options.waitWhenMissing === true && !status.exists) {
    await task;
    // 建完复核真实结果：成功 → `exists: true`；失败 → 仍是「缺失」，交给调用方
    // 用一句精简提示收尾（构建细节已经在 webDistBuildFailed 里）。
    return inspectWebDist(options);
  }
  return status;
}
