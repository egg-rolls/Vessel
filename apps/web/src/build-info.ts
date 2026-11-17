/**
 * 构建指纹（`vite.config.ts` 的 `define` 注入）。
 *
 * `apps/web/dist` 不入 git，gateway 在产物过期时**后台重建**。重建完成后，
 * 正在运行的页面仍是旧 bundle —— 这里把它自己那次构建的标记编进来，
 * 运行时与 `dist/build.json`（重建后会被改写）比对，不一致就提示刷新。
 *
 * @module @vessel-agent/web/build-info
 */

export interface WebBuildInfo {
  /** ISO 时间戳；同一毫秒内两次构建也会不同，足够做「是否换了一份产物」的判据 */
  builtAt: string;
  version: string;
  commit: string;
}

declare const __VESSEL_WEB_BUILD__: WebBuildInfo | undefined;

export const WEB_BUILD: WebBuildInfo = (() => {
  // 生产构建与 vite dev 都会注入；其它打包器 / 测试下兜底。
  if (typeof __VESSEL_WEB_BUILD__ !== 'undefined') return __VESSEL_WEB_BUILD__;
  return { builtAt: 'unknown', version: 'unknown', commit: 'unknown' };
})();

/**
 * 服务端下发的 `/build.json`：磁盘上的构建戳**加上**服务端现场判断。
 *
 * - `builtAt` / `version` / `commit`：静态文件里的字段（老前端只读这三个）。
 * - `stale`：0.57 新增 —— 服务端发现**源码比产物新**（dist 没人重建）。这是前端
 *   唯一能知道「我跑的是旧代码、而且还没人重建」的证据：这种情况下磁盘上的
 *   `builtAt` 与页面自己那份 bundle 是**同一次构建**，比对永远一致。
 * - `newestSource`：落后到什么程度（哪个源文件比产物新），只用于提示的诊断文案。
 * - `building`：0.58 新增 —— 后台重建**此刻**在跑。判断顺序里它最优先：构建中刷新
 *   只会拿到正在被改写的旧产物，提示条必须说「等一等」，不能叫人去刷新。
 */
export interface ServedBuildInfo extends WebBuildInfo {
  stale?: boolean;
  newestSource?: { path: string; mtime: string };
  building?: boolean;
}

/**
 * 「页面该刷新了」的三种原因：
 * - `building`：后台正在重建 ⇒ 现在刷新没用（磁盘上还是旧的），等它说完事；
 * - `rebuilt`：服务端已经重建过产物（`builtAt` 变了）⇒ 刷新就能拿到新版本；
 * - `stale`：源码比产物新、**还没人重建**（或重建失败/被禁用）⇒ 刷新也没用，只能重启重试。
 *
 * 分开是因为「怎么办」不同：一个叫用户等，一个叫他刷新，最后一个必须告诉人怎么把
 * 产物建出来。混成一句话就会出现「构建中让人刷新」这种误导。
 */
export type OutdatedReason = 'building' | 'rebuilt' | 'stale';

/**
 * 把「服务端说的一份构建」解析成 `ServedBuildInfo`；不认识的形状一律 `undefined`。
 *
 * 只读自己认识的那几个字段：服务端多下发的字段（`stale` / `newestSource` / 以后
 * 再加的）一律无视 —— 这是**协议增量**的前提，老前端读到新响应不会失败。
 * 普通轮询（JSON 响应）与推送帧（SSE 的 `data:`）共用这一个解析。
 */
export function parseServedBuild(raw: unknown): ServedBuildInfo | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Partial<ServedBuildInfo>;
  if (typeof record.builtAt !== 'string' || record.builtAt === '') return undefined;
  const newest = record.newestSource;
  return {
    builtAt: record.builtAt,
    version: typeof record.version === 'string' ? record.version : 'unknown',
    commit: typeof record.commit === 'string' ? record.commit : 'unknown',
    // 只有明确的 `true` 才算证据：缺字段 / 类型不对都当「不知道」，宁可沉默。
    ...(record.stale === true ? { stale: true } : {}),
    ...(record.building === true ? { building: true } : {}),
    ...(typeof newest === 'object' &&
    newest !== null &&
    typeof newest.path === 'string' &&
    typeof newest.mtime === 'string'
      ? { newestSource: { path: newest.path, mtime: newest.mtime } }
      : {}),
  };
}

/** 解析 SSE 帧里的 JSON 文本；坏帧（半截 / 非 JSON）返回 `undefined`，不抛错。 */
export function parseServedBuildText(text: string): ServedBuildInfo | undefined {
  try {
    return parseServedBuild(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * 拉取当前被托管的 `build.json`。
 *
 * 带 `cache: 'no-store'`：这个文件就是用来感知变化的，命中缓存等于没查。
 * 任何失败（旧产物没有该文件 / 网关不托管 / 网关版本旧到没有实时字段）返回 `undefined`，
 * 调用方按「无法判断」处理。
 */
export async function fetchServedBuild(signal?: AbortSignal): Promise<ServedBuildInfo | undefined> {
  try {
    const response = await fetch('/build.json', {
      cache: 'no-store',
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!response.ok) return undefined;
    return parseServedBuild((await response.json()) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * 页面为什么该刷新了；不该刷新返回 `undefined`。
 *
 * 顺序有讲究：
 * 1. `building === true` **最先** —— 构建进行中磁盘上还是旧产物，此时叫用户刷新是
 *    句废话（真机上就是这么被骂的）；先让他等，构建完了下一帧自然会变成 `rebuilt`；
 * 2. `builtAt` 不一致说明服务端**已经**有更新的产物，刷新立刻见效；
 * 3. `stale === true` 是「源码新、产物没重建」（构建失败 / 被禁用）—— 这种时候刷新
 *    不会变好，提示只能说「重启重试」（见 AppShell 的三态文案）。
 */
export function outdatedReason(served: ServedBuildInfo | undefined): OutdatedReason | undefined {
  if (served === undefined) return undefined;
  if (served.building === true) return 'building';
  if (WEB_BUILD.builtAt !== 'unknown' && served.builtAt !== WEB_BUILD.builtAt) return 'rebuilt';
  if (served.stale === true) return 'stale';
  return undefined;
}

/** 页面自己那次构建是否已经不是当前托管的那一份。 */
export function isOutdated(served: ServedBuildInfo | undefined): boolean {
  return outdatedReason(served) !== undefined;
}
