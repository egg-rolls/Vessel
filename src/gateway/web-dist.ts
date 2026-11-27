/**
 * Web 控制台静态产物检查 + 后台重建（gateway 启动诊断）。
 *
 * @module vessel/web-dist
 */

import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { createWriteStream, existsSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VesselConfig } from '../../packages/config/src/index';
import { logEvent } from '../../packages/serve/src/log-event';
import { expandHome } from '../data/path-resolution';
import { t } from '../i18n';

/** 仓库内默认静态目录（与 `src/cli.ts` 的 `resolveStaticDir` 一致） */
export const DEFAULT_WEB_DIST_DIR = fileURLToPath(new URL('../../apps/web/dist', import.meta.url));
/** Web 源码目录；用于判断 dist 是否过期 */
export const DEFAULT_WEB_SRC_DIR = fileURLToPath(new URL('../../apps/web/src', import.meta.url));
const DEFAULT_WEB_INDEX = fileURLToPath(new URL('../../apps/web/index.html', import.meta.url));
const DEFAULT_WEB_VITE_CONFIG = fileURLToPath(
  new URL('../../apps/web/vite.config.ts', import.meta.url),
);

const DEFAULT_MAX_FILES = 5_000;

/**
 * q-config-priority（用户裁定#2）：显式静态目录解析（不含仓库内默认值）。
 *
 * 责任链：`gateway.web_dist` config > `VESSEL_STATIC_DIR` env > undefined（= 用默认）。
 * 空串一律视为未设置（与 `inspectWebDist` / `resolveStaticDir` 同口径）。
 * `~` 展开、相对路径按 cwd 解析为绝对路径。
 */
export function explicitWebDistDir(
  config?: Pick<VesselConfig, 'gateway'>,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const fromConfig = config?.gateway?.webDist;
  if (typeof fromConfig === 'string' && fromConfig.trim() !== '') {
    return path.resolve(expandHome(fromConfig.trim()));
  }
  const fromEnv = env.VESSEL_STATIC_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return path.resolve(expandHome(fromEnv.trim()));
  }
  return undefined;
}

/**
 * 生效静态目录：显式（config > env）?? 仓库内 `apps/web/dist`。
 * 只解析路径，不判存在性（存在性由 `inspectWebDist` / 启动 fail-fast 负责）。
 */
export function resolveWebDistDir(
  config?: Pick<VesselConfig, 'gateway'>,
  env: Record<string, string | undefined> = process.env,
): string {
  return explicitWebDistDir(config, env) ?? DEFAULT_WEB_DIST_DIR;
}

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
 * 自动构建的三档语义（**只有这一处解析**，判据与日志都从这里取）：

 * - `off`：`VESSEL_NO_WEB_AUTOBUILD=1` —— 完全不自建（启动也不建）；
 * - `startup`：`VESSEL_WEB_AUTOBUILD=startup` —— **只在启动时**建一次；运行中不再自查
 *   （给「构建很贵 / 机器很慢」的部署留一条退路，语义与 0.61 之前一致）；
 * - `always`（缺省）—— 启动时建 + 运行中定时自查。
 *
 * 「关掉」只有 `VESSEL_NO_WEB_AUTOBUILD=1` 一种写法：多写几种别名，两处代码就会
 * 各自认一半，最后没人知道现在是哪档。
 */
export type WebAutoBuildMode = 'off' | 'startup' | 'always';

