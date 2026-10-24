import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamService, type DefaultTeamService } from '../src/team-service.js';
import { FileTeamStore, teamMetadataPath } from '../src/team-store.js';
import {
  type AgentService,
  type MemberStatus,
  TeamError,
  type TeamLogEntry,
} from '../src/types.js';
import { FakeTeamAgent, makeMember } from './helpers.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-agent-team-lifecycle-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface Harness {
  dataDir: string;
  store: FileTeamStore;
  agent: FakeTeamAgent;
  service: DefaultTeamService;
}

async function makeHarness(members: MemberStatus[] = []): Promise<Harness> {
  const dataDir = await tempDir();
  let clock = 1_700_000_000_000;
  const now = () => clock++;
  const store = new FileTeamStore({ dataDir, tenantId: 'default', durable: false, now });
  const agent = new FakeTeamAgent(members, now);
  let counter = 0;
  const service = createTeamService({
    tenantId: 'default',
    agent: agent as unknown as AgentService,
    store,
    now,
    newId: () => `team-${++counter}`,
  });
  return { dataDir, store, agent, service };
}

function logEntry(messageId: string, teamId: string): TeamLogEntry {
  return {
    message_id: messageId,
    team_id: teamId,
    from: 'main',
    to: [],
    mentions: [],
    content: `message ${messageId}`,
    ts: 1_700_000_000_000,
    kind: 'post',
  };
}

/** 取 promise 的失败 code；解析成功会让断言以 undefined 失败。 */
async function failureCode(promise: Promise<unknown>): Promise<string | undefined> {
  const value = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  return value instanceof TeamError ? value.code : undefined;
}

describe('FileTeamStore.create (S10.3)', () => {
  it('dedupes by workspace and preserves the original name and policy', async () => {
    const { dataDir, store, service } = await makeHarness();
    const workspace = join(dataDir, 'ws', 'alpha');

    const first = await store.create({
      workspace,
      name: 'Alpha',
      policy: { mode: 'alpha' },
    });
    expect(first.deduplicated).toBe(false);
    expect(first.record.team_id).toBe('alpha');

    // Trailing separator normalizes to the same workspace key.
    const second = await store.create({
      workspace: `${workspace}/`,
      name: 'Renamed',
      policy: { mode: 'beta' },
    });
    expect(second.deduplicated).toBe(true);
    expect(second.record.team_id).toBe(first.record.team_id);
    expect(second.record.name).toBe('Alpha');
    expect(second.record.policy).toEqual({ mode: 'alpha' });

    const onDisk = JSON.parse(
      await readFile(teamMetadataPath(dataDir, 'default', first.record.team_id), 'utf8'),
    ) as { name: string; policy: Record<string, unknown> };
    expect(onDisk.name).toBe('Alpha');
    expect(onDisk.policy).toEqual({ mode: 'alpha' });

    const viaService = await service.create({
      workspace,
      name: 'Again',
      policy: { mode: 'gamma' },
    });
    expect(viaService.deduplicated).toBe(true);
    expect(viaService.team.name).toBe('Alpha');
    expect(viaService.team.policy).toEqual({ mode: 'alpha' });
    expect(viaService.team.member_count).toBe(0);
    expect(viaService.team.online_count).toBe(0);
  });

  it('keeps same-basename workspaces as distinct teams with the hash suffix', async () => {
    const { dataDir, store } = await makeHarness();
    const first = await store.create({ workspace: join(dataDir, 'one', 'proj') });
    const second = await store.create({ workspace: join(dataDir, 'two', 'proj') });

    expect(first.record.team_id).toBe('proj');
    expect(second.record.team_id).toMatch(/^proj-[0-9a-f]{8}$/);
    expect(second.deduplicated).toBe(false);
    expect(store.list().length).toBe(2);
  });
});

