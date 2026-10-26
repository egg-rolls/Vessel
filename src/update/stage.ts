/**
 * 更新资产暂存（CONTRACT-hot-apply §3 update scope）。
 *
 * gateway 发现新版本后，只做「下载 + 校验 + 暂存」，**不安装、不重启**：
 * - 资产来自清单的 `assets[<platform>-<arch>]`；缺资产 / 缺 sha256 一律不暂存；
 * - 下载后校验 sha256（大小写不敏感），不一致删除临时文件并报错；
 * - 暂存目录 `~/.vessel/updates/<version>/`，写入 `<artifact>` + `staged.json`；
 * - 同版本已暂存且 sha256 一致时直接复用，不重复下载；
 * - 有最大体积上限，防止清单被替换成超大文件。
 *
 * @module vessel/update/stage
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UpdateAsset, UpdateManifest } from './manifest';

/** 单文件上限：512 MiB。 */
export const MAX_STAGE_BYTES = 512 * 1024 * 1024;

/** 暂存标记文件名。 */
export const STAGE_MARKER = 'staged.json';

/** 暂存结果。 */
export type StageOutcome =
  | { staged: true; path: string; version: string; sha256: string }
  | { staged: false; reason: string /** true = 没有可暂存资产，不算失败 */; skipped?: boolean };

export interface StageUpdateOptions {
  manifest: UpdateManifest;
  /** 平台资产键；缺省按当前进程推导。 */
  assetKey?: string;
  /** `~/.vessel/updates`；测试可注入临时目录。 */
  updatesDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

interface StageMarker {
  version: string;
  asset: string;
  sha256: string;
  bytes: number;
  staged_at: number;
}

/** 默认暂存根目录 `~/.vessel/updates`。 */
export function getUpdateStageRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.vessel', 'updates');
}

/** 资产键（与 manifest 的 `platformAssetKey` 一致；此处避免循环依赖由调用方传入）。 */
function defaultAssetKey(): string {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  return `${platform}-${process.arch}`;
}

/** URL 最后一段作为文件名；去掉查询串与不安全字符。 */
function artifactName(url: string): string {
  let tail: string;
  try {
    tail = path.basename(new URL(url).pathname);
  } catch {
    tail = path.basename(url.split('?')[0] ?? '');
  }
  const safe = tail.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe === '' || safe === '.' || safe === '..' ? 'artifact' : safe;
}

async function readMarker(filePath: string): Promise<StageMarker | null> {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Partial<StageMarker>;
    if (
      typeof raw.version !== 'string' ||
      typeof raw.asset !== 'string' ||
      typeof raw.sha256 !== 'string' ||
      typeof raw.bytes !== 'number'
    ) {
      return null;
    }
    return {
      version: raw.version,
      asset: raw.asset,
      sha256: raw.sha256,
      bytes: raw.bytes,
      staged_at: typeof raw.staged_at === 'number' ? raw.staged_at : 0,
    };
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 暂存一份更新资产。网络/校验失败返回 `{ staged: false, reason }`，不抛异常
 * （gateway 侧据此发失败 notice；CLI 可自行决定是否视为错误）。
 */
export async function stageUpdate(options: StageUpdateOptions): Promise<StageOutcome> {
  const { manifest } = options;
  const assetKey = options.assetKey ?? defaultAssetKey();
  const asset: UpdateAsset | undefined = manifest.assets?.[assetKey];
  if (asset === undefined) {
    return {
      staged: false,
      skipped: true,
      reason: `no asset for ${assetKey}`,
    };
  }
  const expected = asset.sha256?.trim().toLowerCase();
  if (expected === undefined || expected === '') {
    return {
      staged: false,
      skipped: true,
      reason: `asset ${assetKey} has no sha256`,
    };
  }

  const root = options.updatesDir ?? getUpdateStageRoot();
  const versionDir = path.join(root, manifest.version);
  const fileName = artifactName(asset.url);
  const target = path.join(versionDir, fileName);
  const markerPath = path.join(versionDir, STAGE_MARKER);
  const maxBytes = options.maxBytes ?? MAX_STAGE_BYTES;

  // 已暂存且校验值一致：复用，不重复下载。
  const marker = await readMarker(markerPath);
  if (
    marker !== null &&
    marker.version === manifest.version &&
    marker.asset === assetKey &&
    marker.sha256 === expected &&
    (await exists(target))
  ) {
    return { staged: true, path: target, version: manifest.version, sha256: expected };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('update asset download timed out')),
    options.timeoutMs ?? 30_000,
  );
  (timeout as { unref?: () => void }).unref?.();

  const temp = `${target}.part-${process.pid}-${Date.now()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const response = await fetchImpl(asset.url, { signal: controller.signal });
    if (!response.ok) {
      return { staged: false, reason: `download failed: HTTP ${response.status}` };
    }
    const length = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(length) && length > maxBytes) {
      return { staged: false, reason: `asset too large (${length} bytes)` };
    }
    if (response.body === null) {
      return { staged: false, reason: 'download failed: empty body' };
    }

    await mkdir(versionDir, { recursive: true });
    handle = await open(temp, 'w');
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new Error(`asset too large (> ${maxBytes} bytes)`);
      }
      hash.update(value);
      await handle.write(value);
    }
    await handle.close();
    handle = undefined;

    const actual = hash.digest('hex').toLowerCase();
    if (actual !== expected) {
      await unlink(temp).catch(() => undefined);
      return {
        staged: false,
        reason: `sha256 mismatch (expected ${expected}, got ${actual})`,
      };
    }

    await rename(temp, target);
    const staged: StageMarker = {
      version: manifest.version,
      asset: assetKey,
      sha256: actual,
      bytes,
      staged_at: Date.now(),
    };
    await writeFile(markerPath, JSON.stringify(staged, null, 2), { encoding: 'utf8', mode: 0o600 });
    return { staged: true, path: target, version: manifest.version, sha256: actual };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    return {
      staged: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