export function webAutoBuildMode(): WebAutoBuildMode {
  if ((process.env.VESSEL_NO_WEB_AUTOBUILD ?? '').trim() === '1') return 'off';
  if ((process.env.VESSEL_WEB_AUTOBUILD ?? '').trim().toLowerCase() === 'startup') return 'startup';
  return 'always';
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
  // 自修复会接管时，「缺失 / 过期」都不是用户的事：`web.build.*` 事件已经说过一遍，
  // 紧接着就自己修好了 —— 再把「缺失 + 命令教学」糊到启动输出里只是噪声。只有真的
  // 修不了（关了自动构建 / 不是默认目录 / 没装依赖 / 构建失败）才值得占一行终端。
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
 */
export function webDistProbe(staticDir: string): () => Promise<WebDistStatus> {
  const resolved = path.resolve(staticDir);
  return resolved === path.resolve(DEFAULT_WEB_DIST_DIR)
    ? () => inspectWebDist({})
    : () => inspectWebDist({ staticDir: resolved });
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

/* ══════════════════════════════════════════════════════════════════════════
 * 构建运行时：「web 产物在不在建、建成没有」只有这一份状态（0.60）
 *
 * 一次构建在日志里的全部输出（单行 key=value，字段序见 `log-event.ts`）：
 *
 *   [vessel] web.build.start reason=stale target=apps/web pid=1234 log=/tmp/…
 *   [vessel] web.build.progress elapsed=30s rss=180MB        （可选，最多 2 条）
 *   [vessel] web.build.done dur=17.2s assets=42 bytes=8.1MB
 *   [vessel] web.build.fail exit=1 dur=9.1s log=/tmp/…
 *   | error TS2322: …                                        （失败尾部，≤15 行）
 *   [vessel] web.build.interrupted signal=SIGTERM elapsed=8.4s
 *
 * 为什么集中在这里：构建状态以前有四处各自的说法（启动横幅 / `/build.json` /
 * WebUI 横幅 / `gateway status`），改一处文案另一处就开始说谎。现在四处都从
 * {@link webDistBuildState} 派生，人的话只有 `EVENT_FIELDS` 一份。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 构建事件里 `target=` 的值（人读的短标签，不是绝对路径）。 */
const BUILD_TARGET = 'apps/web';
/** 第一次进度行的门槛：构建不到 30s 一条都不打（19 秒的常态构建不产生噪声）。 */
const BUILD_PROGRESS_FIRST_MS = 30_000;
/** 进度行间隔（≥15s，避免刷屏）。 */
const BUILD_PROGRESS_INTERVAL_MS = 15_000;
/** 进度行上限：一次构建最多 2 条。 */
const BUILD_PROGRESS_MAX = 2;
/** 失败时内联的尾部行数上限。 */
const BUILD_TAIL_LINES = 15;
/** 失败尾部每行的字符上限。 */
const BUILD_TAIL_LINE_MAX = 160;
/** 内存里保留的构建输出行数（只为自己算尾部，不落盘）。 */
const BUILD_RING_LINES = 600;
/** 构建临时目录根：`<os tmp>/vessel-web-build/<startedAt>-<pid>/`。 */
const BUILD_LOG_DIRNAME = 'vessel-web-build';
/** 收尾过的构建目录保留期（超期在下次启动时静默清掉）。 */
const BUILD_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 判定「残留在跑」的最长可信时间：超过这个岁数的 running 记录一定是死的。 */
const BUILD_STALE_AFTER_MS = 60 * 60 * 1000;

/** 中断结果（停止方据此打同一套 `web.build.interrupted` 行）。 */
export interface WebBuildInterruption {
  signal: string;
  elapsedMs: number;
  log: string;
}

/** 构建阶段。`idle` = 本进程还没建过（也可能根本不需要建）。 */
export type WebBuildPhase = 'idle' | 'running' | 'done' | 'failed' | 'interrupted';

/**
 * 这次构建是被谁触发的（`web.build.start check=` 的值）。
 *
 * 为什么要区分：0.61 起有三条入口（启动、没人开浏览器时的定时自查、`/build.json`
 * 探针），出问题时「谁把它叫起来的」是第一个要回答的问题，而这三条**共用同一套**
 * 判据与同一个 `inFlightBuild`，不区分就查不出是哪条在反复触发。
 */
export type WebBuildTrigger = 'startup' | 'probe' | 'timer';

/** 上一次构建的终态（`/build.json`、`gateway status` 都读它）。 */
export interface WebBuildLast {
  phase: 'done' | 'failed' | 'interrupted';
  /** 结束时刻（epoch ms） */
  at: number;
  durMs: number;
  exitCode?: number;
  signal?: string;
  assets?: number;
  bytes?: number;
  logPath?: string;
}

/** 构建状态的**唯一**快照。 */
export interface WebBuildState {
  phase: WebBuildPhase;
  /** 本次构建开始时刻（epoch ms） */
  startedAt?: number;
  /** 为什么建：产物缺失 / 落后于源码 */
  reason?: 'missing' | 'stale';
  /** 谁叫起来的：启动 / 探针 / 定时自查（`web.build.start check=`） */
  trigger?: WebBuildTrigger;
  pid?: number;
  logPath?: string;
  last?: WebBuildLast;
}

const buildState: WebBuildState = { phase: 'idle' };
/** 进行中的构建；重复调用共用同一个 promise，避免并发起两份。 */
let inFlightBuild: Promise<void> | undefined;
/** 正在跑的构建子进程（中断时要真的杀掉它，不留孤儿）。 */
let activeChild: ChildProcess | undefined;
/** 本次构建的临时目录（中断时要同步落终态，得知道写哪）。 */
let activeBuildDir: string | undefined;
/** 上一次「探测/定时自查」触发构建的时刻（60s 限频用）。 */
let lastRecheckTriggerAt = 0;

/**
 * 构建状态快照（**唯一**读取口）。
 *
 * `/build.json`、`gateway status`、启动诊断都从这里取；谁都不许自己拼「正在构建」
 * 这种话 —— 拼出来的第二份文案迟早和 `web.build.*` 事件对不上。
 */
export function webDistBuildState(): WebBuildState {
  return buildState.last === undefined
    ? { ...buildState }
    : { ...buildState, last: { ...buildState.last } };
}

/**
 * 后台重建**此刻**是否在跑（`/build.json` 的 `building` 字段）。
 *
 * 只是 {@link webDistBuildState} 的一个派生判断：「构建中」和「构建完了但失败了」
 * 对用户是两件事（前者让他等，后者才该重试），所以这两种状态的来源都要明确。
 */
export function webDistBuildInFlight(): boolean {
  return buildState.phase === 'running';
}

/** `<os tmp>/vessel-web-build`：构建日志与元数据的根（永不进仓库）。 */
function buildLogRoot(): string {
  return path.join(os.tmpdir(), BUILD_LOG_DIRNAME);
}

/** 本次构建的临时目录（`build.log` + `meta.json`）。 */
async function prepareBuildDir(startedAt: number): Promise<{ dir: string; logPath: string }> {
  const dir = path.join(buildLogRoot(), `${startedAt}-${process.pid}`);
  await mkdir(dir, { recursive: true });
  return { dir, logPath: path.join(dir, 'build.log') };
}

interface BuildMeta {
  v: 1;
  /** 构建子进程 pid（中断时要杀的就是它）。 */
  pid: number;
  /**
   * 跑这次构建的宿主进程 pid（gateway）。
   *
   * 为什么要记：Windows 上 `process.kill(pid,'SIGTERM')` 是直接终止，宿主没机会
   * 说「我被打断了」—— 停止方（`gateway stop`）只能靠这一个字段认出「这次构建是
   * 我刚刚杀掉的那个宿主的」。
   */
  parentPid: number;
  startedAt: number;
  phase: WebBuildPhase;
  log: string;
  /** 终态才写（`gateway status` 跨进程读同一份记录，不另存一份口径）。 */
  endedAt?: number;
  durMs?: number;
  exitCode?: number;
  signal?: string;
  assets?: number;
  bytes?: number;
}

/** 跨进程读到的构建记录（`gateway status` 与日志里的 `web.build.*` 同一条事实）。 */
export interface WebBuildRecord {
  /** 这次构建的临时目录（宿主已死时，停止方改写 `meta.json` 用它）。 */
  dir: string;
  pid: number;
  parentPid: number;
  startedAt: number;
  phase: WebBuildPhase;
  log: string;
  endedAt?: number;
  durMs?: number;
  exitCode?: number;
  signal?: string;
  assets?: number;
  bytes?: number;
  /** 「此刻仍在建」：写记录时说在跑、进程还活着、岁数没超可信窗口。 */
  running: boolean;
}

async function readBuildMeta(dir: string): Promise<BuildMeta | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return undefined;
    const meta = raw as Partial<BuildMeta>;
    if (typeof meta.pid !== 'number' || typeof meta.startedAt !== 'number') return undefined;
    return {
      v: 1,
      pid: meta.pid,
      parentPid: typeof meta.parentPid === 'number' ? meta.parentPid : 0,
      startedAt: meta.startedAt,
      phase: meta.phase ?? 'running',
      log: typeof meta.log === 'string' ? meta.log : path.join(dir, 'build.log'),
      ...(typeof meta.endedAt === 'number' ? { endedAt: meta.endedAt } : {}),
      ...(typeof meta.durMs === 'number' ? { durMs: meta.durMs } : {}),
      ...(typeof meta.exitCode === 'number' ? { exitCode: meta.exitCode } : {}),
      ...(typeof meta.signal === 'string' ? { signal: meta.signal } : {}),
      ...(typeof meta.assets === 'number' ? { assets: meta.assets } : {}),
      ...(typeof meta.bytes === 'number' ? { bytes: meta.bytes } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * 最近一次构建落盘的记录（`gateway status` 用）。
 *
 * 为什么要落盘：构建发生在 gateway 进程里，而 `gateway status` 是**另一个**进程 ——
 * 内存态读不到，只能读同一份记录。这不是第二个事实源：记录就是 {@link WebBuildState}
 * 的持久化投影，字段一个不多。
 */
export async function readLatestWebBuildRecord(): Promise<WebBuildRecord | undefined> {
  const root = buildLogRoot();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return undefined;
  }
  let latest: BuildMeta | undefined;
  for (const name of names) {
    const meta = await readBuildMeta(path.join(root, name));
    if (meta === undefined) continue;
    if (latest === undefined || meta.startedAt > latest.startedAt) latest = meta;
  }
  if (latest === undefined) return undefined;
  const running =
    latest.phase === 'running' &&
    isPidAlive(latest.pid) &&
    Date.now() - latest.startedAt < BUILD_STALE_AFTER_MS;
  return {
    dir: path.join(root, `${latest.startedAt}-${latest.parentPid}`),
    pid: latest.pid,
    parentPid: latest.parentPid,
    startedAt: latest.startedAt,
    phase: latest.phase,
    log: latest.log,
    ...(latest.endedAt !== undefined ? { endedAt: latest.endedAt } : {}),
    ...(latest.durMs !== undefined ? { durMs: latest.durMs } : {}),
    ...(latest.exitCode !== undefined ? { exitCode: latest.exitCode } : {}),
    ...(latest.signal !== undefined ? { signal: latest.signal } : {}),
    ...(latest.assets !== undefined ? { assets: latest.assets } : {}),
    ...(latest.bytes !== undefined ? { bytes: latest.bytes } : {}),
    running,
  };
}

/** 元数据写失败不是错误：只影响下次启动能不能判断「上一轮是硬死的」。 */
async function writeBuildMeta(dir: string, meta: BuildMeta): Promise<void> {
  try {
    await writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(meta)}\n`, 'utf8');
  } catch {
    // 忽略。
  }
}

/**
 * 同步版本：只在**中断**路径用。
 *
 * 进程可能下一秒就没了（Windows 上它已经没了），异步写有丢终态的机会 —— 丢了就会被
 * 停止方替我们说第二遍，或者下次启动误报 `stale_artifact`。
 */
function writeBuildMetaSync(dir: string, meta: BuildMeta): void {
  try {
    writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta)}\n`, 'utf8');
  } catch {
    // 忽略。
  }
}

/** pid 还活着吗（EPERM = 活着但不归我，照样算活）。 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 清掉**上次被硬杀**留下的构建临时目录（`SIGKILL` / 断电才留得下）。
 *
 * 判据不是「目录存在」—— 收尾过的目录还要留着给人翻日志；只有「元数据还写着
 * running、进程却已经不在了」才是残留。返回清掉的数量，调用方只报**一行**总数
 * （用户要的是「有没有残留」，不是每个目录一条）。
 */
export async function cleanStaleWebBuildDirs(): Promise<number> {
  const root = buildLogRoot();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  const now = Date.now();
  let cleaned = 0;
  for (const name of names) {
    const dir = path.join(root, name);
    const meta = await readBuildMeta(dir);
    if (meta === undefined) {
      // 这个根只有我们写：没有可用元数据的目录没有保留价值。
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      cleaned += 1;
      continue;
    }
    if (meta.phase === 'running') {
      const dead = !isPidAlive(meta.pid);
      const tooOld = now - meta.startedAt > BUILD_STALE_AFTER_MS;
      if (!dead && !tooOld) continue;
      // 构建进程已经不在了：产物是半截的，元数据也别留。
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      cleaned += 1;
      continue;
    }
    if (now - meta.startedAt > BUILD_LOG_RETENTION_MS) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return cleaned;
}

/** 一行行切出来的环形缓冲：只为算失败尾部，绝不整体读回日志文件。 */
function createLineRing(): { push: (chunk: string) => void; snapshot: () => string[] } {
  const lines: string[] = [];
  let pending = '';
  const push = (chunk: string): void => {
    pending += chunk;
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const part of parts) {
      lines.push(part.replace(/\r$/, ''));
      if (lines.length > BUILD_RING_LINES) lines.shift();
    }
  };
  const snapshot = (): string[] => {
    const all = pending === '' ? [...lines] : [...lines, pending];
    return all.map((line) => line.replace(ANSI_ESCAPE, '').trimEnd());
  };
  return { push, snapshot };
}

/** 失败尾部：`|` 前缀、每行 ≤160 字、总共 ≤15 行，超出写一行省略。 */
function printBuildTail(lines: readonly string[]): void {
  const kept = lines.filter((line) => line.trim() !== '');
  if (kept.length === 0) return;
  const shown = kept.slice(-BUILD_TAIL_LINES);
  if (kept.length > BUILD_TAIL_LINES) {
    console.error(`| … 省略前 ${kept.length - BUILD_TAIL_LINES} 行（完整输出见上面的 log= 路径）`);
  }
  for (const line of shown) {
    const flat = line.replace(/\s+/g, ' ').trim();
    const cut = flat.length > BUILD_TAIL_LINE_MAX ? `${flat.slice(0, BUILD_TAIL_LINE_MAX)}…` : flat;
    console.error(`| ${cut}`);
  }
}

/**
 * 杀掉构建子进程**连同它的孩子们**（`bun run build` → `tsc` / `vite`）。
 *
 * POSIX 上子进程自成进程组（`detached`），一次 `kill(-pid)` 带走整棵树；Windows
 * 没有进程组，退回 `taskkill /T`。再兜一个 3 秒后的 SIGKILL：用户要的是「中断了
 * 就别留孤儿」，不是「发过信号了」。
 *
 * 只认 pid 不认 `ChildProcess`：宿主被打死时（Windows 的 SIGTERM 就是直接终止），
 * 替它收尾的是**另一个进程**（`gateway stop`），它只有构建 pid。
 */
function killBuildTreeByPid(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // 进程已经不在了。
    }
    return;
  }
  try {
    // 负 pid = 整个进程组（spawn 时 detached 建的）。
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 已经退出。
    }
  }
  const hard = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // 已经退出。
    }
  }, 3_000);
  hard.unref?.();
}

