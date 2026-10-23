import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TeamPolicy } from '@vessel-agent/config';
import { ConversationBudget } from '../src/conversation-budget.js';
import { ConversationStore } from '../src/conversation-store.js';
import {
  type AgentEvent,
  type AgentService,
  createAgentService,
  type MemberTurnResult,
  type TeamBinder,
} from '../src/index.js';
import { TeamLogWriter } from '../src/team-log.js';
import { type Deferred, deferred, FakeRuntime, settle } from './helpers.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vessel-budget-'));
  dirs.push(dir);
  return dir;
}

interface BudgetHarness {
  service: AgentService;
  runtime: FakeRuntime;
  budget: ConversationBudget;
  store: ConversationStore;
  dataDir: string;
  advance: (ms: number) => void;
}

function makeBudgetHarness(policy: TeamPolicy | undefined): BudgetHarness {
  const dataDir = tempDataDir();
  let clock = 1_000;
  const now = (): number => clock;
  const runtime = new FakeRuntime();
  const store = new ConversationStore({ dataDir, tenantId: 'default' });
  const budget = new ConversationBudget({
    store,
    policyFor: (teamId) => (teamId === 'alpha' ? policy : undefined),
    now,
  });
  const teamBinder: TeamBinder = {
    ensureForWorkspace: async (input) => ({
      v: 1,
      team_id: 'alpha',
      name: input.name ?? 'alpha',
      tenant_id: 'default',
      workspace: input.workspace,
      policy: {},
      created_at: 1,
    }),
  };
  let counter = 0;
  const service = createAgentService({
    tenantId: 'default',
    dataDir,
    snapshot: { enabled: false },
    runtime,
    now,
    newId: () => `id-${++counter}`,
    teamBinder,
    budget,
  });
  return {
    service,
    runtime,
    budget,
    store,
    dataDir,
    advance: (ms) => {
      clock += ms;
    },
  };
}

async function createWorker(harness: BudgetHarness, name = 'worker') {
  return harness.service.new({ name, workspace: '/w/alpha' });
}

describe('conversation budget: sender side', () => {
  it('sender-side hop and cycle limits reject before enqueue and leave no run', async () => {
    const hop = makeBudgetHarness({ budget: { maxHops: 1 } });
    hop.runtime.handler = async () => ({});
    const member = await createWorker(hop);

    const first = await hop.service.dispatch({
      to: member.id,
      content: 'one',
      conversation_id: 'conv_hop',
    });
    expect(first.status).toBe('queued');
    expect(first.status === 'queued' ? first.conversation_id : undefined).toBe('conv_hop');
    await settle();
    const runsAfterFirst = hop.runtime.turns.length;

    const second = await hop.service.dispatch({
      to: member.id,
      content: 'two',
      conversation_id: 'conv_hop',
    });
    expect(second.status).toBe('rejected');
    expect(second.status === 'rejected' ? second.code : undefined).toBe('budget_exceeded');
    // 反向验证锚点：超限仍入队会多跑一轮
    expect(hop.runtime.turns.length).toBe(runsAfterFirst);

    const cycle = makeBudgetHarness({ budget: { cycle: { maxRepeats: 2 } } });
    cycle.runtime.handler = () => new Promise<MemberTurnResult>(() => {});
    const a = await createWorker(cycle, 'a');
    const b = await createWorker(cycle, 'b');
    const events: AgentEvent[] = [];
    cycle.service.subscribe((event) => events.push(event));

    const edges: Array<[string, string]> = [
      [a.id, b.id],
      [b.id, a.id],
      [a.id, b.id],
      [b.id, a.id],
    ];
    for (const [from, to] of edges) {
      const result = await cycle.service.dispatch({
        to,
        from,
        content: 'ping',
        conversation_id: 'conv_cycle',
      });
      expect(result.status).toBe('queued');
    }
    const runsBeforeBlock = cycle.runtime.turns.length;

    const blocked = await cycle.service.dispatch({
      to: b.id,
      from: a.id,
      content: 'loop',
      conversation_id: 'conv_cycle',
    });
    expect(blocked.status).toBe('rejected');
    expect(blocked.status === 'rejected' ? blocked.reason : '').toContain('cycle_detected');
    expect(cycle.runtime.turns.length).toBe(runsBeforeBlock);

    const blockedEvent = events.find((event) => event.type === 'team.budget.blocked');
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent?.reason).toBe('cycle_detected');
    const payload = blockedEvent as unknown as Record<string, unknown> | undefined;
    expect(typeof payload?.retry_after_ts).toBe('number');
  });
});

