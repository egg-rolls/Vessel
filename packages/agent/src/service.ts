/**
 * AgentService：成员生命周期、消息队列与回复投递。
 *
 * 约束：
 * - `send` 入队即返回，不等待 runTurn；
 * - 同一成员同时只有一轮在跑，其余消息排队；
 * - close 先 cancel 当前轮再 dispose；后到的 run 终态不得覆盖 closed；
 * - 消息队列只在内存；状态变化经节流 snapshot 落盘。
 *
 * @module @vessel-agent/agent
 */

import { randomUUID } from 'node:crypto';
import {
  assertTenantId,
  type EventStream,
  type Logger,
  noopLogger,
  type RunEvent,
} from '@vessel-agent/core';
import { generateConversationId, isValidConversationId } from './conversation-budget.js';
import {
  type MemberRecord,
  MemberRegistry,
  toMemberStatus,
  toPersistedRecord,
  toRuntimeMember,
} from './registry.js';
import { AgentSnapshotStore, snapshotPath } from './snapshot.js';
import {
  type AgentBodyPointer,
  type AgentDrainOptions,
  type AgentDrainOutcome,
  AgentError,
  type AgentEvent,
  type AgentEventListener,
  type AgentMessage,
  type AgentService,
  type AgentServiceOptions,
  type AgentUpdateBatchInput,
  type AgentUpdateField,
  type AgentUpdateInput,
  type AgentUpdateResult,
  type AttachOwnerInput,
  type BatchItemResult,
  type BatchResult,
  type BudgetBlockReason,
  type BudgetCheckResult,
  type BudgetOverrideInput,
  type BudgetOverview,
  type BudgetStatusInput,
  type CloseBatchInput,
  type CloseInput,
  type CloseResult,
  type ConversationBudgetPort,
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
  type NewBatchInput,
  type NewMemberInput,
  type PersistedAgentRecord,
  type ReinstateInput,
  type ReplyResult,
  type RotateInput,
  type RotateResult,
  type SendBatchInput,
  type SendInput,
  type SendResult,
  type TeamBinder,
} from './types.js';

const VISIBILITIES: readonly MemberVisibility[] = ['private', 'team', 'tenant'];

/** 单成员运行态（不落 snapshot）；队列 per-agent，不 per-body */
interface MemberQueue {
  pending: AgentMessage[];
  turnActive: boolean;
  /** 本轮实际运行的 Body（pump 时捕获） */
  activeBodySession?: string;
  /** 本轮 conversation（0.19 S4；系统消息也继承） */
  activeConversationId?: string;
  repliedThisTurn: boolean;
  closing: boolean;
  /** `${session_id}|${key}`；rotate 成功 / close 时清空 */
  warnedSignals: Set<string>;
  /** 接收侧被预算挡下的 conversation（只作 bookkeeping，override / release 时清） */
  budgetHold: Set<string>;
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
  | { ok: false; code: 'fork_not_allowed' | 'fork_failed' | 'agent_left'; reason: string };

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

/** 从快照恢复记录：engine 状态是进程内易失，重启后非 left 一律 idle + gone */
function recordFromStatus(status: PersistedAgentRecord, now: number): MemberRecord {
  const state: MemberState =
    status.membership === 'left' || status.state === 'closed' ? 'closed' : 'idle';
  const currentBody = status.current_body ?? {
    session_id: status.session_id,
    epoch: 0,
    started_at: status.last_seen ?? now,
  };
  return {
    id: status.id,
    sessionId: status.session_id,
    ...(status.name !== undefined ? { name: status.name } : {}),
    ...(status.parent_id !== undefined ? { parentId: status.parent_id } : {}),
    owner: status.owner,
    visibility: status.visibility,
    state,
    presence: 'gone',
    membership: status.membership,
    ...(status.team_id !== undefined ? { teamId: status.team_id } : {}),
    rotation: 'stable',
    currentBody,
    bodyHistory: status.body_history ?? [],
    ...(status.model !== undefined ? { model: status.model } : {}),
    ...(status.system_prompt !== undefined ? { systemPrompt: status.system_prompt } : {}),
    ...(status.forked_from !== undefined ? { forkedFrom: status.forked_from } : {}),
    ...(status.current_tool !== undefined ? { currentTool: status.current_tool } : {}),
    ...(status.last_seen !== undefined ? { lastSeen: status.last_seen } : {}),
    ...(status.usage !== undefined ? { usage: status.usage } : {}),
  };
}

/** 默认实现 */
export class AgentServiceImpl implements AgentService {
  private readonly registry: MemberRegistry;
  private readonly runtime: AgentServiceOptions['runtime'];
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly logger: Logger;
  private readonly snapshot: AgentSnapshotStore | undefined;
  private readonly queues = new Map<string, MemberQueue>();
  /** drain 之后不再从队列起新轮（关闭窗口内排队的消息随进程退出丢弃） */
  private draining = false;
  /** gone 成员的 single-flight resume；同一 id 并发 dispatch 只 spawn 一次 */
  private readonly resuming = new Map<string, Promise<void>>();
  /** 同一源成员的 single-flight fork；并发只 spawn 一个新 Agent */
  private readonly forking = new Map<string, Promise<ForkOutcome>>();
  /** 进行中的 rotate（agentId → 旧 / 新 Body）；只在内存 */
  private readonly rotations = new Map<string, RotationState>();
  /** external owner（REPL 主 agent）：队列由 takeMessages 消费，pump 永不执行 */
  private readonly externalOwners = new Set<string>();
  private readonly listeners = new Set<AgentEventListener>();
  private readonly tenantId: string;
  private readonly eventStream: EventStream | undefined;
  private readonly defaultModel: string | undefined;
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

