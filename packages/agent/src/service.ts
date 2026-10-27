/**
 * AgentService：Agent 身份、多 Body 生命周期、统一准入与回复投递。
 *
 * 0.27 不变量：
 * - 一个 Agent 可有多个 live Body（`body_id ≡ session_id`），每 Body 独立 runtime /
 *   历史 / checkpoint / 队列；同 Body 串行、不同 Body 并发由 Scheduler 保证；
 * - 所有入口（send / dispatch / Team @ / runs.start）只调用 `admit`；
 * - `run.*` 是唯一执行生命周期，本服务不 emit `agent.turn.*` / `agent.reply.posted`；
 * - 队列按 Body，不按 Agent；预算 block 的消息留在 Body mailbox。
 *
 * @module @vessel-agent/agent
 */

import { randomUUID } from 'node:crypto';
import {
  type AgentHandle,
  assertTenantId,
  type EventStream,
  type Logger,
  noopLogger,
  type RunEvent,
  type RunHandle,
  type RunStatus,
  type RunStore,
  type RuntimePermissionConfig,
  type ScheduledTask,
  type Scheduler,
  type Usage,
} from '@vessel-agent/core';
import { generateConversationId, isValidConversationId } from './conversation-budget.js';
import {
  ADMIN_VIEWER,
  type AgentBodyRecord,
  liveBodies,
  type MemberRecord,
  MemberRegistry,
  primaryBody,
  toMemberStatus,
  toPersistedRecord,
  toRuntimeMember,
} from './registry.js';
import { AgentSnapshotStore, snapshotPath } from './snapshot.js';
import {
  type AdmitInput,
  type AdmitResult,
  type AgentDrainOptions,
  type AgentDrainOutcome,
  AgentError,
  type AgentEvent,
  type AgentEventListener,
  type AgentMessage,
  type AgentRole,
  type AgentService,
  type AgentServiceOptions,
  type AgentUpdateBatchInput,
  type AgentUpdateField,
  type AgentUpdateInput,
  type AgentUpdateResult,
  type BatchItemResult,
  type BatchResult,
  type BodyLeasePort,
  type BodyStatus,
  type BudgetBlockReason,
  type BudgetCheckResult,
  type BudgetOverrideInput,
  type BudgetOverview,
  type BudgetStatusInput,
  type CloseBatchInput,
  type CloseInput,
  type CloseResult,
  type ConversationBudgetPort,
  type CreateBatchInput,
  type CreateMemberInput,
  DEFAULT_OWNER,
  type DispatchInput,
  type DispatchResult,
  type ListFilter,
  MAX_MESSAGE_BYTES,
  type MemberPermissionState,
  type MemberRuntimeMember,
  type MemberState,
  type MemberStatus,
  type MemberTurnResult,
  type MemberVisibility,
  type PersistedAgentRecord,
  type ReinstateInput,
  type ReplyResult,
  type ResumeResult,
  type RotateInput,
  type RotateResult,
  type SendBatchInput,
  type SendInput,
  type SendResult,
  type TeamBinder,
} from './types.js';

const VISIBILITIES: readonly MemberVisibility[] = ['private', 'team', 'tenant'];

/** Team 内 present 成员上限（peer + contractor 都计入；后续可配置） */
const TEAM_MEMBER_LIMIT = 20;

/** 每 agent live body 上限缺省值 */
const DEFAULT_MAX_LIVE_BODIES = 20;

/**
 * turn 域预算维度：投递侧不拦（否则消息进不了 body mailbox，override 也无从恢复）；
 * 由 turn_start 检查后留在 mailbox，override / release 后重新准入。
 */
const TURN_DIMENSIONS: ReadonlySet<string> = new Set(['turns', 'tokens']);

/** 空闲 body TTL 缺省值（小时）；0 = 关闭 */
const DEFAULT_BODY_IDLE_TTL_HOURS = 24;

/** Body 执行态（对外 BodyStatus.state） */
type BodyExecState = 'idle' | 'running' | 'waiting_permission' | 'closed';

/** 单个 Body 的运行态（不落 snapshot） */
interface BodyEntry {
  agentId: string;
  bodyId: string;
  epoch: number;
  state: BodyExecState;
  primary: boolean;
  createdAt: number;
  lastActiveAt: number;
  retired: boolean;
  runtimeMember: MemberRuntimeMember;
  /** 预算 block 留在 mailbox 的消息；正常消息 submit 后即移出 */
  pending: AgentMessage[];
  /** 已提交给 scheduler、尚未开始执行的 run */
  queuedRuns: Set<string>;
  /** 正在执行的 run（同 body 同时最多一个） */
  active?: { runId: string; conversationId?: string; replied: boolean };
  budgetHold: Set<string>;
  /** `${session_id}|${key}`；rotate 成功 / close 时清空 */
  warnedSignals: Set<string>;
  closing: boolean;
  spawned: boolean;
  /** 在途 spawn（single-flight）：并发 admit 只 spawn 一次 */
  spawning?: Promise<void>;
  leaseHeld: boolean;
}

/** 事件 extra 允许预算字段（开放字符串事件，不在 AgentEvent 里加常量） */
type AgentEventExtra = Omit<Partial<AgentEvent>, 'type' | 'agent_id' | 'session_id' | 'ts'> &
  Record<string, unknown>;

/** 预算拒绝结果的窄类型 */
type BudgetBlockedCheck = Extract<BudgetCheckResult, { ok: false }>;

/** rotate 窗口内的旧 / 新 Body 身份（agentId → state） */
interface RotationState {
  fromSessionId: string;
  fromEpoch: number;
  toSessionId: string;
  toEpoch: number;
}

/** 0.20 fork 结果：成功带新记录；失败带稳定 code 与 `code: reason` 文本 */
type ForkOutcome =
  | { ok: true; member: MemberRecord }
  | {
      ok: false;
      code: 'fork_not_allowed' | 'fork_failed' | 'agent_left' | 'team_full' | 'team_frozen';
      reason: string;
    };

/** 一次准入的内部结果（message_id 供 send / dispatch 复用） */
interface AdmitOutcome {
  result: AdmitResult;
  message: AgentMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** 稳定错误码：只取错误对象自带的 string `code`，不猜测 / 不解析消息 */
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

/** 按输入顺序把 allSettled 转成逐条结果；单条失败不影响其它条目 */
function settleBatch<T>(settled: PromiseSettledResult<T>[]): BatchResult<T> {
  return {
    results: settled.map((item): BatchItemResult<T> => {
      if (item.status === 'fulfilled') return { ok: true, status: item.value };
      const code = errorCode(item.reason);
      return {
        ok: false,
        error: errorText(item.reason),
        ...(code !== undefined ? { code } : {}),
      };
    }),
  };
}

/** 校验 visibility 或返回缺省 */
function resolveVisibility(value: unknown, fallback: MemberVisibility): MemberVisibility {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !VISIBILITIES.includes(value as MemberVisibility)) {
    throw new AgentError(
      'invalid_input',
      `invalid visibility "${String(value)}" (expected private|team|tenant)`,
    );
  }
  return value as MemberVisibility;
}

/** 内部 Body → 对外状态 */
function toBodyStatus(entry: BodyEntry): BodyStatus {
  return {
    session_id: entry.bodyId,
    epoch: entry.epoch,
    state: entry.state,
    primary: entry.primary,
    created_at: entry.createdAt,
    last_active_at: entry.lastActiveAt,
  };
}

/** 从快照恢复记录：engine 状态是进程内易失，重启后非 left 一律 idle + gone */
function recordFromStatus(status: PersistedAgentRecord, now: number): MemberRecord {
  const state: MemberState =
    status.membership === 'left' || status.state === 'closed' ? 'closed' : 'idle';
  const bodies: AgentBodyRecord[] = (status.bodies ?? []).map((body) => ({
    bodyId: body.body_id,
    epoch: body.epoch,
    createdAt: body.created_at,
    lastActiveAt: body.last_active_at,
    ...(body.retired_at !== undefined ? { retiredAt: body.retired_at } : {}),
    primary: body.primary === true,
  }));
  if (bodies.length === 0) {
    const live = status.current_body ?? {
      session_id: status.session_id,
      epoch: 0,
      started_at: status.last_seen ?? now,
    };
    bodies.push({
      bodyId: live.session_id,
      epoch: live.epoch,
      createdAt: live.started_at,
      lastActiveAt: status.last_seen ?? live.started_at,
      primary: true,
    });
  }
  const primaryBodyId =
    status.primary_body_id ??
    status.current_body?.session_id ??
    bodies.find((body) => body.primary && body.retiredAt === undefined)?.bodyId;
  const primary = bodies.find((body) => body.bodyId === primaryBodyId);
  return {
    id: status.id,
    sessionId: status.session_id,
    bodies,
    ...(primaryBodyId !== undefined ? { primaryBodyId } : {}),
    ...(primary !== undefined
      ? {
          currentBody: {
            session_id: primary.bodyId,
            epoch: primary.epoch,
            started_at: primary.createdAt,
          },
        }
      : {}),
    ...(status.name !== undefined ? { name: status.name } : {}),
    ...(status.parent_id !== undefined ? { parentId: status.parent_id } : {}),
    role: status.role,
    owner: status.owner,
    visibility: status.visibility,
    state,
    presence: 'gone',
    membership: status.membership,
    ...(status.team_id !== undefined ? { teamId: status.team_id } : {}),
    rotation: 'stable',
    bodyHistory: status.body_history ?? [],
    ...(status.model !== undefined ? { model: status.model } : {}),
    ...(status.system_prompt !== undefined ? { systemPrompt: status.system_prompt } : {}),
    ...(status.forked_from !== undefined ? { forkedFrom: status.forked_from } : {}),
    ...(status.current_tool !== undefined ? { currentTool: status.current_tool } : {}),
    ...(status.last_seen !== undefined ? { lastSeen: status.last_seen } : {}),
    ...(status.usage !== undefined ? { usage: status.usage } : {}),
  };
}

/** Scheduler 返回的 RunHandle 适配器：把 runtime 轮次包装成 run 生命周期 */
class BodyRunHandle implements RunHandle {
  readonly result: Promise<string>;
  private state: RunStatus = 'running';
  private usageValue: Usage | undefined;
  private resolveResult!: (value: string) => void;
  private rejectResult!: (reason?: unknown) => void;
  cancelRequested = false;
  cancelHandler: ((reason?: string) => void) | undefined;

  constructor(
    readonly id: string,
    readonly agentId: string,
    readonly sessionId: string,
  ) {
    this.result = new Promise<string>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    void this.result.catch(() => {});
  }

  status(): RunStatus {
    return this.state;
  }

  usage(): Usage | undefined {
    return this.usageValue;
  }

  setUsage(usage: Usage | undefined): void {
    this.usageValue = usage;
  }

  cancel(reason?: string): void {
    if (this.terminal()) return;
    this.cancelRequested = true;
    this.cancelHandler?.(reason);
  }

  terminal(): boolean {
    return this.state === 'completed' || this.state === 'failed' || this.state === 'cancelled';
  }

  complete(content: string): void {
    if (this.terminal()) return;
    this.state = 'completed';
    this.resolveResult(content);
  }

  fail(error: unknown): void {
    if (this.terminal()) return;
    this.state = 'failed';
    this.rejectResult(error instanceof Error ? error : new Error(String(error)));
  }

  markCancelled(reason?: string): void {
    if (this.terminal()) return;
    this.state = 'cancelled';
    this.rejectResult(new Error(reason ?? 'run cancelled'));
  }
}

/** 默认实现 */
export class AgentServiceImpl implements AgentService {
  private readonly registry: MemberRegistry;
  private readonly runtime: AgentServiceOptions['runtime'];
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly logger: Logger;
  private readonly snapshot: AgentSnapshotStore | undefined;
  private readonly maxLiveBodies: number;
  private readonly bodyIdleTtlMs: number;
  private readonly bodyLease: BodyLeasePort | undefined;
  private readonly runStore: RunStore | undefined;
  /** AgentService 的 body registry：agentId → bodyId → BodyEntry（含已退役直到清理） */
  private readonly bodyRegistry = new Map<string, Map<string, BodyEntry>>();
  /** run_id → 准入消息 id（send / dispatch 复用） */
  private readonly runMessageIds = new Map<string, string>();
  /** drain 之后不再从队列起新轮（关闭窗口内排队的消息随进程退出丢弃） */
  private draining = false;
  /** 同一源成员的 single-flight fork；并发只 spawn 一个新 Agent */
  private readonly forking = new Map<string, Promise<ForkOutcome>>();
  /** 进行中的 rotate（agentId → 旧 / 新 Body）；只在内存 */
  private readonly rotations = new Map<string, RotationState>();
  private readonly listeners = new Set<AgentEventListener>();
  private readonly tenantId: string;
  private readonly eventStream: EventStream | undefined;
  private readonly defaultModel: string | undefined;
  /** `create` 未显式指定 owner 时的默认 owner；不持久化 */
  private readonly defaultOwner: string;
  /** `new` 未显式传 workspace 时的默认 workspace；无配置声明时为 undefined */
  private readonly defaultWorkspace: string | undefined;
  private readonly teamBinder: TeamBinder | undefined;
  private readonly teamPolicy: AgentServiceOptions['teamPolicy'];
  private readonly budgetPort: ConversationBudgetPort | undefined;
  /** 进程内 blocked 事件去重（每个 conversation 一次；release / override 清） */
  private readonly blockedBudgetEvents = new Set<string>();
  private readonly ready: Promise<void>;

