import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { FileSessionBackend } from '../src/session/file-backend';
import { MemorySessionBackend } from '../src/session/session-backend';
import type { RunState } from '../src/types/session';

const createRunState = (sessionId: string, overrides?: Partial<RunState>): RunState => ({
  run_id: `run-${sessionId}`,
  session_id: sessionId,
  messages: [{ role: 'user', content: 'test' }],
  started_at: Date.now(),
  status: 'running',
  ...overrides,
});

describe('MemorySessionBackend', () => {
  let backend: MemorySessionBackend;

  beforeEach(() => {
    backend = new MemorySessionBackend();
  });

  it('should save and load run states', async () => {
    const state = createRunState('session-1');
    await backend.save(state);

    const loaded = await backend.load('session-1');
    expect(loaded).toEqual(state);
  });

  it('should return null for missing sessions', async () => {
    const loaded = await backend.load('missing-session');
    expect(loaded).toBeNull();
  });

  it('should delete sessions', async () => {
    const state = createRunState('session-1');
    await backend.save(state);

    expect(await backend.load('session-1')).not.toBeNull();

    await backend.delete('session-1');

    expect(await backend.load('session-1')).toBeNull();
  });

  it('should list sessions', async () => {
    await backend.save(createRunState('session-1'));
    await backend.save(createRunState('session-2'));
    await backend.save(createRunState('session-3'));

    const sessions = await backend.list();
    expect(sessions).toHaveLength(3);
    expect(sessions).toContain('session-1');
    expect(sessions).toContain('session-2');
    expect(sessions).toContain('session-3');
  });

  it('should report size', async () => {
    expect(backend.size).toBe(0);

    await backend.save(createRunState('session-1'));
    expect(backend.size).toBe(1);

    await backend.save(createRunState('session-2'));
    expect(backend.size).toBe(2);
  });
});

describe('FileSessionBackend', () => {
  const TEST_DIR = '.vessel/test-sessions';
  let backend: FileSessionBackend;

  beforeEach(() => {
    backend = new FileSessionBackend(TEST_DIR);
  });

  afterEach(() => {
    backend.close();
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  });

  it('should save and load run states', async () => {
    const state = createRunState('session-1');
    await backend.save(state);

    const loaded = await backend.load('session-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.session_id).toBe('session-1');
    expect(loaded?.run_id).toBe('run-session-1');
    expect(loaded?.messages).toEqual([{ role: 'user', content: 'test' }]);
  });

  it('should return null for missing sessions', async () => {
    const loaded = await backend.load('missing-session');
    expect(loaded).toBeNull();
  });

  it('should delete sessions', async () => {
    const state = createRunState('session-1');
    await backend.save(state);

    expect(await backend.load('session-1')).not.toBeNull();

    await backend.delete('session-1');

    expect(await backend.load('session-1')).toBeNull();
  });

  it('should list sessions', async () => {
    await backend.save(createRunState('session-1'));
    await backend.save(createRunState('session-2'));
    await backend.save(createRunState('session-3'));

    const sessions = await backend.list();
    expect(sessions).toHaveLength(3);
    expect(sessions).toContain('session-1');
    expect(sessions).toContain('session-2');
    expect(sessions).toContain('session-3');
  });

  it('should return empty list for non-existent directory', async () => {
    const fresh = new FileSessionBackend('.vessel/nonexistent');
    const sessions = await fresh.list();
    expect(sessions).toEqual([]);
    fresh.close();
  });

  it('should auto-derive title and preview on save', async () => {
    const state = createRunState('with-title', {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'What is the weather today in Tokyo?' },
      ],
    });
    await backend.save(state);

    const loaded = await backend.load('with-title');
    expect(loaded?.title).toBe('What is the weather today in Tokyo?');
    expect(loaded?.preview).toBe('What is the weather today in Tokyo?');
  });

  it('should preserve explicit title and preview on save', async () => {
    const state = createRunState('explicit', {
      title: 'Custom Title',
      preview: 'Custom preview text',
      messages: [{ role: 'user', content: 'Original message' }],
    });
    await backend.save(state);

    const loaded = await backend.load('explicit');
    expect(loaded?.title).toBe('Custom Title');
    expect(loaded?.preview).toBe('Custom preview text');
  });

  it('should auto-set updated_at when not provided', async () => {
    const state = createRunState('timed');
    await backend.save(state);

    const loaded = await backend.load('timed');
    expect(loaded?.updated_at).toBeGreaterThan(0);
  });

  describe('listRich', () => {
    it('should filter empty sessions and sort by updated_at desc', async () => {
      await backend.save(
        createRunState('empty', {
          messages: [],
          status: 'completed',
        }),
      );
      await backend.save(
        createRunState('old', {
          messages: [{ role: 'user', content: 'old msg' }],
          status: 'completed',
          updated_at: 2000,
        }),
      );
      await backend.save(
        createRunState('new', {
          messages: [{ role: 'user', content: 'new msg' }],
          status: 'completed',
          updated_at: 5000,
        }),
      );

      const rich = await backend.listRich();
      expect(rich.length).toBe(2); // empty filtered out
      expect(rich[0]?.session_id).toBe('new');
      expect(rich[1]?.session_id).toBe('old');
      expect(rich[0]?.preview).toBe('new msg');
      expect(rich[0]?.message_count).toBe(1);
    });

    it('should persist and return branch field', async () => {
      await backend.save(
        createRunState('with-branch', {
          messages: [{ role: 'user', content: 'test' }],
          status: 'completed',
          branch: 'feat/my-feature',
        }),
      );
      await backend.save(
        createRunState('no-branch', {
          messages: [{ role: 'user', content: 'test2' }],
          status: 'completed',
        }),
      );

      const rich = await backend.listRich();
      const withBranch = rich.find((s) => s.session_id === 'with-branch');
      const noBranch = rich.find((s) => s.session_id === 'no-branch');
      expect(withBranch?.branch).toBe('feat/my-feature');
      expect(noBranch?.branch).toBeUndefined();
    });
  });

  it('should no-op on close', () => {
    // close() should not throw
    backend.close();
    expect(true).toBe(true);
  });
});
