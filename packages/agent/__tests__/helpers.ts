import type { TeamPolicy } from '@vessel-agent/config';
import type { RuntimePermissionConfig } from '@vessel-agent/core';
import {
  type AgentEvent,
  type AgentEventListener,
  type AgentMessage,
  type AgentService,
  type AgentServiceOptions,
  type BudgetOverrideInput,
  type BudgetOverview,
  type BudgetStatusInput,
  type CloseInput,
  type CloseResult,
  createAgentService,
  type DispatchInput,
  type DispatchResult,
  type ListFilter,
  type MemberRuntimeMember,
  type MemberRuntimePort,
  type MemberStatus,
  type MemberTurnResult,
  type ReinstateInput,
  type TeamCreateInput,
  type TeamDeclaration,
  TeamError,
  type TeamLogEntry,
  type TeamRecord,
  type TeamStore,
  type TeamUpdatePatch,
} from '../src/index.js';
import { createTeamService, type DefaultTeamService } from '../src/team-service.js';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让出若干轮事件循环，等后台 turn 收口 */
export async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** 记录调用的假执行内核；不联网、不启子进程 */
export class FakeRuntime implements MemberRuntimePort {
  readonly spawned: MemberRuntimeMember[] = [];
  /** spawn 过的 Body session（rotate 断言用；与 spawned 同序） */
  readonly spawnedSessions: string[] = [];
  readonly cancelled: string[] = [];
  readonly cancelledSessions: string[] = [];
  readonly disposed: string[] = [];
  readonly disposedSessions: string[] = [];
  readonly turns: { member: MemberRuntimeMember; message: AgentMessage }[] = [];
  spawnError: Error | undefined;
  handler: (member: MemberRuntimeMember, message: AgentMessage) => Promise<MemberTurnResult> =
    async () => ({});

  async spawn(member: MemberRuntimeMember): Promise<void> {
    if (this.spawnError) throw this.spawnError;
    this.spawned.push(member);
    this.spawnedSessions.push(member.session_id);
  }

  async runTurn(member: MemberRuntimeMember, message: AgentMessage): Promise<MemberTurnResult> {
    this.turns.push({ member, message });
    return this.handler(member, message);
  }

  cancel(member: MemberRuntimeMember): void {
    this.cancelled.push(member.id);
    this.cancelledSessions.push(member.session_id);
  }

  dispose(member: MemberRuntimeMember): void {
    // 仍按 id 记录（兼容既有断言），另记 session 供 rotate / close 断言
    this.disposed.push(member.id);
    this.disposedSessions.push(member.session_id);
  }

  /** CONTRACT-hot-apply §4：记录热应用的权限规则 */
  readonly appliedPermissionRules: RuntimePermissionConfig[] = [];

  applyPermissionRules(rules: RuntimePermissionConfig): number {
    this.appliedPermissionRules.push(rules);
    // 语义与 InProcessMemberRuntime 一致：返回仍存活的 Body 数量。
    return this.spawned.length - this.disposed.length;
  }
}

export function makeService(overrides: Partial<AgentServiceOptions> = {}): {
  service: AgentService;
  runtime: FakeRuntime;
} {
  const runtime = new FakeRuntime();
  let counter = 0;
  const service = createAgentService({
    tenantId: 'default',
    runtime,
    newId: () => `id-${++counter}`,
    ...overrides,
  });
  return { service, runtime };
}

/** 构造 MemberStatus（只填测试关心的字段；其余给稳定默认值） */
export function makeMember(overrides: Partial<MemberStatus> & { id: string }): MemberStatus {
  return {
    id: overrides.id,
    session_id: overrides.session_id ?? overrides.id,
    owner: overrides.owner ?? 'main',
    visibility: overrides.visibility ?? 'team',
    state: overrides.state ?? 'idle',
    presence: overrides.presence ?? 'live',
    membership: overrides.membership ?? 'present',
    epoch: overrides.epoch ?? 0,
    ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    ...(overrides.parent_id !== undefined ? { parent_id: overrides.parent_id } : {}),
    ...(overrides.team_id !== undefined ? { team_id: overrides.team_id } : {}),
    ...(overrides.body_history !== undefined ? { body_history: overrides.body_history } : {}),
  };
}

