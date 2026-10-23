import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeService } from './helpers.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-agent-dispatch-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('AgentService.dispatch', () => {
  it('single-flights resume when a gone member receives concurrent dispatches', async () => {
    const dataDir = await tempDir();
    const first = makeService({ dataDir });
    const member = await first.service.new({ visibility: 'team' });
    await first.service.flushSnapshot();

    // 重启：engine 不在，成员应为 gone
    const second = makeService({ dataDir });
    const [before] = await second.service.list({ viewer: 'main' });
    expect(before?.presence).toBe('gone');

    const [a, b] = await Promise.all([
      second.service.dispatch({ to: member.id, content: 'first' }),
      second.service.dispatch({ to: member.id, content: 'second' }),
    ]);

    // single-flight：两次并发只 spawn 一次
    expect(second.runtime.spawned.length).toBe(1);
    for (const result of [a, b]) {
      expect(result.status).toBe('queued');
      if (result.status === 'queued') {
        expect(result.resolution).toBe('resumed');
        expect(result.resolved_to).toBe(member.id);
      }
    }
    expect(a.status === 'queued' ? a.message_id : '').not.toBe(
      b.status === 'queued' ? b.message_id : '',
    );
  });

  it('rejects dispatch to a left member with agent_left', async () => {
    const { service } = makeService();
    const member = await service.new({ visibility: 'team' });
    await service.close({ member: member.id });

    const result = await service.dispatch({ to: member.id, content: 'x' });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.code).toBe('agent_left');
    }
  });
});
