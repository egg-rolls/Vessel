import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from '@vessel-agent/core';
import {
  AGENT_SNAPSHOT_VERSION,
  type AgentError,
  type MemberTurnResult,
  snapshotPath,
} from '../src/index.js';
import { deferred, makeService, settle } from './helpers.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-agent-snapshot-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function recordingLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message: string) => {
        errors.push(message);
      },
    },
  };
}

describe('Agent snapshot', () => {
  it('restores terminal members, marks non-terminal members stale, and drops queued messages', async () => {
    const dataDir = await tempDir();
    const first = makeService({ dataDir });

    const completed = await first.service.new({ visibility: 'team' });
    await first.service.send({ to: completed.id, content: 'done' });
    await settle();

    const gate = deferred<MemberTurnResult>();
    first.runtime.handler = () => gate.promise;
    const running = await first.service.new({ visibility: 'team' });
    await first.service.send({ to: running.id, content: 'in-flight' });
    await first.service.send({ to: running.id, content: 'queued-not-persisted' });
    await first.service.flushSnapshot();

    const raw = await readFile(snapshotPath(dataDir, 'default'), 'utf8');
    expect(raw).not.toContain('queued-not-persisted');
    const file = JSON.parse(raw) as { version: number; members: { id: string; state: string }[] };
    expect(file.version).toBe(AGENT_SNAPSHOT_VERSION);

    const second = makeService({ dataDir });
    const restored = await second.service.list({ viewer: 'main' });
    const states = new Map(restored.map((member) => [member.id, member.state]));
    expect(states.get(completed.id)).toBe('completed');
    expect(states.get(running.id)).toBe('stale');

    const error = await second.service
      .send({ to: running.id, content: 'after-restart' })
      .catch((reason) => reason);
    expect((error as AgentError).code).toBe('member_stale');
  });

  it('loads a corrupt snapshot as an empty registry instead of throwing', async () => {
    const dataDir = await tempDir();
    const path = snapshotPath(dataDir, 'default');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{broken json');

    const { service } = makeService({ dataDir });

    expect(await service.list({ viewer: 'main' })).toEqual([]);
  });

  it('snapshot write failure is logged but does not reject service calls', async () => {
    const root = await tempDir();
    const blocker = join(root, 'blocker');
    await writeFile(blocker, 'not a directory');
    const { logger, errors } = recordingLogger();
    const { service } = makeService({ dataDir: join(blocker, 'nested'), logger });

    const member = await service.new({ visibility: 'team' });
    await service.flushSnapshot();
    const closed = await service.close({ member: member.id });

    expect(closed.state).toBe('closed');
    expect(errors).toContain('agent.snapshot.write_failed');
  });

  it('restored stale member can be closed without calling runtime dispose', async () => {
    const dataDir = await tempDir();
    const first = makeService({ dataDir });
    const gate = deferred<MemberTurnResult>();
    first.runtime.handler = () => gate.promise;
    const running = await first.service.new({ visibility: 'team' });
    await first.service.send({ to: running.id, content: 'x' });
    await first.service.flushSnapshot();

    const second = makeService({ dataDir });
    await second.service.close({ member: running.id });

    expect(second.runtime.disposed).toEqual([]);
    const [status] = await second.service.list({ viewer: 'main' });
    expect(status?.state).toBe('closed');
  });
});
