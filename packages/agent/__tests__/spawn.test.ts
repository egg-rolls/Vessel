import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentError,
  type AgentErrorCode,
  type AgentEvent,
  type AgentService,
  snapshotPath,
  type TeamBinder,
  type TeamRecord,
} from '../src/index.js';
import { makeService, makeTeam } from './helpers.js';

const TEAM_ID = 'alpha';
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-agent-spawn-'));
  tempDirs.push(dir);
  return dir;
}

/** 固定 Team 的绑定端口；ensureForWorkspace 不应在本片被调用 */
function makeBinder(...teams: TeamRecord[]): TeamBinder {
  return {
    ensureForWorkspace: async () => {
      throw new Error('unexpected ensureForWorkspace');
    },
    get: (teamId: string) => teams.find((team) => team.team_id === teamId),
  };
}

function collect(service: AgentService): AgentEvent[] {
  const events: AgentEvent[] = [];
  service.subscribe((event) => events.push(event));
  return events;
}

function lastSpawned(events: AgentEvent[]): AgentEvent | undefined {
  return events.filter((event) => event.type === 'agent.spawned').at(-1);
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: AgentErrorCode,
  messagePart?: string,
): Promise<void> {
  const error = await promise.catch((reason) => reason);
  expect(error).toBeInstanceOf(AgentError);
  expect((error as AgentError).code).toBe(code);
  if (messagePart !== undefined) expect((error as AgentError).message).toContain(messagePart);
}

describe('AgentService.create peer / contractor', () => {
  it('peer becomes a member with self owner, no parent, team visibility', async () => {
    const { service } = makeService({ teamBinder: makeBinder(makeTeam(TEAM_ID)) });
    const events = collect(service);

    const peer = await service.create({ kind: 'peer', teamId: TEAM_ID, spawnedBy: 'caller' });

    expect(peer.role).toBe('member');
    expect(peer.owner).toBe(peer.id);
    expect(peer.parent_id).toBeUndefined();
    expect(peer.visibility).toBe('team');
    expect(peer.team_id).toBe(TEAM_ID);
    expect(peer.name).toBe('caller-2');
    expect((await service.list({ viewer: 'bob' })).map((entry) => entry.id)).toEqual([peer.id]);
    const spawned = lastSpawned(events);
    expect(spawned?.spawned_by).toBe('caller');
    expect(spawned?.team_id).toBe(TEAM_ID);
  });

  it('contractor defaults owner and parent to the explicit owner', async () => {
    const { service } = makeService({ teamBinder: makeBinder(makeTeam(TEAM_ID)) });

    const contractor = await service.create({
      kind: 'contractor',
      owner: 'worker-1',
      teamId: TEAM_ID,
    });

    expect(contractor.role).toBe('temporary');
    expect(contractor.owner).toBe('worker-1');
    expect(contractor.parent_id).toBe('worker-1');
    expect(contractor.visibility).toBe('team');
  });

  it('contractor keeps explicit private visibility and is only visible to its owner', async () => {
    const { service } = makeService({ teamBinder: makeBinder(makeTeam(TEAM_ID)) });

    const hidden = await service.create({
      kind: 'contractor',
      owner: 'worker-1',
      teamId: TEAM_ID,
      visibility: 'private',
    });

    expect(hidden.visibility).toBe('private');
    expect((await service.list({ viewer: 'worker-1' })).map((entry) => entry.id)).toEqual([
      hidden.id,
    ]);
    expect(await service.list({ viewer: 'bob' })).toEqual([]);
  });

  it('legacy create without kind becomes a temporary with default owner and private visibility', async () => {
    const { service } = makeService();

    const legacy = await service.create({});

    expect(legacy.role).toBe('temporary');
    expect(legacy.owner).toBe('main');
    // 无 kind 的旧请求保持无 parent（contractor 才默认 parent = owner）。
    expect(legacy.parent_id).toBeUndefined();
    expect(legacy.visibility).toBe('private');
    expect((await service.list({ viewer: 'main' })).map((entry) => entry.id)).toEqual([legacy.id]);
    expect(await service.list({ viewer: 'bob' })).toEqual([]);
  });

  it('unbound contractor has owner/parent but stays private', async () => {
    const { service } = makeService();

    const contractor = await service.create({ kind: 'contractor', owner: 'worker-2' });

    expect(contractor.owner).toBe('worker-2');
    expect(contractor.parent_id).toBe('worker-2');
    expect(contractor.visibility).toBe('private');
    expect(contractor.team_id).toBeUndefined();
  });

  it('owner: null behaves as peer even without an explicit kind', async () => {
    const { service } = makeService({ teamBinder: makeBinder(makeTeam(TEAM_ID)) });

    const peer = await service.create({ owner: null, teamId: TEAM_ID });

    expect(peer.role).toBe('member');
    expect(peer.owner).toBe(peer.id);
    expect(peer.parent_id).toBeUndefined();
    expect(peer.visibility).toBe('team');
  });

  it('defaults owner to the configured ownerId for contractor and legacy create', async () => {
    const { service } = makeService({ ownerId: 'boss' });

    const contractor = await service.create({ kind: 'contractor' });
    const legacy = await service.create({});

    expect(contractor.owner).toBe('boss');
    expect(contractor.parent_id).toBe('boss');
    expect(legacy.owner).toBe('boss');
    expect(legacy.parent_id).toBeUndefined();
  });

  it('gives peer self-ownership and honors an explicit owner when ownerId is configured', async () => {
    const { service } = makeService({
      ownerId: 'boss',
      teamBinder: makeBinder(makeTeam(TEAM_ID)),
    });

    const peer = await service.create({ kind: 'peer', teamId: TEAM_ID });
    const explicit = await service.create({ kind: 'contractor', owner: 'worker-1' });

    expect(peer.owner).toBe(peer.id);
    expect(explicit.owner).toBe('worker-1');
  });

  it('falls back to main when ownerId is not configured', async () => {
    const { service } = makeService();

    expect((await service.create({ kind: 'contractor' })).owner).toBe('main');
    expect((await service.create({})).owner).toBe('main');
  });
});

