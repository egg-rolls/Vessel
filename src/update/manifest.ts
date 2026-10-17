/**
 * 更新清单（latest.json）解析与来源解析。
 *
 * 契约见 docs/operations/CI-CD.md §2：
 * { version, channel, released_at, assets: { "<platform>-<arch>": { url, sha256 } } }
 * 0.1.0 只做版本检查，不下载 asset；assets 可缺省，但格式错误要显式失败。
 */

import { parseVersion } from './semver';

export type UpdateChannel = 'latest' | 'beta';

export interface UpdateAsset {
  url: string;
  sha256?: string;
}

export interface UpdateManifest {
  version: string;
  channel: UpdateChannel;
  releasedAt?: string;
  assets?: Record<string, UpdateAsset>;
}

/** 默认清单源（GitHub Release） */
export const DEFAULT_UPDATE_SOURCE = 'https://github.com/egg-rolls/Vessel';

/** 解析清单；非法返回 null */
export function parseManifest(
  raw: unknown,
  expectedChannel?: UpdateChannel,
): UpdateManifest | null {
  if (!isRecord(raw)) return null;

  const version = raw.version;
  if (typeof version !== 'string' || !parseVersion(version)) return null;

  const channel = raw.channel;
  if (channel !== 'latest' && channel !== 'beta') return null;
  if (expectedChannel && channel !== expectedChannel) return null;

  const releasedAt = typeof raw.released_at === 'string' ? raw.released_at : undefined;

  let assets: Record<string, UpdateAsset> | undefined;
  if (raw.assets !== undefined) {
    if (!isRecord(raw.assets)) return null;
    assets = {};
    for (const [key, value] of Object.entries(raw.assets)) {
      if (!isRecord(value) || typeof value.url !== 'string') return null;
      const sha256 = typeof value.sha256 === 'string' ? value.sha256 : undefined;
      assets[key] = sha256 ? { url: value.url, sha256 } : { url: value.url };
    }
  }

  return {
    version,
    channel,
    ...(releasedAt ? { releasedAt } : {}),
    ...(assets ? { assets } : {}),
  };
}

/**
 * 平台资产键：win32 → windows、x64 → x64。
 * 例如 Windows x64 = `windows-x64`，macOS arm64 = `darwin-arm64`。
 */
export function platformAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === 'win32' ? 'windows' : platform;
  return `${os}-${arch}`;
}

/**
 * 解析清单 URL：
 * - 显式 `.json` 源：直接使用（测试与自建镜像）；
 * - latest：`<source>/releases/latest/download/latest.json`；
 * - beta：返回 GitHub releases API 地址，由调用方挑选最新预发布资产。
 */
export function resolveManifestUrl(source: string, channel: UpdateChannel): string {
  const base = source.replace(/\/+$/, '');
  if (base.endsWith('.json')) return base;
  if (channel === 'latest') {
    return `${base}/releases/latest/download/latest.json`;
  }
  return `${base}/releases?per_page=20`;
}

/** 从 GitHub releases 响应中挑选最新预发布版本的 latest.json 资产 URL */
export function pickBetaManifestUrl(releases: unknown): string | null {
  if (!Array.isArray(releases)) return null;
  for (const release of releases) {
    if (!isRecord(release) || release.prerelease !== true) continue;
    const assets = release.assets;
    if (!Array.isArray(assets)) continue;
    for (const asset of assets) {
      if (!isRecord(asset)) continue;
      if (asset.name === 'latest.json' && typeof asset.browser_download_url === 'string') {
        return asset.browser_download_url;
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
