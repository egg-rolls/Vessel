/**
 * Web 控制台静态产物检查（gateway 启动诊断；只读）。
 *
 * @module vessel/web-dist
 */

import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
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
  if (webAutoBuildMode() === 'off') return false;
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

/**
 * 平台 gateway 的 `/build.json` 实时字段来源（组合根注入给 `startPlatformGateway`）。
 *
 * 判据**完全复用** `inspectWebDist`：默认产物目录才比源码；`VESSEL_STATIC_DIR`
 * 指向的外部产物只报存在性 —— 拿仓库内源码去比外部构建时间只会误报。
 *
 * 0.59：这个探针同时是**运行期重建的触发点**。它被 `/build.json`（每标签页每 10 秒）
 * 与产物推送的节拍器按 5 秒 TTL 调用，所以「源码变了」这件事一被发现就能顺手起一次
 * 后台重建 —— 不需要自己的定时器，也不需要重启 gateway。限频 / 单飞 / 失败终止态都在
 * `requestRuntimeRebuild` 里（见那里的注释）。
 */
export function webDistProbe(staticDir: string): () => Promise<WebDistStatus> {
  const resolved = path.resolve(staticDir);
  const managedDir = resolved === path.resolve(DEFAULT_WEB_DIST_DIR);
  return async () => {
    const status = managedDir
      ? await inspectWebDist({})
      : await inspectWebDist({ staticDir: resolved });
    if (managedDir && status.stale) requestRuntimeRebuild();
    return status;
  };
}

/**
 * `doctor` / `gateway status` 的一行诊断：产物落后于源码时**一定**说话，并给出
 * 怎么修；不算落后返回 null。
 *
 * 和 `webDistWarning` 的区别：那个是**启动横幅**，自修复会接管时就该闭嘴；这里
 * 是「用户主动来问现状」，自修复管不管都得如实回答 —— 这次的事故正是「机制在，
 * 但只在启动时跑一次」，启动之后就再也没人说过 dist 已经旧了。
 */
