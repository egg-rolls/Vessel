/**
 * 0.24 S10.3 canonical Team CRUD（create / update / archive）。
 *
 * 守的故障：team-scoped token 凭空 create Team；update / archive 越界到别的 team；
 * archive 的业务拒绝（team_not_empty / team_archived）被降级成 invalid_params。
 */

import { describe, expect, it } from 'bun:test';
import { teamSummarySchema } from '../src/gateway/methods/schemas';
import { createTeamMethods } from '../src/gateway/methods/teams';
import { RpcError, type RpcMethodContext, type RpcMethodDefinition } from '../src/rpc';
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
  spawnFrozen: Array<{ teamId: string; frozen: boolean }>;
}

function fakeTeams(options: { tenantId?: string; archiveError?: Error } = {}): {
  control: TeamControlLike;
  calls: Calls;
} {
  const calls: Calls = { create: [], update: [], archive: [], spawnFrozen: [] };
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
    async setSpawnFrozen(teamId, frozen) {
      calls.spawnFrozen.push({ teamId, frozen });
      return summary(teamId, frozen ? { spawn_frozen: true } : {});
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

function methodOf(control: TeamControlLike, name: string): RpcMethodDefinition {
  const method = createTeamMethods({ teams: control }).find((entry) => entry.name === name);
  if (method === undefined) throw new Error(`missing method: ${name}`);
  return method;
}

function paramsProperties(method: RpcMethodDefinition): Record<string, unknown> {
  const schema = method.params_schema as { properties?: Record<string, unknown> } | undefined;
  return schema?.properties ?? {};
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

describe('teams.spawnFrozen', () => {
  it('declares the method with a boolean frozen param and a team summary result', () => {
    const { control } = fakeTeams();
    const method = methodOf(control, 'teams.spawnFrozen');
    expect(method.permission).toBe('write');
    expect(method.result_schema).toBe(teamSummarySchema);
    const schema = method.params_schema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['team_id', 'frozen']);
    expect(schema.properties?.frozen).toEqual({ type: 'boolean' });
  });

  it('forwards freeze / unfreeze and returns spawn_frozen', async () => {
    const { control, calls } = fakeTeams();
    const frozen = (await methodOf(control, 'teams.spawnFrozen').handler(
      { team_id: 'alpha', frozen: true },
      context(),
    )) as TeamSummaryLike;
    const thawed = (await methodOf(control, 'teams.spawnFrozen').handler(
      { team_id: 'alpha', frozen: false },
      context(),
    )) as TeamSummaryLike;
    expect(calls.spawnFrozen).toEqual([
      { teamId: 'alpha', frozen: true },
      { teamId: 'alpha', frozen: false },
    ]);
    expect(frozen.spawn_frozen).toBe(true);
    expect(thawed.spawn_frozen).toBeUndefined();
  });

  it('lets a team-scoped token freeze its own team only', async () => {
    const { control, calls } = fakeTeams();
    await methodOf(control, 'teams.spawnFrozen').handler(
      { team_id: 'alpha', frozen: true },
      context({ scope: 'control', team_id: 'alpha' }),
    );
    expect(calls.spawnFrozen).toEqual([{ teamId: 'alpha', frozen: true }]);

    await expectRpcError(
      async () =>
        await methodOf(control, 'teams.spawnFrozen').handler(
          { team_id: 'beta', frozen: true },
          context({ scope: 'control', team_id: 'alpha' }),
        ),
      'not_found',
    );
    expect(calls.spawnFrozen).toEqual([{ teamId: 'alpha', frozen: true }]);
  });

  it('rejects a non-boolean frozen value', async () => {
    const { control } = fakeTeams();
    await expectRpcError(
      async () =>
        await methodOf(control, 'teams.spawnFrozen').handler(
          { team_id: 'alpha', frozen: 'yes' },
          context(),
        ),
      'invalid_params',
    );
  });
});

describe('retired default_principal / handoff_path', () => {
  it('does not declare either key in params or team summary schemas', () => {
    const { control } = fakeTeams();
    for (const name of ['teams.create', 'teams.update']) {
      const properties = paramsProperties(methodOf(control, name));
      expect(properties).not.toHaveProperty('default_principal');
      expect(properties).not.toHaveProperty('handoff_path');
    }
    expect(teamSummarySchema.properties).not.toHaveProperty('default_principal');
    expect(teamSummarySchema.properties).not.toHaveProperty('handoff_path');
  });

  it('silently ignores the legacy params from old clients', async () => {
    const { control, calls } = fakeTeams();
    await methodOf(control, 'teams.create').handler(
      {
        workspace: '/ws/alpha',
        default_principal: 'alice',
        handoff_path: '/ws/alpha/HANDOFF.md',
      },
      context(),
    );
    await methodOf(control, 'teams.update').handler(
      { team_id: 'alpha', default_principal: null, handoff_path: null },
      context(),
    );
    expect(calls.create).toEqual([{ workspace: '/ws/alpha' }]);
    expect(calls.update).toEqual([{ team_id: 'alpha' }]);
    for (const forwarded of [...calls.create, ...calls.update]) {
      expect('default_principal' in forwarded).toBe(false);
      expect('handoff_path' in forwarded).toBe(false);
    }
  });
});

describe('teams.update / teams.archive', () => {
  it('lets a team-scoped token update its own team and forwards null clears', async () => {
    const { control, calls } = fakeTeams();
    await methodOf(control, 'teams.update').handler(
      { team_id: 'alpha', description: null },
      context({ scope: 'control', team_id: 'alpha' }),
    );
    expect(calls.update).toEqual([{ team_id: 'alpha', description: null }]);
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