  constructor(options: AgentServiceOptions) {
    if (!options || !nonEmpty(options.tenantId)) {
      throw new AgentError('invalid_input', 'tenantId is required');
    }
    assertTenantId(options.tenantId);
    if (!options.runtime) {
      throw new AgentError('invalid_input', 'runtime is required');
    }
    if (!options.scheduler) {
      throw new AgentError('invalid_input', 'scheduler is required');
    }

    this.registry = new MemberRegistry(options.now);
    this.runtime = options.runtime;
    this.scheduler = options.scheduler;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.logger = options.logger ?? noopLogger;
    this.tenantId = options.tenantId;
    this.eventStream = options.events;
    this.defaultModel = options.defaultModel;
    this.defaultOwner = options.ownerId ?? DEFAULT_OWNER;
    this.defaultWorkspace = nonEmpty(options.defaultWorkspace)
      ? options.defaultWorkspace
      : undefined;
    this.teamBinder = options.teamBinder;
    this.teamPolicy = options.teamPolicy;
    this.budgetPort = options.budget;
    this.maxLiveBodies =
      typeof options.maxLiveBodies === 'number' && options.maxLiveBodies > 0
        ? Math.floor(options.maxLiveBodies)
        : DEFAULT_MAX_LIVE_BODIES;
    const ttlHours =
      typeof options.bodyIdleTtlHours === 'number' && options.bodyIdleTtlHours >= 0
        ? options.bodyIdleTtlHours
        : DEFAULT_BODY_IDLE_TTL_HOURS;
    this.bodyIdleTtlMs = ttlHours * 60 * 60 * 1000;
    this.bodyLease = options.bodyLease;
    this.runStore = options.runStore;

    const dataDir = options.dataDir;
    const snapshotEnabled = dataDir !== undefined && options.snapshot?.enabled !== false;
    this.snapshot =
      snapshotEnabled && dataDir !== undefined
        ? new AgentSnapshotStore(snapshotPath(dataDir, options.tenantId), options.tenantId, {
            ...(options.snapshot?.throttleMs !== undefined
              ? { throttleMs: options.snapshot.throttleMs }
              : {}),
            ...(options.snapshot?.mode !== undefined ? { mode: options.snapshot.mode } : {}),
            logger: this.logger,
            now: this.now,
          })
        : undefined;
    this.ready = this.loadSnapshot();
  }

  /**
   * 重启恢复：非 left 成员一律 idle + gone（engine 状态是进程内易失）。
   * Body 只恢复记录，运行时在首次 admit 时惰性重建。
   */
  private async loadSnapshot(): Promise<void> {
    if (!this.snapshot) return;
    let members: PersistedAgentRecord[] = [];
    try {
      members = await this.snapshot.load();
    } catch (error) {
      this.logger.error('agent.snapshot.load_failed', { error: errorText(error) });
      return;
    }
    const idsByName = new Map<string, string[]>();
    let restored = 0;
    for (const status of members) {
      const record = recordFromStatus(status, this.now());
      try {
        this.registry.add(record);
        restored += 1;
      } catch (error) {
        this.logger.warn('agent.snapshot.member_skipped', {
          member_id: status.id,
          error: errorText(error),
        });
        continue;
      }
      if (record.name !== undefined) {
        const ids = idsByName.get(record.name);
        if (ids === undefined) idsByName.set(record.name, [record.id]);
        else ids.push(record.id);
      }
      if (record.membership === 'present') {
        this.emit('agent.stale', record, { state: 'idle', presence: 'gone' });
      }
    }
    for (const [name, ids] of idsByName) {
      if (ids.length > 1) {
        this.logger.warn('agent.snapshot.duplicate_name', { name, ids });
      }
    }
    if (restored > 0) this.scheduleSnapshot();
  }

  async create(input: CreateMemberInput): Promise<MemberStatus>;
  async create(input: CreateBatchInput): Promise<BatchResult<MemberStatus>>;
  async create(
    input: CreateMemberInput | CreateBatchInput,
  ): Promise<MemberStatus | BatchResult<MemberStatus>> {
    await this.ready;
    const record = input as unknown as Record<string, unknown>;
    if ('members' in record) {
      if (
        record.id !== undefined ||
        record.role !== undefined ||
        record.name !== undefined ||
        record.model !== undefined ||
        record.systemPrompt !== undefined ||
        record.visibility !== undefined ||
        record.parentId !== undefined ||
        record.owner !== undefined ||
        record.kind !== undefined ||
        record.teamId !== undefined ||
        record.spawnedBy !== undefined ||
        record.workspace !== undefined
      ) {
        throw new AgentError(
          'invalid_input',
          'pass either single member fields or members, not both',
        );
      }
      const members = record.members;
      if (!Array.isArray(members)) {
        throw new AgentError('invalid_input', 'members must be an array');
      }
      if (members.length === 0) {
        throw new AgentError('invalid_input', 'members must not be empty');
      }
      const settled = await Promise.allSettled(
        members.map((entry) =>
          isRecord(entry)
            ? this.createOne(entry)
            : Promise.reject(new AgentError('invalid_input', 'member entries must be objects')),
        ),
      );
      return settleBatch(settled);
    }
    return this.createOne(record);
  }

  private async createOne(input: Record<string, unknown>): Promise<MemberStatus> {
    const kind = input.kind;
    if (kind !== undefined && kind !== 'peer' && kind !== 'contractor') {
      throw new AgentError('invalid_input', 'kind must be peer or contractor');
    }
    const rawOwner = input.owner;
    if (rawOwner !== undefined && rawOwner !== null && !nonEmpty(rawOwner)) {
      throw new AgentError('invalid_input', 'owner must be a non-empty string or null');
    }
    const explicitRole = input.role === undefined ? undefined : readAgentRole(input, 'role');
    if (explicitRole === 'single') {
      return this.createSingle(input);
    }
    if (kind === 'contractor' && rawOwner === null) {
      throw new AgentError('invalid_input', 'contractor requires an owner');
    }
    const peer = kind === 'peer' || rawOwner === null;
    if (peer && typeof rawOwner === 'string') {
      throw new AgentError('invalid_input', 'peer must not specify an owner');
    }

    const id = input.id === undefined ? this.newId() : readRequiredString(input, 'id');
    if (!nonEmpty(id)) throw new AgentError('invalid_input', 'id generator returned an empty id');
    if (this.registry.resolve(id) !== undefined || this.registry.getBySession(id) !== undefined) {
      throw new AgentError('invalid_input', `duplicate member id: ${id}`);
    }
    // v3 映射：peer → member（owner=self）；contractor / 无 kind → temporary（owner=雇佣者）。
    const role: AgentRole = peer ? 'member' : 'temporary';
    const owner = role === 'member' ? id : ((rawOwner as string | undefined) ?? this.defaultOwner);

    const name = optionalString(input.name);
    const spawnedBy = optionalString(input.spawnedBy);
    // 显式 workspace 只由 CLI 传入；默认 workspace 来自配置声明。
    const explicitWorkspace =
      input.workspace === undefined ? undefined : readRequiredString(input, 'workspace');
    const explicitTeamId =
      input.teamId === undefined ? undefined : readRequiredString(input, 'teamId');
    if (explicitTeamId !== undefined && explicitWorkspace !== undefined) {
      throw new AgentError('invalid_input', 'pass either teamId or workspace, not both');
    }

    let teamId: string | undefined;
    if (explicitTeamId !== undefined) {
      if (this.teamBinder === undefined || this.teamBinder.get(explicitTeamId) === undefined) {
        throw new AgentError('invalid_input', `team_not_found: ${explicitTeamId}`);
      }
      teamId = explicitTeamId;
    } else {
      const workspace = explicitWorkspace ?? this.defaultWorkspace;
      if (workspace !== undefined && name !== undefined) {
        if (this.teamBinder === undefined) {
          throw new AgentError('invalid_input', 'team binding is not configured');
        }
        // Team ensure 必须在名字检查 / registry.add 之前完成（F7：之后不得有 await）。
        const team = await this.teamBinder.ensureForWorkspace({ workspace, name });
        teamId = team.team_id;
      } else if (explicitWorkspace !== undefined) {
        // 默认 workspace 无名字时保持 unbound；显式 workspace 无名字则拒绝绑定。
        throw new AgentError('invalid_input', 'team binding requires a name');
      }
    }

    if (peer && teamId === undefined) {
      throw new AgentError('invalid_input', 'peer members require a team');
    }

    let parentId: string | undefined;
    if (role === 'member') {
      if (input.parentId !== undefined) {
        throw new AgentError('invalid_input', 'peer members must not have a parent');
      }
    } else {
      parentId = optionalString(input.parentId);
      // contractor 缺省以 owner（雇佣者）为 parent；无 kind 的旧请求保持无 parent。
      if (kind === 'contractor' && parentId === undefined) parentId = owner;
    }

    // member 强制 team 可见；temporary 缺省 team（有 Team）或 private（unbound）。
    let visibility: MemberVisibility;
    if (role === 'member') {
      if (input.visibility !== undefined && input.visibility !== 'team') {
        throw new AgentError('invalid_input', 'peer members must use team visibility');
      }
      visibility = 'team';
    } else {
      visibility =
        input.visibility === undefined
          ? teamId !== undefined
            ? 'team'
            : 'private'
          : resolveVisibility(input.visibility, 'private');
    }

    // 冻结 / 上限 / 名称检查 / registry.add 之间不得有 await（F7）。
    if (teamId !== undefined && this.teamBinder?.get(teamId)?.spawn_frozen === true) {
      throw new AgentError('team_frozen', `team_frozen: ${teamId}`);
    }
    if (teamId !== undefined && this.presentTeamCount(teamId) >= TEAM_MEMBER_LIMIT) {
      throw new AgentError('team_full', `team_full: ${teamId}`);
    }
    // 名称只由 present 成员占用：同 Team 内唯一；unbound 沿用 tenant 全扫。
    // 名字表达的是职位 / 功能，同 Team 已有同名成员说明这个职能已经有人承担：
    // 复用已存在的成员，不再造一个同职能的。create / hire 不发消息，所以
    // 「返回 id 让调用方自己决定要不要 send」不会引入隐式动作。
    if (name !== undefined) {
      const existing = this.reusableByName(name, teamId);
      if (existing !== undefined) return { ...this.statusFor(existing), reused: true };
    }
    const resolvedName = name !== undefined ? name : this.autoNameFor(spawnedBy, teamId);

    const now = this.now();
    const record: MemberRecord = {
      id,
      sessionId: id,
      bodies: [
        {
          bodyId: id,
          epoch: 0,
          createdAt: now,
          lastActiveAt: now,
          primary: true,
        },
      ],
      primaryBodyId: id,
      currentBody: { session_id: id, epoch: 0, started_at: now },
      role,
      owner,
      visibility,
      state: 'created',
      presence: 'gone',
      membership: 'present',
      rotation: 'stable',
      bodyHistory: [],
    };
    record.name = resolvedName;
    if (teamId !== undefined) record.teamId = teamId;
    if (parentId !== undefined) record.parentId = parentId;
    // 落“有效 model”：未显式指定时用 wiring 默认值，resume 才不会回流到空
    const model = optionalString(input.model) ?? this.defaultModel;
    if (model !== undefined) record.model = model;
    const systemPrompt = optionalString(input.systemPrompt);
    if (systemPrompt !== undefined) record.systemPrompt = systemPrompt;

    try {
      await this.spawnRecord(record);
    } catch (error) {
      throw new AgentError('spawn_failed', `spawn_failed: ${errorText(error)}`);
    }
    this.emit('agent.spawned', record, {
      state: 'idle',
      presence: 'live',
      ...(spawnedBy !== undefined ? { spawned_by: spawnedBy } : {}),
    });
    return this.statusFor(record);
  }

  /**
   * `main` 等普通 single agent（0.27）：owner=self、无 Team / parent、private（可显式）。
   * 不 attachOwner、无外部 owner 队列。
   */
  private async createSingle(input: Record<string, unknown>): Promise<MemberStatus> {
    const id = input.id === undefined ? this.newId() : readRequiredString(input, 'id');
    if (!nonEmpty(id)) throw new AgentError('invalid_input', 'id generator returned an empty id');
    if (this.registry.get(id) !== undefined || this.registry.getBySession(id) !== undefined) {
      throw new AgentError('invalid_input', `duplicate member id: ${id}`);
    }
    if (input.teamId !== undefined || input.workspace !== undefined) {
      throw new AgentError('invalid_input', 'single agents must not bind a team');
    }
    // 与 createOne 同一语义：同名 present 成员已存在则复用，不新建。
    // `main` 等启动路径只传 `{ id, role }`、不传 name，占不到这个分支。
    const name = optionalString(input.name);
    if (name !== undefined) {
      const existing = this.reusableByName(name, undefined);
      if (existing !== undefined) return { ...this.statusFor(existing), reused: true };
    }
    const now = this.now();
    const record: MemberRecord = {
      id,
      sessionId: id,
      bodies: [{ bodyId: id, epoch: 0, createdAt: now, lastActiveAt: now, primary: true }],
      primaryBodyId: id,
      currentBody: { session_id: id, epoch: 0, started_at: now },
      ...(name !== undefined ? { name } : {}),
      role: 'single',
      owner: id,
      visibility: resolveVisibility(input.visibility, 'private'),
      state: 'created',
      presence: 'gone',
      membership: 'present',
      rotation: 'stable',
      bodyHistory: [],
    };
    const model = optionalString(input.model) ?? this.defaultModel;
    if (model !== undefined) record.model = model;
    const systemPrompt = optionalString(input.systemPrompt);
    if (systemPrompt !== undefined) record.systemPrompt = systemPrompt;
    try {
      await this.spawnRecord(record);
    } catch (error) {
      throw new AgentError('spawn_failed', `spawn_failed: ${errorText(error)}`);
    }
    this.emit('agent.spawned', record, { state: 'idle', presence: 'live' });
    return this.statusFor(record);
  }