describe('AgentService.create auto name', () => {
  it('keeps explicit names and generates unique -2/-3 suffixes', async () => {
    const { service } = makeService({ teamBinder: makeBinder(makeTeam(TEAM_ID)) });

    const explicit = await service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'lead',
      spawnedBy: 'caller',
    });
    const second = await service.create({ kind: 'peer', teamId: TEAM_ID, spawnedBy: 'caller' });
    const third = await service.create({ kind: 'peer', teamId: TEAM_ID, spawnedBy: 'caller' });

    expect(explicit.name).toBe('lead');
    expect(second.name).toBe('caller-2');
    expect(third.name).toBe('caller-3');
  });

  it('uses the spawned_by member name as the base when it resolves', async () => {
    const { service } = makeService({ teamBinder: makeBinder(makeTeam(TEAM_ID)) });

    const caller = await service.create({
      kind: 'contractor',
      owner: 'root',
      teamId: TEAM_ID,
      name: 'lead',
    });
    const child = await service.create({ kind: 'peer', teamId: TEAM_ID, spawnedBy: caller.id });

    expect(child.name).toBe('lead-2');
  });

  it('reports name_exhausted when 100 candidates collide', async () => {
    // unbound：tenant 全扫、无 20 上限，才能把 100 个候选全部占满。
    const { service } = makeService();
    for (let index = 2; index <= 101; index += 1) {
      await service.create({ kind: 'contractor', owner: 'owner', name: `caller-${index}` });
    }

    await rejectsWithCode(
      service.create({ kind: 'contractor', owner: 'owner', spawnedBy: 'caller' }),
      'invalid_input',
      'name_exhausted',
    );
  });
});

describe('AgentService.create team limit', () => {
  it('allows the 20th present member and rejects the 21st with team_full', async () => {
    const { service } = makeService({ teamBinder: makeBinder(makeTeam(TEAM_ID)) });

    for (let index = 0; index < 19; index += 1) {
      await service.create({ kind: 'contractor', owner: 'owner', teamId: TEAM_ID });
    }
    const twentieth = await service.create({
      kind: 'contractor',
      owner: 'owner',
      teamId: TEAM_ID,
    });
    expect(twentieth.team_id).toBe(TEAM_ID);

    await rejectsWithCode(
      service.create({ kind: 'contractor', owner: 'owner', teamId: TEAM_ID }),
      'team_full',
      `team_full: ${TEAM_ID}`,
    );
  });
});