/**
 * 子进程整棵树的常驻内存（`web.build.progress` 的 `rss=`）。
 *
 * 为什么不是自己的 `process.memoryUsage()`：用户问的是「构建还在动吗」，那要看
 * **构建**那棵树。Linux 走 `/proc`（`children` + `VmRSS`）；其它平台读不到就不打
 * 这个字段，绝不拿网关自己的数字冒充。
 */
async function processTreeRssBytes(root: number): Promise<number | undefined> {
  if (process.platform !== 'linux' || root <= 0) return undefined;
  const queue = [root];
  const seen = new Set<number>();
  let total = 0;
  while (queue.length > 0 && seen.size < 64) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += await readRssBytes(pid);
    let tids: string[];
    try {
      tids = await readdir(`/proc/${pid}/task`);
    } catch {
      continue;
    }
    for (const tid of tids) {
      try {
        const raw = await readFile(`/proc/${pid}/task/${tid}/children`, 'utf8');
        for (const part of raw.split(/\s+/)) {
          if (part !== '') queue.push(Number(part));
        }
      } catch {
        // 线程刚退出：跳过。
      }
    }
  }
  return total > 0 ? total : undefined;
}

async function readRssBytes(pid: number): Promise<number> {
  try {
    const raw = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(raw);
    return match === null ? 0 : Number(match[1]) * 1024;
  } catch {
    return 0;
  }
}

