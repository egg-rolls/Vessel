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
  it('restores members as idle + gone, persists v2 fields, and drops queued messages', async () => {
    const dataDir = await tempDir();
    const first = makeService({ dataDir });

    const completed = await first.service.new({ visibility: 'team', model: 'test-model' });
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
    expect(raw).not.toContain('"presence"');
    const file = JSON.parse(raw) as {
      version: number;
      members: {
        id: string;
        state: string;
        membership: string;
        model?: string;
        current_body?: { session_id: string; epoch: number };
      }[];
    };
    expect(file.version).toBe(AGENT_SNAPSHOT_VERSION);
    const persisted = file.members.find((member) => member.id === completed.id);
    expect(persisted?.membership).toBe('present');
    expect(persisted?.model).toBe('test-model');
    expect(persisted?.current_body?.session_id).toBe(completed.id);
    expect(persisted?.current_body?.epoch).toBe(0);

    const second = makeService({ dataDir });
    const restored = await second.service.list({ viewer: 'main' });
    const byId = new Map(restored.map((member) => [member.id, member]));
    expect(byId.get(completed.id)?.state).toBe('idle');
    expect(byId.get(completed.id)?.presence).toBe('gone');
    expect(byId.get(running.id)?.state).toBe('idle');
    expect(byId.get(running.id)?.presence).toBe('gone');

    const error = await second.service
      .send({ to: running.id, content: 'after-restart' })
      .catch((reason) => reason);
    expect((error as AgentError).code).toBe('member_stale');
  });

  it('reads a v1 snapshot, normalizes fields, writes v2, and keeps a .v1.bak', async () => {
    const dataDir = await tempDir();
    const path = snapshotPath(dataDir, 'default');
    await mkdir(dirname(path), { recursive: true });
    const v1 = {
      version: 1,
      tenant_id: 'default',
      updated_at: 1,
      members: [
        {
          id: 'old-present',
          session_id: 'old-present',
          name: 'legacy',
          owner: 'main',
          visibility: 'team',
          state: 'stale',
          last_seen: 111,
        },
        {
          id: 'old-closed',
          session_id: 'old-closed',
          owner: 'main',
          visibility: 'team',
          state: 'closed',
          last_seen: 222,
        },
      ],
    };
    const rawV1 = `${JSON.stringify(v1, null, 2)}\n`;
    await writeFile(path, rawV1);

    const { service } = makeService({ dataDir });
    const members = await service.list({ viewer: 'main' });
    const byId = new Map(members.map((member) => [member.id, member]));

    const present = byId.get('old-present');
    expect(present?.state).toBe('idle');
    expect(present?.presence).toBe('gone');
    expect(present?.membership).toBe('present');
    expect(present?.epoch).toBe(0);
    expect(present?.name).toBe('legacy');

    const closed = byId.get('old-closed');
    expect(closed?.state).toBe('closed');
    expect(closed?.membership).toBe('left');

    expect(await readFile(`${path}.v1.bak`, 'utf8')).toBe(rawV1);

    await service.flushSnapshot();
    const upgraded = JSON.parse(await readFile(path, 'utf8')) as {
      version: number;
      members: { id: string; presence?: string; membership: string }[];
    };
    expect(upgraded.version).toBe(AGENT_SNAPSHOT_VERSION);
    const upgradedPresent = upgraded.members.find((member) => member.id === 'old-present');
    expect(upgradedPresent?.membership).toBe('present');
    expect(upgradedPresent?.presence).toBeUndefined();
    expect(await readFile(`${path}.v1.bak`, 'utf8')).toBe(rawV1);
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

  it('restored gone member can be closed and becomes left + gone', async () => {
    const dataDir = await tempDir();
    const first = makeService({ dataDir });
    const gate = deferred<MemberTurnResult>();
    first.runtime.handler = () => gate.promise;
    const running = await first.service.new({ visibility: 'team' });
    await first.service.send({ to: running.id, content: 'x' });
    await first.service.flushSnapshot();

    const second = makeService({ dataDir });
    await second.service.close({ member: running.id });

    const [status] = await second.service.list({ viewer: 'main' });
    expect(status?.state).toBe('closed');
    expect(status?.membership).toBe('left');
    expect(status?.presence).toBe('gone');
    // 重复 close 幂等，不再调用 dispose
    const disposed = second.runtime.disposed.length;
    await second.service.close({ member: running.id });
    expect(second.runtime.disposed.length).toBe(disposed);
  });
});