/** 构造 TeamRecord；未指定的字段给稳定默认值 */
export function makeTeam(teamId: string, overrides: Partial<TeamRecord> = {}): TeamRecord {
  return {
    v: 1,
    team_id: teamId,
    name: teamId,
    tenant_id: 'default',
    workspace: `/workspace/${teamId}`,
    policy: {},
    created_at: 1,
    ...overrides,
  };
}

/**
 * TeamService 用的假 AgentService：只实现 TeamService 依赖的方法
 * （list / identify / dispatch / reinstate / close / subscribe），其余经 cast 忽略。
 * close 默认同步发 agent.closed，供 archive / leave 系统消息测试。
 */
export class FakeTeamAgent {
  readonly members: MemberStatus[];
  readonly dispatches: DispatchInput[] = [];
  readonly closes: string[] = [];
  readonly reinstates: ReinstateInput[] = [];
  dispatchImpl: ((input: DispatchInput) => DispatchResult | Promise<DispatchResult>) | undefined;
  listError: Error | undefined;
  emitOnClose = true;
  /** 成员 send 继承的当前会话（agentId → conversation_id） */
  readonly currentConversations = new Map<string, string>();
  /** budget() 的替身；未设置时抛错（与无端口一致） */
  budgetImpl:
    | ((input: BudgetStatusInput | BudgetOverrideInput) => BudgetOverview | Promise<BudgetOverview>)
    | undefined;
  private readonly listeners = new Set<AgentEventListener>();

  constructor(
    members: MemberStatus[] = [],
    private readonly now: () => number = Date.now,
  ) {
    this.members = [...members];
  }

  async list(filter: ListFilter = {}): Promise<MemberStatus[]> {
    if (this.listError !== undefined) throw this.listError;
    return this.members.filter((member) => {
      if (member.visibility !== 'private') return true;
      return filter.viewer !== undefined && filter.viewer === member.owner;
    });
  }

  async identify(sessionId: string): Promise<MemberStatus | undefined> {
    return this.members.find(
      (member) => member.session_id === sessionId || member.id === sessionId,
    );
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    this.dispatches.push(input);
    if (this.dispatchImpl !== undefined) return this.dispatchImpl(input);
    return {
      status: 'queued',
      message_id: `dispatch-${this.dispatches.length}`,
      resolved_to: input.to,
      resolution: 'live',
    };
  }

  currentConversation(agentId: string): string | undefined {
    return this.currentConversations.get(agentId);
  }

  async budget(input: BudgetStatusInput | BudgetOverrideInput): Promise<BudgetOverview> {
    if (this.budgetImpl === undefined) throw new Error('budget unavailable');
    return this.budgetImpl(input);
  }

  async reinstate(input: ReinstateInput): Promise<MemberStatus> {
    this.reinstates.push(input);
    const target = this.members.find(
      (member) => member.id === input.to || member.session_id === input.to,
    );
    if (target === undefined) throw new Error(`unknown_member: ${input.to}`);
    target.team_id = input.team_id;
    target.membership = 'present';
    target.state = 'idle';
    return target;
  }