describe('TeamService.archive (S10.3)', () => {
  it('rejects a team with a present member with team_not_empty', async () => {
    const member = makeMember({
      id: 'a1',
      team_id: 'alpha',
      membership: 'present',
      presence: 'gone',
    });
    const { dataDir, store, service } = await makeHarness([member]);

    const created = await service.create({ workspace: join(dataDir, 'alpha') });
    expect(created.team.team_id).toBe('alpha');
    expect(created.team.member_count).toBe(1);
    expect(created.team.online_count).toBe(0);

    expect(await failureCode(service.archive({ team_id: 'alpha' }))).toBe('team_not_empty');
    expect(store.get('alpha')?.archived_at).toBeUndefined();
  });

  it('makes the team read-only while keeping get / roster / prior logs readable', async () => {
    const { dataDir, store, service } = await makeHarness();
    await service.create({ workspace: join(dataDir, 'alpha') });
    await store.appendLog(logEntry('m1', 'alpha'));

    const archived = await service.archive({ team_id: 'alpha' });
    expect(archived.archived_at).toBeDefined();

    // Collect all codes before asserting so one broken guard cannot mask the others.
    const codes = {
      post: await failureCode(service.post({ team_id: 'alpha', content: 'hello' })),
      add: await failureCode(service.members({ team_id: 'alpha', action: 'add', member: 'a1' })),
      remove: await failureCode(
        service.members({ team_id: 'alpha', action: 'remove', member: 'a1' }),
      ),
      override: await failureCode(
        service.budget({
          team_id: 'alpha',
          conversation_id: 'conv-1',
          dimension: 'hops',
          max: 5,
        }),
      ),
      update: await failureCode(store.update('alpha', { name: 'nope' })),
    };
    expect(codes).toEqual({
      post: 'team_archived',
      add: 'team_archived',
      remove: 'team_archived',
      override: 'team_archived',
      update: 'team_archived',
    });

    const detail = await service.get('alpha');
    expect(detail?.team.archived_at).toBe(archived.archived_at);
    expect(detail?.messages.map((entry) => entry.message_id)).toEqual(['m1']);
    expect(await service.roster('alpha')).toEqual([]);
    const listed = await service.list();
    expect(listed.find((team) => team.team_id === 'alpha')?.archived_at).toBe(archived.archived_at);

    // Idempotent: the existing archived_at is returned, not rewritten.
    const again = await service.archive({ team_id: 'alpha' });
    expect(again.archived_at).toBe(archived.archived_at);

    // Durable across reload.
    const reopened = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    await reopened.ready();
    expect(reopened.get('alpha')?.archived_at).toBe(archived.archived_at);
  });
});

describe('FileTeamStore.update (S10.3)', () => {
  it('null clears optional fields, undefined leaves them, and policy is replaced', async () => {
    const { dataDir, store } = await makeHarness();
    const created = await store.create({
      workspace: join(dataDir, 'ws', 'alpha'),
      name: 'Alpha',
      description: 'desc',
      default_principal: 'alice',
      handoff_path: '/h',
      policy: { a: 1 },
    });
    const id = created.record.team_id;

    const cleared = await store.update(id, { default_principal: null });
    expect('default_principal' in cleared).toBe(false);
    expect(cleared.description).toBe('desc');
    expect(cleared.handoff_path).toBe('/h');
    expect(cleared.policy).toEqual({ a: 1 });

    const kept = await store.update(id, {
      description: undefined,
      handoff_path: null,
      policy: { b: 2 },
    });
    expect(kept.description).toBe('desc');
    expect('handoff_path' in kept).toBe(false);
    expect(kept.policy).toEqual({ b: 2 });
    // Immutable fields never move.
    expect(kept.v).toBe(1);
    expect(kept.team_id).toBe(created.record.team_id);
    expect(kept.tenant_id).toBe('default');
    expect(kept.workspace).toBe(created.record.workspace);
    expect(kept.created_at).toBe(created.record.created_at);

    const raw = JSON.parse(
      await readFile(teamMetadataPath(dataDir, 'default', id), 'utf8'),
    ) as Record<string, unknown>;
    expect(raw.policy).toEqual({ b: 2 });
    expect(raw.description).toBe('desc');
    expect('handoff_path' in raw).toBe(false);
    expect('default_principal' in raw).toBe(false);

    const reopened = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    await reopened.ready();
    expect(reopened.get(id)).toEqual(kept);
  });

  it('does not mutate memory when the metadata write fails', async () => {
    const { dataDir, store } = await makeHarness();
    const created = await store.create({
      workspace: join(dataDir, 'ws', 'alpha'),
      name: 'Alpha',
    });
    const id = created.record.team_id;
    const before = store.get(id);

    // Replace team.json with a directory: persist() must fail, memory must stay.
    const metadataPath = teamMetadataPath(dataDir, 'default', id);
    await rm(metadataPath);
    await mkdir(metadataPath);

    const error = await store.update(id, { name: 'Broken' }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(store.get(id)).toEqual(before);
  });
});
