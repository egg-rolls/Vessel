import { describe, expect, it } from 'bun:test';
import { MemoryEventStream, type ToolContext, type ToolDefinition } from '@vessel-agent/core';
import {
  type AgentService,
  type AgentTeamService,
  type BatchItemResult,
  createAgentTool,
  createTeamService,
  type FederationSendPort,
  type FederationSendRequest,
  type FederationSendResult,
  type TeamAgentSendInput,
  type TeamAgentSendResult,
  type TeamMemberSummary,
  type TeamPostInput,
  type TeamPostResult,
} from '../src/index.js';
import { FakeTeamAgent, MemoryTeamStore, makeMember, makeService, makeTeam } from './helpers.js';

/** 记录调用的假跨节点端口；默认返回 queued。 */
class FakeFederationPort implements FederationSendPort {
  readonly nodeId = 'node-a';
  readonly calls: FederationSendRequest[] = [];
  result: FederationSendResult = { status: 'queued', message_id: 'fed-1' };

  async send(input: FederationSendRequest): Promise<FederationSendResult> {
    this.calls.push(input);
    return this.result;
  }
}

function makeSendHarness(federation?: FederationSendPort) {
  const agent = new FakeTeamAgent([]);
  const store = new MemoryTeamStore([makeTeam('alpha')]);
  let counter = 0;
  const service = createTeamService({
    tenantId: 'default',
    agent: agent as unknown as AgentService,
    store,
    newId: () => `team-${++counter}`,
    ...(federation !== undefined ? { federation } : {}),
  });
  return { service, agent, store };
}

function makeContext(sessionId?: string): ToolContext {
  return {
    run_id: 'tool-test',
    messages: [],
    events: new MemoryEventStream(),
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
  };
}

function call(tool: ToolDefinition, args: unknown, sessionId?: string): Promise<string> {
  return tool.handler(args, makeContext(sessionId));
}

function parse<T>(text: string): T {
  return JSON.parse(text) as T;
}

/** 记录 send / post 的假 TeamService（owner 地址形式不得触碰它） */
function makeRecordingTeam(): { team: AgentTeamService; sendCalls: TeamAgentSendInput[] } {
  const sendCalls: TeamAgentSendInput[] = [];
  const roster: TeamMemberSummary[] = [];
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
    async list() {
      return [];
    },
    async get() {
      return undefined;
    },
    async roster() {
      return roster;
    },
    async post(input: TeamPostInput): Promise<TeamPostResult> {
      return {
        message_id: 'post-1',
        team_id: input.team_id,
        kind: 'post',
        mentions: [],
        delivered: [],
        ts: 1,
      };
    },
    async members() {
      return undefined;
    },
    async send(input) {
      sendCalls.push(input);
      return {
        status: 'rejected',
        code: 'federation_invalid',
        reason: 'fake team',
        logged: false,
      };
    },
    async listForCaller() {
      return roster;
    },
    async identify() {
      return undefined;
    },
    subscribe: () => () => {},
    dispose() {},
  };
  return { team, sendCalls };
}

