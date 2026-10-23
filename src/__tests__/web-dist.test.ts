import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectWebDist, webDistWarning } from '../web-dist';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vessel-web-dist-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('inspectWebDist', () => {
  it('reports a missing index.html instead of silently disabling static hosting', async () => {
    const root = await tempRoot();
    const dist = join(root, 'dist');
    await mkdir(dist, { recursive: true });

    const status = await inspectWebDist({
      staticDir: dist,
      webSrcDir: join(root, 'src'),
      extraSourceFiles: [],
      checkStale: true,
    });

    expect(status.exists).toBe(false);
    expect(webDistWarning(status)).toContain(dist);
  });

  it('reports a dist older than the newest source file as stale', async () => {
    const root = await tempRoot();
    const dist = join(root, 'dist');
    const src = join(root, 'src');
    await mkdir(dist, { recursive: true });
    await mkdir(src, { recursive: true });
    const index = join(dist, 'index.html');
    const source = join(src, 'view.tsx');
    await writeFile(index, '<html></html>');
    await writeFile(source, 'export const view = 1;\n');
    await utimes(index, new Date(1_000_000), new Date(1_000_000));
    await utimes(source, new Date(2_000_000), new Date(2_000_000));

    const status = await inspectWebDist({
      staticDir: dist,
      webSrcDir: src,
      extraSourceFiles: [],
      checkStale: true,
    });

    expect(status.stale).toBe(true);
    expect(status.newestSource?.path).toBe(source);
    expect(webDistWarning(status)).toContain(source);
  });
});
