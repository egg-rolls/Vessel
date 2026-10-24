import { describe, expect, it } from 'bun:test';
import { createAuthMethods } from '../src/gateway/methods/auth';
import type {
  IssuedNodeToken,
  NodeTokenControlLike,
  NodeTokenMeta,
  RevokeTokenResult,
} from '../src/node-token-control';
import { RpcError, type RpcMethodContext, type RpcMethodDefinition } from '../src/rpc';
import type { TeamControlLike, TeamSummaryLike } from '../src/team-control';

type Principal = RpcMethodContext['principal'];

interface ExchangeCall {
  principal: Parameters<NodeTokenControlLike['exchange']>[0];
  input: Parameters<NodeTokenControlLike['exchange']>[1];
}

interface RevokeCall {
  principal: Parameters<NodeTokenControlLike['revoke']>[0];
  tokenId: string;
}

interface ControlHarness {
  control: NodeTokenControlLike;
  exchangeCalls: ExchangeCall[];
  revokeCalls: RevokeCall[];
  listCalls: () => number;
}

const defaultMeta: NodeTokenMeta = {
  token_id: 'tok-view-1',
  scope: 'view',
  tenant_id: 'tenant-a',
  issued_by: 'hub-1',
  created_at: 1_700_000_000_000,
  expires_at: 1_700_100_000_000,
};

function makeControl(
  options: { exchangeResult?: Partial<IssuedNodeToken>; meta?: NodeTokenMeta[] } = {},
): ControlHarness {
  const exchangeCalls: ExchangeCall[] = [];
  const revokeCalls: RevokeCall[] = [];
  let listCount = 0;

  const control: NodeTokenControlLike = {
    authenticate: () => null,
    hasTokens: () => true,
    async mintPairingTokens() {
      throw new Error('mintPairingTokens is not used by auth methods');
    },
    async exchange(principal, input) {
      exchangeCalls.push({ principal, input });
      return {
        token: 'control-plaintext',
        token_id: 'tok-control-1',
        scope: 'control',
        tenant_id: principal.tenant_id,
        node_id: 'node-1',
        team_id: input.team_id,
        expires_at: 1_700_000_000_000,
        ...options.exchangeResult,
      };
    },
    async revoke(principal, tokenId): Promise<RevokeTokenResult> {
      revokeCalls.push({ principal, tokenId });
      return { token_id: tokenId, revoked_at: 1_700_000_000_000 };
    },
    async list(): Promise<NodeTokenMeta[]> {
      listCount += 1;
      return options.meta ?? [defaultMeta];
    },
    onRevoke: () => () => {},
  };

  return { control, exchangeCalls, revokeCalls, listCalls: () => listCount };
}

const defaultTeam: TeamSummaryLike = {
  team_id: 'team-1',
  name: 'Team One',
  tenant_id: 'tenant-a',
  workspace: '/work/team-1',
  policy: {},
  member_count: 1,
  online_count: 1,
  created_at: 1_700_000_000_000,
};

interface TeamsHarness {
  teams: TeamControlLike;
  getCalls: Array<{ teamId: string; options?: { viewer?: string; limit?: number } }>;
}

/** 假的 Team 控制面；默认只认识 `team-1`。 */
function makeTeams(
  options: { tenantId?: string; known?: Set<string>; getError?: unknown } = {},
): TeamsHarness {
  const getCalls: TeamsHarness['getCalls'] = [];
  const known = options.known ?? new Set(['team-1']);
  const teams: TeamControlLike = {
    tenantId: options.tenantId ?? 'tenant-a',
    async create() {
      throw new Error('create is not used by auth methods');
    },
    async update() {
      throw new Error('update is not used by auth methods');
    },
    async archive() {
      throw new Error('archive is not used by auth methods');
    },
    async list() {
      return [];
    },
    async get(teamId, getOptions) {
      getCalls.push({ teamId, ...(getOptions !== undefined ? { options: getOptions } : {}) });
      if (options.getError !== undefined) throw options.getError;
      if (!known.has(teamId)) return undefined;
      return { team: { ...defaultTeam, team_id: teamId }, members: [], messages: [] };
    },
    async roster() {
      return [];
    },
    async post() {
      throw new Error('post is not used by auth methods');
    },
    async members() {
      return undefined;
    },
  };
  return { teams, getCalls };
}

/**
 * `teamsOverride`：`undefined` = 注入默认假 Team（成功路径）；
 * `null` = 完全不注入 teams（缺控制面路径）。
 */