/** `apps/web/dist` 的体量（`assets=` / `bytes=` 的来源）；有界，读不到就报 0。 */
async function distFootprint(
  dir: string,
  maxFiles = DEFAULT_MAX_FILES,
): Promise<{ assets: number; bytes: number }> {
  let assets = 0;
  let bytes = 0;
  let visited = 0;
  const walk = async (current: string): Promise<void> => {
    if (visited >= maxFiles) return;
    let entries: Dirent<string>[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      assets += 1;
      try {
        bytes += (await stat(target)).size;
      } catch {
        // 产物正在被替换：算个文件数就够。
      }
    }
  };
  await walk(dir);
  return { assets, bytes };
}

/**
 * 中断正在跑的构建（gateway 收到 SIGTERM / SIGINT / 正常停止时调用）。
 *
 * **真的杀**：先整树 SIGTERM、3 秒后 SIGKILL，所以不会留下还在往 `dist` 写的孤儿；
 * 然后打**一行**终态。返回是否真的中断了一次构建（没在构建 = false，静默）。
 *
 * **同步写元数据**：终态必须赶在进程退出前落盘，否则停止方（`gateway stop`）看到
 * 的还是 `running`，会替我们说第二遍 —— 同一件事不能说两次。
 *
 * 为什么由调用方显式调而不是在模块里挂 `process.on('SIGTERM')`：gateway 的停止
 * 顺序（drain → stop 子进程）是既有的，模块偷偷加监听会把顺序变成两套。
 */
