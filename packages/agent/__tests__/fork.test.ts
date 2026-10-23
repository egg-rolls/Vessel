import { describe, expect, it } from 'bun:test';
import { join, normalize } from 'node:path';
import {
  type AgentEvent,
  type AgentMessage,
  type AgentService,
  createTeamService,
  type MemberRecord,
  type NewMemberInput,
  type TeamBinder,
  type TeamRecord,
} from '../src/index.js';
import { type FakeRuntime, MemoryTeamStore, makeService, makeTeam, settle } from './helpers.js';

const TEAM_ID = 'alpha';
const TEAM_WORKSPACE = '/workspace/alpha';

type ForkOutcome =
  | { ok: true; member: MemberRecord }
  | { ok: false; code: 'fork_not_allowed' | 'fork_failed' | 'agent_left'; reason: string };

/** 只用于测试的私有接缝：fork 是 F2 才公开的 dispatch 分支，这里直接断言核心语义。 */
interface ServiceSeam {
  ensureForked(sourceId: string): Promise<ForkOutcome>;
  registry: {
    get(id: string): MemberRecord | undefined;
    all(): MemberRecord[];
    setPresence(id: string, presence: 'live' | 'gone'): void;
  };
  queues: Map<string, { pending: AgentMessage[] }>;
}

function seam(service: AgentService): ServiceSeam {
  return service as unknown as ServiceSeam;
}

/** 固定 Team 的假绑定端口：get 返回带 handoff_path 的 TeamRecord */
function makeBinder(handoffPath?: string): TeamBinder {
  const team = makeTeam(TEAM_ID, {
    workspace: TEAM_WORKSPACE,
    ...(handoffPath !== undefined ? { handoff_path: handoffPath } : {}),
  });
  return {
    ensureForWorkspace: async (input) => ({ ...team, name: input.name ?? team.name }),
    get: (teamId: string): TeamRecord | undefined => (teamId === TEAM_ID ? team : undefined),
  };
}

/** 重启后的等价状态：engine 不在，presence=gone（不持久化，只能经 registry 设置） */
function markGone(service: AgentService, id: string): void {
  seam(service).registry.setPresence(id, 'gone');
}

/** 只让源 Agent 的 resume spawn 失败；fork 的新 Body spawn 正常。 */
function failResumeOnly(runtime: FakeRuntime, sourceId: string): void {
  const original = runtime.spawn.bind(runtime);
  runtime.spawn = async (member) => {
    if (member.session_id === sourceId) throw new Error('resume boom');
    return original(member);
  };
}

function pendingCount(service: AgentService, id: string): number {
  return seam(service).queues.get(id)?.pending.length ?? 0;
}

async function createSource(
  service: AgentService,
  overrides: Partial<NewMemberInput> = {},
): Promise<MemberRecord> {
  const status = await service.new({
    name: 'src',
    workspace: TEAM_WORKSPACE,
    model: 'model-src',
    systemPrompt: 'You are src.\n\nBe brief.  \n',
    ...overrides,
  });
  const record = seam(service).registry.get(status.id);
  if (record === undefined) throw new Error('source record missing');
  return record;
}