  /** 同 Team 的 present 成员数（上限闸门；与 name 检查同在无 await 窗口） */
  private presentTeamCount(teamId: string): number {
    let count = 0;
    for (const record of this.registry.all()) {
      if (record.membership === 'present' && record.teamId === teamId) count += 1;
    }
    return count;
  }

  /** name 是否被 present 成员占用：同 Team 内唯一；unbound 沿用 tenant 全扫 */
  private nameOccupied(name: string, teamId: string | undefined): boolean {
    return this.reusableByName(name, teamId) !== undefined;
  }

  /**
   * 同 Team present 成员里叫这个名字的那个（unbound 时 tenant 全扫）。
   * 名字是职能标签，重名即「这个职能已有人做」——create / hire 复用它而不是新建。
   */
  private reusableByName(name: string, teamId: string | undefined): MemberRecord | undefined {
    return this.registry
      .findByName(name)
      .find(
        (record) =>
          record.membership === 'present' && (teamId === undefined || record.teamId === teamId),
      );
  }

  /**
   * `${base}-2..${base}-101` 中第一个未被占用的名字；100 次仍冲突则 name_exhausted。
   * 占用判据就是 `nameOccupied`：同 Team 的 present 成员（unbound 时 tenant 全扫），
   * 不同 Team 可以同名。
   */
  private numberedNameFor(base: string, teamId: string | undefined): string {
    for (let index = 2; index <= 101; index += 1) {
      const candidate = `${base}-${index}`;
      if (!this.nameOccupied(candidate, teamId)) return candidate;
    }
    throw new AgentError('invalid_input', `name_exhausted: ${base}`);
  }

  /** 缺省名：以派生出的 base 走 numbering */
  private autoNameFor(spawnedBy: string | undefined, teamId: string | undefined): string {
    const base =
      (spawnedBy !== undefined ? this.registry.resolve(spawnedBy)?.name : undefined) ??
      spawnedBy ??
      'agent';
    return this.numberedNameFor(base, teamId);
  }

  /**
   * 创建路径共用的 spawn / 回滚骨架（createOne / createSingle / fork）。
   * registry.add → 首个 Body lease + runtime.spawn；失败移除记录 / Body 后重抛。
   */
  private async spawnRecord(record: MemberRecord): Promise<void> {
    const body = primaryBody(record);
    if (body === undefined) throw new Error('missing initial body');
    this.registry.add(record);
    let entry: BodyEntry | undefined;
    try {
      entry = await this.entryFor(record, body, true);
      await this.runtime.spawn(entry.runtimeMember);
      entry.spawned = true;
    } catch (error) {
      if (entry !== undefined) await this.disposeEntry(entry);
      this.registry.remove(record.id);
      this.bodyRegistry.delete(record.id);
      throw error;
    }
    this.registry.setState(record.id, 'idle');
    this.registry.setPresence(record.id, 'live');
    this.scheduleSnapshot();
  }

  /**
   * 0.20 fork：resume 失败后的兜底。single-flight（同一源并发只 spawn 一次）。
   * 失败一律显式且零写入；成功时源仍保持 present + gone。
   */
  private async ensureForked(sourceId: string): Promise<ForkOutcome> {
    const inflight = this.forking.get(sourceId);
    if (inflight) return inflight;
    const promise = this.forkOne(sourceId);
    this.forking.set(sourceId, promise);
    try {
      return await promise;
    } finally {
      if (this.forking.get(sourceId) === promise) this.forking.delete(sourceId);
    }
  }

  private async forkOne(sourceId: string): Promise<ForkOutcome> {
    const source = this.registry.get(sourceId);
    // fork 不是复活路径：left / closed / 正在关闭一律 agent_left。
    if (
      source === undefined ||
      source.membership === 'left' ||
      source.state === 'closed' ||
      this.hasClosingBody(sourceId)
    ) {
      return { ok: false, code: 'agent_left', reason: `agent_left: ${sourceId}` };
    }
    if (source.visibility === 'private') {
      return { ok: false, code: 'fork_not_allowed', reason: 'fork_not_allowed: private' };
    }
    const teamId = source.teamId;
    if (teamId === undefined || this.teamBinder === undefined) {
      return { ok: false, code: 'fork_not_allowed', reason: 'fork_not_allowed: no_team' };
    }
    const team = this.teamBinder.get(teamId);
    if (team === undefined) {
      return { ok: false, code: 'fork_not_allowed', reason: 'fork_not_allowed: no_team' };
    }
    if (team.spawn_frozen === true) {
      return { ok: false, code: 'team_frozen', reason: `team_frozen: ${teamId}` };
    }
    if (this.presentTeamCount(teamId) >= TEAM_MEMBER_LIMIT) {
      return { ok: false, code: 'team_full', reason: `team_full: ${teamId}` };
    }

    const existingFork = this.registry
      .all()
      .find((record) => record.forkedFrom === sourceId && record.membership === 'present');
    if (existingFork !== undefined) {
      return {
        ok: false,
        code: 'fork_not_allowed',
        reason: `fork_not_allowed: already_forked:${existingFork.id}`,
      };
    }

    const name = this.forkNameFor(source.name ?? source.id, teamId);
    if (name === undefined) {
      return { ok: false, code: 'fork_not_allowed', reason: 'fork_not_allowed: name_exhausted' };
    }

    const id = this.newId();
    if (!nonEmpty(id) || this.registry.resolve(id) !== undefined) {
      return { ok: false, code: 'fork_failed', reason: 'fork_failed: session_id_collision' };
    }

    const now = this.now();
    const record: MemberRecord = {
      id,
      sessionId: id,
      bodies: [{ bodyId: id, epoch: 0, createdAt: now, lastActiveAt: now, primary: true }],
      primaryBodyId: id,
      currentBody: { session_id: id, epoch: 0, started_at: now },
      name,
      role: source.role,
      // member / single 的 owner 恒为 self；temporary 沿用雇佣者。
      owner: source.role === 'temporary' ? source.owner : id,
      visibility: source.visibility,
      state: 'created',
      presence: 'gone',
      membership: 'present',
      teamId,
      rotation: 'stable',
      bodyHistory: [],
      forkedFrom: source.id,
    };
    if (source.systemPrompt !== undefined) record.systemPrompt = source.systemPrompt;
    if (source.parentId !== undefined) record.parentId = source.parentId;
    if (source.model !== undefined) record.model = source.model;
    else if (this.defaultModel !== undefined) record.model = this.defaultModel;

    try {
      await this.spawnRecord(record);
    } catch (error) {
      return { ok: false, code: 'fork_failed', reason: `fork_failed: ${errorText(error)}` };
    }

    // spawn 期间源可能已被 close：踢人不得凭空产生新 Agent。
    const currentSource = this.registry.get(source.id);
    if (
      currentSource === undefined ||
      currentSource.membership === 'left' ||
      currentSource.state === 'closed' ||
      this.hasClosingBody(source.id)
    ) {
      await this.disposeAgentBodies(record);
      this.registry.remove(record.id);
      this.scheduleSnapshot();
      return { ok: false, code: 'agent_left', reason: `agent_left: ${sourceId}` };
    }

    this.emit('agent.forked', record, {
      state: 'idle',
      presence: 'live',
      from: source.id,
      to: record.id,
    });
    return { ok: true, member: record };
  }

  /** `base-fork` → `base-fork-2..100`；同 Team present 占用才跳过。耗尽返回 undefined。 */
  private forkNameFor(base: string, teamId: string): string | undefined {
    for (let index = 1; index <= 100; index += 1) {
      const candidate = index === 1 ? `${base}-fork` : `${base}-fork-${index}`;
      const occupied = this.registry
        .findByName(candidate)
        .some((record) => record.membership === 'present' && record.teamId === teamId);
      if (!occupied) return candidate;
    }
    return undefined;
  }

  // ─── Body registry ──────────────────────────────────────────────

  private entryMap(agentId: string): Map<string, BodyEntry> {
    let map = this.bodyRegistry.get(agentId);
    if (!map) {
      map = new Map();
      this.bodyRegistry.set(agentId, map);
    }
    return map;
  }

  private liveEntries(agentId: string): BodyEntry[] {
    const map = this.bodyRegistry.get(agentId);
    if (!map) return [];
    return [...map.values()].filter((entry) => !entry.retired && !entry.closing);
  }

  private findEntry(agentId: string, bodyId: string): BodyEntry | undefined {
    return this.bodyRegistry.get(agentId)?.get(bodyId);
  }

  private hasClosingBody(agentId: string): boolean {
    return this.liveEntries(agentId).some((entry) => entry.closing);
  }

  /** 从记录构造 BodyEntry；`withLease` 时获取跨进程租约 */
  private async entryFor(
    record: MemberRecord,
    body: AgentBodyRecord,
    withLease = true,
  ): Promise<BodyEntry> {
    const existing = this.findEntry(record.id, body.bodyId);
    if (existing !== undefined) return existing;
    let leaseHeld = false;
    if (withLease && this.bodyLease !== undefined) {
      try {
        await this.bodyLease.acquire(body.bodyId);
        leaseHeld = true;
      } catch (error) {
        throw new AgentError('spawn_failed', `body_lease_failed: ${errorText(error)}`);
      }
    }
    const entry: BodyEntry = {
      agentId: record.id,
      bodyId: body.bodyId,
      epoch: body.epoch,
      state: 'idle',
      primary: body.primary,
      createdAt: body.createdAt,
      lastActiveAt: body.lastActiveAt,
      retired: false,
      runtimeMember: { ...toRuntimeMember(record), session_id: body.bodyId },
      pending: [],
      queuedRuns: new Set(),
      budgetHold: new Set(),
      warnedSignals: new Set(),
      closing: false,
      spawned: false,
      spawning: undefined,
      leaseHeld,
    };
    this.entryMap(record.id).set(body.bodyId, entry);
    return entry;
  }

  /** 新增一个 live body（上限 / 冲突 / lease 都在这里） */
  private async createBody(
    record: MemberRecord,
    bodyId: string,
    options: { epoch?: number; primary?: boolean } = {},
  ): Promise<AgentBodyRecord> {
    const live = liveBodies(record);
    if (live.length >= this.maxLiveBodies) {
      throw new AgentError(
        'body_limit',
        `body_limit: ${record.id} (max ${this.maxLiveBodies} live bodies)`,
      );
    }
    if (
      this.registry.getBySession(bodyId) !== undefined ||
      record.bodies.some((body) => body.bodyId === bodyId)
    ) {
      throw new AgentError('invalid_input', `duplicate session id: ${bodyId}`);
    }
    const now = this.now();
    const body: AgentBodyRecord = {
      bodyId,
      epoch: options.epoch ?? 0,
      createdAt: now,
      lastActiveAt: now,
      primary: options.primary ?? live.length === 0,
    };
    if (this.bodyLease !== undefined) {
      try {
        await this.bodyLease.acquire(bodyId);
      } catch (error) {
        throw new AgentError('spawn_failed', `body_lease_failed: ${errorText(error)}`);
      }
    }
    this.registry.addBody(record.id, body);
    return body;
  }

  /** 解析或惰性创建 body；`requested` 是显式 session（必须未退役） */
  private async ensureBody(
    record: MemberRecord,
    requested?: string,
  ): Promise<{ entry: BodyEntry; body: AgentBodyRecord }> {
    let body: AgentBodyRecord | undefined;
    if (requested !== undefined) {
      body = record.bodies.find((entry) => entry.bodyId === requested);
      if (body !== undefined && body.retiredAt !== undefined) {
        throw new AgentError('invalid_input', `session is retired: ${requested}`);
      }
      if (body === undefined) {
        body = await this.createBody(record, requested, { epoch: 0 });
      }
    } else {
      body = primaryBody(record);
      if (body === undefined) {
        body = await this.createBody(record, this.newId(), { epoch: 0 });
      }
    }
    const entry = await this.entryFor(record, body);
    entry.primary = body.primary;
    return { entry, body };
  }

  /**
   * 惰性重建 body runtime；并发 admit single-flight，只 spawn 一次。
   * `presence === gone`（重启 / stale）时即使 entry 标记为 spawned 也要重新 spawn：
   * registry presence 是进程外可观测的唯一真相。
   */
  private async ensureRuntime(entry: BodyEntry): Promise<void> {
    const record = this.registry.get(entry.agentId);
    const stale = record === undefined || record.presence === 'gone';
    if (entry.spawned && !stale) return;
    if (entry.spawning !== undefined) {
      await entry.spawning;
      return;
    }
    const spawning = (async () => {
      await this.runtime.spawn(entry.runtimeMember);
      entry.spawned = true;
      this.registry.setPresence(entry.agentId, 'live');
    })();
    entry.spawning = spawning;
    try {
      await spawning;
    } finally {
      entry.spawning = undefined;
    }
  }

  private async disposeEntry(entry: BodyEntry): Promise<boolean> {
    let ok = true;
    if (entry.spawned) {
      try {
        await this.runtime.dispose(entry.runtimeMember);
        entry.spawned = false;
      } catch (error) {
        ok = false;
        this.logger.warn('agent.dispose.failed', {
          member_id: entry.agentId,
          session_id: entry.bodyId,
          error: errorText(error),
        });
      }
    }
    if (entry.leaseHeld && this.bodyLease !== undefined) {
      try {
        await this.bodyLease.release(entry.bodyId);
        entry.leaseHeld = false;
      } catch (error) {
        this.logger.warn('agent.body.lease_release_failed', {
          session_id: entry.bodyId,
          error: errorText(error),
        });
      }
    }
    this.bodyRegistry.get(entry.agentId)?.delete(entry.bodyId);
    return ok;
  }

