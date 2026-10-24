/**
 * `vessel attention` 的契约测试（0.22 S9.1）。
 *
 * 用注入的 fake target 走完整命令路径；不启动真实 gateway。
 *
 * @module vessel/__tests__
 */

import { describe, expect, it } from 'bun:test';
import type { AttentionInteraction } from '../attention-client';
import type { AttentionCommandArgs } from '../cli-args';
import { attentionCommand } from '../commands/attention';
import type { ControlPlaneTarget } from '../control-plane-target';
import { RpcClientError } from '../rpc';

interface Call {
  method: string;
  params?: unknown;
}

type FakeTarget = ControlPlaneTarget & { calls: Call[] };

function fakeTarget(
  handler: (method: string, params?: unknown) => unknown | Promise<unknown>,
): FakeTarget {
  const calls: Call[] = [];
  return {
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8642',
    token: 'super-secret-token',
    calls,
    request: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, ...(params !== undefined ? { params } : {}) });
      return (await handler(method, params)) as T;
    },
    close: async () => undefined,
  };
}

function command(overrides: Partial<AttentionCommandArgs> = {}): AttentionCommandArgs {
  return {
    kind: 'list',
    status: 'pending',
    limit: 20,
    json: true,
    interactive: false,
    all: false,
    remember: false,
    yes: false,
    ...overrides,
  };
}

function options(target: ControlPlaneTarget) {
  return {
    target,
    config: { dataDir: '.' },
    dataDir: '.',
    tenantId: 'default',
    isTTY: false,
  };
}

function interaction(overrides: Partial<AttentionInteraction> = {}): AttentionInteraction {
  return {
    kind: 'permission',
    request_id: 'r1',
    run_id: 'run-1',
    agent_id: 'agent-1',
    team_id: 'alpha',
    tool: 'bash',
    created_at: Date.parse('2026-10-24T10:00:00.000Z'),
    status: 'pending',
    ...overrides,
  };
}

function page(interactions: AttentionInteraction[], total = interactions.length) {
  return { interactions, total };
}

