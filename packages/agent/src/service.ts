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
import { assertTenantId, type Logger, noopLogger } from '@vessel-agent/core';
import {
  isTerminalState,
  type MemberRecord,
  MemberRegistry,
  toMemberStatus,
  toRuntimeMember,
} from './registry.js';
import { AgentSnapshotStore, snapshotPath } from './snapshot.js';
import {
  AgentError,
  type AgentMessage,
  type AgentService,
  type AgentServiceOptions,
  type BatchItemResult,
  type BatchResult,
  type CloseBatchInput,
  type CloseInput,
  type CloseResult,
  DEFAULT_OWNER,
  type ListFilter,
  MAX_MESSAGE_BYTES,
  type MemberState,
  type MemberStatus,
  type MemberTurnResult,
  type MemberVisibility,
  type NewBatchInput,
  type NewMemberInput,
  type PermissionDecision,
  type PermissionRequestInput,
  type ReplyResult,
  type SendBatchInput,
  type SendInput,
  type SendResult,
} from './types.js';

const VISIBILITIES: readonly MemberVisibility[] = ['private', 'team', 'tenant'];

/** 单成员运行态（不落 snapshot） */
interface MemberQueue {
  pending: AgentMessage[];
  turnActive: boolean;
  repliedThisTurn: boolean;
  closing: boolean;
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

/** 按输入顺序把 allSettled 转成逐条结果；单条失败不影响其它条目 */
function settleBatch<T>(settled: PromiseSettledResult<T>[]): BatchResult<T> {
  return {
    results: settled.map(
      (item): BatchItemResult<T> =>
        item.status === 'fulfilled'
          ? { ok: true, status: item.value }
          : { ok: false, error: errorText(item.reason) },
    ),
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

/** 从快照恢复记录；非终态在 loadSnapshot 里统一标 stale */
function recordFromStatus(status: MemberStatus): MemberRecord {
  return {
    id: status.id,
    sessionId: status.session_id,
    ...(status.name !== undefined ? { name: status.name } : {}),
    ...(status.parent_id !== undefined ? { parentId: status.parent_id } : {}),
    owner: status.owner,
    visibility: status.visibility,
    state: status.state,
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
  private readonly permissionBridge: AgentServiceOptions['permissionBridge'];
  private readonly snapshot: AgentSnapshotStore | undefined;
  private readonly queues = new Map<string, MemberQueue>();
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
    this.permissionBridge = options.permissionBridge;

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

  /** 重启恢复：非终态成员一律 stale（执行内核未恢复，不能静默接受新消息） */
  private async loadSnapshot(): Promise<void> {
    if (!this.snapshot) return;
    let members: MemberStatus[] = [];
    try {
      members = await this.snapshot.load();
    } catch (error) {
      // load 自身不抛；这里兜底，避免损坏文件阻塞构造
      this.logger.error('agent.snapshot.load_failed', { error: errorText(error) });
      return;
    }
    let restored = 0;
    for (const status of members) {
      const record = recordFromStatus(status);
      if (!isTerminalState(record.state)) record.state = 'stale';
      try {
        this.registry.add(record);
        restored += 1;
      } catch (error) {
        this.logger.warn('agent.snapshot.member_skipped', {
          member_id: status.id,
          error: errorText(error),
        });
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
        record.owner !== undefined
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
    const visibility = resolveVisibility(input.visibility, 'private');
    const owner = input.owner === undefined ? DEFAULT_OWNER : readRequiredString(input, 'owner');
    const id = this.newId();
    if (!nonEmpty(id)) throw new AgentError('invalid_input', 'id generator returned an empty id');

    const record: MemberRecord = {
      id,
      // session 即成员：两者同值，消息可用任一寻址
      sessionId: id,
      owner,
      visibility,
      state: 'created',
    };
    const name = optionalString(input.name);
    if (name !== undefined) record.name = name;
    const parentId = optionalString(input.parentId);
    if (parentId !== undefined) record.parentId = parentId;
    const model = optionalString(input.model);
    if (model !== undefined) record.model = model;
    const systemPrompt = optionalString(input.systemPrompt);
    if (systemPrompt !== undefined) record.systemPrompt = systemPrompt;

    this.registry.add(record);
    try {
      await this.runtime.spawn(toRuntimeMember(record));
    } catch (error) {
      this.registry.remove(id);
      this.queues.delete(id);
      throw new AgentError('spawn_failed', `spawn_failed: ${errorText(error)}`);
    }
    this.registry.setState(id, 'idle');
    this.scheduleSnapshot();
    return toMemberStatus(record);
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

  /** 入队（同步推进，不等待 runTurn）；async 只为把校验异常转成逐条 rejection */
  private async enqueue(input: Record<string, unknown>): Promise<SendResult> {
    const to = readRequiredString(input, 'to');
    const content = readContent(input, 'content');
    const from = input.from === undefined ? DEFAULT_OWNER : readRequiredString(input, 'from');

    const target = this.requireMember(to);
    if (target.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${to}`);
    }
    if (target.state === 'stale') {
      throw new AgentError('member_stale', `member_stale: ${to}`);
    }
    if (this.queueFor(target.id).closing) {
      throw new AgentError('member_closed', `member_closed: ${to}`);
    }
    if (!this.registry.canView(target, from)) {
      throw new AgentError('member_not_visible', `member_not_visible: ${to}`);
    }

    const message: AgentMessage = {
      id: this.newId(),
      from,
      to: target.id,
      content,
      ts: this.now(),
    };
    const queue = this.queueFor(target.id);
    queue.pending.push(message);
    this.registry.touch(target.id);
    this.scheduleSnapshot();
    this.pump(target.id);
    return { queued: true, message_id: message.id, state: target.state };
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
    if (member.state === 'closed') return { state: 'closed' };

    const queue = this.queueFor(member.id);
    queue.closing = true;
    queue.pending.length = 0;

    // stale 成员没有可释放的运行时对象；直接关闭，避免对恢复成员调 dispose
    if (member.state === 'stale') {
      this.registry.setState(member.id, 'closed');
      this.scheduleSnapshot();
      await this.flushSnapshot();
      return { state: 'closed' };
    }

    if (queue.turnActive) {
      try {
        await this.runtime.cancel(toRuntimeMember(member));
      } catch (error) {
        this.logger.warn('agent.cancel.failed', {
          member_id: member.id,
          error: errorText(error),
        });
      }
    }

    // cancel 期间执行内核仍可能完成本轮；closing 已置位，executeTurn 不会覆盖 closed
    this.registry.setState(member.id, 'closed');
    queue.pending.length = 0;
    this.scheduleSnapshot();

    try {
      await this.runtime.dispose(toRuntimeMember(member));
    } catch (error) {
      this.logger.warn('agent.dispose.failed', {
        member_id: member.id,
        error: errorText(error),
      });
    }

    await this.flushSnapshot();
    return { state: 'closed' };
  }

  async list(filter: ListFilter = {}): Promise<MemberStatus[]> {
    await this.ready;
    return this.registry.list(filter).map(toMemberStatus);
  }

  async reply(memberId: string, content: string): Promise<ReplyResult> {
    await this.ready;
    const text = readContent({ content }, 'content');
    const member = this.requireMember(memberId);
    if (member.state === 'closed') {
      throw new AgentError('member_closed', `member_closed: ${memberId}`);
    }
    if (member.state === 'stale') {
      throw new AgentError('member_stale', `member_stale: ${memberId}`);
    }
    if (!nonEmpty(member.parentId)) {
      throw new AgentError('no_parent', `member has no parent: ${memberId}`);
    }
    const parent = this.requireMember(member.parentId);
    if (parent.state === 'closed' || this.queueFor(parent.id).closing) {
      throw new AgentError('member_closed', `member_closed: ${parent.id}`);
    }
    if (parent.state === 'stale') {
      throw new AgentError('member_stale', `member_stale: ${parent.id}`);
    }

    // 本轮已显式回复 → 抑制自动最终文本
    this.queueFor(member.id).repliedThisTurn = true;
    const message: AgentMessage = {
      id: this.newId(),
      from: member.id,
      to: parent.id,
      content: text,
      ts: this.now(),
    };
    this.queueFor(parent.id).pending.push(message);
    this.registry.touch(parent.id);
    this.scheduleSnapshot();
    this.pump(parent.id);
    return { queued: true, message_id: message.id, to: parent.id };
  }

  async requestPermission(
    memberId: string,
    request: PermissionRequestInput,
  ): Promise<PermissionDecision> {
    await this.ready;
    const member = this.requireMember(memberId);
    if (member.state !== 'running' && member.state !== 'waiting_permission') {
      return { decision: 'deny', reason: `member_not_running: ${member.state}` };
    }

    this.registry.setState(member.id, 'waiting_permission', request.tool);
    this.scheduleSnapshot();

    let decision: PermissionDecision;
    try {
      decision = this.permissionBridge
        ? await this.permissionBridge.request(toRuntimeMember(member), request)
        : { decision: 'deny', reason: 'no_permission_bridge' };
    } catch (error) {
      decision = { decision: 'deny', reason: errorText(error) };
    }

    // close / stale 优先于应答：不得把已关闭成员拉回 running
    const current = this.registry.get(member.id);
    if (current && current.state === 'waiting_permission') {
      this.registry.setState(member.id, 'running');
      this.scheduleSnapshot();
    }
    return decision;
  }

  async flushSnapshot(): Promise<void> {
    await this.ready;
    await this.snapshot?.flush();
  }

  /** 取队列；不存在则建 */
  private queueFor(memberId: string): MemberQueue {
    let queue = this.queues.get(memberId);
    if (!queue) {
      queue = { pending: [], turnActive: false, repliedThisTurn: false, closing: false };
      this.queues.set(memberId, queue);
    }
    return queue;
  }

  private requireMember(ref: string): MemberRecord {
    const member = this.registry.resolve(ref);
    if (!member) throw new AgentError('unknown_member', `unknown_member: ${ref}`);
    return member;
  }

  /** 有排队消息且无在跑轮次时启动下一轮；waiting_permission / closing 不推进 */
  private pump(memberId: string): void {
    const member = this.registry.get(memberId);
    if (!member) return;
    const queue = this.queueFor(memberId);
    if (queue.turnActive || queue.closing) return;
    if (member.state === 'created' || member.state === 'closed' || member.state === 'stale') return;
    if (member.state === 'waiting_permission') return;
    const message = queue.pending.shift();
    if (!message) return;

    if (member.state === 'completed' || member.state === 'failed' || member.state === 'cancelled') {
      this.registry.setState(memberId, 'idle');
    }
    this.registry.setState(memberId, 'running');
    queue.turnActive = true;
    queue.repliedThisTurn = false;
    this.scheduleSnapshot();
    void this.executeTurn(member, message);
  }

  /** 执行一轮；任何异常都收口为 failed，不让后台任务产生未处理 rejection */
  private async executeTurn(member: MemberRecord, message: AgentMessage): Promise<void> {
    const queue = this.queueFor(member.id);
    let result: MemberTurnResult | undefined;
    let failed = false;
    try {
      result = await this.runtime.runTurn(toRuntimeMember(member), message);
    } catch (error) {
      failed = true;
      // close 主动取消不是失败；按 error 记录会把正常关闭刷成告警
      if (queue.closing) {
        this.logger.debug('agent.turn.cancelled', { member_id: member.id });
      } else {
        this.logger.error('agent.turn.failed', {
          member_id: member.id,
          error: errorText(error),
        });
      }
    }
    queue.turnActive = false;

    const current = this.registry.get(member.id);
    // close 已发生（或成员已被关闭）：后到的终态不得覆盖 closed
    if (!current || queue.closing || current.state === 'closed' || current.state === 'stale')
      return;

    if (result?.usage !== undefined) this.registry.setUsage(member.id, result.usage);

    const outcome = failed ? 'failed' : (result?.outcome ?? 'completed');
    if (outcome === 'completed' && !queue.repliedThisTurn && nonEmpty(result?.content)) {
      this.deliverToParent(current, result.content as string);
    }

    const state: MemberState =
      outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'cancelled' : 'completed';
    // 应答丢失时可能仍停在 waiting_permission；先回到 running 才能进终态
    if (current.state === 'waiting_permission') this.registry.setState(member.id, 'running');
    this.registry.setState(member.id, state);
    this.scheduleSnapshot();
    this.pump(member.id);
  }

  /** 自动最终文本投递到父成员队列；父不存在时丢弃（主 agent 可能未注册） */
  private deliverToParent(member: MemberRecord, content: string): void {
    if (!nonEmpty(member.parentId)) return;
    const parent = this.registry.resolve(member.parentId);
    if (!parent || parent.state === 'closed' || parent.state === 'stale') return;
    const parentQueue = this.queueFor(parent.id);
    if (parentQueue.closing) return;

    parentQueue.pending.push({
      id: this.newId(),
      from: member.id,
      to: parent.id,
      content,
      ts: this.now(),
    });
    this.registry.touch(parent.id);
    this.scheduleSnapshot();
    this.pump(parent.id);
  }

  private scheduleSnapshot(): void {
    this.snapshot?.schedule(() => this.registry.all().map(toMemberStatus));
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
