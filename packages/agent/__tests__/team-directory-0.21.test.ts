import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTeamStore, type MemberStatus, teamsDirPath } from '../src/index.js';
import { makeMember, makeTeamHarness } from './helpers.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-team-directory-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function withSeen(member: MemberStatus, lastSeen: number): MemberStatus {
  return { ...member, last_seen: lastSeen };
}

describe('team directory persistence (0.21)', () => {
  it('persists seeded description / default_principal across reload', async () => {
    const dataDir = await tempDir();
    const workspace = join(dataDir, 'seed', 'proj');
    const store = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });

    await store.seed([
      {
        workspace,
        name: 'Alpha',
        description: 'find alice for releases',
        default_principal: 'alice',
      },
    ]);
    const seeded = store.list()[0];
    if (seeded === undefined) throw new Error('expected seeded team');
    expect(seeded.description).toBe('find alice for releases');
    expect(seeded.default_principal).toBe('alice');

    const reopened = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    await reopened.ready();
    expect(reopened.get(seeded.team_id)).toMatchObject({
      name: 'Alpha',
      description: 'find alice for releases',
      default_principal: 'alice',
    });
  });

  it('copies ensureForWorkspace description / default_principal into team.json', async () => {
    const dataDir = await tempDir();
    const workspace = join(dataDir, 'ensure', 'proj');
    const first = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });

    const created = await first.ensureForWorkspace({
      workspace,
      description: 'handoff mailbox',
      default_principal: 'owner',
    });

    const reopened = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    await reopened.ready();
    expect(reopened.get(created.team_id)).toMatchObject({
      description: 'handoff mailbox',
      default_principal: 'owner',
    });
  });

  it('ignores invalid optional fields but still loads the team', async () => {
    const dataDir = await tempDir();
    const tenantDir = teamsDirPath(dataDir, 'default');
    const workspace = join(dataDir, 'bad-optional');
    await mkdir(join(tenantDir, 'bad-optional'), { recursive: true });
    await writeFile(
      join(tenantDir, 'bad-optional', 'team.json'),
      JSON.stringify({
        v: 1,
        team_id: 'bad-optional',
        name: 'Bad Optional',
        tenant_id: 'default',
        workspace,
        policy: {},
        created_at: 1,
        description: 123,
        default_principal: '',
      }),
    );

    const store = new FileTeamStore({ dataDir, tenantId: 'default', durable: false });
    await store.ready();

    const record = store.get('bad-optional');
    expect(record?.name).toBe('Bad Optional');
    expect(record?.description).toBeUndefined();
    expect(record?.default_principal).toBeUndefined();
  });
});

describe('teams.get member window (0.21)', () => {
  it('defaults to 20, caps at 100, and keeps roster / counts on the full list', async () => {
    const members = Array.from({ length: 105 }, (_, index) =>
      makeMember({ id: `m-${index}`, name: `n-${index}`, team_id: 'alpha' }),
    );
    const { service } = makeTeamHarness({ members });

    const byDefault = await service.get('alpha');
    expect(byDefault?.members).toHaveLength(20);
    expect(byDefault?.team).toMatchObject({ member_count: 105, online_count: 105 });

    expect((await service.get('alpha', { members_limit: 500 }))?.members).toHaveLength(100);
    // 非整数 / <1 回退缺省 20。
    expect((await service.get('alpha', { members_limit: 2.5 }))?.members).toHaveLength(20);
    expect((await service.get('alpha', { members_limit: 0 }))?.members).toHaveLength(20);
    // 窗口只影响 get；roster 仍是完整 roster。
    expect(await service.roster('alpha')).toHaveLength(105);
  });

  it('sorts live first, then last_seen desc, then name', async () => {
    // 故意把 gone 放在前面：live 优先必须重排，而不是靠输入顺序碰巧通过。
    const members: MemberStatus[] = [
      withSeen(makeMember({ id: 'gone-999', name: 'a', team_id: 'alpha', presence: 'gone' }), 999),
      makeMember({ id: 'gone-none', name: 'a', team_id: 'alpha', presence: 'gone' }),
      withSeen(makeMember({ id: 'live-300', name: 'a', team_id: 'alpha' }), 300),
      withSeen(makeMember({ id: 'live-100', name: 'z', team_id: 'alpha' }), 100),
      makeMember({ id: 'live-none-b', name: 'b', team_id: 'alpha' }),
      makeMember({ id: 'live-none-a', name: 'a', team_id: 'alpha' }),
    ];
    const { service } = makeTeamHarness({ members });

    const windowed = await service.get('alpha', { members_limit: 3 });
    expect(windowed?.members.map((member) => member.agent_id)).toEqual([
      'live-300',
      'live-100',
      'live-none-a',
    ]);
    expect(windowed?.members[0]?.last_seen).toBe(300);
    expect(windowed?.team).toMatchObject({ member_count: 6, online_count: 4 });

    const full = await service.get('alpha', { members_limit: 100 });
    expect(full?.members.map((member) => member.agent_id)).toEqual([
      'live-300',
      'live-100',
      'live-none-a',
      'live-none-b',
      'gone-999',
      'gone-none',
    ]);
  });
});

describe('TeamService.post federation metadata (0.21)', () => {
  const federation = {
    from_addr: 'alice@node-a:another-lab',
    to_addr: 'eggrolls@node-b:lab',
    conversation_id: 'conv_fed',
    hop: 1,
  };

  it('keeps the log original and prefixes the reply header for dispatch', async () => {
    const { service, agent, store } = makeTeamHarness({
      members: [makeMember({ id: 'a', team_id: 'alpha' })],
    });

    const result = await service.post({
      team_id: 'alpha',
      content: 'original body',
      mentions: ['a'],
      conversation_id: 'conv_fed',
      federation,
    });

    expect(result.kind).toBe('mention');
    expect(store.logs[0]).toMatchObject({
      content: 'original body',
      to: ['a'],
      mentions: ['a'],
      federation,
    });
    expect(agent.dispatches).toHaveLength(1);
    const dispatch = agent.dispatches[0];
    expect(dispatch).toMatchObject({
      to: 'a',
      from: 'main',
      conversation_id: 'conv_fed',
      origin_team_id: 'alpha',
    });
    expect(dispatch?.content).toBe(
      '[federation] from alice@node-a:another-lab\n' +
        'reply with: agent(send, to="alice@node-a:another-lab", content="...")\n\n' +
        'original body',
    );
  });

  it('writes owner markers to the log without dispatching them', async () => {
    const { service, agent, store } = makeTeamHarness();

    const result = await service.post({
      team_id: 'alpha',
      content: 'handoff',
      to: ['owner'],
      conversation_id: 'conv_fed',
      federation: { ...federation, to_addr: 'owner@node-b:lab' },
    });

    expect(result.kind).toBe('post');
    expect(store.logs[0]).toMatchObject({
      content: 'handoff',
      to: ['owner'],
      mentions: [],
      federation: { ...federation, to_addr: 'owner@node-b:lab' },
    });
    expect(agent.dispatches).toHaveLength(0);
  });

  it('does not prefix dispatches when federation metadata is absent', async () => {
    const { service, agent, store } = makeTeamHarness({
      members: [makeMember({ id: 'a', team_id: 'alpha' })],
    });

    await service.post({ team_id: 'alpha', content: 'plain', mentions: ['a'] });

    expect(store.logs[0]?.federation).toBeUndefined();
    expect(agent.dispatches[0]?.content).toBe('plain');
  });
});
