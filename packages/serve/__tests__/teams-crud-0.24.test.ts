/**
 * 0.24 S10.3 canonical Team CRUD（create / update / archive）。
 *
 * 守的故障：team-scoped token 凭空 create Team；update / archive 越界到别的 team；
 * archive 的业务拒绝（team_not_empty / team_archived）被降级成 invalid_params。
 */

import { describe, expect, it } from 'bun:test';
import { createTeamMethods } from '../src/gateway/methods/teams';
import { RpcError, type RpcMethodContext } from '../src/rpc';
import type {
  TeamControlLike,
  TeamCreateLikeInput,
  TeamSummaryLike,
  TeamUpdateLikeInput,
} from '../src/team-control';

function summary(teamId: string, overrides: Partial<TeamSummaryLike> = {}): TeamSummaryLike {
  return {
    team_id: teamId,
    name: teamId,
    tenant_id: 'default',
    member_count: 0,
    online_count: 0,
    created_at: 1,
    ...overrides,
  };
}

interface Calls {
  create: TeamCreateLikeInput[];
  update: TeamUpdateLikeInput[];
  archive: Array<{ team_id: string }>;
}

function fakeTeams(options: { tenantId?: string; archiveError?: Error } = {}): {
  control: TeamControlLike;
  calls: Calls;
} {
  const calls: Calls = { create: [], update: [], archive: [] };
  const control: TeamControlLike = {
    tenantId: options.tenantId ?? 'default',
    async create(input) {
      calls.create.push(input);
      return summary(input.workspace.split('/').pop() ?? 'team');
    },
    async update(input) {
      calls.update.push(input);
      if (options.archiveError !== undefined) throw options.archiveError;
      return summary(input.team_id);
    },
    async archive(input) {
      calls.archive.push(input);
      if (options.archiveError !== undefined) throw options.archiveError;
      return summary(input.team_id, { archived_at: 2 });
    },
    async list() {
      return [];
    },
    async get() {
      return undefined;
    },
    async roster() {
      return [];
    },
    async post() {
      throw new Error('not used');
    },
    async members() {
      return undefined;
    },
  };
  return { control, calls };
}

function context(overrides: Partial<RpcMethodContext['principal']> = {}): RpcMethodContext {
  return {
    principal: { tenant_id: 'default', role: 'write', ...overrides },
    tenantId: 'default',
    isAdmin: false,
    allTenants: false,
    connection: 'http',
  };
}

function methodOf(control: TeamControlLike, name: string) {
  const method = createTeamMethods({ teams: control }).find((entry) => entry.name === name);
  if (method === undefined) throw new Error(`missing method: ${name}`);
  return method;
}

async function expectRpcError(
  run: () => Promise<unknown>,
  code: RpcError['code'],
): Promise<RpcError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    if (!(error instanceof RpcError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected RpcError ${code}`);
}

describe('teams.create', () => {
  it('allows a static human token and forwards the workspace', async () => {
    const { control, calls } = fakeTeams();
    const result = (await methodOf(control, 'teams.create').handler(
      { workspace: '/ws/alpha', name: 'Alpha', description: 'desc' },
      context(),
    )) as { team_id: string; name: string };
    expect(result.team_id).toBe('alpha');
    expect(result.name).toBe('alpha');
    expect(calls.create).toEqual([{ workspace: '/ws/alpha', name: 'Alpha', description: 'desc' }]);
  });

  it('forbids team-scoped control tokens from creating teams', async () => {
    const { control, calls } = fakeTeams();
    await expectRpcError(
      async () =>
        await methodOf(control, 'teams.create').handler(
          { workspace: '/ws/alpha' },
          context({ scope: 'control', team_id: 'alpha' }),
        ),
      'forbidden',
    );
    expect(calls.create).toEqual([]);
  });

  it('declares a result_schema for every CRUD method', () => {
    const { control } = fakeTeams();
    for (const name of ['teams.create', 'teams.update', 'teams.archive']) {
      expect(methodOf(control, name).result_schema).toBeDefined();
    }
  });
});

describe('teams.update / teams.archive', () => {
  it('lets a team-scoped token update its own team and forwards null clears', async () => {
    const { control, calls } = fakeTeams();
    await methodOf(control, 'teams.update').handler(
      { team_id: 'alpha', description: null, default_principal: 'main' },
      context({ scope: 'control', team_id: 'alpha' }),
    );
    expect(calls.update).toEqual([
      { team_id: 'alpha', description: null, default_principal: 'main' },
    ]);
  });

  it('does not leak another team to a team-scoped token', async () => {
    const { control, calls } = fakeTeams();
    await expectRpcError(
      async () =>
        await methodOf(control, 'teams.update').handler(
          { team_id: 'beta', name: 'Beta' },
          context({ scope: 'control', team_id: 'alpha' }),
        ),
      'not_found',
    );
    expect(calls.update).toEqual([]);
  });

  it('maps team_not_empty / team_archived to conflict', async () => {
    const notEmpty = fakeTeams({
      archiveError: Object.assign(new Error('team_not_empty: alpha'), { code: 'team_not_empty' }),
    });
    await expectRpcError(
      async () =>
        await methodOf(notEmpty.control, 'teams.archive').handler({ team_id: 'alpha' }, context()),
      'conflict',
    );

    const archived = fakeTeams({
      archiveError: Object.assign(new Error('team_archived: alpha'), { code: 'team_archived' }),
    });
    await expectRpcError(
      async () =>
        await methodOf(archived.control, 'teams.update').handler(
          { team_id: 'alpha', name: 'Alpha' },
          context(),
        ),
      'conflict',
    );
  });
});
