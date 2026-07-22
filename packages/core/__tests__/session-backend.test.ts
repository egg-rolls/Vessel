import { describe, it, expect, beforeEach } from 'bun:test';
import { MemorySessionBackend } from '../src/session/session-backend';
import type { RunState } from '../src/types/session';

describe('MemorySessionBackend', () => {
  let backend: MemorySessionBackend;

  beforeEach(() => {
    backend = new MemorySessionBackend();
  });

  const createRunState = (sessionId: string): RunState => ({
    run_id: `run-${sessionId}`,
    session_id: sessionId,
    messages: [{ role: 'user', content: 'test' }],
    started_at: Date.now(),
    status: 'running',
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