    this.registry = new MemberRegistry(options.now);
    this.runtime = options.runtime;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.logger = options.logger ?? noopLogger;
    this.tenantId = options.tenantId;
    this.eventStream = options.events;
    this.defaultModel = options.defaultModel;
    this.defaultWorkspace = nonEmpty(options.defaultWorkspace)
      ? options.defaultWorkspace
      : undefined;
    this.teamBinder = options.teamBinder;
    this.teamPolicy = options.teamPolicy;
    this.budgetPort = options.budget;

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
   * 旧快照里的重名容忍加载并 warning（new 才会强制唯一）。
   */
  private async loadSnapshot(): Promise<void> {
    if (!this.snapshot) return;
    let members: PersistedAgentRecord[] = [];
    try {
      members = await this.snapshot.load();
    } catch (error) {
      // load 自身不抛；这里兜底，避免损坏文件阻塞构造
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
        // 兼容事件：payload 用新语义（gone / idle），事件名仅为 wire 兼容保留
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

  async 'new'(input: NewMemberInput): Promise<MemberStatus>;
  async 'new'(input: NewBatchInput): Promise<BatchResult<MemberStatus>>;
  async 'new'(
    input: NewMemberInput | NewBatchInput,
  ): Promise<MemberStatus | BatchResult<MemberStatus>> {
    await this.ready;
    const record = input as unknown as Record<string, unknown>;
    if ('members' in record) {
      if (
        record.name !== undefined ||
        record.model !== undefined ||
        record.systemPrompt !== undefined ||
        record.visibility !== undefined ||
        record.parentId !== undefined ||
        record.owner !== undefined ||
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

  /**
   * 注册 root owner（REPL 主 agent）。
   * 不调用 runtime.spawn；恢复的记录置 live / present，并补齐 current_body。
   */
  async attachOwner(input: AttachOwnerInput): Promise<MemberStatus> {
    await this.ready;
    const raw = input as unknown as Record<string, unknown>;
    const id = readRequiredString(raw, 'id');
    const sessionId = raw.sessionId === undefined ? id : readRequiredString(raw, 'sessionId');
    const visibility = resolveVisibility(raw.visibility, 'private');

    const existing = this.registry.get(id);
    if (existing) {
      if (existing.parentId !== undefined || existing.owner !== existing.id) {
        throw new AgentError('invalid_input', `id belongs to a spawned member: ${id}`);
      }
      const sessionOwner = this.registry.resolve(sessionId);
      if (sessionOwner !== undefined && sessionOwner.id !== id) {
        throw new AgentError('invalid_input', `duplicate session id: ${sessionId}`);
      }
      this.registry.updateIdentity(id, { sessionId, visibility });
      // 唯一的 left→present 例外：root owner 由人显式重新附着，必须完整复活。
      // S3 roster 落地后重新审视是否仍需该例外。
      if (existing.state === 'closed' || existing.state === 'stale') existing.state = 'idle';
      existing.membership = 'present';
      this.registry.setPresence(id, 'live');
      if (existing.currentBody?.session_id !== sessionId) {
        this.registry.setCurrentBody(id, {
          session_id: sessionId,
          epoch: existing.currentBody?.epoch ?? 0,
          started_at: this.now(),
        });
      }
      this.externalOwners.add(id);
      this.scheduleSnapshot();
      return toMemberStatus(existing);
    }

    if (this.registry.resolve(sessionId) !== undefined) {
      throw new AgentError('invalid_input', `duplicate session id: ${sessionId}`);
    }
    const record: MemberRecord = {
      id,
      sessionId,
      owner: id,
      visibility,
      state: 'idle',
      presence: 'live',
      membership: 'present',
      rotation: 'stable',
      currentBody: { session_id: sessionId, epoch: 0, started_at: this.now() },
      bodyHistory: [],
    };
    this.registry.add(record);
    this.queueFor(id);
    this.externalOwners.add(id);
    this.scheduleSnapshot();
    return toMemberStatus(record);
  }

  private async createOne(input: Record<string, unknown>): Promise<MemberStatus> {
    const owner = input.owner === undefined ? DEFAULT_OWNER : readRequiredString(input, 'owner');
    const id = this.newId();
    if (!nonEmpty(id)) throw new AgentError('invalid_input', 'id generator returned an empty id');

    const name = optionalString(input.name);
    // 显式 workspace 只由 CLI 传入；默认 workspace 来自配置声明。
    const explicitWorkspace =
      input.workspace === undefined ? undefined : readRequiredString(input, 'workspace');
    const workspace = explicitWorkspace ?? this.defaultWorkspace;
    let teamId: string | undefined;
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

    // 绑定 Team 且调用方未显式指定 visibility 时缺省 team；否则沿用 private。
    const visibility =
      teamId !== undefined && input.visibility === undefined
        ? 'team'
        : resolveVisibility(input.visibility, 'private');

    // 名称只由 present 成员占用：同 Team 内唯一；unbound 沿用 tenant 全扫。
    // 检查与 add 之间不得有 await。
    if (
      name !== undefined &&
      this.registry
        .findByName(name)
        .some(
          (record) =>
            record.membership === 'present' && (teamId === undefined || record.teamId === teamId),
        )
    ) {
      throw new AgentError('invalid_input', `duplicate member name: ${name}`);
    }

    const record: MemberRecord = {
      id,
      // session 即成员：两者同值，消息可用任一寻址
      sessionId: id,
      owner,
      visibility,
      state: 'created',
      presence: 'gone',
      membership: 'present',
      rotation: 'stable',
      currentBody: { session_id: id, epoch: 0, started_at: this.now() },
      bodyHistory: [],
    };
    if (name !== undefined) record.name = name;
    if (teamId !== undefined) record.teamId = teamId;
    const parentId = optionalString(input.parentId);
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
    this.emit('agent.spawned', record, { state: 'idle', presence: 'live' });
    return toMemberStatus(record);
  }

  /**
   * 创建路径共用的 spawn / 回滚骨架（createOne 与 fork）。
   * registry.add → runtime.spawn；失败移除新增记录与队列后重抛，成功 idle + live。
   * 事件由调用方在各自的前置检查之后再发（fork 的源复查必须先于事件）。
   */
  private async spawnRecord(record: MemberRecord): Promise<void> {
    this.registry.add(record);
    try {
      await this.runtime.spawn(toRuntimeMember(record));
    } catch (error) {
      this.registry.remove(record.id);
      this.queues.delete(record.id);
      throw error;
    }
    this.registry.setState(record.id, 'idle');
    this.registry.setPresence(record.id, 'live');
    this.scheduleSnapshot();
  }

  /**
   * 0.20 fork：resume 失败后的兜底。single-flight（同一源并发只 spawn 一次）。
   *
   * 失败一律显式且零写入：源记录不动，registry 不留新记录，不发事件。
   * 成功时源仍保持 present + gone；新 Agent 不继承历史 / body_history。
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
      this.queueFor(sourceId).closing
    ) {
      return { ok: false, code: 'agent_left', reason: `agent_left: ${sourceId}` };
    }
    // fork 必须显式可见；private 成员永不写 Team 日志。
    if (source.visibility === 'private') {
      return { ok: false, code: 'fork_not_allowed', reason: 'fork_not_allowed: private' };
    }
    const teamId = source.teamId;
    if (teamId === undefined || this.teamBinder === undefined) {
      return { ok: false, code: 'fork_not_allowed', reason: 'fork_not_allowed: no_team' };
    }
    if (this.teamBinder.get(teamId) === undefined) {
      return { ok: false, code: 'fork_not_allowed', reason: 'fork_not_allowed: no_team' };
    }

    // 用现有 forked_from 自描述去重，不新增源侧指针、不写源记录。
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

    const record: MemberRecord = {
      id,
      sessionId: id,
      name,
      owner: source.owner,
      visibility: source.visibility,
      state: 'created',
      presence: 'gone',
      membership: 'present',
      teamId,
      rotation: 'stable',
      currentBody: { session_id: id, epoch: 0, started_at: this.now() },
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
    // 复查必须先于 agent.forked：否则日志会出现一条无法回滚的 fork。
    const currentSource = this.registry.get(source.id);
    if (
      currentSource === undefined ||
      currentSource.membership === 'left' ||
      currentSource.state === 'closed' ||
      this.queueFor(source.id).closing
    ) {
      await this.disposeBody(toRuntimeMember(record));
      this.registry.remove(record.id);
      this.queues.delete(record.id);
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
            ? this.enqueue(entry)
            : Promise.reject(new AgentError('invalid_input', 'messages entries must be objects')),
        ),
      );
      return settleBatch(settled);
    }
    return this.enqueue(record);
  }

  /** strict send 入队（不 resume）；async 只为把校验异常转成逐条 rejection */
  private async enqueue(input: Record<string, unknown>): Promise<SendResult> {
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
    if (this.queueFor(target.id).closing) {
      throw new AgentError('member_closed', `member_closed: ${to}`);
    }
    if (!this.registry.canView(target, from)) {
      throw new AgentError('member_not_visible', `member_not_visible: ${to}`);
    }

    const conversationId = this.resolveConversationId(input.conversation_id);
    const teamId = this.resolveOriginTeam(from, target);
    // 状态 / 可见性检查在前，预算检查在后：被拒绝的投递不预留 hop。
    const check = this.checkDelivery(target, from, conversationId, teamId);
    if (!check.ok) {
      this.emitBudgetBlocked(target, check, {
        conversation_id: conversationId,
        from,
        to: target.id,
        phase: 'enqueue',
        ...(teamId !== undefined ? { teamId } : {}),
      });
      throw new AgentError(this.budgetCode(check.reason), `${check.reason}: ${check.dimension}`);
    }
    return this.enqueueMessage(target, content, from, conversationId);
  }

  /** 唯一入队实现：send / dispatch / reply 之外的入队路径都走这里 */
  private enqueueMessage(
    target: MemberRecord,
    content: string,
    from: string,
    conversationId: string | undefined,
    kind?: AgentMessage['kind'],
  ): SendResult {
    const message: AgentMessage = {
      id: this.newId(),
      from,
      to: target.id,
      content,
      ts: this.now(),
      ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
      ...(kind !== undefined ? { kind } : {}),
    };
    const queue = this.queueFor(target.id);
    queue.pending.push(message);
    this.registry.touch(target.id);
    this.emit('agent.message.queued', target, {
      state: target.state,
      message_id: message.id,
      from,
      ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
    });
    this.scheduleSnapshot();
    this.pump(target.id);
    return { queued: true, message_id: message.id, state: target.state };
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
   * dispatch：统一投递入口。
   * `to` 解析顺序 id/session → 唯一 name；gone 走 single-flight resume。
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
    // close 已置 closing 但尚未清空队列：不再入队，避免返回 queued 后消息被丢弃。
    if (this.queueFor(target.id).closing) {
      return { status: 'rejected', code: 'agent_left', reason: `agent_left: ${target.id}` };
    }

    const conversationId = this.resolveConversationId(input.conversation_id);
    const originTeamId =
      raw.origin_team_id === undefined ? undefined : readRequiredString(raw, 'origin_team_id');
    if (target.rotation === 'rotating') {
      const rejected = this.budgetBeforeEnqueue(target, from, conversationId, originTeamId);
      if (rejected !== undefined) return rejected;
      const result = this.enqueueMessage(target, content, from, conversationId);
      return {
        status: 'queued',
        message_id: result.message_id,
        resolved_to: target.id,
        resolution: 'rotating',
        conversation_id: conversationId,
      };
    }
    if (target.presence === 'live') {
      const rejected = this.budgetBeforeEnqueue(target, from, conversationId, originTeamId);
      if (rejected !== undefined) return rejected;
      const result = this.enqueueMessage(target, content, from, conversationId);
      return {
        status: 'queued',
        message_id: result.message_id,
        resolved_to: target.id,
        resolution: 'live',
        conversation_id: conversationId,
      };
    }

    try {
      await this.ensureResumed(target.id);
    } catch (error) {
      // resume 失败：只有显式/team policy 允许且满足 fork 前置时才兜底；不得静默降级。
      if (!this.resolveAllowFork(target, raw.allow_fork)) {
        return { status: 'rejected', code: 'resume_failed', reason: errorText(error) };
      }
      const fork = await this.ensureForked(target.id);
      if (!fork.ok) {
        if (fork.code === 'agent_left') {
          return { status: 'rejected', code: 'agent_left', reason: fork.reason };
        }
        if (fork.code === 'fork_failed') {
          return { status: 'rejected', code: 'fork_failed', reason: fork.reason };
        }
        // fork_not_allowed：没有发生 fork，仍按 resume 失败显式拒绝。
        return { status: 'rejected', code: 'resume_failed', reason: fork.reason };
      }
      const forked = this.registry.get(fork.member.id);
      if (forked === undefined || forked.membership === 'left' || forked.state === 'closed') {
        return { status: 'rejected', code: 'agent_left', reason: `agent_left: ${target.id}` };
      }
      const rejectedFork = this.budgetBeforeEnqueue(forked, from, conversationId, originTeamId);
      if (rejectedFork !== undefined) return rejectedFork;
      const forkedResult = this.enqueueMessage(forked, content, from, conversationId);
      return {
        status: 'queued',
        message_id: forkedResult.message_id,
        resolved_to: forked.id,
        resolution: 'forked',
        conversation_id: conversationId,
      };
    }
    // resume 期间成员可能已被 close：复查后拒绝，不把消息投进已关闭成员
    const current = this.registry.get(target.id);
    if (
      current === undefined ||
      current.membership === 'left' ||
      current.state === 'closed' ||
      current.presence === 'gone'
    ) {
      return { status: 'rejected', code: 'agent_left', reason: `agent_left: ${target.id}` };
    }
    // resume 后、入队前检查（检查与入队之间没有 await）
    const rejected = this.budgetBeforeEnqueue(current, from, conversationId, originTeamId);
    if (rejected !== undefined) return rejected;
    const result = this.enqueueMessage(current, content, from, conversationId);
    return {
      status: 'queued',
      message_id: result.message_id,
      resolved_to: current.id,
      resolution: 'resumed',
      conversation_id: conversationId,
    };
  }

  /** 发送侧预算检查：通过返回 undefined，拒绝时发 blocked 事件并给出 DispatchResult */
  private budgetBeforeEnqueue(
    target: MemberRecord,
    from: string,
    conversationId: string,
    originTeamId?: string,
  ): DispatchResult | undefined {
    const teamId = originTeamId ?? this.resolveOriginTeam(from, target);
    const check = this.checkDelivery(
      target,
      from,
      conversationId,
      teamId,
      originTeamId !== undefined,
    );
    if (check.ok) return undefined;
    this.emitBudgetBlocked(target, check, {
      conversation_id: conversationId,
      from,
      to: target.id,
      phase: 'enqueue',
      ...(teamId !== undefined ? { teamId } : {}),
    });
    return {
      status: 'rejected',
      code: this.budgetCode(check.reason),
      reason: `${check.reason}: ${check.dimension}`,
    };
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
    // present 优先；只有 left 匹配时选中它，由 dispatch 返回 agent_left。
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

  /**
   * single-flight resume：同一成员并发 dispatch 只 spawn 一次。
   * spawn 成功后复查 membership（close 可能在等待期间发生）。
   */
  private async ensureResumed(id: string): Promise<void> {
    const inflight = this.resuming.get(id);
    if (inflight) return inflight;
    const promise = this.resumeOne(id);
    this.resuming.set(id, promise);
    try {
      await promise;
    } finally {
      if (this.resuming.get(id) === promise) this.resuming.delete(id);
    }
  }

  private async resumeOne(id: string): Promise<void> {
    const record = this.registry.get(id);
    if (!record) throw new AgentError('unknown_member', `unknown_member: ${id}`);
    await this.runtime.spawn(toRuntimeMember(record));

    const current = this.registry.get(id);
    if (!current || current.membership === 'left' || current.state === 'closed') {
      if (current) {
        try {
          await this.runtime.dispose(toRuntimeMember(current));
        } catch (error) {
          this.logger.warn('agent.dispose.failed', { member_id: id, error: errorText(error) });
        }
        this.registry.setPresence(id, 'gone');
      }
      throw new AgentError('member_closed', `agent_left: ${id}`);
    }
    this.registry.setPresence(id, 'live');
    this.emit('agent.resumed', current, {
      presence: 'live',
      state: current.state,
      epoch: current.currentBody?.epoch ?? 0,
    });
  }

  /**
   * 换一具新 Body：新 session + epoch + 1，spawn 成功后原子切指针并落盘。
   * 失败保持旧指针、不自动 fork / 重试 / 限流；启动嘱托只在成功后入队。
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
    const queue = this.queueFor(target.id);
    if (target.membership === 'left' || target.state === 'closed' || queue.closing) {
      return { status: 'failed', code: 'agent_left', reason: `agent_left: ${target.id}` };
    }
    if (this.rotations.has(target.id) || target.rotation === 'rotating') {
      return { status: 'failed', code: 'rotating', reason: `rotating: ${target.id}` };
    }
    if (target.presence !== 'live') {
      return { status: 'failed', code: 'body_not_live', reason: `body_not_live: ${target.id}` };
    }
    if (this.externalOwners.has(target.id)) {
      return { status: 'failed', code: 'rotate_failed', reason: 'owner_not_rotatable' };
    }

    // 最终 self-only 闸门：调用者 session 必须就是 target 的当前 Body。
    const callerSession = input.from_session_id;
    if (callerSession !== undefined) {
      const caller = this.registry.resolve(callerSession);
      if (caller !== target || target.currentBody?.session_id !== callerSession) {
        return {
          status: 'failed',
          code: 'not_current_body',
          reason: `not_current_body: ${callerSession}`,
        };
      }
    }

    const startupPrompt = readContent(raw, 'startup_prompt');

    // 指针切换前捕获旧 Body 身份与可回滚状态。
    const oldPointer: AgentBodyPointer = target.currentBody ?? {
      session_id: target.sessionId,
      epoch: 0,
      started_at: this.now(),
    };
    const fromSessionId = oldPointer.session_id;
    const fromEpoch = oldPointer.epoch;
    const oldBodyHistory = [...target.bodyHistory];
    const oldMember = toRuntimeMember(target);

    const toSessionId = this.newId();
    if (!nonEmpty(toSessionId) || this.registry.resolve(toSessionId) !== undefined) {
      this.emitForSession('agent.rotate.failed', target, fromSessionId, {
        from_session_id: fromSessionId,
        ...(nonEmpty(toSessionId) ? { to_session_id: toSessionId } : {}),
        reason: 'session_id_collision',
      });
      return { status: 'failed', code: 'rotate_failed', reason: 'session_id_collision' };
    }
    const toEpoch = fromEpoch + 1;
    const newMember: MemberRuntimeMember = { ...oldMember, session_id: toSessionId };

    const isAborted = (): boolean => {
      const current = this.registry.get(target.id);
      return (
        current === undefined ||
        current.membership === 'left' ||
        current.state === 'closed' ||
        this.queueFor(target.id).closing
      );
    };

    this.registry.setRotation(target.id, 'rotating');
    this.rotations.set(target.id, { fromSessionId, fromEpoch, toSessionId, toEpoch });
    this.emitForSession('agent.rotating', target, fromSessionId, {
      from_session_id: fromSessionId,
      to_session_id: toSessionId,
      epoch: toEpoch,
    });

    try {
      try {
        await this.runtime.spawn(newMember);
      } catch (error) {
        this.registry.setRotation(target.id, 'stable');
        this.rotations.delete(target.id);
        this.emitForSession('agent.rotate.failed', target, fromSessionId, {
          from_session_id: fromSessionId,
          to_session_id: toSessionId,
          reason: errorText(error),
        });
        this.pump(target.id);
        return { status: 'failed', code: 'rotate_failed', reason: errorText(error) };
      }

      // spawn 之后可能已 close：dispose 新 engine，不切换指针。
      if (isAborted()) {
        this.registry.setRotation(target.id, 'stable');
        this.rotations.delete(target.id);
        await this.disposeBody(newMember);
        this.emitForSession('agent.rotate.failed', target, fromSessionId, {
          from_session_id: fromSessionId,
          to_session_id: toSessionId,
          reason: 'agent_left',
        });
        return { status: 'failed', code: 'agent_left', reason: `agent_left: ${target.id}` };
      }

      this.registry.pushBodyHistory(target.id, { ...oldPointer, retired_at: this.now() });
      this.registry.setCurrentBody(target.id, {
        session_id: toSessionId,
        epoch: toEpoch,
        started_at: this.now(),
      });
      this.scheduleSnapshot();
      let ok = false;
      try {
        ok = await this.flushSnapshot();
      } catch {
        ok = false;
      }

      // flush 之后才 close：指针已提交，不再回滚；新 engine 由 close / 本分支回收。
      if (isAborted()) {
        this.registry.setRotation(target.id, 'stable');
        this.rotations.delete(target.id);
        await this.disposeBody(newMember);
        this.emitForSession('agent.rotate.failed', target, fromSessionId, {
          from_session_id: fromSessionId,
          to_session_id: toSessionId,
          reason: 'agent_left',
        });
        return { status: 'failed', code: 'agent_left', reason: `agent_left: ${target.id}` };
      }

      if (!ok) {
        this.registry.setCurrentBody(target.id, oldPointer);
        this.registry.setBodyHistory(target.id, oldBodyHistory);
        this.registry.setRotation(target.id, 'stable');
        this.rotations.delete(target.id);
        await this.disposeBody(newMember);
        this.emitForSession('agent.rotate.failed', target, fromSessionId, {
          from_session_id: fromSessionId,
          to_session_id: toSessionId,
          reason: 'snapshot_write_failed',
        });
        this.pump(target.id);
        return { status: 'failed', code: 'rotate_failed', reason: 'snapshot_write_failed' };
      }

      // 旧 Body 的 80% 预警不得发给新 Body；按 kind 移除，不匹配正文前缀。
      for (let i = queue.pending.length - 1; i >= 0; i--) {
        if (queue.pending[i]?.kind === 'limit_warning') queue.pending.splice(i, 1);
      }
      // rotate startup 是系统消息：不计 hop，但运行起来算一次 turn；继承触发 rotate 的会话。
      const startupConversationId =
        queue.activeConversationId ?? generateConversationId(this.newId);
      queue.pending.unshift({
        id: this.newId(),
        from: 'system',
        to: target.id,
        content: startupPrompt,
        ts: this.now(),
        conversation_id: startupConversationId,
      });
      queue.warnedSignals.clear();
      this.emitForSession('agent.rotated', target, toSessionId, {
        from_session_id: fromSessionId,
        to_session_id: toSessionId,
        epoch: toEpoch,
      });
      this.scheduleSnapshot();
      this.registry.setRotation(target.id, 'stable');
      this.rotations.delete(target.id);

      // 没有在跑的旧轮才立即退役；否则交给 executeTurn 的 stale 分支。
      if (!queue.turnActive) {
        const disposed = await this.disposeBody(oldMember);
        this.emitForSession('agent.retired', target, fromSessionId, {
          body_id: fromSessionId,
          epoch: fromEpoch,
          reason: disposed ? 'rotation' : 'dispose_failed',
        });
      }

      this.pump(target.id);
      return {
        status: 'rotated',
        agent_id: target.id,
        from_session_id: fromSessionId,
        to_session_id: toSessionId,
        epoch: toEpoch,
      };
    } finally {
      // 任何出口都不得留下 rotating 相位或残留的 rotation state。
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

    const queue = this.queueFor(member.id);
    queue.closing = true;
    queue.pending.length = 0;
    queue.warnedSignals.clear();
    queue.budgetHold.clear();
    queue.activeConversationId = undefined;

    const activeSession = queue.activeBodySession;
    const currentSession = member.currentBody?.session_id ?? member.sessionId;
    if (queue.turnActive) {
      try {
        await this.runtime.cancel(
          this.runtimeMemberForSession(member, activeSession ?? currentSession),
        );
      } catch (error) {
        this.logger.warn('agent.cancel.failed', {
          member_id: member.id,
          error: errorText(error),
        });
      }
    }

    // cancel 期间执行内核仍可能完成本轮；closing 已置位，executeTurn 不会覆盖 closed
    this.registry.setState(member.id, 'closed');
    member.membership = 'left';
    this.registry.setPresence(member.id, 'gone');
    queue.pending.length = 0;
    this.emit('agent.closed', member, { state: 'closed', presence: 'gone' });
    this.scheduleSnapshot();

    // 旧 / 新 / 正在 rotate 的目标 Body 全部回收（dispose 按 session 幂等）。
    const sessions = new Set<string>();
    if (activeSession !== undefined) sessions.add(activeSession);
    sessions.add(currentSession);
    sessions.add(member.sessionId);
    const rotating = this.rotations.get(member.id);
    if (rotating !== undefined) sessions.add(rotating.toSessionId);
    for (const sessionId of sessions) {
      await this.disposeBody(this.runtimeMemberForSession(member, sessionId));
    }
    queue.activeBodySession = undefined;

    await this.flushSnapshot();
    return { state: 'closed' };
  }

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
      // 与 new / close 一致：条目并行，失败隔离，结果保持输入顺序。
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

  /**
   * 单条更新。
   *
   * - `name` 立即改并保持同 Team（unbound 为 tenant）内 present 成员唯一；
   * - `model` / `systemPrompt` 只写入记录，已有 Body 不重建——下一次 spawn 才生效；
   * - 事件 `agent.updated` 只带变化字段名，不带 prompt 正文。
   */
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
    if (name === undefined && model === undefined && systemPrompt === undefined) {
      throw new AgentError('invalid_input', 'update requires name, model or systemPrompt');
    }

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
    this.scheduleSnapshot();
    if (changed.length > 0) {
      // 只发字段名；prompt 正文永不进事件。
      this.emit('agent.updated', target, { changed });
    }
    const affectsNextBody = changed.includes('model') || changed.includes('system_prompt');
    return {
      agent: toMemberStatus(target),
      changed,
      ...(affectsNextBody ? { applies_to: 'next_body' as const } : {}),
    };
  }

  /** update 选择器：id / 当前 Body session 直取；否则唯一当前名字。 */
  private resolveUpdateTarget(ref: string): MemberRecord {
    const direct = this.registry.resolve(ref);
    if (direct !== undefined) return direct;
    const matches = this.registry.findByName(ref);
    if (matches.length === 0) {
      throw new AgentError('unknown_member', `unknown_member: ${ref}`);
    }
    // present 优先；只剩 left 时选中它，由 updateOne 返回 member_closed。
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
   *
   * 这是继 `attachOwner` 之后**第二条人力 `left → present` 路径**：只由 roster 管理
   * （teams.members add / owner 端点）调用，engine 与普通投递路径都不能复活成员。
   * `closed → idle` 不能走普通 `setState`（TRANSITIONS.closed 为空数组），因此与
   * `attachOwner` 一样直接写 state。不 spawn、不新建 session，Body / 历史全部保留；
   * 下一次 dispatch 才由 single-flight resume 拉起 engine。
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
    if (this.externalOwners.has(target.id) || target.owner === target.id) {
      throw new AgentError('invalid_input', 'owner_not_rosterable');
    }
    if (target.teamId !== undefined && target.teamId !== teamId) {
      throw new AgentError('invalid_input', `already_in_team: ${target.teamId}`);
    }

    const stillPresent = target.membership === 'present' && target.state !== 'closed';
    if (stillPresent && target.teamId === teamId) {
      return toMemberStatus(target);
    }

    if (stillPresent) {
      // 已 present 只是未绑定：只补 team_id，不改 state / presence，也不清队列。
      this.registry.setTeamId(target.id, teamId);
    } else {
      this.registry.setTeamId(target.id, teamId);
      this.registry.setMembership(target.id, 'present');
      // 专用路径：closed 没有普通状态转移；与 attachOwner 并列的第二条人工复活路径。
      target.state = 'idle';
      this.registry.setPresence(target.id, 'gone');
      // close 会置 queue.closing / 清空 pending；复活后必须清掉 closing，
      // 否则下一次 dispatch 会被当成 agent_left。
      const queue = this.queueFor(target.id);
      queue.closing = false;
      queue.pending.length = 0;
      queue.budgetHold.clear();
    }

    this.emit('agent.rejoined', target, { state: target.state, presence: target.presence });
    this.scheduleSnapshot();
    return toMemberStatus(target);
  }

  async list(filter: ListFilter = {}): Promise<MemberStatus[]> {
    await this.ready;
    return this.registry.list(filter).map(toMemberStatus);
  }

  /** 当前 Body session（或成员 id）→ 状态；忽略可见性，退役 Body 不再命中 */
  async identify(sessionId: string): Promise<MemberStatus | undefined> {
    await this.ready;
    if (!nonEmpty(sessionId)) return undefined;
    const record = this.registry.resolve(sessionId);
    return record === undefined ? undefined : toMemberStatus(record);
  }

  async hasMember(sessionId: string): Promise<boolean> {
    await this.ready;
    const record = this.registry.getBySession(sessionId);
    return record !== undefined && !this.externalOwners.has(record.id);
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
    if (
      parent.membership === 'left' ||
      parent.state === 'closed' ||
      this.queueFor(parent.id).closing
    ) {
      throw new AgentError('member_closed', `member_closed: ${parent.id}`);
    }
    if (parent.presence === 'gone') {
      throw new AgentError('member_stale', `member_stale: ${parent.id}`);
    }

    // 本轮已显式回复 → 抑制自动最终文本
    this.queueFor(member.id).repliedThisTurn = true;
    // 回复归到触发它的成员 turn；没有在跑轮次时生成新会话。
    const conversationId =
      this.queueFor(member.id).activeConversationId ?? generateConversationId(this.newId);
    // external owner 不参与预算；父成员回复是 agent→agent 投递，走发送侧检查。
    if (!this.externalOwners.has(parent.id)) {
      const teamId = this.resolveOriginTeam(member.id, parent);
      const check = this.checkDelivery(parent, member.id, conversationId, teamId);
      if (!check.ok) {
        this.emitBudgetBlocked(parent, check, {
          conversation_id: conversationId,
          from: member.id,
          to: parent.id,
          phase: 'enqueue',
          ...(teamId !== undefined ? { teamId } : {}),
        });
        throw new AgentError(this.budgetCode(check.reason), `${check.reason}: ${check.dimension}`);
      }
    }
    const result = this.enqueueMessage(parent, text, member.id, conversationId);
    return { queued: true, message_id: result.message_id, to: parent.id };
  }

  /**
   * 取走成员待处理消息（REPL owner 轮询）；FIFO、取走即删除，
   * 不触发 pump / runTurn。limit 缺省取空队列。
   */
  async takeMessages(memberId: string, limit?: number): Promise<AgentMessage[]> {
    await this.ready;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new AgentError('invalid_input', 'limit must be a positive integer');
    }
    const member = this.requireMember(memberId);
    if (member.membership === 'left' || member.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${memberId}`);
    }
    if (member.presence === 'gone') {
      throw new AgentError('member_stale', `member_stale: ${memberId}`);
    }
    const queue = this.queueFor(member.id);
    if (queue.closing) {
      throw new AgentError('member_closed', `member_closed: ${memberId}`);
    }
    const count =
      limit === undefined ? queue.pending.length : Math.min(limit, queue.pending.length);
    const taken = queue.pending.splice(0, count);
    if (taken.length > 0) this.registry.touch(member.id);
    return taken;
  }

  /** bridge 执行内核上报的等待/恢复；只接受当前运行 Body，旧 Body 的迟到回调丢弃 */
  notePermissionState(memberId: string, sessionId: string, state: MemberPermissionState): void {
    const member = this.registry.get(memberId);
    if (!member || member.state === 'closed' || member.presence === 'gone') return;
    const queue = this.queueFor(memberId);
    if (!queue.turnActive || queue.activeBodySession !== sessionId) return;
    try {
      if (state === 'waiting') {
        if (member.state !== 'running') return;
        this.registry.setState(member.id, 'waiting_permission');
      } else {
        if (member.state !== 'waiting_permission') return;
        this.registry.setState(member.id, 'running');
      }
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
   * 成员引擎事件回流：只处理**当前** Body 的 `agent.limit.warning`，
   * 按 `${sessionId}|${key}` 去重后作为系统提示排进该 Agent 的下一轮。
   * 旧 Body 的预警丢弃，避免换身体后串台。
   */
  noteMemberEvent(memberId: string, sessionId: string, event: RunEvent): void {
    if (event.type !== 'agent.limit.warning') return;
    const record = this.registry.get(memberId);
    if (!record) return;
    if (record.membership === 'left' || record.state === 'closed') return;
    const queue = this.queueFor(memberId);
    if (queue.closing) return;
    if (record.currentBody?.session_id !== sessionId) return;

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
    if (queue.warnedSignals.has(dedupeKey)) return;
    queue.warnedSignals.add(dedupeKey);

    const text =
      `[system] Context/usage limit warning: ${key} is at ${current}/${max} (>= ${threshold}). ` +
      'If your context is nearly full, write a handoff and call agent.rotate with ' +
      'startup_prompt to continue in a fresh body.';
    // 系统提示继承当前 turn 的会话；事件迟到时也不能丢分组。
    const conversationId = queue.activeConversationId ?? generateConversationId(this.newId);
    this.enqueueMessage(record, text, 'system', conversationId, 'limit_warning');
  }

  /** 该 session 是否属于某个非 owner 成员的 Body（当前 / 在跑 / 已退役 / rotate 目标）。 */
  isMemberBody(sessionId: string): boolean {
    if (!nonEmpty(sessionId)) return false;
    for (const record of this.registry.all()) {
      if (this.externalOwners.has(record.id)) continue;
      if (record.currentBody?.session_id === sessionId) return true;
      if (record.bodyHistory.some((entry) => entry.session_id === sessionId)) return true;
    }
    for (const queue of this.queues.values()) {
      if (queue.activeBodySession === sessionId) return true;
    }
    for (const rotation of this.rotations.values()) {
      if (rotation.fromSessionId === sessionId || rotation.toSessionId === sessionId) return true;
    }
    return false;
  }

  currentConversation(agentId: string): string | undefined {
    return this.queues.get(agentId)?.activeConversationId;
  }

  async budget(input: BudgetStatusInput | BudgetOverrideInput): Promise<BudgetOverview> {
    await this.ready;
    if (!this.budgetPort) {
      throw new AgentError('budget_unavailable', 'budget_unavailable');
    }
    if ('dimension' in input) {
      const result = this.budgetPort.override(input);
      // override 只能由人触发：清 hold、重新 pump 受影响 Agent，并发审计事件。
      const released = this.budgetPort.release(input.conversation_id);
      this.blockedBudgetEvents.delete(input.conversation_id);
      for (const agentId of released) {
        this.queues.get(agentId)?.budgetHold.delete(input.conversation_id);
        this.pump(agentId);
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

  /** 发送者所属 Team 优先；human / owner 无 Team 时退回目标 Team */
  private resolveOriginTeam(from: string, target: MemberRecord): string | undefined {
    return this.registry.resolve(from)?.teamId ?? target.teamId;
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
      // team.budget.* 契约要求 team_id；unbound 会话没有团队事件面，只保留拒绝结果。
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
    // team.budget.* 契约要求 team_id；unbound 会话没有团队事件面，只保留拒绝结果。
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

  /**
   * 关闭前中断并等待成员轮收口：此后不再从队列起新轮，只在跑轮结束（或超时）。
   * 不改 registry 状态 / membership；队列里的后续消息随进程退出丢弃。
   */
  async drain(options: AgentDrainOptions = {}): Promise<AgentDrainOutcome> {
    await this.ready;
    this.draining = true;
    const active = (): boolean => {
      for (const queue of this.queues.values()) {
        if (queue.turnActive) return true;
      }
      return false;
    };
    if (!active()) return 'idle';

    for (const record of this.registry.all()) {
      const member = toRuntimeMember(record);
      try {
        this.runtime.cancel(member);
      } catch (error) {
        this.logger.warn('agent.drain.cancel_failed', {
          member_id: record.id,
          error: errorText(error),
        });
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

  /** 发成员事件（默认用当前 Body 的 session）；监听器与 EventStream 异常都隔离 */
  private emit(type: string, member: MemberRecord, extra: AgentEventExtra = {}): void {
    this.emitForSession(type, member, member.currentBody?.session_id ?? member.sessionId, extra);
  }

  /**
   * 指定 Body 的事件出口：旧轮的 turn / reply.stale / retired 必须带旧 session，
   * rotate 事件带显式 from / to。`run_id` 始终是成员 id。
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
      // S3：spawned / closed / rotated / retired / rejoined 等身份事件都带 team_id
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

  /** 取队列；不存在则建 */
  private queueFor(memberId: string): MemberQueue {
    let queue = this.queues.get(memberId);
    if (!queue) {
      queue = {
        pending: [],
        turnActive: false,
        repliedThisTurn: false,
        closing: false,
        warnedSignals: new Set(),
        budgetHold: new Set(),
      };
      this.queues.set(memberId, queue);
    }
    return queue;
  }

  /** 按指定 Body session 构造执行内核身份（close / 延迟退役用） */
  private runtimeMemberForSession(record: MemberRecord, sessionId: string): MemberRuntimeMember {
    return { ...toRuntimeMember(record), session_id: sessionId };
  }

  /** best-effort dispose；runtime 按 session 幂等，失败只记日志 */
  private async disposeBody(member: MemberRuntimeMember): Promise<boolean> {
    try {
      await this.runtime.dispose(member);
      return true;
    } catch (error) {
      this.logger.warn('agent.dispose.failed', {
        member_id: member.id,
        session_id: member.session_id,
        error: errorText(error),
      });
      return false;
    }
  }

  private requireMember(ref: string): MemberRecord {
    const member = this.registry.resolve(ref);
    if (!member) throw new AgentError('unknown_member', `unknown_member: ${ref}`);
    return member;
  }

  /**
   * 有排队消息且无在跑轮次时启动下一轮；waiting_permission / closing 不推进。
   * external owner 的消息只入队，由 REPL 通过 takeMessages 消费，不在这里起轮。
   */
  private pump(memberId: string): void {
    if (this.draining) return;
    const member = this.registry.get(memberId);
    if (!member) return;
    // gone（需 resume）或 rotating（S2 轮换中）都不推进队列
    if (member.presence === 'gone' || member.rotation === 'rotating') return;
    if (this.externalOwners.has(memberId)) return;
    const queue = this.queueFor(memberId);
    if (queue.turnActive || queue.closing) return;
    if (member.state === 'created' || member.state === 'closed') return;
    if (member.state === 'waiting_permission') return;
    if (queue.pending.length === 0) return;

    // 起轮时捕获 Body 身份：轮末指针可能已被 rotate 切走。
    const runtimeMember = toRuntimeMember(member);
    const capturedEpoch = member.currentBody?.epoch ?? 0;

    // 扫描第一条可运行消息：被挡的会话留在原位置，不阻塞同一 Agent 的其它会话。
    let selected = -1;
    const blocked: Array<{ index: number; message: AgentMessage; check: BudgetCheckResult }> = [];
    for (let index = 0; index < queue.pending.length; index += 1) {
      const candidate = queue.pending[index];
      if (candidate === undefined) continue;
      const check = this.checkTurnStart(member, candidate, runtimeMember.session_id);
      if (check.ok) {
        selected = index;
        break;
      }
      blocked.push({ index, message: candidate, check });
    }

    if (selected < 0) {
      this.holdBlockedMessages(member, queue, blocked);
      return;
    }

    const [message] = queue.pending.splice(selected, 1);
    if (message === undefined) return;
    const conversationId = message.conversation_id;
    if (conversationId !== undefined) {
      this.budgetPort?.noteTurnStarted({
        conversation_id: conversationId,
        ...(member.teamId !== undefined ? { team_id: member.teamId } : {}),
        agent_id: member.id,
        message_id: message.id,
      });
      queue.budgetHold.delete(conversationId);
      this.blockedBudgetEvents.delete(conversationId);
      this.budgetPort?.clearHold?.(conversationId, member.id);
      this.emitBudgetWarnings(member, conversationId, 'turn_start');
    }

    if (member.state === 'completed' || member.state === 'failed' || member.state === 'cancelled') {
      this.registry.setState(memberId, 'idle');
    }
    this.registry.setState(memberId, 'running');
    queue.turnActive = true;
    queue.repliedThisTurn = false;
    queue.activeConversationId = conversationId;
    queue.activeBodySession = runtimeMember.session_id;
    this.emit('agent.turn.started', member, {
      state: 'running',
      message_id: message.id,
      ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
    });
    this.scheduleSnapshot();
    void this.executeTurn(member, message, runtimeMember, capturedEpoch);
  }

  /** 预算 block reason -> 稳定错误码（mismatch / unavailable 不折叠成 exceeded） */
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
   * 所有排队消息都被挡：保留消息（不 shift），持久化 blocked，发一次 blocked 事件。
   */
  private holdBlockedMessages(
    member: MemberRecord,
    queue: MemberQueue,
    blocked: Array<{ index: number; message: AgentMessage; check: BudgetCheckResult }>,
  ): void {
    const reported = new Set<string>();
    for (const entry of blocked) {
      const check = entry.check;
      if (check.ok) continue;
      const conversationId = entry.message.conversation_id;
      if (conversationId === undefined) continue;
      queue.budgetHold.add(conversationId);
      this.budgetPort?.noteHold?.(conversationId, member.id);
      this.budgetPort?.noteTurnBlocked?.({
        conversation_id: conversationId,
        ...(member.teamId !== undefined ? { team_id: member.teamId } : {}),
        dimension: check.dimension,
        reason: check.reason,
      });
      if (reported.has(conversationId) || this.blockedBudgetEvents.has(conversationId)) continue;
      reported.add(conversationId);
      this.blockedBudgetEvents.add(conversationId);
      this.emitBudgetBlocked(member, check, {
        conversation_id: conversationId,
        message_id: entry.message.id,
        from: entry.message.from,
        to: member.id,
        phase: 'turn_start',
      });
    }
  }

  /**
   * 执行一轮；任何异常都收口为 failed，不让后台任务产生未处理 rejection。
   * `runtimeMember` / `capturedEpoch` 是起轮时捕获的 Body 身份；轮末指针已切换
   * 则按 epoch fencing 丢弃本轮的 state / usage / 自动回复。
   */
  private async executeTurn(
    member: MemberRecord,
    message: AgentMessage,
    runtimeMember: MemberRuntimeMember,
    capturedEpoch: number,
  ): Promise<void> {
    const queue = this.queueFor(member.id);
    const conversationId = queue.activeConversationId ?? message.conversation_id;
    let result: MemberTurnResult | undefined;
    let failure: string | undefined;
    try {
      result = await this.runtime.runTurn(runtimeMember, message);
    } catch (error) {
      failure = errorText(error);
      // close 主动取消不是失败；按 error 记录会把正常关闭刷成告警
      if (queue.closing) {
        this.logger.debug('agent.turn.cancelled', { member_id: member.id });
      } else {
        this.logger.error('agent.turn.failed', {
          member_id: member.id,
          error: failure,
        });
      }
    }
    queue.turnActive = false;
    queue.activeConversationId = undefined;

    // turn 完成（含失败 / 取消 / 旧 Body）都记 tokens 与活动时间，并强制落盘。
    if (conversationId !== undefined) {
      this.budgetPort?.noteTurnFinished({
        conversation_id: conversationId,
        ...(member.teamId !== undefined ? { team_id: member.teamId } : {}),
        agent_id: member.id,
        message_id: message.id,
        ...(result?.usage !== undefined ? { usage: result.usage } : {}),
      });
    }

    const current = this.registry.get(member.id);
    // 旧 Body：指针已切走。成对发终态（stale），但不写 registry / usage，也不投递父队列。
    if (current?.currentBody?.session_id !== runtimeMember.session_id) {
      // 先同步收口旧 Body 的运行态，再允许任何 await / 新轮启动：
      // 否则残留 waiting_permission 会让 pump 永远挡住新 Body。
      if (queue.activeBodySession === runtimeMember.session_id) queue.activeBodySession = undefined;
      if (current !== undefined && current.membership !== 'left' && current.state !== 'closed') {
        if (current.state === 'waiting_permission') {
          this.registry.setState(member.id, 'running');
        }
        if (current.state === 'running') {
          this.registry.setState(member.id, 'idle');
        }
        this.scheduleSnapshot();
      }
      if (current !== undefined) {
        const outcome = failure !== undefined ? 'failed' : (result?.outcome ?? 'completed');
        const state: MemberState =
          outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'cancelled' : 'completed';
        this.emitForSession(
          outcome === 'failed'
            ? 'agent.turn.failed'
            : outcome === 'cancelled'
              ? 'agent.turn.cancelled'
              : 'agent.turn.completed',
          current,
          runtimeMember.session_id,
          {
            state,
            outcome,
            message_id: message.id,
            body_id: runtimeMember.session_id,
            stale: true,
            ...(message.conversation_id !== undefined
              ? { conversation_id: message.conversation_id }
              : {}),
            ...(failure !== undefined ? { reason: failure } : {}),
          },
        );
        this.emitForSession('agent.reply.stale', current, runtimeMember.session_id, {
          body_id: runtimeMember.session_id,
          epoch: capturedEpoch,
          message_id: message.id,
          reason: 'epoch_fenced',
        });
      }
      const disposed = await this.disposeBody(runtimeMember);
      if (current !== undefined) {
        this.emitForSession('agent.retired', current, runtimeMember.session_id, {
          body_id: runtimeMember.session_id,
          epoch: capturedEpoch,
          reason: disposed ? 'rotation' : 'dispose_failed',
        });
      }
      this.pump(member.id);
      return;
    }

    if (current === undefined) return;
    if (queue.activeBodySession === runtimeMember.session_id) queue.activeBodySession = undefined;
    // close 已发生（或成员已被关闭）：后到的终态不得覆盖 closed
    if (queue.closing || current.state === 'closed' || current.presence === 'gone') {
      if (queue.closing) {
        this.emit('agent.turn.cancelled', current, {
          state: current.state,
          outcome: 'cancelled',
          reason: 'closed',
          message_id: message.id,
        });
      }
      return;
    }

    if (result?.usage !== undefined) this.registry.setUsage(member.id, result.usage);

    const outcome = failure !== undefined ? 'failed' : (result?.outcome ?? 'completed');
    const state: MemberState =
      outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'cancelled' : 'completed';
    // 应答丢失时可能仍停在 waiting_permission；先回到 running 才能进终态
    if (current.state === 'waiting_permission') this.registry.setState(member.id, 'running');
    this.registry.setState(member.id, state);
    this.emit(
      outcome === 'failed'
        ? 'agent.turn.failed'
        : outcome === 'cancelled'
          ? 'agent.turn.cancelled'
          : 'agent.turn.completed',
      current,
      {
        state,
        outcome,
        message_id: message.id,
        ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
        ...(failure !== undefined ? { reason: failure } : {}),
        ...(outcome === 'completed' && result?.usage !== undefined ? { usage: result.usage } : {}),
      },
    );

    // 0.19 S6：Team 成员的最终文本只发事件，由 TeamService 写日志；
    // AgentService 不直接写 Team 日志，避免双写。agent.turn.completed 仍不带正文。
    if (outcome === 'completed' && nonEmpty(result?.content) && current.teamId !== undefined) {
      this.emit('agent.reply.posted', current, {
        message_id: this.newId(),
        content: truncateMessageContent(result.content as string),
        ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
      });
    }

    if (outcome === 'completed' && !queue.repliedThisTurn && nonEmpty(result?.content)) {
      this.deliverToParent(current, result.content as string, conversationId);
    }

    this.scheduleSnapshot();
    this.pump(member.id);
  }

  /**
   * 自动最终文本投递到父成员队列；父不存在（owner 未 attach）时丢弃。
   * 父已 left / closed / gone 时显式发 `agent.reply.dropped`（不静默、不入队、不重试）。
   * 父是 external owner 时不参与预算；父是成员时被挡只发事件、不进 turn 收尾。
   */
  private deliverToParent(
    member: MemberRecord,
    content: string,
    conversationId: string | undefined,
  ): void {
    if (!nonEmpty(member.parentId)) return;
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
    const parentQueue = this.queueFor(parent.id);
    if (parentQueue.closing) return;

    if (conversationId !== undefined && !this.externalOwners.has(parent.id)) {
      const teamId = this.resolveOriginTeam(member.id, parent);
      const check = this.checkDelivery(parent, member.id, conversationId, teamId);
      if (!check.ok) {
        this.emitBudgetBlocked(parent, check, {
          conversation_id: conversationId,
          from: member.id,
          to: parent.id,
          phase: 'enqueue',
          ...(teamId !== undefined ? { teamId } : {}),
        });
        return;
      }
    }

    this.enqueueMessage(parent, content, member.id, conversationId);
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

/** 消息体：非空且不超过上限 */
function readContent(record: Record<string, unknown>, key: string): string {
  const value = readRequiredString(record, key);
  if (Buffer.byteLength(value, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new AgentError('invalid_input', `content exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
  return value;
}

/**
 * `agent.reply.posted` 的正文上限：超限按 UTF-8 字节截断并加标记，
 * 不静默丢整条回复。事件与 Team 日志使用同一段截断后的文本。
 */
function truncateMessageContent(content: string): string {
  if (Buffer.byteLength(content, 'utf8') <= MAX_MESSAGE_BYTES) return content;
  const marker = '\n[truncated]';
  const budget = MAX_MESSAGE_BYTES - Buffer.byteLength(marker, 'utf8');
  let used = 0;
  let out = '';
  for (const char of content) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return out + marker;
}

function optionalString(value: unknown): string | undefined {
  return nonEmpty(value) ? value : undefined;
}