  /** 退役一个 body：取消排队 run、清 mailbox、迁 primary、落 snapshot */
  private async retireBodyEntry(
    record: MemberRecord,
    entry: BodyEntry,
    reason: string,
    at: number = this.now(),
  ): Promise<void> {
    if (entry.retired) return;
    const wasPrimary = entry.primary || record.primaryBodyId === entry.bodyId;
    entry.retired = true;
    entry.state = 'closed';
    entry.primary = false;
    entry.closing = true;
    entry.pending.length = 0;
    for (const runId of entry.queuedRuns) this.scheduler.cancel(runId, `body retired: ${reason}`);
    entry.queuedRuns.clear();
    if (wasPrimary) {
      this.registry.pushBodyHistory(record.id, {
        session_id: entry.bodyId,
        epoch: entry.epoch,
        started_at: entry.createdAt,
        retired_at: at,
      });
    }
    this.registry.retireBody(record.id, entry.bodyId, at);
    if (wasPrimary) this.promotePrimary(record);
    this.emitForSession('agent.retired', record, entry.bodyId, {
      body_id: entry.bodyId,
      epoch: entry.epoch,
      reason,
    });
    this.scheduleSnapshot();
    if (entry.active === undefined) await this.disposeEntry(entry);
    this.updateAgentState(record.id);
  }