describe('AgentService fork', () => {
  it('concurrent ensureForked spawns only one Agent (a second fork would duplicate the source)', async () => {
    const { service, runtime } = makeService({ teamBinder: makeBinder('HANDOFF.md') });
    const source = await createSource(service);
    markGone(service, source.id);
    const spawnedBefore = runtime.spawned.length;

    const [first, second] = await Promise.all([
      seam(service).ensureForked(source.id),
      seam(service).ensureForked(source.id),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // single-flight：两个并发调用共享同一个新 Agent
    expect(second.member.id).toBe(first.member.id);
    expect(runtime.spawned.length).toBe(spawnedBefore + 1);
    expect(
      seam(service)
        .registry.all()
        .filter((record) => record.forkedFrom === source.id),
    ).toHaveLength(1);
  });

  it('fork inherits model/prompt/team but starts a fresh session with epoch 0 and no body history', async () => {
    const { service, runtime } = makeService({ teamBinder: makeBinder('HANDOFF.md') });
    const source = await createSource(service);
    markGone(service, source.id);
    const sourceBefore = structuredClone(source);

    const outcome = await seam(service).ensureForked(source.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const fork = outcome.member;
    const handoff = normalize(join(TEAM_WORKSPACE, 'HANDOFF.md'));

    expect(fork).toMatchObject({
      sessionId: fork.id,
      owner: source.owner,
      visibility: 'team',
      teamId: TEAM_ID,
      model: 'model-src',
      systemPrompt: `You are src.\n\nBe brief.\n\nHandoff: ${handoff}`,
      forkedFrom: source.id,
      state: 'idle',
      presence: 'live',
      membership: 'present',
      name: 'src-fork',
      bodyHistory: [],
      rotation: 'stable',
    });
    expect(fork.currentBody).toEqual({
      session_id: fork.id,
      epoch: 0,
      started_at: expect.any(Number),
    });

    const spawned = runtime.spawned[runtime.spawned.length - 1];
    expect(spawned?.session_id).toBe(fork.id);
    expect(spawned?.model).toBe('model-src');
    expect(spawned?.system_prompt).toContain(`Handoff: ${handoff}`);

    // 源记录零写入：仍 present + gone，指针 / 历史 / 状态不变
    expect(seam(service).registry.get(source.id)).toEqual(sourceBefore);
    expect(sourceBefore.presence).toBe('gone');
    expect(sourceBefore.membership).toBe('present');
  });

  it('fork spawn failure returns fork_failed and leaves neither a record nor an event', async () => {
    const { service, runtime } = makeService({ teamBinder: makeBinder('HANDOFF.md') });
    const source = await createSource(service);
    markGone(service, source.id);
    const sourceBefore = structuredClone(source);
    const sizeBefore = seam(service).registry.all().length;
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));

    runtime.spawnError = new Error('boom');
    const outcome = await seam(service).ensureForked(source.id);

    expect(outcome).toMatchObject({ ok: false, code: 'fork_failed' });
    if (!outcome.ok) expect(outcome.reason).toBe('fork_failed: boom');
    expect(seam(service).registry.all()).toHaveLength(sizeBefore);
    expect(seam(service).registry.get(source.id)).toEqual(sourceBefore);
    expect(events.filter((event) => event.type === 'agent.forked')).toHaveLength(0);
  });

  it('rejects a private source without spawning (private agents are invisible to Team logs)', async () => {
    const { service, runtime } = makeService();
    const source = await createSource(service, { workspace: undefined, visibility: 'private' });

    const outcome = await seam(service).ensureForked(source.id);

    expect(outcome).toMatchObject({
      ok: false,
      code: 'fork_not_allowed',
      reason: 'fork_not_allowed: private',
    });
    expect(runtime.spawned).toHaveLength(1);
  });

  it('rejects a source without a Team without spawning (no team_id, no handoff source)', async () => {
    const { service, runtime } = makeService();
    const source = await createSource(service, { workspace: undefined, visibility: 'team' });
    expect(source.teamId).toBeUndefined();

    const outcome = await seam(service).ensureForked(source.id);

    expect(outcome).toMatchObject({
      ok: false,
      code: 'fork_not_allowed',
      reason: 'fork_not_allowed: no_team',
    });
    expect(runtime.spawned).toHaveLength(1);
  });

  it('rejects a Team without handoff_path without spawning (fork prompt would have no handoff)', async () => {
    const { service, runtime } = makeService({ teamBinder: makeBinder(undefined) });
    const source = await createSource(service);
    markGone(service, source.id);

    const outcome = await seam(service).ensureForked(source.id);

    expect(outcome).toMatchObject({
      ok: false,
      code: 'fork_not_allowed',
      reason: 'fork_not_allowed: no_handoff',
    });
    expect(runtime.spawned).toHaveLength(1);
  });

  it('rejects a second fork while a present fork exists (already_forked) and does not spawn', async () => {
    const { service, runtime } = makeService({ teamBinder: makeBinder('HANDOFF.md') });
    const source = await createSource(service);
    markGone(service, source.id);

    const first = await seam(service).ensureForked(source.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const spawnedAfterFirst = runtime.spawned.length;

    const second = await seam(service).ensureForked(source.id);

    expect(second).toMatchObject({ ok: false, code: 'fork_not_allowed' });
    if (!second.ok) {
      expect(second.reason).toBe(`fork_not_allowed: already_forked:${first.member.id}`);
    }
    expect(runtime.spawned.length).toBe(spawnedAfterFirst);
  });

  it('writes exactly one system_event fork log when TeamService observes a fork', async () => {
    const { service } = makeService({ teamBinder: makeBinder('HANDOFF.md') });
    const store = new MemoryTeamStore([
      makeTeam(TEAM_ID, { workspace: TEAM_WORKSPACE, handoff_path: 'HANDOFF.md' }),
    ]);
    let counter = 0;
    const teamService = createTeamService({
      tenantId: 'default',
      agent: service,
      store,
      newId: () => `team-${++counter}`,
    });

    const source = await createSource(service);
    markGone(service, source.id);
    const outcome = await seam(service).ensureForked(source.id);
    await settle();
    teamService.dispose();

    expect(outcome.ok).toBe(true);
    const forkLogs = store.logs.filter((entry) => entry.system_event === 'fork');
    expect(forkLogs).toHaveLength(1);
    expect(forkLogs[0]).toMatchObject({
      team_id: TEAM_ID,
      kind: 'system',
      from: 'system',
      content: 'agent forked',
    });
    if (outcome.ok) expect(forkLogs[0]?.to).toEqual([outcome.member.id]);
  });

  it('dispatch rejects with resume_failed when fork is off (default), even with a handoff', async () => {
    const { service, runtime } = makeService({ teamBinder: makeBinder('HANDOFF.md') });
    const source = await createSource(service);
    markGone(service, source.id);
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    failResumeOnly(runtime, source.id);

    const result = await service.dispatch({ to: source.id, content: 'x' });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.code).toBe('resume_failed');
    expect(
      seam(service)
        .registry.all()
        .filter((r) => r.forkedFrom === source.id),
    ).toHaveLength(0);
    expect(events.filter((event) => event.type === 'agent.forked')).toHaveLength(0);
    expect(seam(service).registry.get(source.id)?.presence).toBe('gone');
  });

  it('dispatch forks when team policy allowFork is true and the fork can take new work', async () => {
    const { service, runtime } = makeService({
      teamBinder: makeBinder('HANDOFF.md'),
      teamPolicy: (teamId) => (teamId === TEAM_ID ? { allowFork: true } : undefined),
    });
    const source = await createSource(service);
    markGone(service, source.id);
    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    failResumeOnly(runtime, source.id);

    const result = await service.dispatch({ to: source.id, content: 'take over' });

    expect(result.status).toBe('queued');
    if (result.status !== 'queued') return;
    expect(result.resolution).toBe('forked');
    expect(result.resolved_to).not.toBe(source.id);
    const forked = seam(service).registry.get(result.resolved_to);
    expect(forked).toMatchObject({
      forkedFrom: source.id,
      presence: 'live',
      membership: 'present',
    });
    expect(seam(service).registry.get(source.id)).toMatchObject({
      presence: 'gone',
      membership: 'present',
    });
    expect(events.filter((event) => event.type === 'agent.forked')).toHaveLength(1);

    // 新 Agent 就是后续投递目标：直接 live 入队，不再触发 resume / fork
    const next = await service.dispatch({ to: result.resolved_to, content: 'again' });
    expect(next.status).toBe('queued');
    if (next.status === 'queued') expect(next.resolution).toBe('live');
  });

  it('explicit allow_fork overrides a team policy that leaves fork off', async () => {
    const { service, runtime } = makeService({ teamBinder: makeBinder('HANDOFF.md') });
    const source = await createSource(service);
    markGone(service, source.id);
    failResumeOnly(runtime, source.id);

    const result = await service.dispatch({
      to: source.id,
      content: 'manual fork',
      allow_fork: true,
    });

    expect(result.status).toBe('queued');
    if (result.status === 'queued') {
      expect(result.resolution).toBe('forked');
      expect(result.resolved_to).not.toBe(source.id);
    }
  });

  it('a repeated dispatch does not fork the same source twice (already_forked)', async () => {
    const { service, runtime } = makeService({
      teamBinder: makeBinder('HANDOFF.md'),
      teamPolicy: (teamId) => (teamId === TEAM_ID ? { allowFork: true } : undefined),
    });
    const source = await createSource(service);
    markGone(service, source.id);
    failResumeOnly(runtime, source.id);

    const first = await service.dispatch({ to: source.id, content: 'one' });
    expect(first.status).toBe('queued');
    if (first.status !== 'queued') return;
    const spawnsAfterFirst = runtime.spawned.length;

    const second = await service.dispatch({ to: source.id, content: 'two' });

    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') {
      expect(second.code).toBe('resume_failed');
      expect(second.reason).toContain('already_forked:');
    }
    expect(runtime.spawned.length).toBe(spawnsAfterFirst);
    expect(
      seam(service)
        .registry.all()
        .filter((r) => r.forkedFrom === source.id),
    ).toHaveLength(1);
  });

  it('drops a fork reply with agent.reply.dropped when the parent is gone, without enqueueing', async () => {
    const { service, runtime } = makeService({ teamBinder: makeBinder('HANDOFF.md') });
    const parent = await service.new({ name: 'parent', workspace: TEAM_WORKSPACE });
    const source = await createSource(service, { parentId: parent.id });
    markGone(service, source.id);
    markGone(service, parent.id);

    const outcome = await seam(service).ensureForked(source.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.member.parentId).toBe(parent.id);

    const events: AgentEvent[] = [];
    service.subscribe((event) => events.push(event));
    runtime.handler = async () => ({ content: 'child reply' });
    const sent = await service.send({ to: outcome.member.id, content: 'work' });
    expect(sent.queued).toBe(true);
    await settle();

    const dropped = events.find((event) => event.type === 'agent.reply.dropped');
    expect(dropped).toMatchObject({
      agent_id: outcome.member.id,
      to: parent.id,
      reason: 'parent_gone',
    });
    // 不入队、不重试：父队列为空且父从未起轮
    expect(pendingCount(service, parent.id)).toBe(0);
    expect(runtime.turns.filter((turn) => turn.member.id === parent.id)).toHaveLength(0);
  });
});