export function interruptWebBuild(signal: string): boolean {
  const child = activeChild;
  if (child === undefined || buildState.phase !== 'running') return false;
  const startedAt = buildState.startedAt ?? Date.now();
  const elapsed = Date.now() - startedAt;
  buildState.phase = 'interrupted';
  buildState.last = {
    phase: 'interrupted',
    at: Date.now(),
    durMs: elapsed,
    signal,
    ...(buildState.logPath !== undefined ? { logPath: buildState.logPath } : {}),
  };
  if (child.pid !== undefined) killBuildTreeByPid(child.pid, 'SIGTERM');
  logEvent('warn', 'web.build.interrupted', {
    signal,
    elapsed,
    ...(buildState.logPath !== undefined ? { log: buildState.logPath } : {}),
  });
  if (activeBuildDir !== undefined) {
    writeBuildMetaSync(activeBuildDir, {
      v: 1,
      pid: child.pid ?? process.pid,
      parentPid: process.pid,
      startedAt,
      phase: 'interrupted',
      log: buildState.logPath ?? '',
      endedAt: Date.now(),
      durMs: elapsed,
      signal,
    });
  }
  return true;
}

/**
 * 宿主已经被打死、由**停止方**代打的「构建被中断」终态（Windows 唯一可行路径）。
 *
 * 为什么需要：Windows 没有可捕获的 SIGTERM（`process.kill` 就是 TerminateProcess），
 * gateway 来不及说任何话 —— 于是「这次构建是被刚才那次停止打断的」只能由刚执行停止
 * 的那个进程说，它从构建记录里认得出宿主 pid（`parentPid`）。
 *
 * 单口规则：记录已经是终态（宿主自己说过了）就**一句都不说**；只处理还写着
 * `running` 的那一次，顺手把构建树杀掉（`taskkill /T`），不留孤儿。
 * 返回 undefined = 「这次不归我说」；行由调用方用 `formatEventLine` 打。
 */