function methodMap(
  control?: NodeTokenControlLike,
  teamsOverride?: TeamControlLike | null,
): Map<string, RpcMethodDefinition> {
  const teams = teamsOverride === null ? undefined : (teamsOverride ?? makeTeams().teams);
  return new Map(
    createAuthMethods({
      ...(control === undefined ? {} : { nodeTokens: control }),
      ...(teams === undefined ? {} : { teams }),
    }).map((method) => [method.name, method]),
  );
}

function methodOf(methods: Map<string, RpcMethodDefinition>, name: string): RpcMethodDefinition {
  const method = methods.get(name);
  if (!method) throw new Error(`missing method ${name}`);
  return method;
}

function makeCtx(
  principal: Principal,
  overrides: Partial<RpcMethodContext> = {},
): RpcMethodContext {
  return {
    principal,
    tenantId: principal.tenant_id === '*' ? 'default' : principal.tenant_id,
    isAdmin: principal.role === 'admin',
    allTenants: false,
    connection: 'http',
    ...overrides,
  };
}

async function call(
  methods: Map<string, RpcMethodDefinition>,
  name: string,
  params: Record<string, unknown>,
  ctx: RpcMethodContext,
): Promise<Record<string, unknown>> {
  return (await methodOf(methods, name).handler(params, ctx)) as Record<string, unknown>;
}

async function expectRpcCode(promise: Promise<unknown>, code: RpcError['code']): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(code);
    return;
  }
  throw new Error(`expected RpcError(${code})`);
}

const exchangePrincipal: Principal = { tenant_id: 'tenant-a', role: 'write', scope: 'exchange' };
const viewPrincipal: Principal = { tenant_id: 'tenant-a', role: 'read', scope: 'view' };
const controlPrincipal: Principal = { tenant_id: 'tenant-a', role: 'write', scope: 'control' };
const adminPrincipal: Principal = { tenant_id: 'tenant-a', role: 'admin', scope: 'admin' };
const staticAdmin: Principal = { tenant_id: '*', role: 'admin' };
const staticWriter: Principal = { tenant_id: 'tenant-a', role: 'write' };

