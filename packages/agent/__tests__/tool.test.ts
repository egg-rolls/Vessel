import { describe, expect, it } from 'bun:test';
import { MemoryEventStream, type ToolContext, type ToolDefinition } from '@vessel-agent/core';
import {
  type BatchItemResult,
  createAgentTool,
  type MemberStatus,
  type SendResult,
} from '../src/index.js';
import { makeService, settle } from './helpers.js';

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

function setup(options: { ownerId?: string } = {}) {
  const made = makeService();
  return {
    service: made.service,
    runtime: made.runtime,
    tool: createAgentTool(made.service, options),
  };
}

describe('agent tool', () => {
  it('single new returns parseable MemberStatus JSON with snake_case fields', async () => {
    const { service, tool } = setup();

    const status = parse<MemberStatus>(
      await call(tool, {
        action: 'new',
        name: 'worker',
        model: 'm',
        visibility: 'team',
      }),
    );

    expect(status.id).toBe('id-1');
    expect(status.session_id).toBe(status.id);
    expect(status.name).toBe('worker');
    expect(status.visibility).toBe('team');
    expect(status.owner).toBe('main');
    expect(status.state).toBe('idle');
    expect((await service.list({ viewer: 'main' })).map((entry) => entry.id)).toEqual([status.id]);
  });

  it('batch new preserves input order and reports a per-entry failure without dropping the rest', async () => {
    const { runtime, tool } = (() => {
      const made = makeService();
      return { runtime: made.runtime, tool: createAgentTool(made.service) };
    })();

    const { results } = parse<{ results: BatchItemResult<MemberStatus>[] }>(
      await call(tool, {
        action: 'new',
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
    const created = parse<MemberStatus>(await call(tool, { action: 'new', name: 'worker' }));
    expect(created.parent_id).toBe('main');
    runtime.handler = async (member) => (member.id === created.id ? { content: 'done' } : {});

    await call(tool, { action: 'send', to: created.id, content: 'work' });
    await settle();

    expect(runtime.turns.filter((turn) => turn.member.id === 'main')).toEqual([]);
    const queued = await service.takeMessages('main');
    expect(queued.map((turn) => turn.content)).toEqual(['done']);
    expect(queued[0]?.from).toBe(created.id);
  });

  it('custom ownerId scopes new owner/parent and list visibility', async () => {
    const { service, tool } = setup({ ownerId: 'boss' });
    const created = parse<MemberStatus>(await call(tool, { action: 'new', name: 'worker' }));

    expect(created.owner).toBe('boss');
    expect(created.parent_id).toBe('boss');
    expect(
      parse<MemberStatus[]>(await call(tool, { action: 'list' })).map((entry) => entry.id),
    ).toEqual([created.id]);
    expect(await service.list({ viewer: 'main' })).toEqual([]);
    expect((await service.list({ viewer: 'boss' })).map((entry) => entry.id)).toEqual([created.id]);
  });

  it('single send queues and returns queued/message_id without waiting for the turn', async () => {
    const { runtime, tool } = setup();
    const created = parse<MemberStatus>(await call(tool, { action: 'new', name: 'worker' }));

    const result = parse<SendResult>(
      await call(tool, { action: 'send', to: created.id, content: 'do work' }),
    );

    expect(result.queued).toBe(true);
    expect(typeof result.message_id).toBe('string');
    expect(result.state).toBe('running');
    await settle();
    expect(runtime.turns.map((turn) => turn.message.content)).toEqual(['do work']);
  });

  it('batch send preserves order and reports an unknown target per entry', async () => {
    const { runtime, tool } = setup();
    const first = parse<MemberStatus>(await call(tool, { action: 'new', name: 'a' }));
    const second = parse<MemberStatus>(await call(tool, { action: 'new', name: 'b' }));

    const { results } = parse<{ results: BatchItemResult<SendResult>[] }>(
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
    const created = parse<MemberStatus>(await call(tool, { action: 'new', name: 'worker' }));

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
    const first = parse<MemberStatus>(await call(tool, { action: 'new', name: 'a' }));
    const second = parse<MemberStatus>(await call(tool, { action: 'new', name: 'b' }));

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
    const member = parse<MemberStatus>(await call(tool, { action: 'new', name: 'worker' }));
    const child = await made.service.new({ name: 'child', parentId: 'grand', visibility: 'team' });

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

  it('mixing single fields with a batch is rejected as invalid_input and creates nothing', async () => {
    const made = makeService();
    const tool = createAgentTool(made.service);

    for (const args of [
      { action: 'new', name: 'x', members: [{}] },
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
    expect((schema.properties.action as { enum: string[] }).enum).toEqual([
      'new',
      'send',
      'close',
      'list',
      'rotate',
    ]);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'action',
      'content',
      'handoff_path',
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
    expect(`${tool.description} ${JSON.stringify(schema)}`).not.toMatch(
      /\b(wait|inbox|status|cancel)\b/i,
    );
  });

  it('member body callers can only rotate; the owner keeps new/send/close/list', async () => {
    const made = makeService();
    await made.service.attachOwner({ id: 'main', sessionId: 'owner-session' });
    const tool = createAgentTool(made.service, {
      ownerId: 'main',
      ownerSessionId: 'owner-session',
    });

    const member = parse<MemberStatus>(
      await callAs(tool, { action: 'new', name: 'worker' }, 'owner-session'),
    );

    // 成员 Body：rotate 自己成功，其它动作一律拒绝。
    const rotated = await callAs(
      tool,
      { action: 'rotate', startup_prompt: 'continue' },
      member.session_id,
    );
    expect(rotated).toContain('"status":"rotated"');
    expect(rotated).toContain('rotation committed; finish the current turn');
    expect(rotated).not.toContain('continue"');

    for (const args of [
      { action: 'new', name: 'nope' },
      { action: 'send', to: member.id, content: 'x' },
      { action: 'close', member: member.id },
      { action: 'list' },
    ]) {
      expect(await callAs(tool, args, member.session_id)).toMatch(
        /^Error: invalid_input: agent bodies may only use action=rotate$/,
      );
    }

    // root owner 的四个生命周期动作保持可用。
    const created = parse<MemberStatus>(
      await callAs(tool, { action: 'new', name: 'plain' }, 'owner-session'),
    );
    expect(created.owner).toBe('main');
    expect(
      parse<SendResult>(
        await callAs(tool, { action: 'send', to: created.id, content: 'work' }, 'owner-session'),
      ).queued,
    ).toBe(true);
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
