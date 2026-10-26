import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UpdateManifest } from '../update/manifest';
import { STAGE_MARKER, stageUpdate } from '../update/stage';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vessel-stage-'));
  tempDirs.push(dir);
  return dir;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifest(assets: UpdateManifest['assets']): UpdateManifest {
  return { version: '0.27.0', channel: 'latest', assets };
}

const CONTENT = new TextEncoder().encode('staged artifact bytes');

describe('stageUpdate', () => {
  it('downloads, verifies and stages the asset; second call reuses it', async () => {
    const updatesDir = await tempDir();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(CONTENT);
    }) as unknown as typeof fetch;

    const first = await stageUpdate({
      manifest: manifest({
        'test-x64': { url: 'https://example.com/vessel-0.27.0.tgz', sha256: sha256(CONTENT) },
      }),
      assetKey: 'test-x64',
      updatesDir,
      fetchImpl,
    });

    expect(first.staged).toBe(true);
    if (!first.staged) throw new Error('expected staged');
    expect(await readFile(first.path)).toEqual(Buffer.from(CONTENT));
    const marker = JSON.parse(
      await readFile(path.join(updatesDir, '0.27.0', STAGE_MARKER), 'utf8'),
    );
    expect(marker).toMatchObject({ version: '0.27.0', asset: 'test-x64', bytes: CONTENT.length });

    const second = await stageUpdate({
      manifest: manifest({
        'test-x64': { url: 'https://example.com/vessel-0.27.0.tgz', sha256: sha256(CONTENT) },
      }),
      assetKey: 'test-x64',
      updatesDir,
      fetchImpl,
    });
    expect(second.staged).toBe(true);
    expect(calls).toBe(1);
  });

  it('rejects a sha256 mismatch and leaves no partial file', async () => {
    const updatesDir = await tempDir();
    const fetchImpl = (async () => new Response(CONTENT)) as unknown as typeof fetch;

    const outcome = await stageUpdate({
      manifest: manifest({
        'test-x64': { url: 'https://example.com/vessel.tgz', sha256: '0'.repeat(64) },
      }),
      assetKey: 'test-x64',
      updatesDir,
      fetchImpl,
    });

    expect(outcome.staged).toBe(false);
    if (outcome.staged) throw new Error('expected failure');
    expect(outcome.reason).toContain('sha256 mismatch');
    const files = await readdir(path.join(updatesDir, '0.27.0')).catch(() => []);
    expect(files.filter((name) => name.includes('.part-'))).toEqual([]);
  });

  it('skips when the platform asset is missing', async () => {
    const outcome = await stageUpdate({
      manifest: manifest(undefined),
      assetKey: 'windows-x64',
      updatesDir: await tempDir(),
    });
    expect(outcome).toMatchObject({ staged: false, skipped: true });
  });

  it('skips when the asset has no sha256', async () => {
    const outcome = await stageUpdate({
      manifest: manifest({ 'test-x64': { url: 'https://example.com/vessel.tgz' } }),
      assetKey: 'test-x64',
      updatesDir: await tempDir(),
    });
    expect(outcome).toMatchObject({ staged: false, skipped: true });
    if (!outcome.staged) expect(outcome.reason).toContain('no sha256');
  });

  it('refuses oversized assets', async () => {
    const updatesDir = await tempDir();
    const fetchImpl = (async () => new Response(CONTENT)) as unknown as typeof fetch;

    const outcome = await stageUpdate({
      manifest: manifest({
        'test-x64': { url: 'https://example.com/vessel.tgz', sha256: sha256(CONTENT) },
      }),
      assetKey: 'test-x64',
      updatesDir,
      fetchImpl,
      maxBytes: 4,
    });

    expect(outcome.staged).toBe(false);
    if (!outcome.staged) expect(outcome.reason).toContain('too large');
  });

  it('reports HTTP failures without staging', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const outcome = await stageUpdate({
      manifest: manifest({
        'test-x64': { url: 'https://example.com/vessel.tgz', sha256: sha256(CONTENT) },
      }),
      assetKey: 'test-x64',
      updatesDir: await tempDir(),
      fetchImpl,
    });
    expect(outcome.staged).toBe(false);
    if (!outcome.staged) expect(outcome.reason).toContain('HTTP 404');
  });
});
