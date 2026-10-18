import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AtomicWriteError, atomicWrite } from '../src/index';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  it('serializes concurrent writes and never exposes partial JSON', async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'state.json');
    await atomicWrite(file, JSON.stringify({ i: -1 }));

    const failures: unknown[] = [];
    let reading = true;
    const reader = (async () => {
      while (reading) {
        try {
          JSON.parse(await readFile(file, 'utf8'));
        } catch (error) {
          failures.push(error);
        }
        await delay(1);
      }
    })();

    const payloads = Array.from({ length: 30 }, (_, i) => JSON.stringify({ i }));
    await Promise.all(payloads.map((payload) => atomicWrite(file, payload)));
    reading = false;
    await reader;

    expect(failures).toEqual([]);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { i: number };
    expect(parsed.i).toBeGreaterThanOrEqual(0);
    expect(parsed.i).toBeLessThan(30);
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('rejects with AtomicWriteError and leaves no temp when rename cannot succeed', async () => {
    const dir = tempDir();
    await mkdir(join(dir, 'target.json'), { recursive: true });

    const error = await atomicWrite(join(dir, 'target.json'), 'x', { retries: 1 }).catch((e) => e);

    expect(error).toBeInstanceOf(AtomicWriteError);
    expect((error as AtomicWriteError).code).toBe('atomic_write_failed');
    expect(await readdir(dir)).toEqual(['target.json']);
  });
});
