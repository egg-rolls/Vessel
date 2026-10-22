import { afterEach, describe, expect, it } from 'bun:test';
import { CHECK_INTERVAL_MS, shouldCheck, type UpdateCheckCache } from '../update/cache';
import { checkForUpdate, installHint } from '../update/check';
import {
  parseManifest,
  pickBetaManifestUrl,
  platformAssetKey,
  resolveManifestUrl,
} from '../update/manifest';
import { compareVersions, isNewerVersion, parseVersion } from '../update/semver';

describe('semver', () => {
  it('解析合法版本', () => {
    expect(parseVersion('0.1.0')).toEqual({
      major: 0,
      minor: 1,
      patch: 0,
      prerelease: [],
    });
    expect(parseVersion('v0.2.0-beta.1')?.prerelease).toEqual(['beta', 1]);
  });

  it('拒绝非法版本', () => {
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('1.2.3.4')).toBeNull();
  });

  it('按 semver 比较，预发布低于正式版', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0-beta.2', '0.2.0-beta.1')).toBe(1);
    expect(compareVersions('0.2.0-beta.10', '0.2.0-beta.2')).toBe(1);
  });

  it('isNewerVersion', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
  });
});

describe('manifest', () => {
  it('解析合法清单（assets 可选）', () => {
    expect(parseManifest({ version: '0.2.0', channel: 'latest' })).toEqual({
      version: '0.2.0',
      channel: 'latest',
    });
    expect(
      parseManifest({
        version: '0.2.0-beta.1',
        channel: 'beta',
        released_at: '2026-10-17T00:00:00Z',
        assets: { 'windows-x64': { url: 'https://example.com/v.exe', sha256: 'abc' } },
      }),
    ).toEqual({
      version: '0.2.0-beta.1',
      channel: 'beta',
      releasedAt: '2026-10-17T00:00:00Z',
      assets: { 'windows-x64': { url: 'https://example.com/v.exe', sha256: 'abc' } },
    });
  });

  it('拒绝非法清单', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest({ version: 'bad', channel: 'latest' })).toBeNull();
    expect(parseManifest({ version: '0.2.0', channel: 'nightly' })).toBeNull();
    expect(parseManifest({ version: '0.2.0', channel: 'latest' }, 'beta')).toBeNull();
    expect(
      parseManifest({ version: '0.2.0', channel: 'latest', assets: { x: { url: 1 } } }),
    ).toBeNull();
  });

  it('平台键映射', () => {
    expect(platformAssetKey('win32', 'x64')).toBe('windows-x64');
    expect(platformAssetKey('linux', 'x64')).toBe('linux-x64');
    expect(platformAssetKey('darwin', 'arm64')).toBe('darwin-arm64');
  });

  it('清单 URL 解析', () => {
    expect(resolveManifestUrl('https://github.com/o/r', 'latest')).toBe(
      'https://github.com/o/r/releases/latest/download/latest.json',
    );
    expect(resolveManifestUrl('https://mirror.example/latest.json', 'beta')).toBe(
      'https://mirror.example/latest.json',
    );
    expect(resolveManifestUrl('https://github.com/o/r/', 'beta')).toBe(
      'https://github.com/o/r/releases?per_page=20',
    );
  });

  it('从 releases 中挑最新预发布的 latest.json', () => {
    const releases = [
      { prerelease: false, assets: [{ name: 'latest.json', browser_download_url: 'stable' }] },
      {
        prerelease: true,
        assets: [{ name: 'other.txt', browser_download_url: 'x' }],
      },
      {
        prerelease: true,
        assets: [{ name: 'latest.json', browser_download_url: 'https://example.com/beta.json' }],
      },
    ];
    expect(pickBetaManifestUrl(releases)).toBe('https://example.com/beta.json');
    expect(pickBetaManifestUrl([])).toBeNull();
    expect(pickBetaManifestUrl('nope')).toBeNull();
  });
});

describe('checkForUpdate', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  function serve(handler: (path: string) => Response): string {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        return handler(new URL(req.url).pathname);
      },
    });
    return `http://127.0.0.1:${server.port}/latest.json`;
  }

  it('发现新版本', async () => {
    const source = serve(() => Response.json({ version: '0.2.0', channel: 'latest' }));
    const result = await checkForUpdate({
      currentVersion: '0.1.0',
      channel: 'latest',
      source,
    });
    expect(result.upToDate).toBe(false);
    expect(result.latest).toBe('0.2.0');
    expect(result.installHint).toContain('vessel-agent@0.2.0');
  });

  it('已是最新', async () => {
    const source = serve(() => Response.json({ version: '0.1.0', channel: 'latest' }));
    const result = await checkForUpdate({
      currentVersion: '0.1.0',
      channel: 'latest',
      source,
    });
    expect(result.upToDate).toBe(true);
  });

  it('beta 清单通道不匹配时报错', async () => {
    const source = serve(() => Response.json({ version: '0.2.0-beta.1', channel: 'latest' }));
    await expect(
      checkForUpdate({ currentVersion: '0.1.0', channel: 'beta', source }),
    ).rejects.toThrow('Invalid update manifest');
  });

  it('404 报错', async () => {
    const source = serve(() => new Response('not found', { status: 404 }));
    await expect(
      checkForUpdate({ currentVersion: '0.1.0', channel: 'latest', source }),
    ).rejects.toThrow('HTTP 404');
  });
});

describe('cache', () => {
  const cache: UpdateCheckCache = {
    checkedAt: 1_000,
    current: '0.1.0',
    latest: '0.2.0',
    channel: 'latest',
  };

  it('无缓存或超过 24h 才检查', () => {
    expect(shouldCheck(null)).toBe(true);
    expect(shouldCheck(cache, 1_000 + CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(shouldCheck(cache, 1_000 + CHECK_INTERVAL_MS)).toBe(true);
  });
});

describe('installHint', () => {
  it('给出包管理器命令，不做自替换', () => {
    expect(installHint('0.2.0')).toContain('bun add -g vessel-agent@0.2.0');
    expect(installHint('0.2.0')).toContain('npm i -g vessel-agent@0.2.0');
  });
});
