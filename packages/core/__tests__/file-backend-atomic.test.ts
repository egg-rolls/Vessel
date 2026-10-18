import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunState } from '../src/index';
import { FileSessionBackend } from '../src/index';

const roots: string[] = [];

function tempDir(): string {
  const dir = join(process.env.TEMP ?? '/tmp', `vessel-session-${randomUUID()}`);
  roots.push(dir);
  return dir;
}

function state(sessionId: string, content: string): RunState {
  return {
    run_id: `run-${content}`,
    session_id: sessionId,
    messages: [{ role: 'user', content }],
    started_at: Date.now(),
    status: 'completed',
  };
}

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('FileSessionBackend atomic writes (0.5 E3/E4)', () => {
  it('round-trips a session and leaves no temp files', async () => {
    const dir = tempDir();
    const backend = new FileSessionBackend(dir);

    await backend.save(state('s1', 'hello'));
    const loaded = await backend.load('s1');

    expect(loaded?.session_id).toBe('s1');
    expect(loaded?.messages[0]?.content).toBe('hello');
    expect(await readdir(dir)).toEqual(['s1.json']);
  });

  it('encodes session ids in file names and decodes them in list()', async () => {
    const dir = tempDir();
    const backend = new FileSessionBackend(dir);
    const id = 'session with space';

    await backend.save(state(id, 'hello'));

    expect(await readdir(dir)).toEqual([`${encodeURIComponent(id)}.json`]);
    expect(await backend.list()).toEqual([id]);
    expect((await backend.load(id))?.session_id).toBe(id);
  });

  it('reads legacy unencoded session files', async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'legacy-id.json'), JSON.stringify(state('legacy-id', 'old')), 'utf8');

    const backend = new FileSessionBackend(dir);

    expect((await backend.load('legacy-id'))?.messages[0]?.content).toBe('old');
    expect(await backend.list()).toEqual(['legacy-id']);
  });

  it('serializes concurrent saves for the same session', async () => {
    const dir = tempDir();
    const backend = new FileSessionBackend(dir);

    await Promise.all([
      backend.save(state('s1', 'one')),
      backend.save(state('s1', 'two')),
      backend.save(state('s1', 'three')),
    ]);

    const loaded = await backend.load('s1');
    expect(loaded).not.toBeNull();
    expect(['one', 'two', 'three']).toContain(String(loaded?.messages[0]?.content));
    expect(await readdir(dir)).toEqual(['s1.json']);
  });

  it('delete removes both encoded and legacy files', async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plain.json'), '{}', 'utf8');
    const backend = new FileSessionBackend(dir);

    await backend.delete('plain');

    expect(await readdir(dir)).toEqual([]);
  });
});