describe('auth.exchange', () => {
  it('signs a control token for an exchange-scoped principal', async () => {
    const harness = makeControl();
    const methods = methodMap(harness.control);

    const result = await call(
      methods,
      'auth.exchange',
      { team_id: 'team-1', ttl_s: 600 },
      makeCtx(exchangePrincipal),
    );

    expect(result).toMatchObject({
      token: 'control-plaintext',
      token_id: 'tok-control-1',
      scope: 'control',
      tenant_id: 'tenant-a',
      team_id: 'team-1',
      node_id: 'node-1',
      expires_at: 1_700_000_000_000,
    });
    expect(harness.exchangeCalls).toHaveLength(1);
    expect(harness.exchangeCalls[0]?.principal).toMatchObject({
      tenant_id: 'tenant-a',
      scope: 'exchange',
    });
    expect(harness.exchangeCalls[0]?.input).toEqual({ team_id: 'team-1', ttl_s: 600 });
  });

  it('returns not_found for an unknown team and never signs a token', async () => {
    const harness = makeControl();
    const teamHarness = makeTeams();
    const methods = methodMap(harness.control, teamHarness.teams);

    await expectRpcCode(
      call(methods, 'auth.exchange', { team_id: 'team-404' }, makeCtx(exchangePrincipal)),
      'not_found',
    );
    expect(teamHarness.getCalls).toHaveLength(1);
    expect(teamHarness.getCalls[0]?.teamId).toBe('team-404');
    expect(harness.exchangeCalls).toHaveLength(0);
  });

  it('maps a team_not_found error from the control plane to not_found', async () => {
    const harness = makeControl();
    const teamHarness = makeTeams({
      getError: Object.assign(new Error('missing'), { code: 'team_not_found' }),
    });
    const methods = methodMap(harness.control, teamHarness.teams);

    await expectRpcCode(
      call(methods, 'auth.exchange', { team_id: 'team-1' }, makeCtx(exchangePrincipal)),
      'not_found',
    );
    expect(harness.exchangeCalls).toHaveLength(0);
  });

  it('passes through non team_not_found errors unchanged', async () => {
    const harness = makeControl();
    const teamHarness = makeTeams({ getError: new RpcError('conflict', 'corrupt team store') });
    const methods = methodMap(harness.control, teamHarness.teams);

    await expectRpcCode(
      call(methods, 'auth.exchange', { team_id: 'team-1' }, makeCtx(exchangePrincipal)),
      'conflict',
    );
    expect(harness.exchangeCalls).toHaveLength(0);
  });

  it('returns not_found when team control is not injected', async () => {
    const harness = makeControl();
    const methods = methodMap(harness.control, null);

    await expectRpcCode(
      call(methods, 'auth.exchange', { team_id: 'team-1' }, makeCtx(exchangePrincipal)),
      'not_found',
    );
    expect(harness.exchangeCalls).toHaveLength(0);
  });

  it('returns not_found when the team control tenant does not match', async () => {
    const harness = makeControl();
    const teamHarness = makeTeams({ tenantId: 'tenant-b' });
    const methods = methodMap(harness.control, teamHarness.teams);

    await expectRpcCode(
      call(methods, 'auth.exchange', { team_id: 'team-1' }, makeCtx(exchangePrincipal)),
      'not_found',
    );
    expect(teamHarness.getCalls).toHaveLength(0);
    expect(harness.exchangeCalls).toHaveLength(0);
  });

  it('calls exchange exactly once for an existing team', async () => {
    const harness = makeControl();
    const teamHarness = makeTeams();
    const methods = methodMap(harness.control, teamHarness.teams);

    await call(
      methods,
      'auth.exchange',
      { team_id: 'team-1', ttl_s: 600 },
      makeCtx(exchangePrincipal),
    );

    expect(teamHarness.getCalls).toHaveLength(1);
    expect(teamHarness.getCalls[0]?.options).toEqual({ limit: 1 });
    expect(harness.exchangeCalls).toHaveLength(1);
    expect(harness.exchangeCalls[0]?.input).toEqual({ team_id: 'team-1', ttl_s: 600 });
  });

  it('always returns control scope even when params ask for another scope', async () => {
    const harness = makeControl();
    const methods = methodMap(harness.control);

    for (const scope of ['view', 'admin']) {
      const result = await call(
        methods,
        'auth.exchange',
        { team_id: 'team-1', scope },
        makeCtx(exchangePrincipal),
      );
      expect(result.scope).toBe('control');
    }
    expect(harness.exchangeCalls).toHaveLength(2);
  });

  it('forbids view and control tokens', async () => {
    const harness = makeControl();
    const methods = methodMap(harness.control);

    await expectRpcCode(
      call(methods, 'auth.exchange', { team_id: 'team-1' }, makeCtx(viewPrincipal)),
      'forbidden',
    );
    await expectRpcCode(
      call(methods, 'auth.exchange', { team_id: 'team-1' }, makeCtx(controlPrincipal)),
      'forbidden',
    );
    await expectRpcCode(
      call(methods, 'auth.exchange', { team_id: 'team-1' }, makeCtx(staticWriter)),
      'forbidden',
    );
    expect(harness.exchangeCalls).toHaveLength(0);
  });

  it('allows admin-scoped and static admin principals', async () => {
    const harness = makeControl();
    const methods = methodMap(harness.control);

    const scoped = await call(
      methods,
      'auth.exchange',
      { team_id: 'team-1' },
      makeCtx(adminPrincipal),
    );
    expect(scoped.scope).toBe('control');
    expect(scoped.tenant_id).toBe('tenant-a');

    // 静态 admin 的 ctx.tenantId 是 default，Team 控制面必须位于同一 tenant。
    const wildcardMethods = methodMap(harness.control, makeTeams({ tenantId: 'default' }).teams);
    const wildcard = await call(
      wildcardMethods,
      'auth.exchange',
      { team_id: 'team-1' },
      makeCtx(staticAdmin),
    );
    expect(wildcard.scope).toBe('control');
    expect(wildcard.tenant_id).toBe('default');
    expect(harness.exchangeCalls).toHaveLength(2);
  });

  it('rejects a wildcard target tenant', async () => {
    const harness = makeControl();
    const methods = methodMap(harness.control);

    await expectRpcCode(
      call(
        methods,
        'auth.exchange',
        { team_id: 'team-1' },
        makeCtx(staticAdmin, { tenantId: '*' }),
      ),
      'forbidden',
    );
    expect(harness.exchangeCalls).toHaveLength(0);
  });

  it('validates team_id and ttl_s defensively', async () => {
    const harness = makeControl();
    const methods = methodMap(harness.control);

    await expectRpcCode(
      call(methods, 'auth.exchange', {}, makeCtx(exchangePrincipal)),
      'invalid_params',
    );
    for (const ttl of [59, 86_401, 1.5, '600']) {
      await expectRpcCode(
        call(
          methods,
          'auth.exchange',
          { team_id: 'team-1', ttl_s: ttl },
          makeCtx(exchangePrincipal),
        ),
        'invalid_params',
      );
    }
    expect(harness.exchangeCalls).toHaveLength(0);
  });

  it('does not pass through extra fields from the control implementation', async () => {
    const harness = makeControl({
      exchangeResult: { secret: 'should-not-leak' } as unknown as Partial<IssuedNodeToken>,
    });
    const methods = methodMap(harness.control);

    const result = await call(
      methods,
      'auth.exchange',
      { team_id: 'team-1' },
      makeCtx(exchangePrincipal),
    );

    expect(result).not.toHaveProperty('secret');
    expect(JSON.stringify(result)).not.toContain('should-not-leak');
  });
});

