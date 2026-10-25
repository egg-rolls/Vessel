import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentEvent, snapshotPath, type TeamBinder, type TeamRecord } from '../src/index.js';
import { makeService, settle } from './helpers.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-agent-dispatch-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('AgentService.dispatch', () => {
  it('single-flights resume when a gone member receives concurrent dispatches', async () => {
    const dataDir = await tempDir();
    const first = makeService({ dataDir });
    const member = await first.service.new({ visibility: 'team' });
    await first.service.flushSnapshot();

    // 重启：engine 不在，成员应为 gone
    const second = makeService({ dataDir });
    const [before] = await second.service.list({ viewer: 'main' });
    expect(before?.presence).toBe('gone');

    const [a, b] = await Promise.all([
      second.service.dispatch({ to: member.id, content: 'first' }),
      second.service.dispatch({ to: member.id, content: 'second' }),
    ]);

    // single-flight：两次并发只 spawn 一次
    expect(second.runtime.spawned.length).toBe(1);
    for (const result of [a, b]) {
      expect(result.status).toBe('queued');
      if (result.status === 'queued') {
        expect(result.resolution).toBe('resumed');
        expect(result.resolved_to).toBe(member.id);
      }
    }
    expect(a.status === 'queued' ? a.message_id : '').not.toBe(
      b.status === 'queued' ? b.message_id : '',
    );
  });

  it('rejects dispatch to a left member with agent_left', async () => {
    const { service } = makeService();
    const member = await service.new({ visibility: 'team' });
    await service.close({ member: member.id });

    const result = await service.dispatch({ to: member.id, content: 'x' });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.code).toBe('agent_left');
    }
  });

  it('allows reusing the name of a left member and resolves the present one', async () => {
    const { service } = makeService();
    const first = await service.new({ name: 'reuse', visibility: 'team' });
    await service.close({ member: first.id });

    const again = await service.new({ name: 'reuse', visibility: 'team' });
    expect(again.name).toBe('reuse');

    const result = await service.dispatch({ to: 'reuse', content: 'x' });
    expect(result.status).toBe('queued');
    if (result.status === 'queued') expect(result.resolved_to).toBe(again.id);
  });

  it('does not report queued when close races dispatch', async () => {
    const { service } = makeService();
    const member = await service.new({ name: 'closing', visibility: 'team' });

    const closing = service.close({ member: member.id });
    const result = await service.dispatch({ to: member.id, content: 'x' });
    await closing;

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.code).toBe('agent_left');
  });

  it('fully revives a closed root owner on attachOwner', async () => {
    const dataDir = await tempDir();
    const first = makeService({ dataDir });
    await first.service.attachOwner({ id: 'main' });
    await first.service.close({ member: 'main' });
    await first.service.flushSnapshot();

    const second = makeService({ dataDir });
    const revived = await second.service.attachOwner({ id: 'main' });

    expect(revived.state).toBe('idle');
    expect(revived.presence).toBe('live');
    expect(revived.membership).toBe('present');
    const sent = await second.service.send({ to: 'main', content: 'x' });
    expect(sent.queued).toBe(true);
  });
});

/** 固定两个 Team 的假绑定端口：workspace 含 beta 的进 team-beta，其余进 team-alpha */
class FakeTeamBinder implements TeamBinder {
  readonly ensured: { workspace: string; name?: string }[] = [];

  async ensureForWorkspace(input: {
    workspace: string;
    name?: string;
    policy?: Record<string, unknown>;
  }): Promise<TeamRecord> {
    this.ensured.push({ workspace: input.workspace, name: input.name });
    const teamId = input.workspace.includes('beta') ? 'team-beta' : 'team-alpha';
    return {
      v: 1,
      team_id: teamId,
      name: teamId,
      tenant_id: 'default',
      workspace: input.workspace,
      policy: {},
      created_at: 1,
    };
  }

  get(_teamId: string): TeamRecord | undefined {
    return undefined;
  }
}

