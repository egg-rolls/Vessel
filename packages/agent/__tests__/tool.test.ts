import { describe, expect, it } from 'bun:test';
import { MemoryEventStream, type ToolContext, type ToolDefinition } from '@vessel-agent/core';
import {
  type AgentEvent,
  type AgentService,
  type AgentTeamService,
  type AgentToolOptions,
  type BatchItemResult,
  createAgentTool,
  type DispatchInput,
  type DispatchResult,
  type MemberStatus,
  type TeamAgentSendInput,
  type TeamAgentSendResult,
  type TeamBinder,
  type TeamMemberSummary,
  TeamMetadataCorruptError,
  type TeamPostInput,
  type TeamPostResult,
  type TeamRecord,
} from '../src/index.js';
import { makeService, makeTeam as makeTeamRecord, settle } from './helpers.js';

const TEAM_ID = 'alpha';

/** 固定 Team 的绑定端口；本文件只做显式 teamId 绑定 */
function makeBinder(...teams: TeamRecord[]): TeamBinder {
  return {
    ensureForWorkspace: async () => {
      throw new Error('unexpected ensureForWorkspace');
    },
    get: (teamId: string) => teams.find((team) => team.team_id === teamId),
  };
}

interface TeamRecorder {
  identify: string[];
  listForCaller: string[];
  post: TeamPostInput[];
  send: TeamAgentSendInput[];
}

/** 记录调用的假 TeamService；identify 按契约注释返回 team_id（类型暂未声明） */
function makeTeam(roster: TeamMemberSummary[] = []): {
  team: AgentTeamService;
  calls: TeamRecorder;
} {
  const calls: TeamRecorder = { identify: [], listForCaller: [], post: [], send: [] };
  const team: AgentTeamService = {
    tenantId: 'default',
    async create() {
      throw new Error('not used');
    },
    async update() {
      throw new Error('not used');
    },
    async archive() {
      throw new Error('not used');
    },
    async setSpawnFrozen() {
      throw new Error('not used');
    },
    isSpawnFrozen() {
      return false;
    },
    async list() {
      return [];
    },
    async get() {
      return undefined;
    },
    async roster() {
      return roster;
    },
    async post(input) {
      calls.post.push(input);
      return {
        message_id: 'msg-1',
        team_id: input.team_id,
        kind: 'post',
        mentions: [],
        delivered: [],
        ts: 123,
      };
    },
    async members() {
      return undefined;
    },
    async send(input) {
      calls.send.push(input);
      return {
        status: 'queued',
        resolved_to: input.to,
        message_id: 'msg-2',
        resolution: 'live',
        logged: false,
      };
    },
    async listForCaller(sessionId) {
      calls.listForCaller.push(sessionId);
      return roster;
    },
    async identify(sessionId) {
      calls.identify.push(sessionId);
      return {
        agent_id: 'worker',
        name: 'worker',
        session_id: sessionId,
        membership: 'present',
        presence: 'live',
        visibility: 'team',
        state: 'idle',
        epoch: 0,
        team_id: 'team-1',
      } as unknown as TeamMemberSummary;
    },
    subscribe: () => () => {},
    dispose() {},
  };
  return { team, calls };
}

function makeContext(sessionId?: string): ToolContext {
  return {
    run_id: 'tool-test',
    messages: [],
    events: new MemoryEventStream(),
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
  };
}

async function call(tool: ToolDefinition, args: unknown): Promise<string> {
  return tool.handler(args, makeContext());
}

async function callAs(tool: ToolDefinition, args: unknown, sessionId: string): Promise<string> {
  return tool.handler(args, makeContext(sessionId));
}

function parse<T>(text: string): T {
  return JSON.parse(text) as T;
}

function failureText(entry: BatchItemResult<unknown> | undefined): string {
  return entry !== undefined && !entry.ok ? entry.error : '';
}

function setup(options: AgentToolOptions = {}) {
  const made = makeService();
  return {
    service: made.service,
    runtime: made.runtime,
    tool: createAgentTool(made.service, options),
  };
}