describe('vessel attention --to', () => {
  it('rejects a node mismatch before listing or responding', async () => {
    const target = fakeTarget((method) => {
      if (method === 'health.get') return { node: { node_id: 'node-b' } };
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(
      command({ to: 'human@node-a:alpha', json: false }),
      options(target),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('federation_target_mismatch');
    const methods = target.calls.map((call) => call.method);
    expect(methods).toEqual(['health.get']);
  });
});

describe('vessel attention --agent', () => {
  it('sends the resolved name as agent_id and keeps the server page total', async () => {
    const target = fakeTarget((method) => {
      if (method === 'interactions.list') {
        return {
          interactions: [interaction({ request_id: 'r2', agent_id: 'agent-2' })],
          total: 2,
          next_cursor: 'cursor-2',
        };
      }
      if (method === 'teams.get') {
        return { members: [{ agent_id: 'agent-2', name: 'worker', membership: 'present' }] };
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(
      command({ agent: 'worker', teamId: 'alpha', json: true }),
      options(target),
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      interactions: Array<{ request_id: string }>;
      total: number;
      next_cursor?: string;
    };
    expect(payload.interactions.map((entry) => entry.request_id)).toEqual(['r2']);
    // total / next_cursor 由服务端过滤后给出，客户端不得按本页重算。
    expect(payload.total).toBe(2);
    expect(payload.next_cursor).toBe('cursor-2');
    const listCall = target.calls.find((call) => call.method === 'interactions.list');
    expect((listCall?.params as { agent_id?: string } | undefined)?.agent_id).toBe('agent-2');
  });

  it('passes an unresolved name through as the agent id', async () => {
    const target = fakeTarget((method) => {
      if (method === 'interactions.list') return page([], 0);
      if (method === 'teams.get') return { members: [] };
      if (method === 'agents.list') return { agents: [] };
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(
      command({ agent: 'nobody', teamId: 'alpha', json: true }),
      options(target),
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      interactions: Array<{ request_id: string }>;
      total: number;
    };
    expect(payload.interactions).toEqual([]);
    expect(payload.total).toBe(0);
    const listCall = target.calls.find((call) => call.method === 'interactions.list');
    expect((listCall?.params as { agent_id?: string } | undefined)?.agent_id).toBe('nobody');
  });

  it('selects indexes on the server-filtered page', async () => {
    const target = fakeTarget((method) => {
      if (method === 'interactions.list') {
        return page([interaction({ request_id: 'r2', agent_id: 'agent-2' })], 1);
      }
      if (method === 'teams.get') {
        return { members: [{ agent_id: 'agent-2', name: 'worker', membership: 'present' }] };
      }
      if (method === 'permission.respond') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(
      command({
        kind: 'respond',
        select: [1],
        decision: 'allow',
        yes: true,
        agent: 'worker',
        teamId: 'alpha',
        json: false,
      }),
      options(target),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK r2 allow');
    const listCall = target.calls.find((call) => call.method === 'interactions.list');
    expect((listCall?.params as { agent_id?: string } | undefined)?.agent_id).toBe('agent-2');
  });
});

describe('vessel attention respond status', () => {
  it('refuses orphaned status instead of answering a pending row by index', async () => {
    const target = fakeTarget((method) => {
      if (method === 'interactions.list') return page([interaction({ request_id: 'p1' })]);
      if (method === 'permission.respond') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(
      command({
        kind: 'respond',
        status: 'orphaned',
        select: [1],
        decision: 'allow',
        yes: true,
        json: false,
      }),
      options(target),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('pending');
    // 不得发任何 RPC：否则 orphaned 列表的第 1 条会批准另一条 pending。
    expect(target.calls).toEqual([]);
  });
});

describe('vessel attention agent resolution', () => {
  it('never calls agents.list for a pure id under a team token', async () => {
    const target = fakeTarget((method) => {
      if (method === 'teams.get') {
        return { members: [{ agent_id: 'agent-1', name: 'worker', membership: 'present' }] };
      }
      if (method === 'interactions.list') return page([], 0);
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(
      command({ agent: 'agent-1', teamId: 'alpha', json: true }),
      options(target),
    );

    expect(result.exitCode).toBe(0);
    expect(target.calls.some((call) => call.method === 'agents.list')).toBe(false);
    const listCall = target.calls.find((call) => call.method === 'interactions.list');
    expect((listCall?.params as { agent_id?: string } | undefined)?.agent_id).toBe('agent-1');
  });

  it('a 403 roster lookup falls back to the pure id instead of a token error', async () => {
    const target = fakeTarget((method) => {
      if (method === 'teams.get') {
        throw new RpcClientError('forbidden', 'insufficient scope', { httpStatus: 403 });
      }
      if (method === 'interactions.list') return page([], 0);
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(
      command({ agent: 'agent-1', teamId: 'alpha', json: true }),
      options(target),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const listCall = target.calls.find((call) => call.method === 'interactions.list');
    expect((listCall?.params as { agent_id?: string } | undefined)?.agent_id).toBe('agent-1');
  });

  it('a 401 roster lookup still stops as an auth failure', async () => {
    const target = fakeTarget((method) => {
      if (method === 'teams.get') {
        throw new RpcClientError('unauthorized', 'bad token', { httpStatus: 401 });
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(
      command({ agent: 'agent-1', teamId: 'alpha', json: true }),
      options(target),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('human control token');
    expect(target.calls.some((call) => call.method === 'interactions.list')).toBe(false);
  });
});

describe('vessel attention respond', () => {
  it('continues after a failing item and exits 1 when any item fails', async () => {
    const target = fakeTarget((method, params) => {
      if (method === 'interactions.list') {
        return page([interaction({ request_id: 'r1' }), interaction({ request_id: 'r2' })]);
      }
      if (method === 'permission.respond') {
        const requestId = (params as { request_id?: string }).request_id;
        if (requestId === 'r2') throw new RpcClientError('conflict', 'already answered');
        return { ok: true };
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(
      command({ kind: 'respond', select: [1, 2], decision: 'allow', yes: true, json: false }),
      options(target),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('OK r1 allow');
    expect(result.stdout).toContain('FAIL r2 conflict: already answered');
    const responded = target.calls
      .filter((call) => call.method === 'permission.respond')
      .map((call) => (call.params as { request_id: string }).request_id);
    expect(responded).toEqual(['r1', 'r2']);
  });

  it('answers a permission through permission.respond with answered_via cli', async () => {
    const target = fakeTarget((method) => {
      if (method === 'interactions.list') {
        return page([interaction({ kind: 'permission', request_id: 'r1' })]);
      }
      if (method === 'permission.respond') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(
      command({
        kind: 'respond',
        requestId: 'r1',
        decision: 'deny',
        remember: true,
        json: false,
      }),
      options(target),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('OK r1 deny');
    const call = target.calls.find((entry) => entry.method === 'permission.respond');
    expect(call?.params).toEqual({
      request_id: 'r1',
      decision: 'deny',
      remember: true,
      answered_via: 'cli',
    });
  });

  it('answers an ask through ask.respond with answered_via cli', async () => {
    const target = fakeTarget((method) => {
      if (method === 'interactions.list') {
        return page([interaction({ kind: 'ask', request_id: 'a1', tool: undefined })]);
      }
      if (method === 'ask.respond') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(
      command({
        kind: 'respond',
        requestId: 'a1',
        answers: [{ question: 'ok?', answer: 'yes' }],
        json: false,
      }),
      options(target),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('OK a1 answers');
    const call = target.calls.find((entry) => entry.method === 'ask.respond');
    expect(call?.params).toEqual({
      request_id: 'a1',
      answers: [{ question: 'ok?', answer: 'yes' }],
      answered_via: 'cli',
    });
  });

  it('caps --all at 200 responses and reports truncation', async () => {
    const pages = new Map<
      string,
      { interactions: AttentionInteraction[]; total: number; next_cursor?: string }
    >();
    pages.set('', {
      interactions: Array.from({ length: 100 }, (_, index) =>
        interaction({ request_id: `p${index + 1}` }),
      ),
      total: 300,
      next_cursor: 'c2',
    });
    pages.set('c2', {
      interactions: Array.from({ length: 100 }, (_, index) =>
        interaction({ request_id: `p${index + 101}` }),
      ),
      total: 300,
      next_cursor: 'c3',
    });
    pages.set('c3', {
      interactions: Array.from({ length: 100 }, (_, index) =>
        interaction({ request_id: `p${index + 201}` }),
      ),
      total: 300,
    });

    const target = fakeTarget((method, params) => {
      if (method === 'interactions.list') {
        const cursor = (params as { cursor?: string }).cursor ?? '';
        const result = pages.get(cursor);
        if (result === undefined) throw new Error(`unexpected cursor: ${cursor}`);
        return result;
      }
      if (method === 'permission.respond') return { ok: true };
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(
      command({ kind: 'respond', all: true, decision: 'allow', yes: true, json: false }),
      options(target),
    );

    expect(result.exitCode).toBe(0);
    expect(target.calls.filter((call) => call.method === 'permission.respond').length).toBe(200);
    expect(
      target.calls.some(
        (call) =>
          call.method === 'interactions.list' &&
          (call.params as { cursor?: string }).cursor === 'c3',
      ),
    ).toBe(false);
    expect(result.stderr).toContain('200');
  });
});

interface NodeSpec {
  name: string;
  url: string;
  tokenEnv?: string;
  nodeId?: string;
}

function multiNodeOptions(input: {
  nodes: NodeSpec[];
  env: Record<string, string | undefined>;
  factory: (node: NodeSpec, token: string) => FakeTarget;
}) {
  return {
    config: { dataDir: '.', attention: { nodes: input.nodes } },
    env: input.env,
    dataDir: '.',
    tenantId: 'default',
    isTTY: false,
    nodeTargetFactory: (node: NodeSpec, token: string) => input.factory(node, token),
  };
}

describe('vessel attention multi-node', () => {
  it('keeps the healthy node and its own token when another node returns 401', async () => {
    const factoryTokens: Record<string, string> = {};
    const factory = (node: NodeSpec, token: string) => {
      factoryTokens[node.name] = token;
      return fakeTarget((method) => {
        if (method !== 'interactions.list') throw new Error(`unexpected ${method}`);
        if (node.name === 'beta') {
          throw new RpcClientError('unauthorized', 'invalid gateway token', { httpStatus: 401 });
        }
        return page([interaction({ request_id: 'r-alpha' })], 1);
      });
    };

    const result = await attentionCommand(
      command({ allNodes: true, json: true }),
      multiNodeOptions({
        nodes: [
          { name: 'alpha', url: 'https://alpha.example', tokenEnv: 'ALPHA_TOKEN' },
          { name: 'beta', url: 'https://beta.example', tokenEnv: 'BETA_TOKEN' },
        ],
        env: { ALPHA_TOKEN: 'token-alpha', BETA_TOKEN: 'token-beta' },
        factory,
      }),
    );

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      nodes: Array<{
        name: string;
        ok: boolean;
        interactions?: Array<{ request_id: string }>;
        total?: number;
        error?: string;
      }>;
    };
    expect(payload.nodes.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
    expect(payload.nodes[0]?.ok).toBe(true);
    expect(payload.nodes[0]?.interactions?.map((item) => item.request_id)).toEqual(['r-alpha']);
    expect(payload.nodes[0]?.total).toBe(1);
    // beta 的 401 只属于 beta 分组。
    expect(payload.nodes[1]?.ok).toBe(false);
    expect(payload.nodes[1]?.error).toContain('unauthorized');
    // 每节点只用自己的 token。
    expect(factoryTokens).toEqual({ alpha: 'token-alpha', beta: 'token-beta' });
    expect(result.stdout).not.toContain('token-alpha');
    expect(result.stdout).not.toContain('token-beta');
  });

  it('reports a missing token env for one node without blocking the other', async () => {
    const calls: string[] = [];
    const factory = (node: NodeSpec) => {
      calls.push(node.name);
      return fakeTarget((method) => {
        if (method === 'interactions.list') {
          return page([interaction({ request_id: 'r-alpha' })], 1);
        }
        throw new Error(`unexpected ${method}`);
      });
    };

    const result = await attentionCommand(
      command({ allNodes: true, json: true }),
      multiNodeOptions({
        nodes: [
          { name: 'alpha', url: 'https://alpha.example', tokenEnv: 'ALPHA_TOKEN' },
          { name: 'beta', url: 'https://beta.example', tokenEnv: 'BETA_TOKEN' },
        ],
        env: { ALPHA_TOKEN: 'token-alpha' },
        factory,
      }),
    );

    expect(result.exitCode).toBe(1);
    // token 缺失的节点不发任何 RPC。
    expect(calls).toEqual(['alpha']);
    const payload = JSON.parse(result.stdout) as {
      nodes: Array<{ name: string; ok: boolean; error?: string }>;
    };
    expect(payload.nodes[0]?.ok).toBe(true);
    expect(payload.nodes[1]?.ok).toBe(false);
    expect(payload.nodes[1]?.error).toContain('BETA_TOKEN');
  });

  it('uses --to to select a configured node by node_id and keeps the address team', async () => {
    const calls: Call[] = [];
    const factory = () =>
      fakeTarget((method, params) => {
        calls.push({ method, ...(params !== undefined ? { params } : {}) });
        if (method === 'health.get') return { node: { node_id: 'node-a' } };
        if (method === 'interactions.list') {
          return page([interaction({ request_id: 'r-alpha', team_id: 'alpha' })], 1);
        }
        throw new Error(`unexpected ${method}`);
      });

    const result = await attentionCommand(
      command({ to: 'human@node-a:alpha', json: true }),
      multiNodeOptions({
        nodes: [
          {
            name: 'alpha',
            url: 'https://alpha.example',
            tokenEnv: 'ALPHA_TOKEN',
            nodeId: 'node-a',
          },
        ],
        env: { ALPHA_TOKEN: 'token-alpha' },
        factory,
      }),
    );

    expect(result.exitCode).toBe(0);
    const methods = calls.map((call) => call.method);
    expect(methods).toContain('health.get');
    const listCall = calls.find((call) => call.method === 'interactions.list');
    expect((listCall?.params as { team_id?: string } | undefined)?.team_id).toBe('alpha');
  });

  it('refuses a configured node whose node_id does not match before listing', async () => {
    const methods: string[] = [];
    const factory = () =>
      fakeTarget((method) => {
        methods.push(method);
        if (method === 'health.get') return { node: { node_id: 'node-b' } };
        throw new Error(`unexpected ${method}`);
      });

    const result = await attentionCommand(
      command({ to: 'human@node-a:alpha', json: true }),
      multiNodeOptions({
        nodes: [
          {
            name: 'alpha',
            url: 'https://alpha.example',
            tokenEnv: 'ALPHA_TOKEN',
            nodeId: 'node-a',
          },
        ],
        env: { ALPHA_TOKEN: 'token-alpha' },
        factory,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('node-b');
    expect(result.stderr).toContain('node-a');
    expect(methods).not.toContain('interactions.list');
  });

  it('answers through --node without consulting other node tokens', async () => {
    const calls: string[] = [];
    const factory = (node: NodeSpec) => {
      calls.push(node.name);
      return fakeTarget((method, params) => {
        if (method === 'interactions.list') return page([interaction({ request_id: 'r1' })]);
        if (method === 'permission.respond') return { ok: true };
        throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
      });
    };

    const result = await attentionCommand(
      command({
        kind: 'respond',
        node: 'alpha',
        requestId: 'r1',
        decision: 'allow',
        json: false,
      }),
      multiNodeOptions({
        nodes: [
          { name: 'alpha', url: 'https://alpha.example', tokenEnv: 'ALPHA_TOKEN' },
          { name: 'beta', url: 'https://beta.example', tokenEnv: 'BETA_TOKEN' },
        ],
        env: { ALPHA_TOKEN: 'token-alpha', BETA_TOKEN: 'token-beta' },
        factory,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('OK r1 allow');
    expect(calls).toEqual(['alpha']);
  });
});

describe('vessel attention auth', () => {
  it('401 keeps stdout empty and never prints the token', async () => {
    const target = fakeTarget((method) => {
      if (method === 'interactions.list') {
        throw new RpcClientError('unauthorized', 'missing token', { httpStatus: 401 });
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(command({ json: false }), options(target));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unauthorized: missing token');
    expect(result.stderr).toContain('human control token');
    expect(result.stderr).not.toContain('super-secret-token');
  });
});