export function webDistStaleLine(status: WebDistStatus): string | null {
  if (!status.exists || !status.stale || status.newestSource === undefined) return null;
  return t('gateway.webDistStaleLine', {
    index: status.indexFile,
    source: status.newestSource.path,
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: 去 ANSI 转义必须匹配 ESC（\u001B），范围已收窄到 CSI 序列，不是任意控制字符
const ANSI_ESCAPE = /\u001B\[[0-9;]*[A-Za-z]/g;

/**
 * 把一次失败的构建压成**一句**人话。
 *
 * `bun run build`（= `tsc --noEmit && vite build`）出错时输出里可能有几百行 vite
 * 进度、chunk 体积表和 tsc 报错。用户要的只是一句「哪坏了」，所以这里取：优先含
 * error/failed/cannot 的**最后一行**，否则最后一行非空输出；ANSI 全去、截到 200 字。
 *
 * `detail` 是这次构建的「一句话失败外壳」（退出码 / 超时），只在构建日志里挑不出
 * 真实报错行时兜底。日志正文本身由 {@link readBuildLogTail} 从磁盘读回来 ——
 * 构建输出不进主日志（几百行 vite 表格不是用户要读的东西）。
 */
function summarizeBuildFailure(raw: string, detail: string): string {
  const lines = raw
    .replace(ANSI_ESCAPE, '')
    .split('\n')
    .map((line) => line.trim())
    // vite 的 chunk 体积警告不是「失败原因」，别让它顶掉真错误。
    .filter((line) => line !== '' && !/Some chunks are larger than/i.test(line));
  // 「Command failed」/ 超时这类包装行信息量最低，只能在没有真实报错行时兜底，
  // 别让它抢在 tsc/vite 的报错前面。
  const isWrapper = (line: string): boolean =>
    /^Command failed:/i.test(line) || /timed out after/i.test(line);
  const candidates = lines.filter((line) => !isWrapper(line));
  const keyword = [...candidates]
    .reverse()
    .find((line) => /error|failed|cannot|not found|ENOENT/i.test(line));
  const picked = keyword ?? candidates[candidates.length - 1] ?? lines[lines.length - 1] ?? detail;
  return picked.length > 200 ? `${picked.slice(0, 200)}…` : picked;
}

/** 进行中的构建；重复调用共用同一个 promise，避免并发起两份。 */
let inFlightBuild: Promise<void> | undefined;

/** 运行期重建的最小间隔：同一产物 60s 内最多起一次构建。 */
export const WEB_REBUILD_MIN_INTERVAL_MS = 60_000;

/**
 * 连续失败上限：到顶就**停止自动重建**（不再无限重试），等人重启。
 *
 * 为什么要有终止态：源码本身编译不过时，60s 一次的自动重建会永远转下去 ——
 * 每转一次写一次日志、占一次 CPU，而用户看到的还是那张「前端更新失败」。停下来
 * 并把「最后一次为什么失败」说出去，比装作还在努力更有用。
 */
export const WEB_REBUILD_MAX_FAILURES = 3;

/**
 * 自动重建的开关：
 * - `live`（默认）：启动时建，运行期发现产物过期也建；
 * - `startup`：**只在启动时**建一次（保守模式，`VESSEL_WEB_AUTOBUILD=startup`）；
 * - `off`：完全不建（`VESSEL_NO_WEB_AUTOBUILD=1`，老开关语义不变）。
 */
export type WebAutoBuildMode = 'live' | 'startup' | 'off';

/** 运行期自动重建的现场状态；`/build.json` 的 `autobuild` 字段就是它。 */
export interface WebAutoBuildStatus {
  /** 运行期**还会不会**自己重建。`false` 时提示条才该说「失败 / 已关闭」。 */
  enabled: boolean;
  mode: WebAutoBuildMode;
  /** 连续失败次数（成功一次即清零）。 */
  failures: number;
  /** 最后一次失败的一句话原因；没失败过为 `undefined`。 */
  lastError?: string;
}

const autoBuildState: { failures: number; lastError?: string; lastStartAt: number } = {
  failures: 0,
  lastStartAt: 0,
};

/** 解析当前生效的自动重建开关（env 三态，缺省 `live`）。 */
export function webAutoBuildMode(): WebAutoBuildMode {
  if ((process.env.VESSEL_NO_WEB_AUTOBUILD ?? '').trim() === '1') return 'off';
  if ((process.env.VESSEL_WEB_AUTOBUILD ?? '').trim() === 'startup') return 'startup';
  return 'live';
}

/** 运行期还能不能自己重建（`autoBuildManaged` 的**运行期**版本）。 */
function autoBuildAtRuntime(): boolean {
  if (webAutoBuildMode() !== 'live') return false;
  const explicitDir = process.env.VESSEL_STATIC_DIR;
  if (explicitDir !== undefined && explicitDir.trim() !== '') return false;
  if (!canAutoBuild()) return false;
  // 连续失败到顶：停手。重启应用会重置这份内存状态（这也是提示条说「重启重试」的依据）。
  return autoBuildState.failures < WEB_REBUILD_MAX_FAILURES;
}

/**
 * 运行期自动重建的现场状态（`/build.json` 的 `autobuild`）。
 *
 * 前端靠 `enabled` 区分「正在（或即将）自己重建」与「不会再有动作了」：
 * 后者才该让用户看到「失败，重启重试」或「已关闭」。
 */
export function webDistAutoBuildStatus(): WebAutoBuildStatus {
  return {
    enabled: autoBuildAtRuntime(),
    mode: webAutoBuildMode(),
    failures: autoBuildState.failures,
    ...(autoBuildState.lastError !== undefined ? { lastError: autoBuildState.lastError } : {}),
  };
}

/**
 * 后台重建**此刻**是否在跑（`/build.json` 的 `building` 字段来源，0.58）。
 *
 * 存在的理由：构建要十几到几十秒，而「构建中」和「构建完了但失败了」对用户是**两件事** ——
 * 前者让他等（刷新也没用，磁盘上还是旧的），后者才该让他重启重试。只看 `stale` 分不出
 * 这两种，所以把「在跑」这个内存事实直接说出去。
 */
export function webDistBuildInFlight(): boolean {
  return inFlightBuild !== undefined;
}

/** 构建输出落地文件：不进主日志，也不进被服务的 dist（`dist/` 下的东西会对外可读）。 */
function buildLogFile(): string {
  return path.join(os.tmpdir(), 'vessel-web-build.log');
}

/** 读构建日志的尾部（失败原因只在最后几百行里）。失败返回空串，绝不抛。 */
async function readBuildLogTail(file: string, maxBytes = 64 * 1024): Promise<string> {
  try {
    const text = await readFile(file, 'utf8');
    return text.length > maxBytes ? text.slice(text.length - maxBytes) : text;
  } catch {
    return '';
  }
}

/**
 * 跑一次 `bun run build`，**stdout/stderr 直接写文件**。
 *
 * 为什么不用 `execFile`：它把整段输出读进内存（`maxBuffer`），只为了在失败时挑一行 ——
 * 而「构建到底怎么了」在事后还要能翻（用户/我们复盘时）。写文件一步到位：主日志只留
 * 开始 / 完成 / 失败三行，细节留在 {@link buildLogFile} 里等人去看。
 */
async function runBuildCommand(timeoutMs: number, logFile: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { openSync, closeSync } = await import('node:fs');
  const fd = openSync(logFile, 'w');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['run', 'build'], {
        cwd: DEFAULT_WEB_ROOT,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Command failed: exit ${String(code ?? signal ?? 'unknown')}`));
      });
    });
  } finally {
    closeSync(fd);
  }
}

/**
 * 起一次构建（或复用在飞的那次）；主日志只留「开始 / 完成 / 失败 + 耗时」三行。
 *
 * **绝不并发**：`inFlightBuild` 就是那把锁，第二次调用直接拿到同一个 promise。
 * 失败**不改退出码**：产物旧一点还能用，不能因为构建坏了就把 gateway 拖死。
 * 连续失败到 {@link WEB_REBUILD_MAX_FAILURES} 时多打一行警告并停手（`lastError` 进
 * `/build.json`，让提示条说得出「为什么」）。
 */
function startBuild(options: EnsureWebDistOptions, warn: (line: string) => void): Promise<void> {
  if (inFlightBuild !== undefined) return inFlightBuild;
  const startedAt = Date.now();
  autoBuildState.lastStartAt = startedAt;
  warn(t('gateway.webDistBuilding', { path: DEFAULT_WEB_ROOT }));
  const task = (async (): Promise<void> => {
    const logFile = buildLogFile();
    try {
      await runBuildCommand(options.buildTimeoutMs ?? 180_000, logFile);
      autoBuildState.failures = 0;
      autoBuildState.lastError = undefined;
      warn(t('gateway.webDistBuilt', { ms: Date.now() - startedAt }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const reason = summarizeBuildFailure(await readBuildLogTail(logFile), detail);
      autoBuildState.failures += 1;
      autoBuildState.lastError = reason;
      warn(
        t('gateway.webDistBuildFailed', {
          ms: Date.now() - startedAt,
          detail: reason,
          log: logFile,
        }),
      );
      if (autoBuildState.failures === WEB_REBUILD_MAX_FAILURES) {
        warn(t('gateway.webDistBuildGaveUp', { count: autoBuildState.failures }));
      }
    } finally {
      inFlightBuild = undefined;
    }
  })();
  inFlightBuild = task;
  return task;
}

/**
 * 运行期「探针发现产物过期」时的一次重建请求（限频 + 单飞 + 失败终止态）。
 *
 * 为什么挂在探针上而不是自己起定时器：`/build.json`（每标签页每 10 秒）与产物推送
 * 的节拍器本来就在按 5 秒 TTL 调这个探针 —— 「源码变了」这件事**已经在有人看**，
 * 再养一个定时器只会多一条没人需要的唤醒路径。没人看的时候也就不建（产品在这里
 * 要的是「别让用户看到旧前端」，不是「后台永远热着」）。
 *
 * 三道闸，顺序不能换：
 * 1. **绝不并发**：在飞就直接返回（`inFlightBuild` 是那把锁）；
 * 2. **能建才建**：`autoBuildAtRuntime`（关掉了 / 只在启动建 / 连续失败到顶 ⇒ 不建）；
 * 3. **限频**：距上一次**开始**不足 {@link WEB_REBUILD_MIN_INTERVAL_MS} 就不建 ——
 *    构建自己失败时也按这个节奏重试，最多 {@link WEB_REBUILD_MAX_FAILURES} 次。
 */
function requestRuntimeRebuild(): void {
  if (inFlightBuild !== undefined) return;
  if (!autoBuildAtRuntime()) return;
  if (Date.now() - autoBuildState.lastStartAt < WEB_REBUILD_MIN_INTERVAL_MS) return;
  void startBuild({}, (line) => console.error(line));
}

/**
 * 静态产物过期/缺失时**后台重建**，默认立即返回当前状态（不阻塞启动）。
 *
 * 为什么后台：`bun run build` 实测十几到几十秒（`tsc --noEmit && vite build`），
 * 放在启动路径上会让每次「改过 web 源码后启动」都白等。
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
 *
 * 0.59：这只是**启动时**的那一次。运行期源码再变，由探针走
 * {@link requestRuntimeRebuild}（同一个 `startBuild`，所以仍然单飞 + 限频）。
 */
export async function ensureWebDist(options: EnsureWebDistOptions = {}): Promise<WebDistStatus> {
  const warn = options.warn ?? ((line: string) => console.error(line));
  const status = await inspectWebDist(options);
  const enabled = options.autoBuild ?? webAutoBuildMode() !== 'off';
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