describe('agent tool', () => {
  it('single hire returns parseable MemberStatus JSON with snake_case fields', async () => {
    const { service, tool } = setup();

    const status = parse<MemberStatus>(
      await call(tool, {
        action: 'hire',
        name: 'worker',
        model: 'm',
      }),
    );

    expect(status.id).toBe('id-1');
    expect(status.session_id).toBe(status.id);
    expect(status.name).toBe('worker');
    expect(status.visibility).toBe('private');
    expect(status.owner).toBe('main');
    expect(status.state).toBe('idle');
    expect((await service.list({ viewer: 'main' })).map((entry) => entry.id)).toEqual([status.id]);
  });

  it('batch hire preserves input order and reports a per-entry failure without dropping the rest', async () => {
    const { runtime, tool } = (() => {
      const made = makeService();
      return { runtime: made.runtime, tool: createAgentTool(made.service) };
    })();

    const { results } = parse<{ results: BatchItemResult<MemberStatus>[] }>(
      await call(tool, {
        action: 'hire',
        members: [{ name: 'first' }, { visibility: 'bogus' }, { name: 'third' }],
      }),
    );

    expect(results).toHaveLength(3);
    expect(results[0]?.ok ? results[0].status.name : undefined).toBe('first');
    expect(results[1]?.ok).toBe(false);
    expect(failureText(results[1])).toContain('invalid visibility');
    expect(results[2]?.ok ? results[2].status.name : undefined).toBe('third');
    expect(runtime.spawned.map((member) => member.name)).toEqual(['first', 'third']);
    expect(runtime.spawned.map((member) => member.parent_id)).toEqual(['main', 'main']);
  });

  it('member final text is delivered to the owner queue', async () => {
    const { service, runtime, tool } = setup();
    await service.attachOwner({ id: 'main', visibility: 'team' });
    const created = parse<MemberStatus>(await call(tool, { action: 'hire', name: 'worker' }));
    expect(created.parent_id).toBe('main');
    runtime.handler = async (member) => (member.id === created.id ? { content: 'done' } : {});

    await call(tool, { action: 'send', to: created.id, content: 'work' });
    await settle();

    expect(runtime.turns.filter((turn) => turn.member.id === 'main')).toEqual([]);
    const queued = await service.takeMessages('main');
    expect(queued.map((turn) => turn.content)).toEqual(['done']);
    expect(queued[0]?.from).toBe(created.id);
  });

  it('custom ownerId scopes hire owner/parent and list visibility', async () => {
    const { service, tool } = setup({ ownerId: 'boss' });
    const created = parse<MemberStatus>(await call(tool, { action: 'hire', name: 'worker' }));

    expect(created.owner).toBe('boss');
    expect(created.parent_id).toBe('boss');
    expect(
      parse<MemberStatus[]>(await call(tool, { action: 'list' })).map((entry) => entry.id),
    ).toEqual([created.id]);
    expect(await service.list({ viewer: 'main' })).toEqual([]);
    expect((await service.list({ viewer: 'boss' })).map((entry) => entry.id)).toEqual([created.id]);
  });

  it('single send dispatches and returns queued/message_id without waiting for the turn', async () => {
    const { runtime, tool } = setup();
    const created = parse<MemberStatus>(await call(tool, { action: 'hire', name: 'worker' }));

    const result = parse<DispatchResult>(
      await call(tool, { action: 'send', to: created.id, content: 'do work' }),
    );

    expect(result.status).toBe('queued');
    if (result.status !== 'queued') throw new Error('expected queued dispatch');
    expect(typeof result.message_id).toBe('string');
    expect(result.resolution).toBe('live');
    await settle();
    expect(runtime.turns.map((turn) => turn.message.content)).toEqual(['do work']);
  });

  it('batch send preserves order and reports an unknown target per entry', async () => {
    const { runtime, tool } = setup();
    const first = parse<MemberStatus>(await call(tool, { action: 'hire', name: 'a' }));
    const second = parse<MemberStatus>(await call(tool, { action: 'hire', name: 'b' }));

    const { results } = parse<{ results: BatchItemResult<DispatchResult>[] }>(
      await call(tool, {
        action: 'send',
        messages: [
          { to: first.id, content: 'x' },
          { to: 'missing', content: 'y' },
          { to: second.id, content: 'z' },
        ],
      }),
    );

    expect(results.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(failureText(results[1])).toContain('unknown_member');
    await settle();
    expect(runtime.turns.map((turn) => turn.message.content).sort()).toEqual(['x', 'z']);
  });

  it('single close returns closed, is idempotent, and list keeps the closed state', async () => {
    const { tool } = setup();
    const created = parse<MemberStatus>(await call(tool, { action: 'hire', name: 'worker' }));

    expect(parse(await call(tool, { action: 'close', member: created.id }))).toEqual({
      state: 'closed',
    });
    expect(parse(await call(tool, { action: 'close', member: created.id }))).toEqual({
      state: 'closed',
    });

    const listed = parse<MemberStatus[]>(await call(tool, { action: 'list' }));
    expect(listed.find((entry) => entry.id === created.id)?.state).toBe('closed');
  });

  it('batch close isolates an unknown member', async () => {
    const { tool } = setup();
    const first = parse<MemberStatus>(await call(tool, { action: 'hire', name: 'a' }));
    const second = parse<MemberStatus>(await call(tool, { action: 'hire', name: 'b' }));

    const { results } = parse<{ results: BatchItemResult<{ state: string }>[] }>(
      await call(tool, {
        action: 'close',
        members: [first.id, 'missing', second.id],
      }),
    );

    expect(results.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(failureText(results[1])).toContain('unknown_member');
    expect(results[0]?.ok ? results[0].status.state : undefined).toBe('closed');
    expect(results[2]?.ok ? results[2].status.state : undefined).toBe('closed');
  });

  it('list maps parent_id to the service filter instead of ignoring it', async () => {
    const made = makeService();
    const tool = createAgentTool(made.service);
    const member = parse<MemberStatus>(await call(tool, { action: 'hire', name: 'worker' }));
    const child = await made.service.create({
      name: 'child',
      parentId: 'grand',
      visibility: 'team',
    });

    const all = parse<MemberStatus[]>(await call(tool, { action: 'list' }));
    expect(all.map((entry) => entry.id).sort()).toEqual([member.id, child.id].sort());
    expect(all.find((entry) => entry.id === member.id)?.parent_id).toBe('main');

    const children = parse<MemberStatus[]>(
      await call(tool, { action: 'list', parent_id: 'grand' }),
    );
    expect(children.map((entry) => entry.id)).toEqual([child.id]);
    expect(parse(await call(tool, { action: 'list', parent_id: 'other' }))).toEqual([]);

    expect(parse(await call(tool, { action: 'list', state: 'idle' }))).toHaveLength(2);
    expect(parse(await call(tool, { action: 'list', visibility: 'team' }))).toEqual([
      expect.objectContaining({ id: child.id, visibility: 'team' }),
    ]);
  });

  it('corrupt team metadata surfaces as team_metadata_corrupt instead of invalid_input', async () => {
    const made = makeService();
    const corrupt = new TeamMetadataCorruptError('/data/teams/default/alpha/team.json');
    const service = Object.create(made.service) as AgentService & {
      create: () => Promise<never>;
    };
    service.create = async () => {
      throw corrupt;
    };
    const tool = createAgentTool(service, {});

    expect(await call(tool, { action: 'hire', name: 'alpha' })).toBe(
      'Error: team_metadata_corrupt: /data/teams/default/alpha/team.json',
    );
  });

  it('mixing single fields with a batch is rejected as invalid_input and creates nothing', async () => {
    const made = makeService();
    const tool = createAgentTool(made.service);

    for (const args of [
      { action: 'hire', name: 'x', members: [{}] },
      { action: 'send', to: 'x', content: 'y', messages: [{ to: 'x', content: 'y' }] },
      { action: 'close', member: 'x', members: ['x'] },
    ]) {
      expect(await call(tool, args)).toMatch(/^Error: invalid_input: /);
    }
    expect(made.runtime.spawned).toEqual([]);
  });

  it('unknown or missing action returns an invalid_input error string instead of throwing', async () => {
    const made = makeService();
    const tool = createAgentTool(made.service);

    expect(await call(tool, { action: 'wait' })).toMatch(
      /^Error: invalid_input: unknown action "wait"/,
    );
    expect(await call(tool, {})).toMatch(/^Error: invalid_input: unknown action/);
  });

  it('missing send/close fields return the AgentError code', async () => {
    const made = makeService();
    const tool = createAgentTool(made.service);

    expect(await call(tool, { action: 'send', to: 'id-1' })).toMatch(
      /^Error: invalid_input: content must be a non-empty string$/,
    );
    expect(await call(tool, { action: 'close' })).toMatch(
      /^Error: invalid_input: close requires member$/,
    );
    expect(await call(tool, { action: 'list', visibility: 'bogus' })).toMatch(
      /^Error: invalid_input: invalid visibility/,
    );
  });

  it('schema exposes the lifecycle actions plus rotate', async () => {
    const made = makeService();
    const tool = createAgentTool(made.service);
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };

    expect(tool.name).toBe('agent');
    expect(schema.required).toEqual(['action']);
    // root owner 没有 Team，不暴露 create。
    expect((schema.properties.action as { enum: string[] }).enum).toEqual([
      'hire',
      'send',
      'close',
      'list',
      'rotate',
      'post',
    ]);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'action',
      'content',
      'member',
      'members',
      'messages',
      'model',
      'name',
      'parent_id',
      'startup_prompt',
      'state',
      'system_prompt',
      'to',
      'visibility',
    ]);
    expect('handoff_path' in schema.properties).toBe(false);
    expect(tool.description).not.toContain('handoff_path');
    expect(`${tool.description} ${JSON.stringify(schema)}`).not.toMatch(
      /\b(wait|inbox|status|cancel)\b/i,
    );
  });

  it('member body callers can create peers in their team; close is governed by checkPermission', async () => {
    const made = makeService({ teamBinder: makeBinder(makeTeamRecord(TEAM_ID)) });
    const tool = createAgentTool(made.service, {
      ownerId: 'main',
      ownerSessionId: 'owner-session',
    });
    const caller = await made.service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'lead',
      spawnedBy: 'main',
    });
    const events: AgentEvent[] = [];
    made.service.subscribe((event) => events.push(event));

    const created = parse<MemberStatus>(
      await callAs(tool, { action: 'create', name: 'worker' }, caller.session_id),
    );
    expect(created.owner).toBeUndefined();
    expect(created.parent_id).toBeUndefined();
    expect(created.team_id).toBe(TEAM_ID);
    expect(created.visibility).toBe('team');
    expect(
      events.find((event) => event.type === 'agent.spawned' && event.agent_id === created.id)
        ?.spawned_by,
    ).toBe(caller.id);

    const hired = parse<MemberStatus>(
      await callAs(tool, { action: 'hire', name: 'sub' }, caller.session_id),
    );
    expect(hired.owner).toBe(caller.id);
    expect(hired.parent_id).toBe(caller.id);
    expect(hired.team_id).toBe(TEAM_ID);
    expect(hired.visibility).toBe('team');

    const rotated = await callAs(
      tool,
      { action: 'rotate', startup_prompt: 'continue' },
      caller.session_id,
    );
    expect(rotated).toContain('"status":"rotated"');
    expect(rotated).toContain('rotation committed; finish the current turn');
    expect(rotated).not.toContain('continue"');

    // close 已开放给成员；关闭 peer 时权限层要求人类审批（handler 本身不拦截）。
    expect(
      await tool.checkPermission?.(
        { action: 'close', member: created.id },
        makeContext(caller.session_id),
      ),
    ).toBe('ask');

    // 没有注入 team 时，成员侧的 send / list 明确报错而不是回落到 owner 路径。
    expect(await callAs(tool, { action: 'send', to: created.id, content: 'x' }, 'body-2')).toBe(
      'Error: invalid_input: send requires a team service',
    );
    expect(await callAs(tool, { action: 'list' }, 'body-2')).toBe(
      'Error: invalid_input: list requires a team service',
    );
  });

  it('member without a team gets no_team for create and hire', async () => {
    const made = makeService();
    const tool = createAgentTool(made.service, {
      ownerId: 'main',
      ownerSessionId: 'owner-session',
    });
    // root hire 默认 unbound（没有 Team）。
    const member = parse<MemberStatus>(
      await callAs(tool, { action: 'hire', name: 'loner' }, 'owner-session'),
    );

    expect(await callAs(tool, { action: 'create', name: 'x' }, member.session_id)).toMatch(
      /^Error: invalid_input: no_team: /,
    );
    expect(await callAs(tool, { action: 'hire', name: 'y' }, member.session_id)).toMatch(
      /^Error: invalid_input: no_team: /,
    );
    expect(made.runtime.spawned.map((entry) => entry.name)).toEqual(['loner']);
  });

  it('batch create isolates a per-entry failure for a team member', async () => {
    const made = makeService({ teamBinder: makeBinder(makeTeamRecord(TEAM_ID)) });
    const tool = createAgentTool(made.service, {
      ownerId: 'main',
      ownerSessionId: 'owner-session',
    });
    const caller = await made.service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'lead',
      spawnedBy: 'main',
    });

    const { results } = parse<{ results: BatchItemResult<MemberStatus>[] }>(
      await callAs(
        tool,
        {
          action: 'create',
          members: [{ name: 'first' }, { visibility: 'private' }, { name: 'third' }],
        },
        caller.session_id,
      ),
    );

    expect(results.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(failureText(results[1])).toContain('team visibility');
    expect(results[0]?.ok ? results[0].status.name : undefined).toBe('first');
    expect(results[2]?.ok ? results[2].status.name : undefined).toBe('third');
    expect(results[0]?.ok ? results[0].status.team_id : undefined).toBe(TEAM_ID);
  });

  it('owner send uses the unified dispatch path instead of strict send', async () => {
    const made = makeService();
    const dispatched: DispatchInput[] = [];
    const dispatch = made.service.dispatch.bind(made.service);
    made.service.dispatch = async (input) => {
      dispatched.push(input);
      return dispatch(input);
    };
    let strictSendCalls = 0;
    made.service.send = (async () => {
      strictSendCalls += 1;
      throw new Error('strict send must not be used');
    }) as unknown as AgentService['send'];

    const tool = createAgentTool(made.service);
    const created = parse<MemberStatus>(await call(tool, { action: 'hire', name: 'worker' }));

    const result = parse<DispatchResult>(
      await call(tool, { action: 'send', to: created.id, content: 'go' }),
    );

    expect(result.status).toBe('queued');
    expect(dispatched).toEqual([{ to: created.id, content: 'go', from: 'main' }]);
    expect(strictSendCalls).toBe(0);
  });

  it('body send goes through team.send with the caller session and never touches AgentService', async () => {
    const made = makeService();
    const { team, calls } = makeTeam();
    let serviceTouched = 0;
    made.service.send = (async () => {
      serviceTouched += 1;
      throw new Error('strict send must not be used');
    }) as unknown as AgentService['send'];
    const dispatch = made.service.dispatch.bind(made.service);
    made.service.dispatch = async (input) => {
      serviceTouched += 1;
      return dispatch(input);
    };

    const tool = createAgentTool(made.service, {
      ownerId: 'main',
      ownerSessionId: 'owner-session',
      team,
    });

    const result = parse<TeamAgentSendResult>(
      await callAs(tool, { action: 'send', to: 'worker', content: 'hi' }, 'body-session'),
    );

    expect(result.status).toBe('queued');
    expect(calls.send).toEqual([{ from_session_id: 'body-session', to: 'worker', content: 'hi' }]);
    expect(serviceTouched).toBe(0);
  });

  it('body list uses listForCaller and post writes the team log without mentions or dispatch', async () => {
    const made = makeService();
    const roster: TeamMemberSummary[] = [
      {
        agent_id: 'worker',
        name: 'worker',
        session_id: 'body-session',
        membership: 'present',
        presence: 'live',
        visibility: 'team',
        state: 'idle',
        epoch: 0,
      },
      {
        agent_id: 'other',
        name: 'other',
        session_id: 'body-other',
        membership: 'present',
        presence: 'live',
        visibility: 'private',
        state: 'running',
        epoch: 0,
      },
    ];
    const { team, calls } = makeTeam(roster);
    let dispatched = 0;
    made.service.dispatch = async () => {
      dispatched += 1;
      throw new Error('list/post must not dispatch');
    };

    const tool = createAgentTool(made.service, {
      ownerId: 'main',
      ownerSessionId: 'owner-session',
      team,
    });

    const listed = parse<TeamMemberSummary[]>(
      await callAs(
        tool,
        { action: 'list', visibility: 'team', state: 'idle', parent_id: 'ignored' },
        'body-session',
      ),
    );
    expect(calls.listForCaller).toEqual(['body-session']);
    expect(listed.map((entry) => entry.agent_id)).toEqual(['worker']);

    const posted = parse<TeamPostResult>(
      await callAs(tool, { action: 'post', content: 'status update' }, 'body-session'),
    );
    expect(posted.message_id).toBe('msg-1');
    expect(calls.identify).toEqual(['body-session']);
    expect(calls.post).toEqual([{ team_id: 'team-1', content: 'status update', from: 'worker' }]);
    expect('mentions' in (calls.post[0] ?? {})).toBe(false);
    expect(dispatched).toBe(0);
  });

  it('batch send maps a rejected dispatch to an error entry without aborting the others', async () => {
    const made = makeService();
    const order: string[] = [];
    made.service.dispatch = async (input) => {
      order.push(input.to);
      if (input.to === 'bad') {
        return { status: 'rejected', code: 'agent_left', reason: 'agent_left: bad' };
      }
      return {
        status: 'queued',
        message_id: `msg-${input.to}`,
        resolved_to: input.to,
        resolution: 'live',
      };
    };

    const tool = createAgentTool(made.service);
    const { results } = parse<{ results: BatchItemResult<DispatchResult>[] }>(
      await call(tool, {
        action: 'send',
        messages: [
          { to: 'a', content: 'x' },
          { to: 'bad', content: 'y' },
          { to: 'c', content: 'z' },
        ],
      }),
    );

    expect(results.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(failureText(results[1])).toContain('agent_left');
    expect(order).toEqual(['a', 'bad', 'c']);
  });

  it('owner keeps hire/send/close/list but cannot create', async () => {
    const made = makeService();
    await made.service.attachOwner({ id: 'main', sessionId: 'owner-session' });
    const tool = createAgentTool(made.service, {
      ownerId: 'main',
      ownerSessionId: 'owner-session',
    });

    expect(await callAs(tool, { action: 'create', name: 'peer' }, 'owner-session')).toBe(
      'Error: invalid_input: create requires a team member caller; owner should use hire',
    );
    const created = parse<MemberStatus>(
      await callAs(tool, { action: 'hire', name: 'plain' }, 'owner-session'),
    );
    expect(created.owner).toBe('main');
    expect(
      parse<DispatchResult>(
        await callAs(tool, { action: 'send', to: created.id, content: 'work' }, 'owner-session'),
      ).status,
    ).toBe('queued');
    expect(
      parse(await callAs(tool, { action: 'close', member: created.id }, 'owner-session')),
    ).toEqual({ state: 'closed' });
    expect(
      parse<MemberStatus[]>(await callAs(tool, { action: 'list' }, 'owner-session')).map(
        (entry) => entry.id,
      ),
    ).toContain(created.id);
  });
});