describe('conversation budget: receiver side', () => {
  it('receiver-side hold keeps the message queued and override resumes exactly one turn', async () => {
    const harness = makeBudgetHarness({ budget: { maxTurns: 2 } });
    const gates: Deferred<MemberTurnResult>[] = [];
    harness.runtime.handler = () => {
      const gate = deferred<MemberTurnResult>();
      gates.push(gate);
      return gate.promise;
    };
    const member = await createWorker(harness);
    const events: AgentEvent[] = [];
    harness.service.subscribe((event) => events.push(event));

    await harness.service.dispatch({
      to: member.id,
      content: 'one',
      conversation_id: 'conv_hold',
    });
    await harness.service.dispatch({
      to: member.id,
      content: 'two',
      conversation_id: 'conv_hold',
    });
    await harness.service.dispatch({
      to: member.id,
      content: 'three',
      conversation_id: 'conv_hold',
    });
    expect(harness.runtime.turns).toHaveLength(1);

    gates[0]?.resolve({});
    await settle();
    expect(harness.runtime.turns).toHaveLength(2);

    gates[1]?.resolve({});
    await settle();
    // 第三条留在队列：没有第三次 run，且产生一次 turn_start blocked
    expect(harness.runtime.turns).toHaveLength(2);
    const blocked = events.filter((event) => event.type === 'team.budget.blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      conversation_id: 'conv_hold',
      dimension: 'turns',
      current: 2,
      max: 2,
      phase: 'turn_start',
      reason: 'budget_exceeded',
    });

    const override = await harness.service.budget({
      team_id: 'alpha',
      conversation_id: 'conv_hold',
      dimension: 'turns',
      max: 3,
      via: 'cli',
    });
    expect(override.action).toBe('override');
    await settle();
    // override 只能恢复被 hold 的那一条
    expect(harness.runtime.turns).toHaveLength(3);
    expect(harness.runtime.turns[2]?.message.content).toBe('three');

    gates[2]?.resolve({});
    await settle();
    expect(harness.runtime.turns).toHaveLength(3);
  });

  it('budget counters and overrides survive a new service, queued messages do not', async () => {
    const harness = makeBudgetHarness({ budget: { maxTurns: 10, maxTokens: 1000 } });
    harness.runtime.handler = async () => ({ usage: { total_tokens: 5 } });
    const member = await createWorker(harness);
    await harness.service.dispatch({
      to: member.id,
      content: 'one',
      conversation_id: 'conv_restart',
    });
    await settle();

    await harness.service.budget({
      team_id: 'alpha',
      conversation_id: 'conv_restart',
      dimension: 'tokens',
      max: 500,
      via: 'cli',
    });

    // 一条在跑、一条排队；重启后队列必须消失
    const gate = deferred<MemberTurnResult>();
    harness.runtime.handler = () => gate.promise;
    await harness.service.dispatch({
      to: member.id,
      content: 'two',
      conversation_id: 'conv_restart',
    });
    await harness.service.dispatch({
      to: member.id,
      content: 'three',
      conversation_id: 'conv_restart',
    });
    await harness.budget.flush();

    const runtime = new FakeRuntime();
    const store = new ConversationStore({ dataDir: harness.dataDir, tenantId: 'default' });
    const budget = new ConversationBudget({
      store,
      policyFor: (teamId) =>
        teamId === 'alpha' ? { budget: { maxTurns: 10, maxTokens: 1000 } } : undefined,
    });
    const service = createAgentService({
      tenantId: 'default',
      dataDir: harness.dataDir,
      snapshot: { enabled: false },
      runtime,
      budget,
    });

    const overview = await service.budget({
      team_id: 'alpha',
      conversation_id: 'conv_restart',
    });
    expect(overview.action).toBe('status');
    const status = overview.action === 'status' ? overview.conversations[0] : undefined;
    expect(status).toMatchObject({
      conversation_id: 'conv_restart',
      hops: 3,
      turns: 2,
      total_tokens: 5,
    });
    expect(status?.overrides.tokens?.max).toBe(500);

    await settle();
    // 未消费消息不落盘：新实例不会凭空跑任何 turn
    expect(runtime.turns).toHaveLength(0);
  });
});