describe('auth.revoke / auth.tokens', () => {
  it('revoke only accepts admin principals', async () => {
    const harness = makeControl();
    const methods = methodMap(harness.control);

    await expectRpcCode(
      call(methods, 'auth.revoke', { token_id: 'tok-1' }, makeCtx(exchangePrincipal)),
      'forbidden',
    );
    await expectRpcCode(
      call(methods, 'auth.revoke', { token_id: 'tok-1' }, makeCtx(viewPrincipal)),
      'forbidden',
    );

    const revoked = await call(
      methods,
      'auth.revoke',
      { token_id: 'tok-1' },
      makeCtx(adminPrincipal),
    );
    expect(revoked).toEqual({ token_id: 'tok-1', revoked_at: 1_700_000_000_000 });
    expect(harness.revokeCalls).toHaveLength(1);
    expect(harness.revokeCalls[0]?.tokenId).toBe('tok-1');
  });

  it('tokens only accepts admin principals and never returns tokens or hashes', async () => {
    const leaky = {
      ...defaultMeta,
      token: 'should-not-leak',
      token_hash: 'should-not-leak',
      hash: 'should-not-leak',
    } as unknown as NodeTokenMeta;
    const harness = makeControl({ meta: [leaky] });
    const methods = methodMap(harness.control);

    await expectRpcCode(call(methods, 'auth.tokens', {}, makeCtx(exchangePrincipal)), 'forbidden');
    await expectRpcCode(call(methods, 'auth.tokens', {}, makeCtx(viewPrincipal)), 'forbidden');

    const result = await call(methods, 'auth.tokens', {}, makeCtx(adminPrincipal));
    const tokens = result.tokens as Array<Record<string, unknown>>;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      token_id: defaultMeta.token_id,
      scope: defaultMeta.scope,
      tenant_id: defaultMeta.tenant_id,
      issued_by: defaultMeta.issued_by,
      created_at: defaultMeta.created_at,
      expires_at: defaultMeta.expires_at,
    });
    expect(tokens[0]).not.toHaveProperty('token');
    expect(tokens[0]).not.toHaveProperty('token_hash');
    expect(tokens[0]).not.toHaveProperty('hash');
    expect(JSON.stringify(result)).not.toContain('should-not-leak');
    expect(harness.listCalls()).toBe(1);
  });

  it('returns not_found when node token control is not injected', async () => {
    const methods = methodMap();

    await expectRpcCode(
      call(methods, 'auth.exchange', { team_id: 'team-1' }, makeCtx(adminPrincipal)),
      'not_found',
    );
    await expectRpcCode(
      call(methods, 'auth.revoke', { token_id: 'tok-1' }, makeCtx(adminPrincipal)),
      'not_found',
    );
    await expectRpcCode(call(methods, 'auth.tokens', {}, makeCtx(adminPrincipal)), 'not_found');
  });
});

describe('auth method table', () => {
  it('freezes names, permissions and result schemas', () => {
    const methods = methodMap(makeControl().control);

    expect([...methods.keys()]).toEqual(['auth.exchange', 'auth.revoke', 'auth.tokens']);
    expect(methodOf(methods, 'auth.exchange').permission).toBe('write');
    expect(methodOf(methods, 'auth.revoke').permission).toBe('admin');
    expect(methodOf(methods, 'auth.tokens').permission).toBe('admin');

    const params = methodOf(methods, 'auth.exchange').params_schema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(params.required).toEqual(['team_id']);
    expect(params.properties?.ttl_s).toMatchObject({
      type: 'integer',
      minimum: 60,
      maximum: 86_400,
    });

    const result = methodOf(methods, 'auth.exchange').result_schema as {
      required?: string[];
      properties?: Record<string, { enum?: string[] }>;
    };
    expect(result.required).toEqual([
      'token',
      'token_id',
      'scope',
      'tenant_id',
      'node_id',
      'expires_at',
    ]);
    expect(result.properties?.scope?.enum).toEqual(['view', 'exchange', 'control', 'admin']);

    const list = methodOf(methods, 'auth.tokens').result_schema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(list.required).toEqual(['tokens']);
  });
});