describe('agent tool close permission', () => {
  function setupTeams() {
    const made = makeService({
      teamBinder: makeBinder(makeTeamRecord(TEAM_ID), makeTeamRecord('beta')),
    });
    const tool = createAgentTool(made.service, {
      ownerId: 'main',
      ownerSessionId: 'owner-session',
    });
    return { service: made.service, tool };
  }

  async function decide(
    tool: ToolDefinition,
    args: unknown,
    sessionId: string,
  ): Promise<'allow' | 'deny' | 'ask' | undefined> {
    return tool.checkPermission?.(args, makeContext(sessionId));
  }

  it('asks when a member closes a peer', async () => {
    const { service, tool } = setupTeams();
    const caller = await service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'lead',
      spawnedBy: 'main',
    });
    const peer = await service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'peer',
      spawnedBy: caller.id,
    });

    expect(await decide(tool, { action: 'close', member: peer.id }, caller.session_id)).toBe('ask');
  });

  it('allows a member to close its own contractor', async () => {
    const { service, tool } = setupTeams();
    const caller = await service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'lead',
      spawnedBy: 'main',
    });
    const contractor = await service.create({
      kind: 'contractor',
      owner: caller.id,
      teamId: TEAM_ID,
      name: 'sub',
      spawnedBy: caller.id,
    });

    expect(await decide(tool, { action: 'close', member: contractor.id }, caller.session_id)).toBe(
      'allow',
    );
  });

  it('allows a member to self-close', async () => {
    const { service, tool } = setupTeams();
    const caller = await service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'lead',
      spawnedBy: 'main',
    });

    expect(await decide(tool, { action: 'close', member: caller.id }, caller.session_id)).toBe(
      'allow',
    );
  });

  it('denies a member closing a contractor from another team', async () => {
    const { service, tool } = setupTeams();
    const caller = await service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'lead',
      spawnedBy: 'main',
    });
    const foreign = await service.create({
      kind: 'contractor',
      owner: 'other-lead',
      teamId: 'beta',
      name: 'foreign',
      spawnedBy: 'other-lead',
    });

    expect(await decide(tool, { action: 'close', member: foreign.id }, caller.session_id)).toBe(
      'deny',
    );
  });

  it('denies a member closing the root owner record', async () => {
    const { service, tool } = setupTeams();
    await service.attachOwner({ id: 'main', sessionId: 'owner-session' });
    const caller = await service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'lead',
      spawnedBy: 'main',
    });

    expect(await decide(tool, { action: 'close', member: 'main' }, caller.session_id)).toBe('deny');
  });

  it('allows the owner invocation without member lookups', async () => {
    const { service, tool } = setupTeams();
    const contractor = await service.create({
      kind: 'contractor',
      owner: 'main',
      name: 'sub',
      spawnedBy: 'main',
    });

    expect(
      await tool.checkPermission?.(
        { action: 'close', member: contractor.id },
        makeContext('owner-session'),
      ),
    ).toBe('allow');
    expect(
      await tool.checkPermission?.({ action: 'close', member: contractor.id }, makeContext()),
    ).toBe('allow');
  });

  it('asks once for a batch that mixes a peer with a contractor', async () => {
    const { service, tool } = setupTeams();
    const caller = await service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'lead',
      spawnedBy: 'main',
    });
    const contractor = await service.create({
      kind: 'contractor',
      owner: caller.id,
      teamId: TEAM_ID,
      name: 'sub',
      spawnedBy: caller.id,
    });
    const peer = await service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'peer',
      spawnedBy: caller.id,
    });

    expect(
      await decide(tool, { action: 'close', members: [contractor.id, peer.id] }, caller.session_id),
    ).toBe('ask');
  });

  it('keeps peer close at ask so autoApprove cannot lift it', async () => {
    const { service, tool } = setupTeams();
    const caller = await service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'lead',
      spawnedBy: 'main',
    });
    const peer = await service.create({
      kind: 'peer',
      teamId: TEAM_ID,
      name: 'peer',
      spawnedBy: caller.id,
    });

    // The explicit tool ask is preserved regardless of autoApprove config.
    expect(await decide(tool, { action: 'close', member: peer.id }, caller.session_id)).toBe('ask');
  });
});
