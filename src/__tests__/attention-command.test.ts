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
  it('resolves a present member name through teams.get and recomputes total', async () => {
    const target = fakeTarget((method) => {
      if (method === 'interactions.list') {
        return page(
          [
            interaction({ request_id: 'r1', agent_id: 'agent-1' }),
            interaction({ request_id: 'r2', agent_id: 'agent-2' }),
          ],
          2,
        );
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
    };
    expect(payload.interactions.map((entry) => entry.request_id)).toEqual(['r2']);
    expect(payload.total).toBe(1);
  });

  it('rejects an unknown agent name when a team is given', async () => {
    const target = fakeTarget((method) => {
      if (method === 'interactions.list') return page([interaction({ agent_id: 'agent-1' })], 1);
      if (method === 'teams.get') return { members: [] };
      throw new Error(`unexpected ${method}`);
    });

    const result = await attentionCommand(
      command({ agent: 'nobody', teamId: 'alpha', json: true }),
      options(target),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown_agent');
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
