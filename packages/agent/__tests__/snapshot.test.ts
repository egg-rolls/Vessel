import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from '@vessel-agent/core';
import {
  AGENT_SNAPSHOT_VERSION,
  type AgentBodyHistoryEntry,
  type AgentError,
  AgentSnapshotStore,
  MAX_BODY_HISTORY,
  type MemberTurnResult,
  type PersistedAgentRecord,
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

function baseRecord(overrides: Partial<PersistedAgentRecord> = {}): PersistedAgentRecord {
  return {
    id: 'member',
    session_id: 'member',
    owner: 'main',
    visibility: 'team',
    state: 'idle',
    membership: 'present',
    ...overrides,
  };
}

/** owner 缺省的持久化记录（peer）；用于验证可选 owner 往返 */
function ownerlessRecord(overrides: Partial<PersistedAgentRecord> = {}): PersistedAgentRecord {
  const value = baseRecord(overrides);
  delete value.owner;
  return value;
}

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

    const completed = await first.service.create({ visibility: 'team', model: 'test-model' });
    await first.service.send({ to: completed.id, content: 'done' });
    await settle();

    const gate = deferred<MemberTurnResult>();
    first.runtime.handler = () => gate.promise;
    const running = await first.service.create({ visibility: 'team' });
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

  it('quarantines a corrupt snapshot at startup instead of serving it as empty recoverable state', async () => {
    const dataDir = await tempDir();
    const path = snapshotPath(dataDir, 'default');
    await mkdir(dirname(path), { recursive: true });
    const corrupt = '{broken json';
    await writeFile(path, corrupt);

    const { service } = makeService({ dataDir });

    expect(await service.list({ viewer: 'main' })).toEqual([]);
    const quarantined = (await readdir(dirname(path))).filter((name) =>
      name.startsWith('default.json.corrupt-'),
    );
    expect(quarantined).toHaveLength(1);
    expect(await readFile(join(dirname(path), quarantined[0] as string), 'utf8')).toBe(corrupt);
  });

  it('snapshot write failure is logged but does not reject service calls', async () => {
    const root = await tempDir();
    const blocker = join(root, 'blocker');
    await writeFile(blocker, 'not a directory');
    const { logger, errors } = recordingLogger();
    const { service } = makeService({ dataDir: join(blocker, 'nested'), logger });

    const member = await service.create({ visibility: 'team' });
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
    const running = await first.service.create({ visibility: 'team' });
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

  it('round-trips body_history through write and load', async () => {
    const dataDir = await tempDir();
    const store = new AgentSnapshotStore(snapshotPath(dataDir, 'default'), 'default');
    const bodyHistory: AgentBodyHistoryEntry[] = [
      { session_id: 'body-1', epoch: 0, started_at: 10, retired_at: 20 },
      { session_id: 'body-2', epoch: 1, started_at: 30, retired_at: 40 },
    ];

    const written = await store.write([
      baseRecord({
        current_body: { session_id: 'body-current', epoch: 2, started_at: 50 },
        body_history: bodyHistory,
      }),
    ]);
    expect(written).toBe(true);

    const [record] = await store.load();
    expect(record?.current_body).toEqual({ session_id: 'body-current', epoch: 2, started_at: 50 });
    expect(record?.body_history).toEqual(bodyHistory);
  });

  it('round-trips team_id without changing the snapshot version', async () => {
    const dataDir = await tempDir();
    const path = snapshotPath(dataDir, 'default');
    const store = new AgentSnapshotStore(path, 'default');

    const written = await store.write([
      baseRecord({ team_id: 'team-alpha' }),
      baseRecord({ id: 'unbound', session_id: 'unbound' }),
    ]);
    expect(written).toBe(true);

    const file = JSON.parse(await readFile(path, 'utf8')) as {
      version: number;
      members: { id: string; team_id?: string }[];
    };
    expect(file.version).toBe(AGENT_SNAPSHOT_VERSION);
    expect(file.version).toBe(2);

    const loaded = await store.load();
    const byId = new Map(loaded.map((record) => [record.id, record]));
    expect(byId.get('member')?.team_id).toBe('team-alpha');
    expect(byId.get('unbound')?.team_id).toBeUndefined();
  });

  it('round-trips an owner-less member without writing the owner key and keeps version 2', async () => {
    const dataDir = await tempDir();
    const path = snapshotPath(dataDir, 'default');
    const store = new AgentSnapshotStore(path, 'default');

    const written = await store.write([
      ownerlessRecord(),
      baseRecord({ id: 'owned', session_id: 'owned', owner: 'main' }),
    ]);
    expect(written).toBe(true);

    const file = JSON.parse(await readFile(path, 'utf8')) as {
      version: number;
      members: Record<string, unknown>[];
    };
    expect(file.version).toBe(AGENT_SNAPSHOT_VERSION);
    expect(file.version).toBe(2);
    const ownerless = file.members.find((member) => member.id === 'member');
    expect(ownerless).toBeDefined();
    expect('owner' in (ownerless as Record<string, unknown>)).toBe(false);
    expect(file.members.find((member) => member.id === 'owned')?.owner).toBe('main');

    const loaded = await store.load();
    const byId = new Map(loaded.map((record) => [record.id, record]));
    expect(byId.get('member')?.owner).toBeUndefined();
    expect(byId.get('owned')?.owner).toBe('main');
  });

  it('skips invalid body_history entries individually and keeps the valid ones', async () => {
    const dataDir = await tempDir();
    const path = snapshotPath(dataDir, 'default');
    await mkdir(dirname(path), { recursive: true });
    const valid: AgentBodyHistoryEntry = {
      session_id: 'body-ok',
      epoch: 3,
      started_at: 30,
      retired_at: 40,
    };
    const snapshot = {
      version: AGENT_SNAPSHOT_VERSION,
      tenant_id: 'default',
      updated_at: 1,
      members: [
        {
          ...baseRecord({ id: 'mixed', session_id: 'mixed' }),
          body_history: [
            { session_id: '', epoch: 0, started_at: 1, retired_at: 2 },
            { session_id: 'negative-epoch', epoch: -1, started_at: 1, retired_at: 2 },
            { session_id: 'bad-started-at', epoch: 0, started_at: null, retired_at: 2 },
            { session_id: 'missing-retired-at', epoch: 0, started_at: 1 },
            { session_id: 'bad-retired-at', epoch: 0, started_at: 1, retired_at: null },
            valid,
          ],
        },
        baseRecord({ id: 'absent', session_id: 'absent' }),
        { ...baseRecord({ id: 'empty', session_id: 'empty' }), body_history: [] },
        { ...baseRecord({ id: 'not-array', session_id: 'not-array' }), body_history: 'nope' },
      ],
    };
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);

    const loaded = await new AgentSnapshotStore(path, 'default').load();
    const byId = new Map(loaded.map((record) => [record.id, record]));
    expect(byId.get('mixed')?.body_history).toEqual([valid]);
    expect(byId.get('absent')?.body_history).toBeUndefined();
    expect(byId.get('empty')?.body_history).toBeUndefined();
    expect(byId.get('not-array')?.body_history).toBeUndefined();
  });

  it('trims body_history to the last MAX_BODY_HISTORY entries', async () => {
    const dataDir = await tempDir();
    const path = snapshotPath(dataDir, 'default');
    await mkdir(dirname(path), { recursive: true });
    const entries: AgentBodyHistoryEntry[] = Array.from(
      { length: MAX_BODY_HISTORY + 5 },
      (_, index) => ({
        session_id: `body-${index}`,
        epoch: index,
        started_at: index,
        retired_at: index + 1,
      }),
    );
    const snapshot = {
      version: AGENT_SNAPSHOT_VERSION,
      tenant_id: 'default',
      updated_at: 1,
      members: [{ ...baseRecord(), body_history: entries }],
    };
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);

    const [record] = await new AgentSnapshotStore(path, 'default').load();
    expect(record?.body_history).toHaveLength(MAX_BODY_HISTORY);
    expect(record?.body_history?.[0]?.session_id).toBe('body-5');
    expect(record?.body_history?.at(-1)?.session_id).toBe(`body-${MAX_BODY_HISTORY + 4}`);
  });

  it('quarantines a corrupt snapshot instead of letting the next state write overwrite it', async () => {
    const dataDir = await tempDir();
    const path = snapshotPath(dataDir, 'default');
    await mkdir(dirname(path), { recursive: true });
    const corrupt =
      '{"version":2,"tenant_id":"default","members":[{"id":"alpha","session_id":"s1"}';
    await writeFile(path, corrupt);
    const capture = recordingLogger();
    const store = new AgentSnapshotStore(path, 'default', { logger: capture.logger });

    expect(await store.load()).toEqual([]);
    const quarantined = (await readdir(dirname(path))).filter((name) =>
      name.startsWith('default.json.corrupt-'),
    );
    expect(quarantined).toHaveLength(1);
    const quarantinePath = join(dirname(path), quarantined[0] as string);
    expect(await readFile(quarantinePath, 'utf8')).toBe(corrupt);

    // 下一次状态写只能落新文件，不能覆盖唯一恢复副本。
    expect(await store.write([baseRecord()])).toBe(true);
    expect(await readFile(quarantinePath, 'utf8')).toBe(corrupt);
    const fresh = JSON.parse(await readFile(path, 'utf8')) as { members: unknown[] };
    expect(fresh.members).toHaveLength(1);
    expect(capture.errors).toContain('agent.snapshot.corrupt_quarantined');
  });

  it('flush with no pending write returns true', async () => {
    const dataDir = await tempDir();
    const store = new AgentSnapshotStore(snapshotPath(dataDir, 'default'), 'default');

    expect(await store.flush()).toBe(true);
  });

  it('flush returns false when the write fails and true when nothing is pending', async () => {
    const dataDir = await tempDir();
    await writeFile(join(dataDir, 'agents'), 'not a directory');
    const store = new AgentSnapshotStore(snapshotPath(dataDir, 'default'), 'default');

    store.schedule(() => [baseRecord()]);
    expect(await store.flush()).toBe(false);
    expect(await store.flush()).toBe(true);
  });
});