  /** primary 晋升：最近活跃的 live body；没有则清空 */
  private promotePrimary(record: MemberRecord): void {
    const entries = this.liveEntries(record.id)
      .filter((entry) => !entry.retired)
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt);
    const next = entries[0];
    for (const entry of entries) entry.primary = entry === next;
    this.registry.setPrimaryBody(record.id, next?.bodyId);
  }

  /** 关闭 agent 的所有 body（cancel/dispose/release） */
  private async disposeAgentBodies(record: MemberRecord): Promise<void> {
    const entries = [...(this.bodyRegistry.get(record.id)?.values() ?? [])];
    for (const entry of entries) {
      entry.closing = true;
      entry.pending.length = 0;
      for (const runId of entry.queuedRuns) this.scheduler.cancel(runId, 'agent closed');
      entry.queuedRuns.clear();
      if (entry.active !== undefined) {
        try {
          this.runtime.cancel(entry.runtimeMember);
        } catch (error) {
          this.logger.warn('agent.cancel.failed', {
            member_id: entry.agentId,
            session_id: entry.bodyId,
            error: errorText(error),
          });
        }
      }
      entry.retired = true;
      entry.state = 'closed';
      entry.primary = false;
      this.registry.retireBody(record.id, entry.bodyId, this.now());
      await this.disposeEntry(entry);
    }
    this.bodyRegistry.delete(record.id);
  }

  // ─── 统一准入 ───────────────────────────────────────────────────

  async admit(input: AdmitInput): Promise<AdmitResult> {
    await this.ready;
    const outcome = await this.admitInternal(input);
    return outcome.result;
  }

  async bodies(agentId: string): Promise<BodyStatus[]> {
    await this.ready;
    const record = this.registry.get(agentId);
    if (record === undefined) throw new AgentError('unknown_member', `unknown_member: ${agentId}`);
    const entries = this.liveEntries(agentId).sort(
      (left, right) => Number(right.primary) - Number(left.primary),
    );
    if (entries.length === 0) {
      return liveBodies(record).map((body) => ({
        session_id: body.bodyId,
        epoch: body.epoch,
        state: 'idle' as const,
        primary: body.primary,
        created_at: body.createdAt,
        last_active_at: body.lastActiveAt,
      }));
    }
    return entries.map(toBodyStatus);
  }

  /** 统一准入主链路：resolve → membership/visibility → body → budget → mailbox → scheduler */
  private async admitInternal(input: AdmitInput): Promise<AdmitOutcome> {
    await this.ready;
    if (this.bodyIdleTtlMs > 0) await this.sweepIdleBodies();
    const content = readContent(input as unknown as Record<string, unknown>, 'content');
    const from =
      input.from === undefined ? this.defaultOwner : readRequiredString(input as never, 'from');
    const channel = input.channel ?? 'direct';
    if (channel !== 'direct' && channel !== 'team') {
      throw new AgentError('invalid_input', 'channel must be direct or team');
    }
    const strict = input.strict === true;

    // 1. session → agent/body 解析（绑定优先；矛盾输入 = invalid_input）
    let record: MemberRecord;
    let requestedBodyId: string | undefined;
    if (input.session_id !== undefined) {
      const sessionId = readRequiredString(input as never, 'session_id');
      const bound = this.registry.getBySession(sessionId);
      if (bound !== undefined) {
        if (input.agent_id !== undefined && input.agent_id !== bound.id) {
          throw new AgentError(
            'invalid_input',
            `session ${sessionId} belongs to ${bound.id}, not ${input.agent_id}`,
          );
        }
        record = bound;
        requestedBodyId = sessionId;
      } else {
        record = this.requireAgent(input.agent_id ?? DEFAULT_OWNER);
        requestedBodyId = sessionId;
      }
    } else {
      record = this.requireAgent(input.agent_id ?? DEFAULT_OWNER);
    }

    // 2. membership / presence / visibility
    // 人类入口（runs.start / REPL / Web）是管理面：private single 对 ADMIN_VIEWER 可见。
    if (!this.canAdmitView(record, from)) {
      throw new AgentError('member_not_visible', `member_not_visible: ${record.id}`);
    }
    if (record.membership === 'left' || record.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${record.id}`);
    }
    if (strict && record.presence === 'gone') {
      throw new AgentError('member_stale', `member_stale: ${record.id}`);
    }

    // 3. body resolve / 创建（每 agent 上限 body_limit）
    const { entry } = await this.ensureBody(record, requestedBodyId);
    if (strict) {
      // send 不自动恢复 gone；但同 agent 其它 live body 存在时允许投递到该 body。
      if (entry.retired) throw new AgentError('member_closed', `member_closed: ${record.id}`);
    } else {
      try {
        await this.ensureRuntime(entry);
      } catch (error) {
        throw new AgentError('spawn_failed', `resume_failed: ${errorText(error)}`);
      }
    }

    // 4. 预算：human 直接对话免 conversation budget（替代原 externalOwner 特例）；
    //    面向 member 的投递（含 human → member）仍走 budget，与旧口径一致。
    //    投递侧只拦 hop / cycle / wall-clock / team 不一致；turns / tokens 是 turn 域，
    //    留给 turn_start 检查（block 时消息留在 body mailbox，override 后重新准入）。
    const conversationId = this.resolveConversationId(input.conversation_id);
    const originTeamId = input.origin_team_id;
    if (!this.isHumanPrincipal(record.id)) {
      const teamId = originTeamId ?? this.resolveOriginTeam(from, record);
      const check = this.checkDelivery(
        record,
        from,
        conversationId,
        teamId,
        originTeamId !== undefined,
      );
      if (!check.ok && !TURN_DIMENSIONS.has(check.dimension)) {
        this.emitBudgetBlocked(record, check, {
          conversation_id: conversationId,
          from,
          to: record.id,
          phase: 'enqueue',
          ...(teamId !== undefined ? { teamId } : {}),
        });
        throw new AgentError(this.budgetCode(check.reason), `${check.reason}: ${check.dimension}`);
      }
    }

    // 5. 入该 body mailbox，满足条件时 submit
    const senderName = this.senderName(from);
    const message: AgentMessage = {
      id: this.newId(),
      from,
      to: record.id,
      content,
      ts: this.now(),
      ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
      source: this.messageSource(from),
      channel,
      // 名字随消息带上：执行内核不持有 registry，渲染时无处可查。
      ...(senderName !== undefined ? { from_name: senderName } : {}),
    };
    entry.pending.push(message);
    this.registry.touchBody(record.id, entry.bodyId, this.now());
    this.emitForSession('agent.message.queued', record, entry.bodyId, {
      state: record.state,
      message_id: message.id,
      from,
      ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
    });
    this.scheduleSnapshot();

    const submitted = await this.submitMessage(record, entry, message);
    this.runMessageIds.set(submitted.runId, message.id);
    const status = submitted.handle.status();
    const queuePosition = this.queuePositionFor(submitted.runId, status);
    return {
      result: {
        run_id: submitted.runId,
        agent_id: record.id,
        session_id: entry.bodyId,
        status,
        ...(queuePosition !== undefined ? { queue_position: queuePosition } : {}),
      },
      message,
    };
  }

  /**
   * 提交一条消息给 scheduler；预算 turn-start block 时留在 mailbox（不 submit）。
   * 每个 run id 在提交前固定，保证 entry 返回 / events 一致。
   */
  private async submitMessage(
    record: MemberRecord,
    entry: BodyEntry,
    message: AgentMessage,
  ): Promise<{ runId: string; handle: RunHandle }> {
    if (this.draining || entry.closing || entry.retired) {
      throw new AgentError('member_closed', `member_closed: ${record.id}`);
    }
    const runId = this.newId();
    entry.queuedRuns.add(runId);
    const task: ScheduledTask = {
      agent: { id: record.id } as AgentHandle,
      serialKey: entry.bodyId,
      runId,
      sessionId: entry.bodyId,
      input: message.content,
      executor: async (scheduledRunId) => {
        entry.queuedRuns.delete(scheduledRunId);
        return this.startBodyRun(record, entry, message, scheduledRunId);
      },
    };
    try {
      const handle = await this.scheduler.submit(task);
      return { runId, handle };
    } catch (error) {
      entry.queuedRuns.delete(runId);
      const index = entry.pending.indexOf(message);
      if (index >= 0) entry.pending.splice(index, 1);
      throw error;
    }
  }

  private holdBlockedMessage(
    record: MemberRecord,
    entry: BodyEntry,
    message: AgentMessage,
    check: BudgetBlockedCheck,
  ): void {
    const conversationId = message.conversation_id;
    if (conversationId === undefined) return;
    entry.budgetHold.add(conversationId);
    this.budgetPort?.noteHold?.(conversationId, record.id);
    this.budgetPort?.noteTurnBlocked?.({
      conversation_id: conversationId,
      ...(record.teamId !== undefined ? { team_id: record.teamId } : {}),
      dimension: check.dimension,
      reason: check.reason,
    });
    if (this.blockedBudgetEvents.has(conversationId)) return;
    this.blockedBudgetEvents.add(conversationId);
    this.emitBudgetBlocked(record, check, {
      conversation_id: conversationId,
      message_id: message.id,
      from: message.from,
      to: record.id,
      phase: 'turn_start',
    });
  }

  private queuePositionFor(runId: string, status: RunStatus): number | undefined {
    if (status !== 'queued' || this.scheduler.snapshot === undefined) return undefined;
    const index = this.scheduler.snapshot().queued.findIndex((run) => run.runId === runId);
    return index >= 0 ? index + 1 : undefined;
  }

  // ─── Body 执行 ─────────────────────────────────────────────────

  /**
   * scheduler executor：开始该 body 的一轮。
   * 预算 turn_start 检查在这里（而不是提交时）：block 时消息留在 body mailbox，
   * override / release 后由 `retryHeldMessages` 重新准入。
   */
  private async startBodyRun(
    record: MemberRecord,
    entry: BodyEntry,
    message: AgentMessage,
    runId: string,
  ): Promise<RunHandle> {
    if (entry.retired || entry.closing) {
      const cancelled = new BodyRunHandle(runId, record.id, entry.bodyId);
      cancelled.markCancelled('body closed');
      return cancelled;
    }
    const conversationId = message.conversation_id;
    if (!this.isHumanPrincipal(record.id)) {
      const check = this.checkTurnStart(record, message, entry.bodyId);
      if (!check.ok) {
        this.holdBlockedMessage(record, entry, message, check);
        const held = new BodyRunHandle(runId, record.id, entry.bodyId);
        held.complete('');
        return held;
      }
    }
    const index = entry.pending.indexOf(message);
    if (index >= 0) entry.pending.splice(index, 1);
    if (conversationId !== undefined) {
      this.budgetPort?.noteTurnStarted({
        conversation_id: conversationId,
        ...(record.teamId !== undefined ? { team_id: record.teamId } : {}),
        agent_id: record.id,
        message_id: message.id,
      });
      entry.budgetHold.delete(conversationId);
      this.blockedBudgetEvents.delete(conversationId);
      this.budgetPort?.clearHold?.(conversationId, record.id);
      this.emitBudgetWarnings(record, conversationId, 'turn_start');
    }
    await this.ensureRuntime(entry);
    entry.state = 'running';
    entry.lastActiveAt = this.now();
    entry.active = {
      runId,
      ...(conversationId !== undefined ? { conversationId } : {}),
      replied: false,
    };
    this.registry.touchBody(record.id, entry.bodyId, entry.lastActiveAt);
    this.updateAgentState(record.id);
    this.scheduleSnapshot();
    const handle = new BodyRunHandle(runId, record.id, entry.bodyId);
    handle.cancelHandler = () => {
      try {
        this.runtime.cancel(entry.runtimeMember);
      } catch (error) {
        this.logger.warn('agent.cancel.failed', {
          member_id: record.id,
          session_id: entry.bodyId,
          error: errorText(error),
        });
      }
    };
    void this.executeBodyTurn(record, entry, message, handle);
    return handle;
  }

  /** 执行并收口一轮；任何异常都收口为失败，不让后台任务产生未处理 rejection */
  private async executeBodyTurn(
    record: MemberRecord,
    entry: BodyEntry,
    message: AgentMessage,
    handle: BodyRunHandle,
  ): Promise<void> {
    let result: MemberTurnResult | undefined;
    let failure: string | undefined;
    try {
      result = await this.runtime.runTurn(entry.runtimeMember, message, handle.id);
    } catch (error) {
      if (!handle.cancelRequested && !entry.closing) {
        failure = errorText(error);
        this.logger.error('agent.run.failed', {
          member_id: record.id,
          session_id: entry.bodyId,
          run_id: handle.id,
          error: failure,
        });
      }
    }
    handle.setUsage(result?.usage);
    const conversationId = message.conversation_id;
    if (conversationId !== undefined) {
      this.budgetPort?.noteTurnFinished({
        conversation_id: conversationId,
        ...(record.teamId !== undefined ? { team_id: record.teamId } : {}),
        agent_id: record.id,
        message_id: message.id,
        ...(result?.usage !== undefined ? { usage: result.usage } : {}),
      });
    }
    // 先取出本轮是否已显式 reply；随后清空 active（同 body 可继续下一轮）
    const replied = entry.active?.replied === true;
    entry.active = undefined;
    entry.state = 'idle';
    entry.lastActiveAt = this.now();
    this.registry.touchBody(record.id, entry.bodyId, entry.lastActiveAt);
    if (result?.usage !== undefined) this.registry.setUsage(record.id, result.usage);

    const current = this.registry.get(record.id);
    const cancelled = handle.cancelRequested || result?.outcome === 'cancelled';
    const outcome = cancelled
      ? 'cancelled'
      : failure !== undefined
        ? 'failed'
        : (result?.outcome ?? 'completed');

    // 旧 body（rotate / TTL 已退役）：epoch fencing，不写 agent 状态、不投父队列
    if (entry.retired || !current || current.state === 'closed') {
      if (outcome === 'completed' && nonEmpty(result?.content)) {
        this.emitForSession('agent.reply.stale', record, entry.bodyId, {
          body_id: entry.bodyId,
          epoch: entry.epoch,
          message_id: message.id,
          reason: 'epoch_fenced',
        });
      }
      this.updateAgentState(record.id);
      this.scheduleSnapshot();
      if (entry.retired) await this.disposeEntry(entry);
      this.settleHandle(handle, outcome, failure, result?.content);
      return;
    }

    if (outcome === 'completed' && !handle.cancelRequested) {
      if (!replied) {
        await this.deliverToParent(current, result?.content, conversationId);
      }
    }

    this.updateAgentState(record.id, outcome);
    this.scheduleSnapshot();
    this.settleHandle(handle, outcome, failure, result?.content);
  }

  private settleHandle(
    handle: BodyRunHandle,
    outcome: 'completed' | 'failed' | 'cancelled',
    failure: string | undefined,
    content: string | undefined,
  ): void {
    if (outcome === 'cancelled') handle.markCancelled(failure ?? 'run cancelled');
    else if (outcome === 'failed') handle.fail(failure ?? 'run failed');
    else handle.complete(content ?? '');
  }

  /** 自动最终文本投递到父成员；父已 left / closed / gone 时显式 dropped */
  private async deliverToParent(
    member: MemberRecord,
    content: string | undefined,
    conversationId: string | undefined,
  ): Promise<void> {
    if (!nonEmpty(content) || !nonEmpty(member.parentId)) return;
    const parent = this.registry.resolve(member.parentId);
    if (!parent) return;
    if (parent.membership === 'left' || parent.state === 'closed' || parent.presence === 'gone') {
      const reason =
        parent.membership === 'left'
          ? 'parent_left'
          : parent.state === 'closed'
            ? 'parent_closed'
            : 'parent_gone';
      this.emit('agent.reply.dropped', member, { to: parent.id, reason });
      return;
    }
    try {
      await this.admitInternal({
        content,
        agent_id: parent.id,
        from: member.id,
        channel: 'direct',
        ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
        strict: false,
      });
    } catch (error) {
      this.logger.warn('agent.reply.drop_failed', {
        member_id: member.id,
        parent_id: parent.id,
        error: errorText(error),
      });
    }
  }

  /** 按 live body 汇总 agent 状态（running / waiting_permission / idle） */
  /**
   * 按 live body 汇总 agent 状态（running / waiting_permission / idle）。
   * `terminal` 是刚结束的一轮结局：没有 active body 时用它（保持 agents 对外终态口径）。
   */
  private updateAgentState(agentId: string, terminal?: 'completed' | 'failed' | 'cancelled'): void {
    const record = this.registry.get(agentId);
    if (!record || record.membership === 'left' || record.state === 'closed') return;
    const entries = this.liveEntries(agentId);
    const anyWaiting = entries.some((entry) => entry.state === 'waiting_permission');
    const anyRunning = entries.some(
      (entry) => entry.state === 'running' || entry.state === 'waiting_permission',
    );
    const target: MemberState = anyWaiting
      ? 'waiting_permission'
      : anyRunning
        ? 'running'
        : (terminal ?? 'idle');
    if (record.state === target) return;
    try {
      if (
        target === 'running' &&
        (record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled')
      ) {
        this.registry.setState(agentId, 'idle');
      }
      this.registry.setState(agentId, target);
    } catch (error) {
      // 状态竞争（close / 迟到回调）不应打断执行；只记日志。
      this.logger.warn('agent.state.update_failed', {
        agent_id: agentId,
        state: target,
        error: errorText(error),
      });
    }
  }

  /** 空闲 body TTL sweep；返回本次退役数量 */
  async sweepIdleBodies(now: number = this.now()): Promise<number> {
    await this.ready;
    if (this.bodyIdleTtlMs <= 0) return 0;
    let retiredCount = 0;
    for (const record of this.registry.all()) {
      if (record.membership === 'left' || record.state === 'closed') continue;
      const entries = this.liveEntries(record.id);
      let changed = false;
      for (const entry of entries) {
        if (entry.active !== undefined || entry.closing) continue;
        if (entry.queuedRuns.size > 0 || entry.pending.length > 0) continue;
        if (entry.state !== 'idle') continue;
        if (entry.lastActiveAt + this.bodyIdleTtlMs >= now) continue;
        await this.retireBodyEntry(record, entry, 'idle_ttl', now);
        retiredCount += 1;
        changed = true;
      }
      if (changed) this.scheduleSnapshot();
    }
    return retiredCount;
  }

  // ─── send / dispatch ───────────────────────────────────────────

  async send(input: SendInput): Promise<SendResult>;
  async send(input: SendBatchInput): Promise<BatchResult<SendResult>>;
  async send(input: SendInput | SendBatchInput): Promise<SendResult | BatchResult<SendResult>> {
    await this.ready;
    const record = input as unknown as Record<string, unknown>;
    if ('messages' in record) {
      if (record.to !== undefined || record.content !== undefined || record.from !== undefined) {
        throw new AgentError(
          'invalid_input',
          'pass either single to/content or messages, not both',
        );
      }
      const messages = record.messages;
      if (!Array.isArray(messages)) {
        throw new AgentError('invalid_input', 'messages must be an array');
      }
      if (messages.length === 0) {
        throw new AgentError('invalid_input', 'messages must not be empty');
      }
      const settled = await Promise.allSettled(
        messages.map((entry) =>
          isRecord(entry)
            ? this.sendOne(entry)
            : Promise.reject(new AgentError('invalid_input', 'messages entries must be objects')),
        ),
      );
      return settleBatch(settled);
    }
    return this.sendOne(record);
  }

  /** strict send：不自动恢复 gone 成员；走同一个 admit。 */
  private async sendOne(input: Record<string, unknown>): Promise<SendResult> {
    const to = readRequiredString(input, 'to');
    const content = readContent(input, 'content');
    const from = input.from === undefined ? DEFAULT_OWNER : readRequiredString(input, 'from');
    const target = this.requireMember(to);
    if (target.membership === 'left' || target.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${to}`);
    }
    if (target.presence === 'gone') {
      throw new AgentError('member_stale', `member_stale: ${to}`);
    }
    if (!this.registry.canView(target, from)) {
      throw new AgentError('member_not_visible', `member_not_visible: ${to}`);
    }
    const sessionId = this.registry.getBySession(to)?.id === target.id ? to : undefined;
    const result = await this.admit({
      content,
      agent_id: target.id,
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      from,
      channel: 'direct',
      ...(input.conversation_id !== undefined
        ? { conversation_id: readRequiredString(input, 'conversation_id') }
        : {}),
      strict: true,
    });
    const messageId = this.runMessageIds.get(result.run_id) ?? result.run_id;
    return {
      queued: true,
      message_id: messageId,
      state: this.registry.get(target.id)?.state ?? target.state,
      run_id: result.run_id,
      session_id: result.session_id,
    };
  }

  /**
   * dispatch：统一投递入口。`to` 为 id / session / 唯一 name。
   * 与 strict `send` 的区别：gone 成员会先确保 runtime（可 resume）；失败可按策略 fork。
   */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    await this.ready;
    const raw = input as unknown as Record<string, unknown>;
    const to = readRequiredString(raw, 'to');
    const content = readContent(raw, 'content');
    const from = raw.from === undefined ? DEFAULT_OWNER : readRequiredString(raw, 'from');

    const target = this.resolveDispatchTarget(to, from);
    if (target === undefined || !this.registry.canView(target, from)) {
      return { status: 'rejected', code: 'not_visible', reason: `not_visible: ${to}` };
    }
    if (target.membership === 'left' || target.state === 'closed') {
      return { status: 'rejected', code: 'agent_left', reason: `agent_left: ${target.id}` };
    }
    if (this.hasClosingBody(target.id)) {
      return { status: 'rejected', code: 'agent_left', reason: `agent_left: ${target.id}` };
    }

    const conversationId = this.resolveConversationId(input.conversation_id);
    const originTeamId =
      raw.origin_team_id === undefined ? undefined : readRequiredString(raw, 'origin_team_id');
    const boundSession = this.registry.getBySession(to)?.id === target.id ? to : undefined;
    const attempt = async (agentId: string, sessionId?: string) =>
      this.admit({
        content,
        agent_id: agentId,
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
        from,
        channel: originTeamId === undefined ? 'direct' : 'team',
        ...(originTeamId !== undefined ? { origin_team_id: originTeamId } : {}),
        conversation_id: conversationId,
        strict: false,
      });

    // admit 会把 presence 拉回 live，所以先捕获投递前的 presence 来区分 live / resumed。
    const wasLive = target.presence === 'live';
    try {
      const result = await attempt(target.id, boundSession);
      return {
        status: 'queued',
        message_id: this.runMessageIds.get(result.run_id) ?? result.run_id,
        resolved_to: target.id,
        resolution: wasLive ? 'live' : 'resumed',
        conversation_id: conversationId,
      };
    } catch (error) {
      if (!this.resolveAllowFork(target, raw.allow_fork)) {
        return this.rejectAdmit(error);
      }
      const fork = await this.ensureForked(target.id);
      if (!fork.ok) {
        if (fork.code === 'agent_left') {
          return { status: 'rejected', code: 'agent_left', reason: fork.reason };
        }
        if (
          fork.code === 'fork_failed' ||
          fork.code === 'team_full' ||
          fork.code === 'team_frozen'
        ) {
          return { status: 'rejected', code: fork.code, reason: fork.reason };
        }
        return { status: 'rejected', code: 'resume_failed', reason: fork.reason };
      }
      const forked = this.registry.get(fork.member.id);
      if (forked === undefined || forked.membership === 'left' || forked.state === 'closed') {
        return { status: 'rejected', code: 'agent_left', reason: `agent_left: ${target.id}` };
      }
      try {
        const result = await attempt(forked.id);
        return {
          status: 'queued',
          message_id: this.runMessageIds.get(result.run_id) ?? result.run_id,
          resolved_to: forked.id,
          resolution: 'forked',
          conversation_id: conversationId,
        };
      } catch (forkError) {
        return this.rejectAdmit(forkError);
      }
    }
  }

  /** admit / spawn 失败 → DispatchResult（稳定 code 尽量保留） */
  private rejectAdmit(error: unknown): DispatchResult {
    const code = errorCode(error);
    if (code === 'member_not_visible') {
      return { status: 'rejected', code: 'not_visible', reason: errorText(error) };
    }
    if (code === 'member_closed') {
      return { status: 'rejected', code: 'agent_left', reason: errorText(error) };
    }
    if (
      code === 'budget_exceeded' ||
      code === 'budget_unavailable' ||
      code === 'conversation_team_mismatch'
    ) {
      return { status: 'rejected', code, reason: errorText(error) };
    }
    return { status: 'rejected', code: 'resume_failed', reason: errorText(error) };
  }

  /**
   * dispatch 的 to 解析：id/session 直取；name 需唯一且对 from 可见。
   * 返回 undefined 表示 name 存在但全部不可见（调用方返回 rejected not_visible）。
   */
  private resolveDispatchTarget(to: string, from: string): MemberRecord | undefined {
    const direct = this.registry.resolve(to);
    if (direct) return direct;

    const matches = this.registry.findByName(to);
    if (matches.length === 0) {
      throw new AgentError('unknown_member', `unknown_member: ${to}`);
    }
    const present = matches.filter((record) => record.membership === 'present');
    const pool = present.length > 0 ? present : matches;
    const visible = pool.filter((record) => this.registry.canView(record, from));
    if (visible.length === 0) return undefined;
    if (visible.length > 1) {
      const candidates = visible.map((record) => record.id).join(', ');
      throw new AgentError('invalid_input', `ambiguous name: ${to} candidates: ${candidates}`);
    }
    return visible[0];
  }

  /**
   * fork 开关：显式 `allow_fork` 优先（只由 owner / CLI 传入）；
   * 缺省看目标 Team 的 `policy.allowFork`，再缺省 false。
   */
  private resolveAllowFork(target: MemberRecord, explicit: unknown): boolean {
    if (explicit !== undefined) {
      if (typeof explicit !== 'boolean') {
        throw new AgentError('invalid_input', 'allow_fork must be a boolean');
      }
      return explicit;
    }
    if (target.teamId === undefined) return false;
    return this.teamPolicy?.(target.teamId)?.allowFork === true;
  }

  // ─── rotate / close ────────────────────────────────────────────

  /**
   * 只退休 primary body：创建新 primary（新 session + epoch+1），其它 live body 不变。
   * 旧 body 进 body_history；正在跑的旧轮由 epoch fencing 在轮末 dispose。
   */
  async rotate(input: RotateInput): Promise<RotateResult> {
    await this.ready;
    const raw = input as unknown as Record<string, unknown>;
    const to = readRequiredString(raw, 'to');
    const from = input.from === undefined ? DEFAULT_OWNER : readRequiredString(raw, 'from');

    const target = this.resolveDispatchTarget(to, from);
    if (target === undefined || !this.registry.canView(target, from)) {
      return { status: 'failed', code: 'not_visible', reason: `not_visible: ${to}` };
    }
    if (
      target.membership === 'left' ||
      target.state === 'closed' ||
      this.hasClosingBody(target.id)
    ) {
      return { status: 'failed', code: 'agent_left', reason: `agent_left: ${target.id}` };
    }
    if (this.rotations.has(target.id) || target.rotation === 'rotating') {
      return { status: 'failed', code: 'rotating', reason: `rotating: ${target.id}` };
    }
    const oldBody = primaryBody(target);
    if (target.presence !== 'live' || oldBody === undefined) {
      return { status: 'failed', code: 'body_not_live', reason: `body_not_live: ${target.id}` };
    }

    const callerSession = input.from_session_id;
    if (callerSession !== undefined && callerSession !== oldBody.bodyId) {
      return {
        status: 'failed',
        code: 'not_current_body',
        reason: `not_current_body: ${callerSession}`,
      };
    }

    const startupPrompt = readContent(raw, 'startup_prompt');
    const fromSessionId = oldBody.bodyId;
    const fromEpoch = oldBody.epoch;
    const toSessionId = this.newId();
    if (
      !nonEmpty(toSessionId) ||
      this.registry.getBySession(toSessionId) !== undefined ||
      target.bodies.some((body) => body.bodyId === toSessionId)
    ) {
      this.emitForSession('agent.rotate.failed', target, fromSessionId, {
        from_session_id: fromSessionId,
        ...(nonEmpty(toSessionId) ? { to_session_id: toSessionId } : {}),
        reason: 'session_id_collision',
      });
      return { status: 'failed', code: 'rotate_failed', reason: 'session_id_collision' };
    }
    const toEpoch = fromEpoch + 1;
    const oldEntry = this.bodyRegistry.get(target.id)?.get(fromSessionId);
    if (liveBodies(target).length >= this.maxLiveBodies) {
      return {
        status: 'failed',
        code: 'rotate_failed',
        reason: `body_limit: ${target.id} (max ${this.maxLiveBodies})`,
      };
    }

    this.registry.setRotation(target.id, 'rotating');
    this.rotations.set(target.id, { fromSessionId, fromEpoch, toSessionId, toEpoch });
    this.emitForSession('agent.rotating', target, fromSessionId, {
      from_session_id: fromSessionId,
      to_session_id: toSessionId,
      epoch: toEpoch,
    });

    let newBody: AgentBodyRecord | undefined;
    const rollbackNew = async (): Promise<void> => {
      const entry = this.findEntry(target.id, toSessionId);
      if (entry !== undefined) await this.disposeEntry(entry);
      if (newBody !== undefined) this.registry.removeBody(target.id, toSessionId);
    };
    try {
      try {
        newBody = await this.createBody(target, toSessionId, { epoch: toEpoch, primary: false });
        const newEntry = await this.entryFor(target, newBody, false);
        await this.ensureRuntime(newEntry);
        newEntry.primary = true;
      } catch (error) {
        await rollbackNew();
        this.registry.setRotation(target.id, 'stable');
        this.rotations.delete(target.id);
        this.emitForSession('agent.rotate.failed', target, fromSessionId, {
          from_session_id: fromSessionId,
          to_session_id: toSessionId,
          reason: errorText(error),
        });
        return { status: 'failed', code: 'rotate_failed', reason: errorText(error) };
      }

      // 提交 primary；flush 失败回滚到旧 body。
      this.registry.setPrimaryBody(target.id, toSessionId);
      if (oldEntry !== undefined) oldEntry.primary = false;
      this.scheduleSnapshot();
      let ok = false;
      try {
        ok = await this.flushSnapshot();
      } catch {
        ok = false;
      }
      if (!ok) {
        this.registry.setPrimaryBody(target.id, fromSessionId);
        if (oldEntry !== undefined) oldEntry.primary = true;
        await rollbackNew();
        this.registry.setRotation(target.id, 'stable');
        this.rotations.delete(target.id);
        this.emitForSession('agent.rotate.failed', target, fromSessionId, {
          from_session_id: fromSessionId,
          to_session_id: toSessionId,
          reason: 'snapshot_write_failed',
        });
        return { status: 'failed', code: 'rotate_failed', reason: 'snapshot_write_failed' };
      }

      this.emitForSession('agent.rotated', target, toSessionId, {
        from_session_id: fromSessionId,
        to_session_id: toSessionId,
        epoch: toEpoch,
      });

      // 旧 primary 退休；正在跑的旧轮由 executeBodyTurn 的 fencing 分支收口。
      if (oldEntry !== undefined) {
        await this.retireBodyEntry(target, oldEntry, 'rotation');
      } else {
        this.registry.pushBodyHistory(target.id, {
          session_id: fromSessionId,
          epoch: fromEpoch,
          started_at: oldBody.createdAt,
          retired_at: this.now(),
        });
        this.registry.retireBody(target.id, fromSessionId);
      }

      // startup prompt：system 消息，继承触发 rotate 的会话；不计 hop。
      const inheritedConversation =
        oldEntry?.active?.conversationId ?? generateConversationId(this.newId);
      try {
        await this.admitInternal({
          content: startupPrompt,
          agent_id: target.id,
          session_id: toSessionId,
          from: 'system',
          channel: 'direct',
          conversation_id: inheritedConversation,
          strict: false,
        });
      } catch (error) {
        this.logger.warn('agent.rotate.startup_failed', {
          agent_id: target.id,
          error: errorText(error),
        });
      }
      this.registry.setRotation(target.id, 'stable');
      this.rotations.delete(target.id);
      this.scheduleSnapshot();
      this.updateAgentState(target.id);
      return {
        status: 'rotated',
        agent_id: target.id,
        from_session_id: fromSessionId,
        to_session_id: toSessionId,
        epoch: toEpoch,
      };
    } finally {
      this.rotations.delete(target.id);
      const current = this.registry.get(target.id);
      if (current?.rotation === 'rotating') this.registry.setRotation(target.id, 'stable');
    }
  }

  async close(input: CloseInput): Promise<CloseResult>;
  async close(input: CloseBatchInput): Promise<BatchResult<CloseResult>>;
  async close(
    input: CloseInput | CloseBatchInput,
  ): Promise<CloseResult | BatchResult<CloseResult>> {
    await this.ready;
    const record = input as unknown as Record<string, unknown>;
    if ('members' in record) {
      if (record.member !== undefined || record.to !== undefined) {
        throw new AgentError('invalid_input', 'pass either member or members, not both');
      }
      const members = record.members;
      if (!Array.isArray(members)) {
        throw new AgentError('invalid_input', 'members must be an array');
      }
      if (members.length === 0) {
        throw new AgentError('invalid_input', 'members must not be empty');
      }
      const settled = await Promise.allSettled(
        members.map((entry) =>
          nonEmpty(entry)
            ? this.closeOne(entry)
            : Promise.reject(
                new AgentError('invalid_input', 'members entries must be non-empty strings'),
              ),
        ),
      );
      return settleBatch(settled);
    }
    const ref = nonEmpty(record.member) ? record.member : record.to;
    if (!nonEmpty(ref)) {
      throw new AgentError('invalid_input', 'close requires member');
    }
    return this.closeOne(ref);
  }

  private async closeOne(ref: string): Promise<CloseResult> {
    const member = this.requireMember(ref);
    if (member.membership === 'left' || member.state === 'closed') return { state: 'closed' };

    await this.disposeAgentBodies(member);
    this.registry.setState(member.id, 'closed');
    member.membership = 'left';
    this.registry.setPresence(member.id, 'gone');
    this.emit('agent.closed', member, { state: 'closed', presence: 'gone' });
    this.scheduleSnapshot();

    // owner close 后 private contractor 会对所有人不可见：按 registry 原始记录级联关闭。
    const privateChildren = this.registry
      .all()
      .filter(
        (record) =>
          record.membership === 'present' &&
          record.role === 'temporary' &&
          record.visibility === 'private' &&
          record.owner === member.id &&
          record.id !== member.id,
      );
    for (const child of privateChildren) {
      try {
        await this.closeOne(child.id);
      } catch (error) {
        this.logger.warn('agent.cascade_close.failed', {
          owner_id: member.id,
          agent_id: child.id,
          error: errorText(error),
        });
      }
    }

    await this.flushSnapshot();
    return { state: 'closed' };
  }

  // ─── durable resume ────────────────────────────────────────────

  async resume(runId: string): Promise<ResumeResult> {
    await this.ready;
    if (this.runStore === undefined) {
      throw new AgentError('invalid_input', `run_store_required: ${runId}`);
    }
    const checkpoint = await this.runStore.load(runId);
    if (checkpoint === null) {
      throw new AgentError('invalid_input', `run_not_found: ${runId}`);
    }
    const bound = this.registry.getBySession(checkpoint.session_id);
    const agentId = checkpoint.agent_id ?? bound?.id;
    if (agentId === undefined) {
      throw new AgentError('unknown_member', `unknown_member: ${checkpoint.session_id}`);
    }
    const record = this.requireAgent(agentId);
    if (record.membership === 'left' || record.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${agentId}`);
    }
    const { entry } = await this.ensureBody(record, checkpoint.session_id);
    await this.ensureRuntime(entry);
    if (this.runtime.resume === undefined) {
      throw new AgentError('invalid_input', 'resume_not_supported');
    }
    const run = this.newId();
    entry.queuedRuns.add(run);
    const task: ScheduledTask = {
      agent: { id: record.id } as AgentHandle,
      serialKey: entry.bodyId,
      runId: run,
      sessionId: entry.bodyId,
      input: '',
      executor: async (scheduledRunId) => {
        entry.queuedRuns.delete(scheduledRunId);
        return this.startResumeRun(record, entry, scheduledRunId);
      },
    };
    const handle = await this.scheduler.submit(task);
    const status = handle.status();
    const queuePosition = this.queuePositionFor(run, status);
    return {
      run_id: run,
      agent_id: record.id,
      session_id: entry.bodyId,
      status,
      ...(queuePosition !== undefined ? { queue_position: queuePosition } : {}),
    };
  }

  private async startResumeRun(
    record: MemberRecord,
    entry: BodyEntry,
    runId: string,
  ): Promise<RunHandle> {
    const resume = this.runtime.resume;
    if (resume === undefined) throw new Error('resume_not_supported');
    entry.state = 'running';
    entry.lastActiveAt = this.now();
    entry.active = { runId, replied: true };
    this.updateAgentState(record.id);
    const handle = new BodyRunHandle(runId, record.id, entry.bodyId);
    handle.cancelHandler = () => {
      try {
        this.runtime.cancel(entry.runtimeMember);
      } catch (error) {
        this.logger.warn('agent.cancel.failed', {
          member_id: record.id,
          session_id: entry.bodyId,
          error: errorText(error),
        });
      }
    };
    void (async () => {
      let result: MemberTurnResult | undefined;
      let failure: string | undefined;
      try {
        result = await resume.call(this.runtime, entry.runtimeMember, runId);
      } catch (error) {
        if (!handle.cancelRequested && !entry.closing) failure = errorText(error);
      }
      handle.setUsage(result?.usage);
      entry.active = undefined;
      entry.state = 'idle';
      entry.lastActiveAt = this.now();
      this.registry.touchBody(record.id, entry.bodyId, entry.lastActiveAt);
      if (result?.usage !== undefined) this.registry.setUsage(record.id, result.usage);
      const cancelled = handle.cancelRequested || result?.outcome === 'cancelled';
      const outcome = cancelled
        ? 'cancelled'
        : failure !== undefined
          ? 'failed'
          : (result?.outcome ?? 'completed');
      this.updateAgentState(record.id, outcome);
      this.scheduleSnapshot();
      this.settleHandle(handle, outcome, failure, result?.content);
      if (entry.retired) await this.disposeEntry(entry);
    })();
    return handle;
  }

  // ─── life-cycle / update / list ────────────────────────────────

  async update(input: AgentUpdateInput): Promise<AgentUpdateResult>;
  async update(input: AgentUpdateBatchInput): Promise<BatchResult<AgentUpdateResult>>;
  async update(
    input: AgentUpdateInput | AgentUpdateBatchInput,
  ): Promise<AgentUpdateResult | BatchResult<AgentUpdateResult>> {
    await this.ready;
    const record = input as unknown as Record<string, unknown>;
    if ('updates' in record) {
      if (record.id !== undefined || record.to !== undefined) {
        throw new AgentError('invalid_input', 'pass either update fields or updates, not both');
      }
      const updates = record.updates;
      if (!Array.isArray(updates)) {
        throw new AgentError('invalid_input', 'updates must be an array');
      }
      if (updates.length === 0) {
        throw new AgentError('invalid_input', 'updates must not be empty');
      }
      const settled = await Promise.allSettled(
        updates.map((entry) =>
          isRecord(entry)
            ? this.updateOne(entry)
            : Promise.reject(new AgentError('invalid_input', 'updates entries must be objects')),
        ),
      );
      return settleBatch(settled);
    }
    return this.updateOne(record);
  }

  private async updateOne(record: Record<string, unknown>): Promise<AgentUpdateResult> {
    const ref = nonEmpty(record.id) ? record.id : nonEmpty(record.to) ? record.to : undefined;
    if (ref === undefined) {
      throw new AgentError('invalid_input', 'update requires id or to');
    }
    const target = this.resolveUpdateTarget(ref);
    if (target.membership === 'left' || target.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${ref}`);
    }

    const name = readUpdateString(record, 'name');
    const model = readUpdateString(record, 'model');
    const systemPrompt = readUpdateString(record, 'systemPrompt');
    const requestedRole = readUpdateRole(record);
    if (
      name === undefined &&
      model === undefined &&
      systemPrompt === undefined &&
      requestedRole === undefined
    ) {
      throw new AgentError('invalid_input', 'update requires name, model, systemPrompt or role');
    }

    const conversion =
      requestedRole !== undefined && requestedRole !== target.role
        ? this.resolveRoleConversion(target, requestedRole, record)
        : undefined;

    const changed: AgentUpdateField[] = [];
    if (name !== undefined && name !== target.name) {
      this.assertNameAvailable(target, name);
      target.name = name;
      changed.push('name');
    }
    if (model !== undefined && model !== target.model) {
      target.model = model;
      changed.push('model');
    }
    if (systemPrompt !== undefined && systemPrompt !== target.systemPrompt) {
      target.systemPrompt = systemPrompt;
      changed.push('system_prompt');
    }

    this.registry.touch(target.id);
    if (changed.length > 0) {
      this.emit('agent.updated', target, { changed });
    }

    if (conversion !== undefined) {
      const previousRole = target.role;
      target.role = conversion.role;
      target.owner = conversion.owner;
      if (conversion.parentId === undefined) delete target.parentId;
      else target.parentId = conversion.parentId;
      this.registry.setTeamId(target.id, conversion.teamId);
      target.visibility = conversion.visibility;

      this.emit('agent.role.changed', target, {
        from: previousRole,
        to: conversion.role,
        owner: conversion.owner,
        ...(conversion.teamId !== undefined ? { team_id: conversion.teamId } : {}),
      });
      this.runtime.notice?.(
        target.id,
        `[runtime] identity changed: ${previousRole} → ${conversion.role}; owner=${conversion.owner}; team=${conversion.teamId ?? 'none'}`,
      );
      await this.flushSnapshot();
    } else {
      this.scheduleSnapshot();
    }

    const affectsNextBody = changed.includes('model') || changed.includes('system_prompt');
    return {
      agent: this.statusFor(target),
      changed,
      ...(affectsNextBody ? { applies_to: 'next_body' as const } : {}),
    };
  }

  /**
   * 角色转换目标状态（不写记录）：
   * - member：Team 必需（显式或已有），owner=self，清 parent，team 可见；
   * - temporary：owner / parent = 转换者 `from`，Team 显式或沿用，有 Team 则 team 可见；
   * - single：清 Team / parent，owner=self，private。
   */
  private resolveRoleConversion(
    target: MemberRecord,
    role: AgentRole,
    record: Record<string, unknown>,
  ): {
    role: AgentRole;
    owner: string;
    parentId?: string;
    teamId?: string;
    visibility: MemberVisibility;
  } {
    const from = record.from === undefined ? DEFAULT_OWNER : readRequiredString(record, 'from');
    const explicitTeamId =
      record.teamId === undefined ? undefined : readRequiredString(record, 'teamId');
    if (explicitTeamId !== undefined) {
      if (this.teamBinder === undefined || this.teamBinder.get(explicitTeamId) === undefined) {
        throw new AgentError('invalid_input', `team_not_found: ${explicitTeamId}`);
      }
    }

    if (role === 'member') {
      const teamId = explicitTeamId ?? target.teamId;
      if (teamId === undefined) {
        throw new AgentError('invalid_input', 'member role requires a team');
      }
      return { role, owner: target.id, teamId, visibility: 'team' };
    }
    if (role === 'temporary') {
      const teamId = explicitTeamId ?? target.teamId;
      return {
        role,
        owner: from,
        parentId: from,
        ...(teamId !== undefined ? { teamId } : {}),
        visibility: teamId !== undefined ? 'team' : 'private',
      };
    }
    return { role, owner: target.id, visibility: 'private' };
  }

  /** update 选择器：id / 任一 live Body session 直取；否则唯一当前名字。 */
  private resolveUpdateTarget(ref: string): MemberRecord {
    const direct = this.registry.resolve(ref);
    if (direct !== undefined) return direct;
    const matches = this.registry.findByName(ref);
    if (matches.length === 0) {
      throw new AgentError('unknown_member', `unknown_member: ${ref}`);
    }
    const present = matches.filter((record) => record.membership === 'present');
    const pool = present.length > 0 ? present : matches;
    if (pool.length > 1) {
      const candidates = pool.map((record) => record.id).join(', ');
      throw new AgentError('invalid_input', `ambiguous name: ${ref} candidates: ${candidates}`);
    }
    const [only] = pool;
    if (only === undefined) {
      throw new AgentError('unknown_member', `unknown_member: ${ref}`);
    }
    return only;
  }

  /** 与创建一致：present 成员在 Team 内唯一；unbound 成员在整个 tenant 内唯一。 */
  private assertNameAvailable(target: MemberRecord, name: string): void {
    const duplicate = this.registry
      .findByName(name)
      .some(
        (record) =>
          record.id !== target.id &&
          record.membership === 'present' &&
          (target.teamId === undefined || record.teamId === target.teamId),
      );
    if (duplicate) {
      throw new AgentError('invalid_input', `duplicate member name: ${name}`);
    }
  }

  /**
   * roster add：绑定 Team 并把 `left` / `closed` 恢复为 `present`。
   * 只由 roster 管理调用；不 spawn、不新建 session。
   */
  async reinstate(input: ReinstateInput): Promise<MemberStatus> {
    await this.ready;
    const raw = input as unknown as Record<string, unknown>;
    const to = readRequiredString(raw, 'to');
    const teamId = readRequiredString(raw, 'team_id');
    const from = input.from === undefined ? DEFAULT_OWNER : readRequiredString(raw, 'from');

    const target = this.resolveDispatchTarget(to, from);
    if (target === undefined || !this.registry.canView(target, from)) {
      throw new AgentError('member_not_visible', `member_not_visible: ${to}`);
    }
    if (target.role === 'single') {
      target.role = 'member';
      target.owner = target.id;
      delete target.parentId;
      target.visibility = 'team';
    }
    if (target.teamId !== undefined && target.teamId !== teamId) {
      throw new AgentError('invalid_input', `already_in_team: ${target.teamId}`);
    }

    const stillPresent = target.membership === 'present' && target.state !== 'closed';
    if (stillPresent && target.teamId === teamId) {
      return this.statusFor(target);
    }

    const team = this.teamBinder?.get(teamId);
    if (team?.spawn_frozen === true) {
      throw new AgentError('team_frozen', `team_frozen: ${teamId}`);
    }
    if (team !== undefined && this.presentTeamCount(teamId) >= TEAM_MEMBER_LIMIT) {
      throw new AgentError('team_full', `team_full: ${teamId}`);
    }

    if (stillPresent) {
      this.registry.setTeamId(target.id, teamId);
    } else {
      this.registry.setTeamId(target.id, teamId);
      this.registry.setMembership(target.id, 'present');
      target.state = 'idle';
      this.registry.setPresence(target.id, 'gone');
      for (const entry of this.liveEntries(target.id)) entry.closing = false;
    }

    this.emit('agent.rejoined', target, { state: target.state, presence: target.presence });
    this.scheduleSnapshot();
    return this.statusFor(target);
  }

  async list(filter: ListFilter = {}): Promise<MemberStatus[]> {
    await this.ready;
    if (this.bodyIdleTtlMs > 0) await this.sweepIdleBodies();
    return this.registry.list(filter).map((record) => this.statusFor(record));
  }

  /** 任一 live body session（或成员 id）→ 状态；退役 Body 不再命中 */
  async identify(sessionId: string): Promise<MemberStatus | undefined> {
    await this.ready;
    if (!nonEmpty(sessionId)) return undefined;
    const record = this.registry.resolve(sessionId);
    return record === undefined ? undefined : this.statusFor(record);
  }

  async reply(memberId: string, content: string): Promise<ReplyResult> {
    await this.ready;
    const text = readContent({ content }, 'content');
    const member = this.requireMember(memberId);
    if (member.membership === 'left' || member.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${memberId}`);
    }
    if (member.presence === 'gone') {
      throw new AgentError('member_stale', `member_stale: ${memberId}`);
    }
    if (!nonEmpty(member.parentId)) {
      throw new AgentError('no_parent', `member has no parent: ${memberId}`);
    }
    const parent = this.requireMember(member.parentId);
    if (parent.membership === 'left' || parent.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${parent.id}`);
    }
    if (parent.presence === 'gone') {
      throw new AgentError('member_stale', `member_stale: ${parent.id}`);
    }

    // 本轮已显式回复 → 抑制自动最终文本（标记当前正在跑的 body）
    const activeEntry = this.liveEntries(member.id).find((entry) => entry.active !== undefined);
    if (activeEntry?.active !== undefined) activeEntry.active.replied = true;
    const conversationId =
      activeEntry?.active?.conversationId ?? generateConversationId(this.newId);
    const result = await this.admit({
      content: text,
      agent_id: parent.id,
      from: member.id,
      channel: 'direct',
      conversation_id: conversationId,
      strict: true,
    });
    return {
      queued: true,
      message_id: this.runMessageIds.get(result.run_id) ?? result.run_id,
      to: parent.id,
    };
  }

  /** bridge 执行内核上报的等待/恢复；只接受对应 body 的当前 run */
  notePermissionState(memberId: string, sessionId: string, state: MemberPermissionState): void {
    const entry = this.findEntry(memberId, sessionId);
    if (entry === undefined || entry.retired || entry.closing) return;
    const member = this.registry.get(memberId);
    if (!member || member.state === 'closed' || member.presence === 'gone') return;
    if (entry.active === undefined) return;
    try {
      if (state === 'waiting') {
        if (entry.state !== 'running') return;
        entry.state = 'waiting_permission';
      } else {
        if (entry.state !== 'waiting_permission') return;
        entry.state = 'running';
      }
      this.updateAgentState(memberId);
    } catch (error) {
      this.logger.warn('agent.permission.state_failed', {
        member_id: memberId,
        session_id: sessionId,
        state,
        error: errorText(error),
      });
      return;
    }
    this.scheduleSnapshot();
  }

  /**
   * 成员引擎事件回流：只处理 live body 的 `agent.limit.warning`，
   * 按 `${sessionId}|${key}` 去重后作为系统提示排进该 body 的下一轮。
   */
  noteMemberEvent(memberId: string, sessionId: string, event: RunEvent): void {
    if (event.type !== 'agent.limit.warning') return;
    const record = this.registry.get(memberId);
    if (!record) return;
    if (record.membership === 'left' || record.state === 'closed') return;
    const entry = this.findEntry(memberId, sessionId);
    if (entry === undefined || entry.retired || entry.closing) return;

    const data = isRecord(event.data) ? event.data : undefined;
    if (!data) return;
    const key = data.key;
    const current = data.current;
    const max = data.max;
    if (!nonEmpty(key)) return;
    if (typeof current !== 'number' || !Number.isFinite(current)) return;
    if (typeof max !== 'number' || !Number.isFinite(max)) return;
    const threshold =
      typeof data.threshold === 'number' && Number.isFinite(data.threshold) ? data.threshold : 0.8;

    const dedupeKey = `${sessionId}|${key}`;
    if (entry.warnedSignals.has(dedupeKey)) return;
    entry.warnedSignals.add(dedupeKey);

    const text =
      `[system] Context/usage limit warning: ${key} is at ${current}/${max} (>= ${threshold}). ` +
      'If your context is nearly full, write a handoff and call agent.rotate with ' +
      'startup_prompt to continue in a fresh body.';
    const conversationId = entry.active?.conversationId ?? generateConversationId(this.newId);
    const message: AgentMessage = {
      id: this.newId(),
      from: 'system',
      to: memberId,
      content: text,
      ts: this.now(),
      conversation_id: conversationId,
      kind: 'limit_warning',
      source: 'system',
      channel: 'direct',
    };
    entry.pending.push(message);
    this.emitForSession('agent.message.queued', record, sessionId, {
      state: record.state,
      message_id: message.id,
      from: 'system',
      conversation_id: conversationId,
    });
    void this.submitMessage(record, entry, message).catch((error) => {
      this.logger.warn('agent.limit_warning.enqueue_failed', {
        member_id: memberId,
        session_id: sessionId,
        error: errorText(error),
      });
    });
  }

  currentConversation(agentId: string): string | undefined {
    const entries = this.liveEntries(agentId);
    const active = entries.find((entry) => entry.active !== undefined);
    return active?.active?.conversationId;
  }

  async budget(input: BudgetStatusInput | BudgetOverrideInput): Promise<BudgetOverview> {
    await this.ready;
    if (!this.budgetPort) {
      throw new AgentError('budget_unavailable', 'budget_unavailable');
    }
    if ('dimension' in input) {
      const result = this.budgetPort.override(input);
      const released = this.budgetPort.release(input.conversation_id);
      this.blockedBudgetEvents.delete(input.conversation_id);
      for (const agentId of released) {
        const entries = this.liveEntries(agentId);
        for (const entry of entries) {
          entry.budgetHold.delete(input.conversation_id);
          this.retryHeldMessages(entry);
        }
      }
      this.publishTeamBudgetEvent(input.team_id, 'team.budget.override', {
        conversation_id: input.conversation_id,
        dimension: input.dimension,
        previous_max: result.previous_max,
        max: result.max,
        by: 'human',
        via: input.via ?? 'api',
      });
      return { action: 'override', team_id: input.team_id, ...result };
    }
    return {
      action: 'status',
      team_id: input.team_id,
      conversations: this.budgetPort.status(input),
    };
  }

  /** override / release 后重新准入 mailbox 里的消息 */
  private retryHeldMessages(entry: BodyEntry): void {
    if (entry.pending.length === 0 || entry.retired || entry.closing) return;
    const record = this.registry.get(entry.agentId);
    if (record === undefined) return;
    const held = entry.pending.splice(0);
    void (async () => {
      for (const message of held) {
        try {
          const submitted = await this.submitMessage(record, entry, message);
          this.runMessageIds.set(submitted.runId, message.id);
        } catch (error) {
          this.logger.warn('agent.budget.retry_failed', {
            agent_id: record.id,
            session_id: entry.bodyId,
            error: errorText(error),
          });
        }
      }
    })();
  }

  /** 发送者所属 Team 优先；human / owner 无 Team 时退回目标 Team */
  private resolveOriginTeam(from: string, target: MemberRecord): string | undefined {
    return this.registry.resolve(from)?.teamId ?? target.teamId;
  }

  /** 是否 human principal（直接对话免 conversation budget） */
  private isHumanPrincipal(id: string): boolean {
    if (id === 'human' || id === 'system' || id === this.defaultOwner) return true;
    if (id.startsWith('federation:')) return false;
    const record = this.registry.get(id);
    if (record === undefined) return true;
    return record.role === 'single';
  }

  /**
   * 准入可见性：先按 sender 自身身份判定（private 成员的 owner 语义不变）；
   * 人类 / 管理面入口再退一步按 ADMIN_VIEWER 判定，使 private `single`（main）
   * 对 Web / REPL / runs.start 可见，而其它 agent 仍看不到。
   */
  private canAdmitView(record: MemberRecord, from: string): boolean {
    if (this.registry.canView(record, from)) return true;
    if (record.role !== 'single') return false;
    const human = this.isHumanPrincipal(from);
    return human && this.registry.canView(record, ADMIN_VIEWER);
  }

  /** conversation 预算检查 + 通过后的告警收集 */
  private checkDelivery(
    target: MemberRecord,
    from: string,
    conversationId: string,
    teamId?: string,
    originExplicit = false,
  ): BudgetCheckResult {
    if (this.budgetPort === undefined) return { ok: true };
    const resolvedTeamId = teamId ?? this.resolveOriginTeam(from, target);
    const check = this.budgetPort.checkDelivery({
      conversation_id: conversationId,
      ...(resolvedTeamId !== undefined ? { team_id: resolvedTeamId } : {}),
      ...(originExplicit ? { origin_explicit: true } : {}),
      from,
      to: target.id,
    });
    if (check.ok) this.emitBudgetWarnings(target, conversationId, 'enqueue', resolvedTeamId);
    return check;
  }

  private emitBudgetWarnings(
    member: MemberRecord,
    conversationId: string,
    phase: 'enqueue' | 'turn_start',
    teamIdOverride?: string,
  ): void {
    const warnings = this.budgetPort?.takeWarnings?.(conversationId) ?? [];
    for (const warning of warnings) {
      const teamId = teamIdOverride ?? warning.team_id ?? member.teamId;
      if (teamId === undefined) continue;
      this.emit('team.budget.warning', member, {
        conversation_id: conversationId,
        team_id: teamId,
        dimension: warning.dimension,
        current: warning.current,
        max: warning.max,
        threshold: warning.threshold,
        phase,
      });
    }
  }

  private emitBudgetBlocked(
    member: MemberRecord,
    check: BudgetBlockedCheck,
    extra: {
      conversation_id: string;
      message_id?: string;
      from?: string;
      to?: string;
      phase: 'enqueue' | 'turn_start';
      teamId?: string;
    },
  ): void {
    const teamId = extra.teamId ?? member.teamId;
    if (teamId === undefined) return;
    this.emit('team.budget.blocked', member, {
      conversation_id: extra.conversation_id,
      team_id: teamId,
      dimension: check.dimension,
      current: check.current,
      max: check.max,
      reason: check.reason,
      phase: extra.phase,
      ...(extra.message_id !== undefined ? { message_id: extra.message_id } : {}),
      ...(extra.from !== undefined ? { from: extra.from } : {}),
      ...(extra.to !== undefined ? { to: extra.to } : {}),
      ...(check.retry_after_ts !== undefined ? { retry_after_ts: check.retry_after_ts } : {}),
    });
  }

  /** 无成员归属的团队级预算事件（override / team-level blocked） */
  private publishTeamBudgetEvent(
    teamId: string,
    type: string,
    data: Record<string, unknown>,
  ): void {
    if (this.eventStream === undefined) return;
    const payload: Record<string, unknown> = { team_id: teamId, ...data, ts: this.now() };
    try {
      this.eventStream.publish({
        type,
        run_id: `team:${teamId}`,
        data: payload,
        ts: payload.ts as number,
        tenant_id: this.tenantId,
      });
    } catch (error) {
      this.logger.warn('agent.event.publish_failed', { team_id: teamId, error: errorText(error) });
    }
  }

  /** 预算 block reason -> 稳定错误码 */
  private budgetCode(
    reason: BudgetBlockReason,
  ): 'budget_exceeded' | 'budget_unavailable' | 'conversation_team_mismatch' {
    return reason === 'budget_unavailable' || reason === 'conversation_team_mismatch'
      ? reason
      : 'budget_exceeded';
  }

  /** 接收侧检查：无预算端口 / 消息无会话时视为可运行 */
  private checkTurnStart(
    member: MemberRecord,
    message: AgentMessage,
    sessionId: string,
  ): BudgetCheckResult {
    const conversationId = message.conversation_id;
    if (this.budgetPort === undefined || conversationId === undefined) return { ok: true };
    return this.budgetPort.canStartTurn({
      conversation_id: conversationId,
      ...(member.teamId !== undefined ? { team_id: member.teamId } : {}),
      agent_id: member.id,
      session_id: sessionId,
      message_id: message.id,
    });
  }

  /**
   * 关闭前中断并等待成员轮收口：此后不再从队列起新轮，只在跑轮结束（或超时）。
   * 不改 registry 状态 / membership；队列里的后续消息随进程退出丢弃。
   */
  async drain(options: AgentDrainOptions = {}): Promise<AgentDrainOutcome> {
    await this.ready;
    this.draining = true;
    const active = (): boolean => {
      for (const map of this.bodyRegistry.values()) {
        for (const entry of map.values()) {
          if (entry.active !== undefined) return true;
        }
      }
      return false;
    };
    if (!active()) return 'idle';

    for (const map of this.bodyRegistry.values()) {
      for (const entry of map.values()) {
        if (entry.active === undefined) continue;
        try {
          this.runtime.cancel(entry.runtimeMember);
        } catch (error) {
          this.logger.warn('agent.drain.cancel_failed', {
            member_id: entry.agentId,
            session_id: entry.bodyId,
            error: errorText(error),
          });
        }
      }
    }

    const timeoutMs = options.timeoutMs ?? 5000;
    const sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = options.now ?? Date.now;
    const deadline = now() + timeoutMs;
    while (active() && now() < deadline) {
      await sleep(25);
    }
    if (active()) {
      this.logger.warn('agent.drain.timeout', { tenant_id: this.tenantId });
      return 'timeout';
    }
    return 'interrupted';
  }

  async flushSnapshot(): Promise<boolean> {
    await this.ready;
    if (!this.snapshot) return true;
    return this.snapshot.flush();
  }

  /**
   * CONTRACT-hot-apply §4：把权限规则热应用到所有 live Body。
   * 返回成功应用的 Body 数量；port 未实现时返回 0。
   */
  async applyPermissionRules(rules: RuntimePermissionConfig): Promise<number> {
    await this.ready;
    const apply = this.runtime.applyPermissionRules;
    if (typeof apply !== 'function') return 0;
    try {
      const count = await apply.call(this.runtime, rules);
      return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
    } catch (error) {
      this.logger.warn('agent.permission.apply_failed', { error: errorText(error) });
      return 0;
    }
  }

  subscribe(listener: AgentEventListener): () => void {
    if (typeof listener !== 'function') {
      throw new AgentError('invalid_input', 'listener must be a function');
    }
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  /** 发成员事件（默认用 primary Body 的 session）；监听器与 EventStream 异常都隔离 */
  private emit(type: string, member: MemberRecord, extra: AgentEventExtra = {}): void {
    const primary = primaryBody(member);
    this.emitForSession(type, member, primary?.bodyId ?? member.sessionId, extra);
  }

  /**
   * 指定 Body 的事件出口：body 级事件必须带自己的 session_id；
   * `run_id` 始终是成员 id（run.* 由 runtime / scheduler 发布）。
   */
  private emitForSession(
    type: string,
    member: MemberRecord,
    sessionId: string,
    extra: AgentEventExtra = {},
  ): void {
    if (this.listeners.size === 0 && this.eventStream === undefined) return;
    const data: Omit<AgentEvent, 'type'> & Record<string, unknown> = {
      agent_id: member.id,
      session_id: sessionId,
      ...(member.parentId !== undefined ? { parent_id: member.parentId } : {}),
      visibility: member.visibility,
      ...(member.name !== undefined ? { name: member.name } : {}),
      ...(member.teamId !== undefined ? { team_id: member.teamId } : {}),
      ...extra,
      ts: this.now(),
    };
    const event = { type, ...data } as AgentEvent;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn('agent.listener.failed', {
          agent_id: member.id,
          error: errorText(error),
        });
      }
    }
    if (this.eventStream) {
      try {
        this.eventStream.publish({
          type,
          run_id: member.id,
          data,
          ts: data.ts,
          tenant_id: this.tenantId,
        });
      } catch (error) {
        this.logger.warn('agent.event.publish_failed', {
          agent_id: member.id,
          error: errorText(error),
        });
      }
    }
  }

  /** 对外状态：叠加 body 运行态 */
  private statusFor(record: MemberRecord): MemberStatus {
    const status = toMemberStatus(record);
    const entries = this.liveEntries(record.id);
    if (entries.length === 0) return status;
    return {
      ...status,
      bodies: entries
        .sort((left, right) => Number(right.primary) - Number(left.primary))
        .map(toBodyStatus),
    };
  }

  private requireAgent(agentId: string): MemberRecord {
    const record = this.registry.get(agentId) ?? this.registry.resolve(agentId);
    if (!record) throw new AgentError('unknown_member', `unknown_member: ${agentId}`);
    return record;
  }

  private requireMember(ref: string): MemberRecord {
    const member = this.registry.resolve(ref);
    if (!member) throw new AgentError('unknown_member', `unknown_member: ${ref}`);
    return member;
  }

  /** 显式 id 先校验；缺省由人类入口生成 `conv_<id>` */
  private resolveConversationId(value: unknown): string {
    if (value === undefined) return generateConversationId(this.newId);
    if (!isValidConversationId(value)) {
      throw new AgentError('invalid_input', 'invalid conversation_id');
    }
    return value;
  }

  /**
   * 入队时标注发送者类别（仅用于模型上下文，不参与权限判定）。
   * 未登记 principal / `human` / role single 视为人类；`system` 保持系统来源。
   */
  private messageSource(from: string): AgentMessage['source'] {
    if (from === 'system') return 'system';
    if (from.startsWith('federation:')) return 'agent';
    const record = this.registry.get(from);
    if (record === undefined) return 'human';
    return record.role === 'single' ? 'human' : 'agent';
  }

  /**
   * 发送者显示名：只对本机登记成员有值。人类 / 系统 / 联邦地址没有本机成员名，
   * 返回 undefined，渲染时退回短 id。
   */
  private senderName(from: string): string | undefined {
    const record = this.registry.get(from);
    return record === undefined ? undefined : record.name;
  }

  private scheduleSnapshot(): void {
    this.snapshot?.schedule(() => this.registry.all().map(toPersistedRecord));
  }
}

