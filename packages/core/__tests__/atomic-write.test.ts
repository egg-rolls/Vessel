import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../src/index';

const roots: string[] = [];

function tempDir(): string {
  const dir = join(process.env.TEMP ?? '/tmp', `vessel-atomic-${randomUUID()}`);
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('atomicWrite (0.5 E3)', () => {
  it('writes a file atomically and leaves no temp files', async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'state.json');

    await atomicWrite(file, '{"ok":true}');

    expect(await readFile(file, 'utf8')).toBe('{"ok":true}');
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('overwrites an existing file', async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'state.json');
    await writeFile(file, 'old', 'utf8');

    await atomicWrite(file, 'new');

    expect(await readFile(file, 'utf8')).toBe('new');
  });

  it('creates parent directories when ensureDir is set', async () => {
    const dir = tempDir();
    const file = join(dir, 'nested', 'deep', 'state.json');

    await atomicWrite(file, 'x', { ensureDir: true });

    expect(await readFile(file, 'utf8')).toBe('x');
  });

  it('serializes concurrent writes to valid content', async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'state.json');
    const payloads = Array.from({ length: 20 }, (_, i) => JSON.stringify({ i }));

    await Promise.all(payloads.map((payload) => atomicWrite(file, payload)));

    const parsed = JSON.parse(await readFile(file, 'utf8')) as { i: number };
    expect(parsed.i).toBeGreaterThanOrEqual(0);
    expect(parsed.i).toBeLessThan(20);
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('cleans up the temp file when the final path is invalid', async () => {
    const dir = tempDir();
    await mkdir(join(dir, 'target.json'), { recursive: true });

    await expect(atomicWrite(join(dir, 'target.json'), 'x', { retries: 1 })).rejects.toBeDefined();

    const entries = await readdir(dir);
    expect(entries).toEqual(['target.json']);
  });
});