  async close(input: CloseInput): Promise<CloseResult> {
    const id = input.member ?? input.to;
    if (id === undefined) throw new Error('close requires member');
    this.closes.push(id);
    const target = this.members.find((member) => member.id === id || member.session_id === id);
    if (target !== undefined) {
      target.membership = 'left';
      target.state = 'closed';
      target.presence = 'gone';
      if (this.emitOnClose && target.team_id !== undefined) {
        this.emit({
          type: 'agent.closed',
          agent_id: target.id,
          team_id: target.team_id,
          visibility: target.visibility,
          ts: this.now(),
        });
      }
    }
    return { state: 'closed' };
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** 内存 TeamStore：读写同步落内存，可注入 append 失败 */
export class MemoryTeamStore implements TeamStore {
  readonly records: TeamRecord[];
  readonly logs: TeamLogEntry[] = [];
  appendError: Error | undefined;

  constructor(records: TeamRecord[] = []) {
    this.records = [...records];
  }

  async ensureForWorkspace(input: {
    workspace: string;
    name?: string;
    policy?: Record<string, unknown>;
  }): Promise<TeamRecord> {
    const existing = this.records.find((record) => record.workspace === input.workspace);
    if (existing !== undefined) return existing;
    const record = makeTeam(input.name ?? 'workspace', { workspace: input.workspace });
    this.records.push(record);
    return record;
  }

  async seed(_declarations: readonly TeamDeclaration[]): Promise<void> {}

  async create(input: TeamCreateInput): Promise<{ record: TeamRecord; deduplicated: boolean }> {
    const existing = this.records.find((record) => record.workspace === input.workspace);
    if (existing !== undefined) return { record: existing, deduplicated: true };
    const teamId = input.workspace.split('/').pop() ?? 'workspace';
    const record = makeTeam(teamId, {
      workspace: input.workspace,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.policy !== undefined ? { policy: input.policy } : {}),
    });
    this.records.push(record);
    return { record, deduplicated: false };
  }

  async update(teamId: string, patch: TeamUpdatePatch): Promise<TeamRecord> {
    const index = this.records.findIndex((record) => record.team_id === teamId);
    const current = this.records[index];
    if (current === undefined) throw new Error(`team_not_found: ${teamId}`);
    if (current.archived_at !== undefined) throw new Error(`team_archived: ${teamId}`);
    const next: TeamRecord = { ...current, policy: { ...current.policy } };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description !== undefined) {
      if (patch.description === null) delete next.description;
      else next.description = patch.description;
    }
    if (patch.policy !== undefined) next.policy = { ...patch.policy };
    this.records[index] = next;
    return next;
  }

  async archive(teamId: string): Promise<TeamRecord> {
    const index = this.records.findIndex((record) => record.team_id === teamId);
    const current = this.records[index];
    if (current === undefined) throw new Error(`team_not_found: ${teamId}`);
    if (current.archived_at !== undefined) return current;
    const next = { ...current, archived_at: 1 };
    this.records[index] = next;
    return next;
  }

  async setSpawnFrozen(teamId: string, frozen: boolean): Promise<TeamRecord> {
    const index = this.records.findIndex((record) => record.team_id === teamId);
    const current = this.records[index];
    if (current === undefined) throw new TeamError('team_not_found', `team_not_found: ${teamId}`);
    if (current.archived_at !== undefined) {
      throw new TeamError('team_archived', `team_archived: ${teamId}`);
    }
    const next: TeamRecord = { ...current, policy: { ...current.policy } };
    if (frozen) next.spawn_frozen = true;
    else delete next.spawn_frozen;
    this.records[index] = next;
    return next;
  }

  get(teamId: string): TeamRecord | undefined {
    return this.records.find((record) => record.team_id === teamId);
  }

  policy(teamId: string): TeamPolicy | undefined {
    const record = this.get(teamId);
    return record === undefined ? undefined : (record.policy as TeamPolicy);
  }

  list(): TeamRecord[] {
    return [...this.records];
  }

  async readLog(teamId: string, options: { limit?: number } = {}): Promise<TeamLogEntry[]> {
    const entries = this.logs.filter((entry) => entry.team_id === teamId);
    return options.limit === undefined ? entries : entries.slice(-options.limit);
  }

  async appendLog(entry: TeamLogEntry): Promise<void> {
    if (this.appendError !== undefined) throw this.appendError;
    this.logs.push(entry);
  }

  async flush(): Promise<void> {}
}

export interface TeamHarness {
  service: DefaultTeamService;
  agent: FakeTeamAgent;
  store: MemoryTeamStore;
}

/** 组装 DefaultTeamService + 假 AgentService + 内存 TeamStore */
export function makeTeamHarness(
  options: {
    members?: MemberStatus[];
    teams?: TeamRecord[];
    now?: () => number;
    newId?: () => string;
  } = {},
): TeamHarness {
  const agent = new FakeTeamAgent(options.members ?? [], options.now);
  const store = new MemoryTeamStore(options.teams ?? [makeTeam('alpha'), makeTeam('beta')]);
  let counter = 0;
  const service = createTeamService({
    tenantId: 'default',
    agent: agent as unknown as AgentService,
    store,
    now: options.now,
    newId: options.newId ?? (() => `team-${++counter}`),
  });
  return { service, agent, store };
}
