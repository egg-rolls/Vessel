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

/** 磁盘上 `dist/build.json` 的形状（与 `WebBuildInfo` 相同）。 */
export type ServedBuildInfo = WebBuildInfo;

/**
 * 拉取当前被托管的 `build.json`。
 *
 * 带 `cache: 'no-store'`：这个文件就是用来感知变化的，命中缓存等于没查。
 * 任何失败（旧产物没有该文件 / 网关不托管）返回 `undefined`，调用方按「无法判断」处理。
 */
export async function fetchServedBuild(signal?: AbortSignal): Promise<ServedBuildInfo | undefined> {
  try {
    const response = await fetch('/build.json', {
      cache: 'no-store',
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!response.ok) return undefined;
    const raw: unknown = await response.json();
    if (typeof raw !== 'object' || raw === null) return undefined;
    const record = raw as Partial<WebBuildInfo>;
    if (typeof record.builtAt !== 'string' || record.builtAt === '') return undefined;
    return {
      builtAt: record.builtAt,
      version: typeof record.version === 'string' ? record.version : 'unknown',
      commit: typeof record.commit === 'string' ? record.commit : 'unknown',
    };
  } catch {
    return undefined;
  }
}

/** 页面自己那次构建是否已经不是当前托管的那一份。 */
export function isOutdated(served: ServedBuildInfo | undefined): boolean {
  if (served === undefined) return false;
  if (WEB_BUILD.builtAt === 'unknown') return false;
  return served.builtAt !== WEB_BUILD.builtAt;
}