describe('AgentService.create validation', () => {
  it('rejects peer without a team, with a parent, with private visibility or an owner', async () => {
    const { service } = makeService({ teamBinder: makeBinder(makeTeam(TEAM_ID)) });

    await rejectsWithCode(service.create({ kind: 'peer' }), 'invalid_input');
    await rejectsWithCode(
      service.create({ kind: 'peer', teamId: TEAM_ID, parentId: 'someone' }),
      'invalid_input',
    );
    await rejectsWithCode(
      service.create({ kind: 'peer', teamId: TEAM_ID, visibility: 'private' }),
      'invalid_input',
    );
    await rejectsWithCode(
      service.create({ kind: 'peer', teamId: TEAM_ID, owner: 'worker-1' }),
      'invalid_input',
    );
  });

  it('rejects unknown team, teamId+workspace together and contractor with null owner', async () => {
    const { service } = makeService({ teamBinder: makeBinder(makeTeam(TEAM_ID)) });

    await rejectsWithCode(
      service.create({ kind: 'contractor', teamId: 'missing' }),
      'invalid_input',
      'team_not_found',
    );
    await rejectsWithCode(
      service.create({ kind: 'contractor', teamId: TEAM_ID, workspace: '/work/alpha' }),
      'invalid_input',
    );
    await rejectsWithCode(service.create({ kind: 'contractor', owner: null }), 'invalid_input');
  });
});

describe('AgentService.create spawned_by event and snapshot', () => {
  it('omits spawned_by when the input does not carry it', async () => {
    const { service } = makeService({ teamBinder: makeBinder(makeTeam(TEAM_ID)) });
    const events = collect(service);

    await service.create({ kind: 'peer', teamId: TEAM_ID });

    const spawned = lastSpawned(events);
    expect(spawned).toBeDefined();
    expect(spawned?.spawned_by).toBeUndefined();
    expect(Object.hasOwn(spawned as object, 'spawned_by')).toBe(false);
  });

  it('does not persist kind or spawnedBy in the snapshot', async () => {
    const dataDir = await tempDir();
    const { service } = makeService({
      dataDir,
      teamBinder: makeBinder(makeTeam(TEAM_ID)),
    });

    const peer = await service.create({ kind: 'peer', teamId: TEAM_ID, spawnedBy: 'caller' });
    await service.flushSnapshot();

    const raw = await readFile(snapshotPath(dataDir, 'default'), 'utf8');
    expect(raw).not.toContain('spawnedBy');
    expect(raw).not.toContain('spawned_by');
    expect(raw).not.toContain('"kind"');
    const file = JSON.parse(raw) as { members: Record<string, unknown>[] };
    const persisted = file.members.find((member) => member.id === peer.id);
    expect(persisted).toBeDefined();
    expect(Object.hasOwn(persisted as object, 'kind')).toBe(false);
    expect(Object.hasOwn(persisted as object, 'spawned_by')).toBe(false);
  });
});

describe('AgentService.close private contractor cascade', () => {
  it('closes private contractors and keeps team-visible contractors present', async () => {
    const { service } = makeService({ teamBinder: makeBinder(makeTeam(TEAM_ID)) });
    const owner = await service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'owner',
      spawnedBy: 'main',
    });
    const privateChild = await service.create({
      kind: 'contractor',
      owner: owner.id,
      teamId: TEAM_ID,
      visibility: 'private',
      name: 'private-child',
      spawnedBy: owner.id,
    });
    const unboundPrivate = await service.create({
      kind: 'contractor',
      owner: owner.id,
      name: 'unbound-private',
      spawnedBy: owner.id,
    });
    const teamChild = await service.create({
      kind: 'contractor',
      owner: owner.id,
      teamId: TEAM_ID,
      name: 'team-child',
      spawnedBy: owner.id,
    });

    await service.close({ member: owner.id });

    expect((await service.identify(privateChild.id))?.state).toBe('closed');
    expect((await service.identify(unboundPrivate.id))?.state).toBe('closed');
    const kept = await service.identify(teamChild.id);
    expect(kept?.state).toBe('idle');
    expect(kept?.membership).toBe('present');
  });

  it('recursively closes chained private contractors', async () => {
    const { service } = makeService({ teamBinder: makeBinder(makeTeam(TEAM_ID)) });
    const owner = await service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'owner',
      spawnedBy: 'main',
    });
    const child = await service.create({
      kind: 'contractor',
      owner: owner.id,
      teamId: TEAM_ID,
      visibility: 'private',
      name: 'child',
      spawnedBy: owner.id,
    });
    const grandchild = await service.create({
      kind: 'contractor',
      owner: child.id,
      teamId: TEAM_ID,
      visibility: 'private',
      name: 'grandchild',
      spawnedBy: child.id,
    });

    await service.close({ member: owner.id });

    expect((await service.identify(child.id))?.state).toBe('closed');
    expect((await service.identify(grandchild.id))?.state).toBe('closed');
  });
});