describe('TeamService.send federated address', () => {
  it('fills from from the caller identity and maps queued to a batch-ready result', async () => {
    const port = new FakeFederationPort();
    const { service, agent, store } = makeSendHarness(port);
    agent.members.push(
      makeMember({ id: 'a', name: 'alice', team_id: 'alpha', session_id: 'session-a' }),
    );
    agent.currentConversations.set('a', 'conv-inherited');

    const result = await service.send({
      from_session_id: 'session-a',
      to: 'bob@node-b:beta',
      content: 'hello bob',
    });

    expect(result).toEqual({
      status: 'queued',
      resolved_to: 'bob@node-b:beta',
      message_id: 'fed-1',
      logged: false,
      conversation_id: 'conv-inherited',
    });
    expect(port.calls).toEqual([
      {
        from: 'alice@node-a:alpha',
        to: 'bob@node-b:beta',
        content: 'hello bob',
        conversation_id: 'conv-inherited',
      },
    ]);
    // 跨节点发送不写本地 Team 日志、不 dispatch。
    expect(store.logs).toHaveLength(0);
    expect(agent.dispatches).toHaveLength(0);
  });

  it('keeps an explicit conversation_id and does not resolve @ values as local names', async () => {
    const port = new FakeFederationPort();
    const { service, agent, store } = makeSendHarness(port);
    agent.members.push(
      makeMember({ id: 'a', name: 'alice', team_id: 'alpha', session_id: 'session-a' }),
    );
    agent.currentConversations.set('a', 'conv-inherited');

    const result = await service.send({
      from_session_id: 'session-a',
      to: 'alice@node-b:beta',
      content: 'to myself elsewhere',
      conversation_id: 'conv-explicit',
    });

    expect(result.status).toBe('queued');
    expect(result.conversation_id).toBe('conv-explicit');
    // `alice` 是本地 name，但含 @ 的值仍按地址处理。
    expect(port.calls[0]?.to).toBe('alice@node-b:beta');
    expect(store.logs).toHaveLength(0);
    expect(agent.dispatches).toHaveLength(0);
  });

  it('maps rejected and error port results without logging', async () => {
    const port = new FakeFederationPort();
    const { service, agent, store } = makeSendHarness(port);
    agent.members.push(
      makeMember({ id: 'a', name: 'alice', team_id: 'alpha', session_id: 'session-a' }),
    );

    port.result = {
      status: 'rejected',
      code: 'federation_unknown_principal',
      reason: 'unknown principal',
    };
    const rejected = await service.send({
      from_session_id: 'session-a',
      to: 'ghost@node-b:beta',
      content: 'hi',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.code).toBe('federation_unknown_principal');
    expect(rejected.reason).toBe('unknown principal');
    expect(rejected.logged).toBe(false);
    expect(rejected.conversation_id).toBeDefined();

    port.result = { status: 'error', code: 'federation_error', reason: 'boom' };
    const failed = await service.send({
      from_session_id: 'session-a',
      to: 'bob@node-b:beta',
      content: 'hi',
    });
    expect(failed).toEqual({
      status: 'error',
      code: 'federation_error',
      reason: 'boom',
      logged: false,
      conversation_id: failed.conversation_id,
    });
    expect(port.calls).toHaveLength(2);
    expect(store.logs).toHaveLength(0);
    expect(agent.dispatches).toHaveLength(0);
  });

  it('rejects address sends without team / with left membership / without a name', async () => {
    const port = new FakeFederationPort();
    const { service, agent } = makeSendHarness(port);
    agent.members.push(
      makeMember({ id: 'd', name: 'dave', session_id: 'session-d' }),
      makeMember({
        id: 'e',
        name: 'eve',
        team_id: 'alpha',
        membership: 'left',
        session_id: 'session-e',
      }),
      makeMember({ id: 'f', team_id: 'alpha', session_id: 'session-f' }),
    );

    const noTeam = await service.send({
      from_session_id: 'session-d',
      to: 'bob@node-b:beta',
      content: 'hi',
    });
    expect(noTeam).toMatchObject({ status: 'error', code: 'no_team', logged: false });

    const left = await service.send({
      from_session_id: 'session-e',
      to: 'bob@node-b:beta',
      content: 'hi',
    });
    expect(left).toMatchObject({ status: 'error', code: 'member_left', logged: false });

    const noName = await service.send({
      from_session_id: 'session-f',
      to: 'bob@node-b:beta',
      content: 'hi',
    });
    expect(noName).toMatchObject({ status: 'error', code: 'no_name', logged: false });

    // 三个前置失败都不发请求。
    expect(port.calls).toHaveLength(0);
  });

  it('returns federation_unavailable when no port is injected', async () => {
    const { service, agent } = makeSendHarness();
    agent.members.push(
      makeMember({ id: 'a', name: 'alice', team_id: 'alpha', session_id: 'session-a' }),
    );

    const result = await service.send({
      from_session_id: 'session-a',
      to: 'bob@node-b:beta',
      content: 'hi',
    });

    expect(result).toMatchObject({
      status: 'error',
      code: 'federation_unavailable',
      logged: false,
    });
  });

  it('keeps existing validation order before the address branch', async () => {
    const port = new FakeFederationPort();
    const { service, agent } = makeSendHarness(port);
    agent.members.push(
      makeMember({
        id: 'e',
        name: 'eve',
        team_id: 'alpha',
        membership: 'left',
        session_id: 'session-e',
      }),
    );

    const empty = await service.send({
      from_session_id: 'session-e',
      to: 'bob@node-b:beta',
      content: '',
    });
    expect(empty).toMatchObject({ status: 'error', code: 'invalid_input', logged: false });

    const badConversation = await service.send({
      from_session_id: 'session-e',
      to: 'bob@node-b:beta',
      content: 'hi',
      conversation_id: 'bad id',
    });
    expect(badConversation).toMatchObject({
      status: 'error',
      code: 'invalid_input',
      logged: false,
    });

    const unknown = await service.send({
      from_session_id: 'missing',
      to: 'bob@node-b:beta',
      content: 'hi',
    });
    expect(unknown).toMatchObject({ status: 'error', code: 'unknown_member' });
    expect(port.calls).toHaveLength(0);
  });
});

describe('agent tool send with federated addresses', () => {
  it('owner address form returns no_team without dispatch or port calls', async () => {
    const made = makeService();
    const { team, sendCalls } = makeRecordingTeam();
    const port = new FakeFederationPort();
    const tool = createAgentTool(made.service, {
      ownerId: 'main',
      ownerSessionId: 'owner-session',
      team,
    });

    const result = parse<TeamAgentSendResult>(
      await call(tool, { action: 'send', to: 'bob@node-b:beta', content: 'hi' }, 'owner-session'),
    );

    expect(result).toMatchObject({ status: 'rejected', code: 'no_team', logged: false });
    expect(result.reason).toContain('vessel federation post');
    expect(sendCalls).toHaveLength(0);
    expect(port.calls).toHaveLength(0);
  });

  it('owner batch maps the address entry to an error and keeps local entries', async () => {
    const made = makeService();
    const { team, sendCalls } = makeRecordingTeam();
    const port = new FakeFederationPort();
    const created = await made.service.new({ name: 'worker' });
    const tool = createAgentTool(made.service, {
      ownerId: 'main',
      ownerSessionId: 'owner-session',
      team,
    });

    const result = parse<{ results: BatchItemResult<TeamAgentSendResult>[] }>(
      await call(
        tool,
        {
          action: 'send',
          messages: [
            { to: 'bob@node-b:beta', content: 'hi' },
            { to: created.id, content: 'go' },
          ],
        },
        'owner-session',
      ),
    );

    expect(result.results[0]).toEqual({
      ok: false,
      error:
        'no_team: owner has no local team; use vessel federation post --from human@<node>:<team>',
    });
    expect(result.results[1]?.ok).toBe(true);
    expect(sendCalls).toHaveLength(0);
    expect(port.calls).toHaveLength(0);
  });

  it('member bodies pass address forms to team.send unchanged', async () => {
    const made = makeService();
    const { team, sendCalls } = makeRecordingTeam();
    const tool = createAgentTool(made.service, {
      ownerId: 'main',
      ownerSessionId: 'owner-session',
      team,
    });

    const result = parse<TeamAgentSendResult>(
      await call(tool, { action: 'send', to: 'bob@node-b:beta', content: 'hi' }, 'body-session'),
    );

    expect(result.status).toBe('rejected');
    expect(sendCalls).toEqual([
      { from_session_id: 'body-session', to: 'bob@node-b:beta', content: 'hi' },
    ]);
  });

  it('does not accept a model-supplied from field', async () => {
    const made = makeService();
    const { team, sendCalls } = makeRecordingTeam();
    const tool = createAgentTool(made.service, {
      ownerId: 'main',
      ownerSessionId: 'owner-session',
      team,
    });

    await call(
      tool,
      { action: 'send', to: 'bob@node-b:beta', content: 'hi', from: 'evil@node-x:beta' },
      'body-session',
    );

    expect(sendCalls[0]).toEqual({
      from_session_id: 'body-session',
      to: 'bob@node-b:beta',
      content: 'hi',
    });
  });
});