describe('AgentService team binding', () => {
  it('binds an explicit workspace with a name and defaults visibility to team', async () => {
    const binder = new FakeTeamBinder();
    const { service, runtime } = makeService({ teamBinder: binder });
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));

    const member = await service.new({ name: 'alpha-1', workspace: '/work/alpha' });

    expect(member.team_id).toBe('team-alpha');
    expect(member.visibility).toBe('team');
    expect(binder.ensured).toEqual([{ workspace: '/work/alpha', name: 'alpha-1' }]);
    expect(runtime.spawned).toHaveLength(1);
    expect(events.find((event) => event.type === 'agent.spawned')?.team_id).toBe('team-alpha');
  });

  it('scopes name uniqueness to the team: same-team duplicates fail, other teams may reuse', async () => {
    const binder = new FakeTeamBinder();
    const { service } = makeService({ teamBinder: binder });

    const alpha = await service.new({ name: 'dup', workspace: '/work/alpha' });
    expect(alpha.team_id).toBe('team-alpha');
    await expect(service.new({ name: 'dup', workspace: '/work/alpha' })).rejects.toMatchObject({
      code: 'invalid_input',
    });

    const beta = await service.new({ name: 'dup', workspace: '/work/beta' });
    expect(beta.team_id).toBe('team-beta');
  });

  it('requires a name for an explicit workspace, but keeps unnamed default-workspace agents unbound', async () => {
    const binder = new FakeTeamBinder();
    const explicit = makeService({ teamBinder: binder });

    await expect(explicit.service.new({ workspace: '/work/alpha' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(binder.ensured).toHaveLength(0);
    expect(explicit.runtime.spawned).toHaveLength(0);

    const defaults = makeService({ teamBinder: binder, defaultWorkspace: '/work/alpha' });
    const unnamed = await defaults.service.new({});
    expect(unnamed.team_id).toBeUndefined();
    expect(unnamed.visibility).toBe('private');
    expect(binder.ensured).toHaveLength(0);

    const named = await defaults.service.new({ name: 'alpha-2' });
    expect(named.team_id).toBe('team-alpha');
    expect(named.visibility).toBe('team');
  });

  it('reinstate revives a closed agent in place, preserving its body and emitting rejoined', async () => {
    const dataDir = await tempDir();
    const { service, runtime } = makeService({ dataDir });
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));

    const member = await service.new({ name: 'revive', visibility: 'team' });
    const rotated = await service.rotate({ to: member.id, startup_prompt: 'next body' });
    expect(rotated.status).toBe('rotated');
    await settle();
    await service.close({ member: member.id });
    await service.flushSnapshot();

    const path = snapshotPath(dataDir, 'default');
    const before = JSON.parse(await readFile(path, 'utf8')) as {
      members: { id: string; current_body?: unknown; body_history?: unknown }[];
    };
    const beforeRecord = before.members.find((entry) => entry.id === member.id);
    const spawnsBefore = runtime.spawned.length;

    const status = await service.reinstate({ to: member.id, team_id: 'team-alpha' });

    expect(status.membership).toBe('present');
    expect(status.state).toBe('idle');
    expect(status.presence).toBe('gone');
    expect(status.team_id).toBe('team-alpha');
    // 不 spawn、不新建 session：复活只改 membership / state。
    expect(runtime.spawned.length).toBe(spawnsBefore);

    await service.flushSnapshot();
    const after = JSON.parse(await readFile(path, 'utf8')) as {
      members: { id: string; current_body?: unknown; body_history?: unknown }[];
    };
    const afterRecord = after.members.find((entry) => entry.id === member.id);
    expect(afterRecord?.current_body).toEqual(beforeRecord?.current_body);
    expect(afterRecord?.body_history).toEqual(beforeRecord?.body_history);

    const rejoined = events.filter((event) => event.type === 'agent.rejoined');
    expect(rejoined).toHaveLength(1);
    expect(rejoined[0]?.team_id).toBe('team-alpha');

    // 复活清掉了 close 的 closing 标记：下一次 dispatch 走 resume，而不是 agent_left。
    const dispatched = await service.dispatch({ to: member.id, content: 'back' });
    expect(dispatched.status).toBe('queued');
    if (dispatched.status === 'queued') expect(dispatched.resolution).toBe('resumed');
    await settle();
  });

  it('identify resolves only the current body and ignores retired sessions', async () => {
    const { service } = makeService();
    const member = await service.new({ name: 'identify-me', visibility: 'team' });

    expect((await service.identify(member.session_id))?.id).toBe(member.id);

    const first = await service.rotate({ to: member.id, startup_prompt: 'first' });
    expect(first.status).toBe('rotated');
    const firstBody = first.status === 'rotated' ? first.to_session_id : '';
    await settle();
    expect((await service.identify(firstBody))?.id).toBe(member.id);

    // 再换一次：firstBody 退役，不再是当前 Body 的 session。
    const second = await service.rotate({ to: member.id, startup_prompt: 'second' });
    expect(second.status).toBe('rotated');
    const secondBody = second.status === 'rotated' ? second.to_session_id : '';
    await settle();

    expect(await service.identify(firstBody)).toBeUndefined();
    expect((await service.identify(secondBody))?.id).toBe(member.id);
    expect(await service.identify('not-a-member')).toBeUndefined();
  });

  it('emits agent.reply.posted for a completed team turn and keeps turn.completed content-free', async () => {
    const binder = new FakeTeamBinder();
    const { service, runtime } = makeService({
      teamBinder: binder,
      defaultWorkspace: '/work/alpha',
    });
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));

    const member = await service.new({ name: 'replier' });
    runtime.handler = async () => ({ content: 'final answer', outcome: 'completed' });

    await service.dispatch({ to: member.id, content: 'go' });
    await settle();

    const reply = events.find((event) => event.type === 'agent.reply.posted');
    expect(reply).toMatchObject({
      agent_id: member.id,
      team_id: 'team-alpha',
      content: 'final answer',
    });
    expect(typeof reply?.message_id).toBe('string');
    expect((reply?.message_id ?? '').length).toBeGreaterThan(0);

    // 正文只进 agent.reply.posted，不能塞进 turn.completed。
    const completed = events.find((event) => event.type === 'agent.turn.completed');
    expect(completed?.content).toBeUndefined();
  });

  it('truncates oversized agent.reply.posted content with a marker', async () => {
    const binder = new FakeTeamBinder();
    const { service, runtime } = makeService({
      teamBinder: binder,
      defaultWorkspace: '/work/alpha',
    });
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));

    const member = await service.new({ name: 'big-replier' });
    runtime.handler = async () => ({
      content: 'x'.repeat(70 * 1024),
      outcome: 'completed',
    });

    await service.dispatch({ to: member.id, content: 'go' });
    await settle();

    const reply = events.find((event) => event.type === 'agent.reply.posted');
    expect(reply).toBeDefined();
    expect(Buffer.byteLength(reply?.content ?? '', 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect((reply?.content ?? '').endsWith('[truncated]')).toBe(true);
  });
});