describe('AgentService.create spawn freeze', () => {
  it('rejects explicit team and workspace binds while frozen, then allows after unfreeze', async () => {
    const team = makeTeam(TEAM_ID);
    const binder: TeamBinder = {
      ensureForWorkspace: async () => team,
      get: (teamId: string) => (teamId === TEAM_ID ? team : undefined),
    };
    const { service } = makeService({ teamBinder: binder });

    team.spawn_frozen = true;
    await rejectsWithCode(
      service.create({ kind: 'contractor', owner: 'owner', teamId: TEAM_ID }),
      'team_frozen',
      `team_frozen: ${TEAM_ID}`,
    );
    await rejectsWithCode(
      service.create({ name: 'ws-member', workspace: '/work/alpha' }),
      'team_frozen',
      `team_frozen: ${TEAM_ID}`,
    );
    expect(await service.list()).toHaveLength(0);

    team.spawn_frozen = false;
    const created = await service.create({ kind: 'contractor', owner: 'owner', teamId: TEAM_ID });
    expect(created.team_id).toBe(TEAM_ID);
  });

  it('freezing one team does not affect another', async () => {
    const alpha = makeTeam('alpha', { workspace: '/work/alpha' });
    const beta = makeTeam('beta', { workspace: '/work/beta' });
    const { service } = makeService({ teamBinder: makeBinder(alpha, beta) });

    alpha.spawn_frozen = true;
    const created = await service.create({ kind: 'contractor', owner: 'owner', teamId: 'beta' });
    expect(created.team_id).toBe('beta');
  });
});

describe('AgentService.reinstate spawn gates', () => {
  it('rejects a frozen team and succeeds after unfreeze when a slot is free', async () => {
    const team = makeTeam(TEAM_ID);
    const binder: TeamBinder = {
      ensureForWorkspace: async () => team,
      get: (teamId: string) => (teamId === TEAM_ID ? team : undefined),
    };
    const { service } = makeService({ teamBinder: binder });
    const target = await service.create({
      kind: 'contractor',
      owner: 'owner',
      teamId: TEAM_ID,
      name: 'target',
    });
    await service.close({ member: target.id });

    team.spawn_frozen = true;
    await rejectsWithCode(
      service.reinstate({ to: target.id, team_id: TEAM_ID }),
      'team_frozen',
      `team_frozen: ${TEAM_ID}`,
    );

    team.spawn_frozen = false;
    const revived = await service.reinstate({ to: target.id, team_id: TEAM_ID });
    expect(revived.membership).toBe('present');
    expect(revived.team_id).toBe(TEAM_ID);
  });

  it('rejects reinstate when the team already has 20 present members', async () => {
    const team = makeTeam(TEAM_ID);
    const binder: TeamBinder = {
      ensureForWorkspace: async () => team,
      get: (teamId: string) => (teamId === TEAM_ID ? team : undefined),
    };
    const { service } = makeService({ teamBinder: binder });
    const target = await service.create({
      kind: 'contractor',
      owner: 'owner',
      teamId: TEAM_ID,
      name: 'target',
    });
    for (let index = 0; index < 19; index += 1) {
      await service.create({ kind: 'contractor', owner: 'owner', teamId: TEAM_ID });
    }
    await service.close({ member: target.id });
    // 目标离开后空出一位，再补一个回到 20
    await service.create({ kind: 'contractor', owner: 'owner', teamId: TEAM_ID });

    await rejectsWithCode(
      service.reinstate({ to: target.id, team_id: TEAM_ID }),
      'team_full',
      `team_full: ${TEAM_ID}`,
    );
  });
});