export async function interruptBuildOfStoppedHost(
  parentPid: number,
  signal: string,
): Promise<WebBuildInterruption | undefined> {
  const record = await readLatestWebBuildRecord();
  if (record === undefined || record.parentPid !== parentPid) return undefined;
  if (record.phase !== 'running') return undefined;
  const elapsed = Math.max(0, Date.now() - record.startedAt);
  killBuildTreeByPid(record.pid, 'SIGTERM');
  await writeBuildMeta(record.dir, {
    v: 1,
    pid: record.pid,
    parentPid: record.parentPid,
    startedAt: record.startedAt,
    phase: 'interrupted',
    log: record.log,
    endedAt: Date.now(),
    durMs: elapsed,
    signal,
  });
  // 行由调用方用 `formatEventLine` 打（同一个排版口），这里只说事实。
  return { signal, elapsedMs: elapsed, log: record.log };
}

/**
 * 跑一次构建（`bun run build`），「开始 / 进度 / 终态」各一行。
 *
 * 构建自己的输出**始终**写文件（路径就在 start 行里）：日志要能一眼看出「在不在
 * 建、建成没成」，失败时才把最后 ≤15 行内联出来 —— 用户说的是「一眼看出为什么
 * 失败」，不是「去翻文件」。
 */
async function runBuild(
  options: EnsureWebDistOptions,
  status: WebDistStatus,
  trigger: WebBuildTrigger,
): Promise<void> {
  const reason: 'missing' | 'stale' = status.exists ? 'stale' : 'missing';
  const startedAt = Date.now();
  const { dir, logPath } = await prepareBuildDir(startedAt);
  const ring = createLineRing();
  const sink = createWriteStream(logPath, { flags: 'w' });
  const timeoutMs = options.buildTimeoutMs ?? 180_000;

  buildState.phase = 'running';
  buildState.startedAt = startedAt;
  buildState.reason = reason;
  buildState.trigger = trigger;
  buildState.logPath = logPath;

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, ['run', 'build'], {
      cwd: DEFAULT_WEB_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX：自成进程组，中断时一次带走 tsc / vite；Windows：无进程组，靠 taskkill /T。
      detached: process.platform !== 'win32',
      // Windows：构建子进程（bun → tsc/vite）不弹可见控制台窗；输出仍走 pipe 落日志。
      windowsHide: true,
      // 构建输出进文件，不需要也不想要 ANSI：日志行要能直接 grep。
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await writeBuildMeta(dir, {
      v: 1,
      pid: process.pid,
      parentPid: process.pid,
      startedAt,
      phase: 'failed',
      log: logPath,
      endedAt: Date.now(),
      durMs: 0,
      exitCode: -1,
    });
    buildState.phase = 'failed';
    buildState.last = { phase: 'failed', at: Date.now(), durMs: 0, logPath };
    logEvent('warn', 'web.build.fail', { exit: -1, dur: 0, error: detail, log: logPath });
    await new Promise<void>((resolve) => sink.end(resolve));
    return;
  }

  activeChild = child;
  activeBuildDir = dir;
  if (child.pid !== undefined) buildState.pid = child.pid;
  logEvent('warn', 'web.build.start', {
    reason,
    target: BUILD_TARGET,
    check: trigger,
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    log: logPath,
  });
  await writeBuildMeta(dir, {
    v: 1,
    pid: child.pid ?? process.pid,
    parentPid: process.pid,
    startedAt,
    phase: 'running',
    log: logPath,
  });

  const onData = (chunk: string): void => {
    ring.push(chunk);
    sink.write(chunk);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  let progressCount = 0;
  const progressTimer = setInterval(() => {
    if (progressCount >= BUILD_PROGRESS_MAX) return;
    if (Date.now() - startedAt < BUILD_PROGRESS_FIRST_MS) return;
    progressCount += 1;
    // rss 只是「它还在动」的旁证：读不到就不打这个字段，绝不编。
    void processTreeRssBytes(child.pid ?? 0).then((rss) => {
      logEvent('warn', 'web.build.progress', {
        elapsed: Date.now() - startedAt,
        ...(rss !== undefined ? { rss } : {}),
      });
    });
  }, BUILD_PROGRESS_INTERVAL_MS);
  progressTimer.unref?.();

  interface BuildOutcome {
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    spawnError?: string;
  }
  const outcome = await new Promise<BuildOutcome>((resolve) => {
    let settled = false;
    const settle = (value: BuildOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const watchdog = setTimeout(() => {
      // 超时也是失败，但原因必须写在行里 —— 否则看到 exit=124 的人查不出为什么。
      settle({ code: 124, signal: null, timedOut: true });
      if (child.pid !== undefined) killBuildTreeByPid(child.pid, 'SIGTERM');
    }, timeoutMs);
    watchdog.unref?.();
    child.on('error', (error) => {
      clearTimeout(watchdog);
      settle({ code: null, signal: null, timedOut: false, spawnError: error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(watchdog);
      settle({ code, signal, timedOut: false });
    });
  });

  clearInterval(progressTimer);
  activeChild = undefined;
  activeBuildDir = undefined;
  await new Promise<void>((resolve) => sink.end(resolve));

  const durMs = Date.now() - startedAt;
  const metaBase = {
    v: 1 as const,
    pid: child.pid ?? process.pid,
    parentPid: process.pid,
    startedAt,
    log: logPath,
  };
  // 已经被 `interruptWebBuild` 收尾（终态行也打过了）：这里只做清理，别打第二遍。
  // 走快照而不是直接读字段：`interruptWebBuild` 是另一个函数改的状态，直接比较会被
  // TS 上面那次 `phase = 'running'` 的收窄骗过去。
  const phaseAfter = webDistBuildState().phase;
  if (phaseAfter === 'interrupted') {
    await writeBuildMeta(dir, {
      ...metaBase,
      phase: 'interrupted',
      endedAt: Date.now(),
      durMs,
      ...(buildState.last?.signal !== undefined ? { signal: buildState.last.signal } : {}),
    });
    return;
  }

  if (outcome.code === 0 && !outcome.timedOut) {
    const footprint = await distFootprint(DEFAULT_WEB_DIST_DIR);
    buildState.phase = 'done';
    buildState.last = {
      phase: 'done',
      at: Date.now(),
      durMs,
      assets: footprint.assets,
      bytes: footprint.bytes,
      logPath,
    };
    logEvent('warn', 'web.build.done', {
      dur: durMs,
      assets: footprint.assets,
      bytes: footprint.bytes,
    });
  } else {
    const exit = outcome.code ?? -1;
    buildState.phase = 'failed';
    buildState.last = {
      phase: 'failed',
      at: Date.now(),
      durMs,
      exitCode: exit,
      logPath,
    };
    logEvent('warn', 'web.build.fail', {
      exit,
      dur: durMs,
      ...(outcome.spawnError !== undefined ? { error: outcome.spawnError } : {}),
      log: logPath,
    });
    printBuildTail(ring.snapshot());
  }

  await writeBuildMeta(dir, {
    ...metaBase,
    phase: buildState.phase,
    endedAt: Date.now(),
    durMs,
    ...(buildState.last?.exitCode !== undefined ? { exitCode: buildState.last.exitCode } : {}),
    ...(buildState.last?.signal !== undefined ? { signal: buildState.last.signal } : {}),
    ...(buildState.last?.assets !== undefined ? { assets: buildState.last.assets } : {}),
    ...(buildState.last?.bytes !== undefined ? { bytes: buildState.last.bytes } : {}),
  });
}

/** 起一次 `bun run build`（或复用在飞的那次）。 */
function startBuild(
  options: EnsureWebDistOptions,
  status: WebDistStatus,
  trigger: WebBuildTrigger,
): Promise<void> {
  if (inFlightBuild !== undefined) return inFlightBuild;
  const task = runBuild(options, status, trigger)
    .catch(() => undefined)
    .finally(() => {
      inFlightBuild = undefined;
      activeChild = undefined;
      activeBuildDir = undefined;
    });
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
 * 只在**仓库内默认目录**下生效（显式 `gateway.web_dist` / `VESSEL_STATIC_DIR` 不碰）。
 * 任何失败都只告警、不改退出码，继续以现有产物提供服务。
 */
export async function ensureWebDist(options: EnsureWebDistOptions = {}): Promise<WebDistStatus> {
  const status = await inspectWebDist(options);
  const enabled = options.autoBuild ?? webAutoBuildMode() !== 'off';
  if (!enabled) return status;
  if (status.exists && !status.stale) return status;
  // 只构建仓库内的默认产物；显式 staticDir / VESSEL_STATIC_DIR 指向的目录不归我们管。
  const explicitDir = options.staticDir ?? process.env.VESSEL_STATIC_DIR;
  if (explicitDir !== undefined && explicitDir.trim() !== '') return status;
  if (!canAutoBuild()) return status;

  // 上次被硬杀留下的构建临时目录：先清掉，再开工（只报一行总数）。
  const cleaned = await cleanStaleWebBuildDirs().catch(() => 0);
  if (cleaned > 0) {
    logEvent('warn', 'web.build.stale_artifact', { cleaned, dir: buildLogRoot() });
  }

  const task = startBuild(options, status, 'startup');
  if (options.waitWhenMissing === true && !status.exists) {
    await task;
    // 建完复核真实结果：成功 → `exists: true`；失败 → 仍是「缺失」，交给调用方
    // 用一句精简提示收尾（构建细节已经在 `web.build.fail` + 尾部里）。
    return inspectWebDist(options);
  }
  return status;
}

/** 「探测 / 定时自查」两轮之间至少隔这么久（60s 限频，留 5s 抖动余量）。 */
const RECHECK_MIN_INTERVAL_MS = 55_000;

/**
 * 运行中的**自查一轮**：没人开浏览器时，靠它把「源码改了但产物是旧的」自愈掉
 * （0.61）。启动时的 `ensureWebDist` 只跑一次，撑不住「gateway 一直开着」的场景。
 *
 * 复用而不是另起一套：判据仍是 `inspectWebDist`、互斥仍是 `inFlightBuild`、
 * 构建入口仍是 `startBuild`。这里只多两件事 —— **限频**（60s 内不重复触发）和
 * **来源标记**（`web.build.start check=probe|timer`）。
 *
 * 自查本身**一行日志都不打**：60s 一次打一行会把日志刷满，而「没变化」本来就不是
 * 事实。只有真的因此起了构建，才由 `web.build.start` 说话。
 *
 * 三档开关语义（见 `webAutoBuildMode`）：`off` / `startup` 都**不**自查 —— 只有
 * `always`（缺省）才在运行中继续自愈。
 */
export async function recheckWebDist(
  trigger: 'probe' | 'timer',
  options: { staticDir?: string } = {},
): Promise<void> {
  if (webAutoBuildMode() !== 'always') return;
  // q-config-priority（用户裁定#2）：装配面把生效 staticDir 传进来 —— 显式
  // `gateway.web_dist` 指向的外部产物不归我们管（与 VESSEL_STATIC_DIR 同口径）。
  // 未传 / 传的就是仓库内默认目录时，仍按 env 判（兼容旧调用）。
  const explicitDir =
    options.staticDir !== undefined &&
    path.resolve(options.staticDir) !== path.resolve(DEFAULT_WEB_DIST_DIR)
      ? options.staticDir
      : process.env.VESSEL_STATIC_DIR;
  if (explicitDir !== undefined && explicitDir.trim() !== '') return;
  if (!canAutoBuild()) return;
  // 正在建就别排队：这轮本来也只是「确认一下还旧不旧」。
  if (inFlightBuild !== undefined) return;
  const now = Date.now();
  if (now - lastRecheckTriggerAt < RECHECK_MIN_INTERVAL_MS) return;

  const status = await inspectWebDist({});
  if (!status.exists || !status.stale) return;
  // 复核期间可能刚起了一次构建（探针与定时器同时到）：再确认一次，别并发。
  if (inFlightBuild !== undefined) return;
  lastRecheckTriggerAt = now;
  startBuild({}, status, trigger);
}