describe('team log conversation fields', () => {
  it('round-trips conversation_id and budget_override; old lines without it still parse', async () => {
    const writer = new TeamLogWriter({ path: join(tempDataDir(), 'log.ndjson'), durable: false });
    await writer.append({
      message_id: 'm1',
      team_id: 'alpha',
      from: 'human',
      to: [],
      mentions: [],
      content: 'budget override conv_log turns null -> 5',
      ts: 1,
      kind: 'system',
      system_event: 'budget_override',
      conversation_id: 'conv_log',
    });
    await writer.append({
      message_id: 'm2',
      team_id: 'alpha',
      from: 'human',
      to: [],
      mentions: [],
      content: 'legacy line',
      ts: 2,
      kind: 'post',
    });

    const entries = await writer.read();
    expect(entries[0]).toMatchObject({
      conversation_id: 'conv_log',
      system_event: 'budget_override',
    });
    expect(entries[1]?.conversation_id).toBeUndefined();
  });
});

describe('conversation budget: warnings and fail-closed', () => {
  it('emits at most one warning per conversation and dimension at 80%', async () => {
    const harness = makeBudgetHarness({ budget: { maxHops: 5 } });
    harness.runtime.handler = async () => ({});
    const member = await createWorker(harness);
    const events: AgentEvent[] = [];
    harness.service.subscribe((event) => events.push(event));

    for (let index = 0; index < 4; index += 1) {
      await harness.service.dispatch({
        to: member.id,
        content: `m${index}`,
        conversation_id: 'conv_warn',
      });
    }
    const warnings = (): AgentEvent[] =>
      events.filter((event) => event.type === 'team.budget.warning');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({
      conversation_id: 'conv_warn',
      team_id: 'alpha',
      dimension: 'hops',
      current: 4,
      max: 5,
      threshold: 0.8,
      phase: 'enqueue',
    });

    // 4 -> 5 到顶（100%），不重复预警
    await harness.service.dispatch({
      to: member.id,
      content: 'top',
      conversation_id: 'conv_warn',
    });
    expect(warnings()).toHaveLength(1);
  });

  it('a corrupt conversation file fails closed and is never overwritten', async () => {
    const dataDir = tempDataDir();
    mkdirSync(join(dataDir, 'conversations'), { recursive: true });
    const path = join(dataDir, 'conversations', 'default.json');
    const raw = '{"v":1,"tenant_id":"default","conversations":[{"conversation_id":';
    writeFileSync(path, raw);

    const store = new ConversationStore({ dataDir, tenantId: 'default' });
    expect(store.available).toBe(false);
    const budget = new ConversationBudget({ store, policyFor: () => ({ budget: { maxHops: 9 } }) });
    const runtime = new FakeRuntime();
    const service = createAgentService({
      tenantId: 'default',
      dataDir,
      snapshot: { enabled: false },
      runtime,
      budget,
    });
    const member = await service.new({ visibility: 'team' });

    const dispatched = await service.dispatch({
      to: member.id,
      content: 'x',
      conversation_id: 'conv_corrupt',
    });
    expect(dispatched.status).toBe('rejected');
    expect(dispatched.status === 'rejected' ? dispatched.code : undefined).toBe(
      'budget_unavailable',
    );
    await expect(service.send({ to: member.id, content: 'y' })).rejects.toMatchObject({
      code: 'budget_unavailable',
    });
    await expect(service.budget({ team_id: 'alpha' })).rejects.toMatchObject({
      code: 'budget_unavailable',
    });

    await budget.flush();
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });
});

describe('conversation origin', () => {
  it('rejects a conversation_id reused under a different team', async () => {
    const harness = makeBudgetHarness({ budget: { maxHops: 10 } });
    const worker = await createWorker(harness);
    const first = await harness.service.dispatch({
      to: worker.id,
      content: 'a',
      from: 'human',
    });
    if (first.status !== 'queued' || first.conversation_id === undefined) {
      throw new Error('expected queued');
    }
    const check = harness.budget.checkDelivery({
      conversation_id: first.conversation_id,
      team_id: 'beta',
      origin_explicit: true,
      from: 'human',
      to: worker.id,
    });
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error('expected block');
    expect(check.reason).toBe('conversation_team_mismatch');
  });
});
