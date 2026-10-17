import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSET_NAMES, buildLatestJson } from '../latest-json';

describe('buildLatestJson', () => {
  it('emits an empty asset map when no dir is provided', async () => {
    const data = await buildLatestJson({
      version: '0.1.0',
      channel: 'latest',
      releasedAt: '2026-10-17T00:00:00.000Z',
    });

    expect(data).toEqual({
      version: '0.1.0',
      channel: 'latest',
      released_at: '2026-10-17T00:00:00.000Z',
      assets: {},
    });
  });

  it('hashes known assets and builds GitHub release URLs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vessel-latest-'));
    try {
      for (const filename of Object.values(ASSET_NAMES)) {
        await writeFile(join(dir, filename), 'asset');
      }

      const data = await buildLatestJson({
        version: '0.2.0-beta.1',
        channel: 'beta',
        tag: 'v0.2.0-beta.1',
        repo: 'egg-rolls/Vessel',
        dir,
        releasedAt: '2026-10-17T00:00:00.000Z',
      });

      expect(Object.keys(data.assets).sort()).toEqual(Object.keys(ASSET_NAMES).sort());
      expect(data.assets['windows-x64']?.url).toBe(
        'https://github.com/egg-rolls/Vessel/releases/download/v0.2.0-beta.1/vessel-windows-x64.exe',
      );
      expect(data.assets['linux-x64']?.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a missing asset or missing repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vessel-latest-'));
    try {
      await expect(
        buildLatestJson({ version: '0.2.0', channel: 'latest', repo: 'egg-rolls/Vessel', dir }),
      ).rejects.toThrow('missing release asset');

      await expect(buildLatestJson({ version: '0.2.0', channel: 'latest', dir })).rejects.toThrow(
        'repo is required',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
