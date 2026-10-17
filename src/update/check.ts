/**
 * 更新检查——只读：拉取清单、比较版本、生成升级提示。
 * 0.1.0 不下载、不校验、不自替换（二进制分发尚未定稿）。
 */

import {
  DEFAULT_UPDATE_SOURCE,
  parseManifest,
  pickBetaManifestUrl,
  resolveManifestUrl,
  type UpdateChannel,
  type UpdateManifest,
} from './manifest';
import { isNewerVersion } from './semver';

export interface UpdateCheckOptions {
  currentVersion: string;
  channel: UpdateChannel;
  /** 缺省 GitHub Release；以 `.json` 结尾时直接作为清单地址（测试/镜像） */
  source?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface UpdateCheckResult {
  current: string;
  latest: string;
  channel: UpdateChannel;
  upToDate: boolean;
  installHint: string;
  manifest: UpdateManifest;
}

/** 检查更新；网络/格式错误抛异常，由调用方决定静默或报错 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const source = options.source ?? DEFAULT_UPDATE_SOURCE;
  const timeoutMs = options.timeoutMs ?? 3000;
  const fetchImpl = options.fetchImpl ?? fetch;

  const manifestUrl = await resolveSourceManifestUrl(fetchImpl, source, options.channel, timeoutMs);

  const raw = await fetchJson(fetchImpl, manifestUrl, timeoutMs);
  const manifest = parseManifest(raw, options.channel);
  if (!manifest) {
    throw new Error(`Invalid update manifest at ${manifestUrl}`);
  }

  return {
    current: options.currentVersion,
    latest: manifest.version,
    channel: manifest.channel,
    upToDate: !isNewerVersion(manifest.version, options.currentVersion),
    installHint: installHint(manifest.version),
    manifest,
  };
}

/** beta 通道需要先走 releases API 找到预发布版本的 latest.json 资产 */
async function resolveSourceManifestUrl(
  fetchImpl: typeof fetch,
  source: string,
  channel: UpdateChannel,
  timeoutMs: number,
): Promise<string> {
  const direct = resolveManifestUrl(source, channel);
  if (channel === 'latest' || direct.endsWith('.json')) {
    return direct;
  }

  const releases = await fetchJson(fetchImpl, direct, timeoutMs);
  const picked = pickBetaManifestUrl(releases);
  if (!picked) {
    throw new Error('No beta release with a latest.json asset found');
  }
  return picked;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return (await response.json()) as unknown;
}

/** 0.1.0 的升级方式：提示包管理器命令，不做自替换 */
export function installHint(version: string): string {
  return `bun add -g vessel@${version}  (or npm i -g vessel@${version})`;
}