/** 工厂：保持入口层只依赖契约 */
export function createAgentService(options: AgentServiceOptions): AgentService {
  return new AgentServiceImpl(options);
}

/** 读必填字符串；缺失 / 空串抛 invalid_input */
function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (!nonEmpty(value)) {
    throw new AgentError('invalid_input', `${key} must be a non-empty string`);
  }
  return value;
}

/** 缺省 → undefined；存在但为空 / 非字符串 → invalid_input（不静默忽略）。 */
function readUpdateString(record: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(record, key) || record[key] === undefined) return undefined;
  return readRequiredString(record, key);
}

/** update 的 role：缺省或合法值；其它值拒绝 */
function readUpdateRole(record: Record<string, unknown>): AgentRole | undefined {
  if (!Object.hasOwn(record, 'role') || record.role === undefined) return undefined;
  return readAgentRole(record, 'role');
}

/** 严格的 role 字面量校验 */
function readAgentRole(record: Record<string, unknown>, key: string): AgentRole {
  const value = record[key];
  if (value !== 'single' && value !== 'member' && value !== 'temporary') {
    throw new AgentError('invalid_input', `${key} must be single, member or temporary`);
  }
  return value;
}

/** 消息体：非空且不超过上限 */
function readContent(record: Record<string, unknown>, key: string): string {
  const value = readRequiredString(record, key);
  if (Buffer.byteLength(value, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new AgentError('invalid_input', `content exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return nonEmpty(value) ? value : undefined;
}
