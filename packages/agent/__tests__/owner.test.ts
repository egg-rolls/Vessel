import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentError } from '../src/index.js';
import { makeService, settle } from './helpers.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-agent-owner-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('root owner', () => {
  it('attachOwner registers an idle root without spawning the runtime', async () => {
    const { service, runtime } = makeService();

    const owner = await service.attachOwner({ id: 'main', visibility: 'team' });

    expect(owner.state).toBe('idle');
    expect(owner.owner).toBe('main');
    expect(owner.parent_id).toBeUndefined();
    expect(runtime.spawned).toEqual([]);
  });

  it('automatic reply is dropped when the parent owner has not been attached', async () => {
    const { service, runtime } = makeService();
    const child = await service.new({ parentId: 'main', visibility: 'team' });
    runtime.handler = async (member) => (member.id === child.id ? { content: 'auto' } : {});

    await service.send({ to: child.id, content: 'work' });
    await settle();

    expect(runtime.turns.filter((entry) => entry.member.id === 'main')).toEqual([]);
  });

  it('attached owner queues the automatic reply until takeMessages drains it', async () => {
    const { service, runtime } = makeService();
    await service.attachOwner({ id: 'main', visibility: 'team' });
    const child = await service.new({ parentId: 'main', visibility: 'team' });
    runtime.handler = async (member) => (member.id === child.id ? { content: 'auto' } : {});

    await service.send({ to: child.id, content: 'work' });
    await settle();

    // owner 是 external：pump 不执行 runtime，消息留在队列等 REPL 取
    expect(runtime.turns.filter((entry) => entry.member.id === 'main')).toEqual([]);
    const queued = await service.takeMessages('main');
    expect(queued.map((entry) => entry.content)).toEqual(['auto']);
    expect(queued[0]?.from).toBe(child.id);
  });

  it('repeated attach is idempotent and updates visibility and session id', async () => {
    const { service } = makeService();
    await service.attachOwner({ id: 'main', visibility: 'private' });

    await service.attachOwner({ id: 'main', visibility: 'tenant' });
    const visible = await service.list({ viewer: 'bob' });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.visibility).toBe('tenant');

    const updated = await service.attachOwner({
      id: 'main',
      sessionId: 'main-session',
      visibility: 'team',
    });
    expect(updated.session_id).toBe('main-session');
    expect((await service.list({ viewer: 'main' }))[0]?.session_id).toBe('main-session');
  });

  it('attach rejects an id owned by a spawned member', async () => {
    const { service } = makeService();
    const child = await service.new({ visibility: 'team' });

    const error = await service.attachOwner({ id: child.id }).catch((reason) => reason);

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('invalid_input');
  });

  it('snapshot keeps the owner and attach restores it from gone to live', async () => {
    const dataDir = await tempDir();
    const first = makeService({ dataDir });
    await first.service.attachOwner({ id: 'main', visibility: 'team' });
    await first.service.flushSnapshot();

    const second = makeService({ dataDir });
    const [before] = await second.service.list({ viewer: 'main' });
    expect(before?.state).toBe('idle');
    expect(before?.presence).toBe('gone');

    const restored = await second.service.attachOwner({ id: 'main', visibility: 'team' });
    expect(restored.state).toBe('idle');
    expect(restored.presence).toBe('live');
    expect(second.runtime.spawned).toEqual([]);
    expect((await second.service.list({ viewer: 'main' }))[0]?.state).toBe('idle');
  });
});
