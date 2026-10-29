/**
 * Team 能力层默认实现（0.19 S3）。
 *
 * 职责：
 * - roster 由 Agent 记录派生（`team_id` + `membership`），不单独持久化；
 * - 只追加团队日志；无 `@` 的 post 绝不 dispatch（结构性保证零 run）；
 * - `@` 使用结构化 agent id，先写日志再并行 dispatch，逐条返回结果；
 * - 订阅 `agent.spawned/rejoined/closed/rotated` 写系统消息（只写日志）；
 * - 0.27：另从可注入的 `EventStream` 订阅 `run.*` 终态写 reply / 失败日志。
 *
 * 依赖边界：只依赖 `AgentService` 与 `TeamStore` 接口，不 import team-store.ts。
 *
 * @module @vessel-agent/agent
 */

import { randomUUID } from 'node:crypto';
import type { EventStream, Logger, RunEvent } from '@vessel-agent/core';
import { generateConversationId, isValidConversationId } from './conversation-budget.js';
import { addressSegmentCount, HUMAN_PRINCIPAL } from './team-address.js';
import {
  type AgentEvent,
  type AgentService,
  type AgentTeamService,
  type BudgetOverrideInput,
  type BudgetOverview,
  type BudgetStatusInput,
  DEFAULT_OWNER,
  type FederationSendPort,
  MAX_MESSAGE_BYTES,
  type MemberStatus,
  type TeamAgentSendInput,
  type TeamAgentSendResult,
  type TeamArchiveInput,
  type TeamCreateInput,
  type TeamDelivery,
  type TeamDetail,
  TeamError,
  type TeamGetOptions,
  type TeamListOptions,
  type TeamLogEntry,
  type TeamMemberSummary,
  type TeamMembersInput,
  type TeamMembersResult,
  type TeamPostInput,
  type TeamPostResult,
  type TeamRecord,
  type TeamRosterOptions,
  type TeamServiceEvent,
  type TeamStore,
  type TeamSummary,
  type TeamSystemEvent,
  type TeamUpdateInput,
} from './types.js';

/** DefaultTeamService 构造参数（app 装配按此名称接线） */
export interface TeamServiceOptions {
  tenantId: string;
  agent: AgentService;
  store: TeamStore;
  now?: () => number;
  newId?: () => string;
  logger?: Logger;
  /** 0.21：跨节点发送端口；缺失时地址形式返回 federation_unavailable */
  federation?: FederationSendPort;
  /** 0.27：run.* 事件来源；缺省时 reply / 失败日志不写（fail-closed） */
  events?: EventStream;
}

/** 系统消息固定英文文案（不含正文） */
const SYSTEM_CONTENT: Record<TeamSystemEvent, string> = {
  join: 'agent joined team',
  leave: 'agent left team',
  archive: 'agent archived',
  rotate: 'agent rotated body',
  budget_override: 'budget limit overridden',
  fork: 'agent forked',
};

/**
 * 已退役 Body 记账上限（0.27）。每 agent 退役 Body ≤`MAX_RETIRED_BODIES`（50），
 * 超限按插入顺序丢最旧，保证长活进程不无界增长。
 */
const MAX_RETIRED_BODIES_TRACKED = 256;

/** 退役 Body 键（`agentId\0sessionId`）：同一 agent 的不同 Body 互不共用 */
function retiredBodyKey(agentId: string, sessionId: string): string {
  return `${agentId}\u0000${sessionId}`;
}

const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** 解析后的 send 目标（`team_id` 用于判断是否写 mention 日志） */
interface SendTarget {
  agent_id: string;
  team_id?: string;
}

interface NamedSendTarget extends SendTarget {
  name?: string;
}

type ResolvedSendTarget =
  | { ok: true; target?: SendTarget }
  | { ok: false; result: TeamAgentSendResult };

/** post 的投递槽：校验失败的直接带 delivery，校验通过的等日志写完后 dispatch */
interface DispatchSlot {
  targetId?: string;
  delivery?: TeamDelivery;
}

export class DefaultTeamService implements AgentTeamService {
  readonly tenantId: string;

  private readonly agent: AgentService;
  private readonly store: TeamStore;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly logger: Logger;
  private readonly federation: FederationSendPort | undefined;
  private readonly unsubscribe: () => void;
  /** 0.27：run.* 订阅的取消函数；没有 events 时为 undefined */
  private readonly unsubscribeRuns: (() => void) | undefined;
  /** 指针事件监听者；绝不含正文（Web hub 用） */
  private readonly listeners = new Set<(event: TeamServiceEvent) => void>();
  /** members remove 期间的标记：把该次 agent.closed 写成 archive 而不是 leave */
  private readonly archiveInFlight = new Set<string>();
  /**
   * 0.27：已退役 / 已关闭的 Body（`agentId\0sessionId`，有界）。
   *
   * `run.*` 终态不带 `stale` 字段，无法照抄旧回合事件的 `stale === true` 抑制。
   * 退役 / 关闭总是先于旧 Body 的 in-flight 轮收尾（`retireBodyEntry` 先发
   * `agent.retired`），所以在 `agent.*` 管道上记账，在 `onRunEvent` 里抑制旧 Body
   * 的 reply / 失败（文档：旧 Body 的终态不写 Team 日志）。超限丢最旧，dispose 清空。
   *
   * 反向记账（只记“死掉的”）而不是正向白名单：snapshot 恢复的成员不会再发
   * `agent.spawned`，白名单会把重启后所有成员的正常回复一起吞掉。
   */
  private readonly retiredBodies = new Set<string>();
  private disposed = false;

  constructor(options: TeamServiceOptions) {
    this.tenantId = options.tenantId;
    this.agent = options.agent;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.federation = options.federation;
    this.unsubscribe = this.agent.subscribe((event) => this.onAgentEvent(event));
    this.unsubscribeRuns =
      options.events !== undefined
        ? options.events.subscribe((event) => this.onRunEvent(event))
        : undefined;
  }

  async list(options: TeamListOptions = {}): Promise<TeamSummary[]> {
    const records = this.store.list();
    const counts = new Map<string, number>();
    const online = new Map<string, number>();
    for (const status of await this.listVisible(options.viewer)) {
      if (status.team_id === undefined || status.membership !== 'present') continue;
      counts.set(status.team_id, (counts.get(status.team_id) ?? 0) + 1);
      if (status.presence === 'live') {
        online.set(status.team_id, (online.get(status.team_id) ?? 0) + 1);
      }
    }
    return records.map((record) =>
      toTeamSummary(record, counts.get(record.team_id) ?? 0, online.get(record.team_id) ?? 0),
    );
  }

  async get(teamId: string, options: TeamGetOptions = {}): Promise<TeamDetail | undefined> {
    const record = this.store.get(teamId);
    if (record === undefined) return undefined;
    const members = await this.rosterFor(teamId, options.viewer);
    const messages =
      options.limit === undefined
        ? await this.store.readLog(teamId)
        : await this.store.readLog(teamId, { limit: options.limit });
    return {
      // 计数用完整 roster；窗口只裁剪返回的 members（DECISION-037 §7.1）。
      team: toTeamSummary(
        record,
        members.length,
        members.filter((member) => member.presence === 'live').length,
      ),
      members: windowRoster(members, options.members_limit),
      messages,
    };
  }

  async roster(teamId: string, options: TeamRosterOptions = {}): Promise<TeamMemberSummary[]> {
    return this.rosterFor(teamId, options.viewer);
  }

  async identify(sessionId: string): Promise<TeamMemberSummary | undefined> {
    const status = await this.agent.identify(sessionId);
    return status === undefined ? undefined : toMemberSummary(status);
  }

  async create(input: TeamCreateInput): Promise<TeamSummary> {
    // Store 负责 workspace 幂等去重；canonical / CLI / Web 都只消费 TeamSummary。
    const { record } = await this.store.create(input);
    const team = await this.summarize(record);
    this.emit({ team_id: record.team_id, kind: 'roster' });
    return team;
  }

  async update(input: TeamUpdateInput): Promise<TeamSummary> {
    const { team_id, ...patch } = input;
    const record = await this.store.update(team_id, patch);
    const team = await this.summarize(record);
    this.emit({ team_id: record.team_id, kind: 'roster' });
    return team;
  }

  async archive(input: TeamArchiveInput): Promise<TeamSummary> {
    // Store 不知道 roster：present（含 live / gone）成员一律拒绝归档。
    const members = await this.rosterFor(input.team_id);
    if (members.length > 0) {
      throw new TeamError('team_not_empty', `team_not_empty: ${input.team_id}`);
    }
    const record = await this.store.archive(input.team_id);
    this.emit({ team_id: record.team_id, kind: 'roster' });
    return toTeamSummary(record, 0, 0);
  }

  async setSpawnFrozen(teamId: string, frozen: boolean): Promise<TeamSummary> {
    const record = await this.store.setSpawnFrozen(teamId, frozen);
    const team = await this.summarize(record);
    this.emit({ team_id: record.team_id, kind: 'spawn', frozen });
    return team;
  }

  isSpawnFrozen(teamId: string): boolean {
    return this.store.get(teamId)?.spawn_frozen === true;
  }

  async budget(input: BudgetStatusInput | BudgetOverrideInput): Promise<BudgetOverview> {
    const record = this.store.get(input.team_id);
    if (record === undefined) {
      throw new TeamError('team_not_found', `team_not_found: ${input.team_id}`);
    }
    // 归档 Team 只读：status 仍可读，人工 override 拒绝。
    if ('dimension' in input) assertTeamNotArchived(record, input.team_id);
    if (!this.agent.budget) {
      throw new TeamError('team_not_found', 'budget unavailable');
    }
    const result = await this.agent.budget(input);
    if (
      result.action === 'status' &&
      input.conversation_id !== undefined &&
      result.conversations.length === 0
    ) {
      throw new TeamError(
        'team_conversation_not_found',
        `conversation_not_found: ${input.conversation_id}`,
      );
    }
    if (result.action === 'override') {
      // override 审计：只写 system 日志，绝不 dispatch。
      const messageId = this.newId();
      const entry: TeamLogEntry = {
        message_id: messageId,
        team_id: input.team_id,
        from: HUMAN_PRINCIPAL,
        to: [],
        mentions: [],
        content: `budget override ${result.conversation_id} ${result.dimension} ${result.previous_max} -> ${result.max}`,
        ts: this.now(),
        kind: 'system',
        system_event: 'budget_override',
        conversation_id: result.conversation_id,
      };
      try {
        await this.store.appendLog(entry);
      } catch (error) {
        throw new TeamError('team_log_write_failed', errorText(error));
      }
      this.emit({ team_id: input.team_id, kind: 'system', message_id: messageId });
    }
    return result;
  }

  async post(input: TeamPostInput): Promise<TeamPostResult> {
    const record = this.store.get(input.team_id);
    if (record === undefined) {
      throw new TeamError('team_not_found', `team_not_found: ${input.team_id}`);
    }
    assertTeamNotArchived(record, input.team_id);
    const content = readContent(input.content);
    const from = input.from ?? DEFAULT_OWNER;
    const mentions = dedupe(input.mentions ?? []);
    // 一次生成、所有 mention 共用；显式 id 先校验。
    const conversationId = this.resolveConversationId(input.conversation_id);

    // Team 日志对 team 可见：private roster 成员不能作为 post 的 actor。
    if (from !== HUMAN_PRINCIPAL) {
      const actor = await this.agent.identify(from);
      if (actor !== undefined && isPrivateRosterMember(actor)) {
        throw new TeamError('team_private_member', `team_private_member: ${from}`);
      }
    }

    // 1. 只做校验与解析，不产生任何 dispatch。
    const visible = await this.listVisible(from);
    const byId = new Map(visible.map((status) => [status.id, status]));
    const bySession = new Map(visible.map((status) => [status.session_id, status]));
    const slots: DispatchSlot[] = [];
    const resolved: string[] = [];
    const seenTargets = new Set<string>();

    for (const mention of mentions) {
      const target = byId.get(mention) ?? bySession.get(mention);
      if (target === undefined) {
        // 不可见 / 不存在在 viewer 视角下不可区分，按 unknown_member 返回。
        slots.push({
          delivery: {
            agent_id: mention,
            status: 'error',
            code: 'unknown_member',
            reason: `unknown_member: ${mention}`,
          },
        });
        continue;
      }
      if (isPrivateRosterMember(target)) {
        // private 成员不能被 @，其 id 也不得进入日志的 to / mentions。
        slots.push({
          delivery: {
            agent_id: target.id,
            status: 'error',
            code: 'team_private_member',
            reason: `team_private_member: ${target.id}`,
          },
        });
        continue;
      }
      if (target.id === from) {
        slots.push({
          delivery: {
            agent_id: target.id,
            status: 'error',
            code: 'team_self_mention',
            reason: 'team_self_mention',
          },
        });
        continue;
      }
      if (target.team_id !== input.team_id) {
        slots.push({
          delivery: {
            agent_id: target.id,
            status: 'error',
            code: 'team_not_member',
            reason: `team_not_member: ${target.id}`,
          },
        });
        continue;
      }
      if (target.membership !== 'present') {
        slots.push({
          delivery: {
            agent_id: target.id,
            status: 'error',
            code: 'agent_left',
            reason: `agent_left: ${target.id}`,
          },
        });
        continue;
      }
      // 同一目标（id 与 session 两种写法）只投递一次。
      if (seenTargets.has(target.id)) continue;
      seenTargets.add(target.id);
      resolved.push(target.id);
      slots.push({ targetId: target.id });
    }

    // 2. 先写日志；失败直接抛错，绝不 dispatch。
    // 日志 `to` 优先用解析出的 agent id；owner 日志标记（input.to）只进日志、绝不 dispatch。
    const messageId = this.newId();
    const ts = this.now();
    const kind: TeamPostResult['kind'] = mentions.length > 0 ? 'mention' : 'post';
    const to = resolved.length > 0 ? [...resolved] : [...(input.to ?? [])];
    const entry: TeamLogEntry = {
      message_id: messageId,
      team_id: input.team_id,
      from,
      to,
      mentions: [...resolved],
      content,
      ts,
      kind,
      conversation_id: conversationId,
      ...(input.federation !== undefined ? { federation: input.federation } : {}),
    };
    try {
      await this.store.appendLog(entry);
    } catch (error) {
      throw new TeamError('team_log_write_failed', errorText(error));
    }
    this.emit({ team_id: input.team_id, kind, message_id: messageId });

    // 3. 日志已落盘后再并行投递；单条失败不影响其它条目。
    // 跨节点报文只给 dispatch 前置回信抬头；日志 content 保持原文（DECISION-037 §8）。
    const dispatchContent =
      input.federation === undefined
        ? content
        : federationDispatchContent(input.federation.from_addr, content);
    const dispatched = await Promise.all(
      slots.map((slot) =>
        slot.targetId === undefined
          ? Promise.resolve(undefined)
          : this.dispatchMention(
              slot.targetId,
              dispatchContent,
              from,
              conversationId,
              input.team_id,
            ),
      ),
    );
    const delivered: TeamDelivery[] = [];
    slots.forEach((slot, index) => {
      const delivery = slot.delivery ?? dispatched[index];
      if (delivery !== undefined) delivered.push(delivery);
    });

    return {
      message_id: messageId,
      team_id: input.team_id,
      kind,
      mentions: resolved,
      delivered,
      ts,
      conversation_id: conversationId,
    };
  }

  async members(input: TeamMembersInput): Promise<TeamMembersResult | undefined> {
    const record = this.store.get(input.team_id);
    if (record === undefined) return undefined;
    // 归档 Team 只读：add / remove 都拒绝。
    assertTeamNotArchived(record, input.team_id);
    const from = input.from ?? DEFAULT_OWNER;
    const visible = await this.listVisible(from);
    const target = resolveMember(input.member, visible);

    if (input.action === 'add') {
      if (target.team_id !== undefined && target.team_id !== input.team_id) {
        throw new TeamError('team_already_in_team', `team_already_in_team: ${target.id}`);
      }
      if (
        target.name !== undefined &&
        visible.some(
          (status) =>
            status.id !== target.id &&
            status.team_id === input.team_id &&
            status.membership === 'present' &&
            status.name === target.name,
        )
      ) {
        throw new TeamError('invalid_input', `duplicate member name: ${target.name}`);
      }
      await this.agent.reinstate({ to: target.id, team_id: input.team_id, from });
      this.emit({ team_id: input.team_id, kind: 'roster' });
      return {
        team_id: input.team_id,
        action: 'add',
        agent_id: target.id,
        membership: 'present',
      };
    }

    if (target.team_id !== input.team_id) {
      throw new TeamError('team_not_member', `team_not_member: ${target.id}`);
    }
    this.archiveInFlight.add(target.id);
    try {
      await this.agent.close({ member: target.id });
    } finally {
      this.archiveInFlight.delete(target.id);
    }
    this.emit({ team_id: input.team_id, kind: 'roster' });
    return {
      team_id: input.team_id,
      action: 'remove',
      agent_id: target.id,
      membership: 'left',
    };
  }

  async listForCaller(sessionId: string): Promise<TeamMemberSummary[]> {
    const caller = await this.agent.identify(sessionId);
    if (caller === undefined) return [];
    if (caller.team_id !== undefined) {
      return this.rosterFor(caller.team_id, caller.id);
    }
    const visible = await this.listVisible(caller.id);
    // 无 Team 时至少能看到自己（private 成员的 canView 对自身也不放行）。
    return (visible.some((status) => status.id === caller.id) ? visible : [caller, ...visible]).map(
      toMemberSummary,
    );
  }

  async send(input: TeamAgentSendInput): Promise<TeamAgentSendResult> {
    const caller = await this.agent.identify(input.from_session_id);
    if (caller === undefined) {
      return {
        status: 'error',
        code: 'unknown_member',
        reason: `unknown_member: ${input.from_session_id}`,
        logged: false,
      };
    }

    let content: string;
    try {
      content = readContent(input.content);
    } catch (error) {
      return {
        status: 'error',
        code: errorCode(error) ?? 'invalid_input',
        reason: errorText(error),
        logged: false,
      };
    }

    let conversationId: string;
    try {
      // 缺省继承调用者当前 turn；没有则生成。
      conversationId = this.resolveConversationId(input.conversation_id, caller.id);
    } catch (error) {
      return {
        status: 'error',
        code: errorCode(error) ?? 'invalid_input',
        reason: errorText(error),
        logged: false,
      };
    }

    // 地址形式优先于 id / session / name 解析。按段数分派（0.27）：
    // - 3 段 → 地址路；由 port 判定本机 / 远端，本机的就地投递，绝不出网；
    // - 2 段 → 本机，但仍是地址形态，需要拆成 principal + team 再投，不能当名字查；
    // - 1 段 → 普通 id / name 解析；裸 `human` 单独短路（它不是成员名）。
    const segments = typeof input.to === 'string' ? addressSegmentCount(input.to) : undefined;
    if (segments === 3) {
      return this.sendAddress(caller, input.to, content, conversationId);
    }
    if (segments === 2) {
      return this.sendLocalAddress(caller, input.to, content, conversationId);
    }
    // 1 段 `human`：本机人类，写进调用者自己的 Team 日志。
    if (input.to === HUMAN_PRINCIPAL) {
      return this.deliverLocalAddress(
        caller,
        { kind: 'local_human' },
        input.to,
        content,
        conversationId,
      );
    }

    const visible = await this.listVisible(caller.id);
    if (!visible.some((status) => status.id === caller.id)) visible.push(caller);
    const resolved = await this.resolveSendTarget(caller, input.to, visible);
    if (!resolved.ok) return resolved.result;
    const target = resolved.target;

    // Team 日志对 team 可见：private roster 成员不能作为 send 目标，直接拒绝。
    const targetStatus =
      target === undefined ? undefined : visible.find((status) => status.id === target.agent_id);
    if (targetStatus !== undefined && isPrivateRosterMember(targetStatus)) {
      return {
        status: 'error',
        code: 'team_private_member',
        reason: `team_private_member: ${targetStatus.id}`,
        logged: false,
        conversation_id: conversationId,
      };
    }

    // 有 Team 的调用者：name 只在同 Team roster 内解析；未命中不得把原始 name
    // 交给 tenant 全局 dispatch（否则会绕过 roster 解析到别的 Team）。
    if (caller.team_id !== undefined && target === undefined) {
      // 1 段裸名的查找阶梯：本 Team（上面已查）→ 本机其它 Team → 可访问节点。
      const escalated = await this.resolveBareAgent(caller, input.to, content, conversationId);
      if (escalated !== undefined) return escalated;
      return {
        status: 'error',
        code: 'unknown_member',
        reason: `unknown_member: ${input.to}`,
        logged: false,
        conversation_id: conversationId,
      };
    }

    let logged = false;
    // private 调用者同样不得写 Team 日志（消息本身仍可 dispatch，只是不留痕）。
    if (
      target !== undefined &&
      caller.team_id !== undefined &&
      target.team_id === caller.team_id &&
      !isPrivateRosterMember(caller)
    ) {
      const entry: TeamLogEntry = {
        message_id: this.newId(),
        team_id: caller.team_id,
        from: caller.id,
        to: [target.agent_id],
        mentions: [target.agent_id],
        content,
        ts: this.now(),
        kind: 'mention',
        conversation_id: conversationId,
      };
      try {
        await this.store.appendLog(entry);
      } catch (error) {
        return {
          status: 'error',
          code: 'team_log_write_failed',
          reason: errorText(error),
          logged: false,
          conversation_id: conversationId,
        };
      }
      logged = true;
    }

    try {
      const result = await this.agent.dispatch({
        to: target?.agent_id ?? input.to,
        content,
        from: caller.id,
        conversation_id: conversationId,
      });
      if (result.status === 'queued') {
        return {
          status: 'queued',
          resolved_to: result.resolved_to,
          message_id: result.message_id,
          resolution: result.resolution,
          logged,
          conversation_id: conversationId,
        };
      }
      return {
        status: 'rejected',
        ...(target !== undefined ? { resolved_to: target.agent_id } : {}),
        code: result.code,
        reason: result.reason,
        logged,
        conversation_id: conversationId,
      };
    } catch (error) {
      return {
        status: 'error',
        ...(target !== undefined ? { resolved_to: target.agent_id } : {}),
        code: errorCode(error) ?? 'invalid_input',
        reason: errorText(error),
        logged,
        conversation_id: conversationId,
      };
    }
  }

  subscribe(listener: (event: TeamServiceEvent) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.retiredBodies.clear();
    this.unsubscribe();
    this.unsubscribeRuns?.();
  }

  /**
   * 指针事件：只带 team_id / kind / message_id，绝不含正文。
   * 监听者异常被隔离，不影响日志与生命周期。
   */
  private emit(event: TeamServiceEvent): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn('team.event.listener_failed', {
          team_id: event.team_id,
          kind: event.kind,
          error: errorText(error),
        });
      }
    }
  }

  private async listVisible(viewer?: string): Promise<MemberStatus[]> {
    return viewer === undefined ? this.agent.list() : this.agent.list({ viewer });
  }

  /** S10.3：create / update 的摘要计数从 roster 派生（新 Team = 0 / 0）。 */
  private async summarize(record: TeamRecord): Promise<TeamSummary> {
    const members = await this.rosterFor(record.team_id);
    return toTeamSummary(
      record,
      members.length,
      members.filter((member) => member.presence === 'live').length,
    );
  }

  /**
   * 显式 id 先校验；缺省优先继承当前 turn（成员 send），否则生成。
   */
  private resolveConversationId(value: string | undefined, inheritFrom?: string): string {
    if (value !== undefined) {
      if (!isValidConversationId(value)) {
        throw new TeamError('invalid_input', 'invalid conversation_id');
      }
      return value;
    }
    if (inheritFrom !== undefined) {
      const inherited = this.agent.currentConversation(inheritFrom);
      if (inherited !== undefined) return inherited;
    }
    return generateConversationId(this.newId);
  }

  /**
   * 唯一 roster 排序来源（DECISION-038 §2.3）：返回**已排序**的完整 present roster。
   * `get` 的窗口、`roster`、`listForCaller` 与 federation team-info 都复用此顺序，
   * 不得在别处再排序。
   */
  private async rosterFor(teamId: string, viewer?: string): Promise<TeamMemberSummary[]> {
    const statuses = await this.listVisible(viewer);
    return statuses
      .filter((status) => status.team_id === teamId && status.membership === 'present')
      .map(toMemberSummary)
      .sort(compareRoster);
  }

  /**
   * 裸 agent 名的查找阶梯（0.27）：本 Team 已查过 → 本机其它 Team → 可访问节点。
   *
   * 返回 `undefined` 表示**继续按「查完了确实没有」处理**；返回结果表示已经给出
   * 明确答复（投递成功、歧义、超时）。
   *
   * 跨 team 重名不能静默择一：调用方要用完整地址 `<agent>@<team>` 精确指定，
   * 所以重名一律报错并列出候选。
   */
  private async resolveBareAgent(
    caller: MemberStatus,
    to: string,
    content: string,
    conversationId: string,
  ): Promise<TeamAgentSendResult | undefined> {
    const localTeams = this.store
      .list()
      .filter((record) => record.team_id !== caller.team_id && record.archived_at === undefined);

    const localMatches: { teamId: string; agentId: string }[] = [];
    for (const record of localTeams) {
      const roster = await this.rosterFor(record.team_id, caller.id);
      const hit = roster.find(
        (member) => member.agent_id === to || member.session_id === to || member.name === to,
      );
      if (hit !== undefined) localMatches.push({ teamId: record.team_id, agentId: hit.agent_id });
    }

    if (localMatches.length > 1) {
      const candidates = localMatches
        .map((match) => `${to}@${match.teamId}`)
        .sort()
        .join(', ');
      return {
        status: 'error',
        code: 'ambiguous_member',
        reason: `ambiguous name: ${to}; use one of: ${candidates}`,
        logged: false,
        conversation_id: conversationId,
      };
    }

    const [local] = localMatches;
    if (local !== undefined) {
      return this.deliverLocalAddress(
        caller,
        { kind: 'local_member', principal: local.agentId, team_id: local.teamId },
        `${local.agentId}@${local.teamId}`,
        content,
        conversationId,
      );
    }

    const federation = this.federation;
    if (federation === undefined) return undefined;

    const found = await federation.lookup(to);
    if (found.candidates.length > 1) {
      const candidates = found.candidates
        .map((candidate) => candidate.address)
        .sort()
        .join(', ');
      return {
        status: 'error',
        code: 'ambiguous_member',
        reason: `ambiguous name: ${to}; use one of: ${candidates}`,
        logged: false,
        conversation_id: conversationId,
      };
    }
    const [remote] = found.candidates;
    if (remote !== undefined) {
      return this.sendAddress(caller, remote.address, content, conversationId);
    }
    // 没查完就不能说「不存在」：离线 peer 会被误报成查无此人。
    if (found.timedOut) {
      return {
        status: 'error',
        code: 'lookup_timeout',
        reason: `could not finish looking up "${to}" within the lookup budget`,
        logged: false,
        conversation_id: conversationId,
      };
    }
    return undefined;
  }

  /**
   * 三段地址 `<principal>@<node>:<team>`（0.21 / 0.27）。
   *
   * **先问 port 指向哪里**：node 段命中本机时走本机投递（`deliverLocalAddress`），
   * 绝不出网；只有 `remote` 才发请求。这样模型照抄来源行里的
   * `<principal>@<本机 nodeId>:<team>` 也能送达，而不是绕一圈被自己拒绝。
   *
   * 前置失败一律不发请求；`from` 由运行时按调用者身份构造，模型不能伪造。
   * 跨节点发送不写本地 Team 日志（`logged:false`），对端负责落日志。
   */
  private async sendAddress(
    caller: MemberStatus,
    to: string,
    content: string,
    conversationId: string,
  ): Promise<TeamAgentSendResult> {
    const guard = this.addressCallerGuard(caller, conversationId);
    if (guard !== undefined) return guard;

    const federation = this.federation;
    if (federation === undefined) {
      return {
        status: 'error',
        code: 'federation_unavailable',
        reason: 'federation_unavailable',
        logged: false,
        conversation_id: conversationId,
      };
    }

    const placement = federation.resolve(to);
    if (placement.kind === 'invalid') {
      return {
        status: 'error',
        code: placement.code,
        reason: placement.reason,
        logged: false,
        conversation_id: conversationId,
      };
    }
    if (placement.kind !== 'remote') {
      return this.deliverLocalAddress(caller, placement, to, content, conversationId);
    }

    const result = await federation.send({
      from: `${caller.name}@${federation.nodeId}:${caller.team_id}`,
      to,
      content,
      conversation_id: conversationId,
    });
    if (result.status === 'queued') {
      return {
        status: 'queued',
        resolved_to: to,
        message_id: result.message_id,
        logged: false,
        conversation_id: conversationId,
      };
    }
    return {
      status: result.status,
      code: result.code,
      reason: result.reason,
      logged: false,
      conversation_id: conversationId,
    };
  }

  /**
   * 两段地址 `<agent>@<team>`：node 恒为本机，直接本机投递。
   *
   * 拆成 principal + team，不走 port —— 两段形态不需要判定「是不是本机」。
   */
  private async sendLocalAddress(
    caller: MemberStatus,
    to: string,
    content: string,
    conversationId: string,
  ): Promise<TeamAgentSendResult> {
    const guard = this.addressCallerGuard(caller, conversationId);
    if (guard !== undefined) return guard;

    const at = to.indexOf('@');
    const principal = to.slice(0, at);
    const teamId = to.slice(at + 1);
    // `human@<team>` 是同一条地址规则的 human 形态，不是名叫 human 的成员。
    if (principal === HUMAN_PRINCIPAL) {
      return this.deliverLocalAddress(
        caller,
        { kind: 'local_human', team_id: teamId },
        to,
        content,
        conversationId,
      );
    }
    return this.deliverLocalAddress(
      caller,
      { kind: 'local_member', principal, team_id: teamId },
      to,
      content,
      conversationId,
    );
  }

  /** 发送者前置条件：left 不能发；没有 Team / 名字则构造不出 `from`。 */
  private addressCallerGuard(
    caller: MemberStatus,
    conversationId: string,
  ): TeamAgentSendResult | undefined {
    if (caller.membership === 'left') {
      return {
        status: 'error',
        code: 'member_left',
        reason: `member_left: ${caller.id}`,
        logged: false,
        conversation_id: conversationId,
      };
    }
    if (caller.team_id === undefined) {
      return {
        status: 'error',
        code: 'no_team',
        reason: 'no_team',
        logged: false,
        conversation_id: conversationId,
      };
    }
    if (caller.name === undefined) {
      return {
        status: 'error',
        code: 'no_name',
        reason: 'no_name',
        logged: false,
        conversation_id: conversationId,
      };
    }
    return undefined;
  }

  /**
   * 本机地址投递：`human` 只写 Team 日志（零 run）；成员在目标 Team 内按
   * id / session / name 唯一命中后写 mention 日志并 dispatch 一次。
   *
   * **复用 `post()`**：它已经是「校验 roster → 写日志 → dispatch」的唯一实现，
   * 这里只多做一件事 —— 把地址里的 principal 解析成 agent id。node 段在这条路径上
   * 没有意义（已经是本机了），所以 2 段与命中本机的 3 段共用这里。
   */
  private async deliverLocalAddress(
    caller: MemberStatus,
    placement: {
      kind: 'local_human' | 'local_member';
      principal?: string;
      team_id?: string;
    },
    to: string,
    content: string,
    conversationId: string,
  ): Promise<TeamAgentSendResult> {
    const teamId = placement.team_id ?? caller.team_id;
    if (teamId === undefined) {
      return {
        status: 'error',
        code: 'no_team',
        reason: 'local address needs a team segment or a team-bound sender',
        logged: false,
        conversation_id: conversationId,
      };
    }
    // 地址里的 team 段写错必须报 team_not_found，不能退化成 unknown_member：
    // 前者是「Team 不存在」，后者会让人去查成员名，排查方向相反。
    if (this.store.get(teamId) === undefined) {
      return {
        status: 'error',
        code: 'team_not_found',
        reason: `team_not_found: ${teamId}`,
        logged: false,
        conversation_id: conversationId,
      };
    }

    // `human`：只写日志、不唤醒成员（与跨节点入站的 human 分支同形）。
    if (placement.kind === 'local_human') {
      try {
        await this.post({
          team_id: teamId,
          content,
          from: caller.id,
          to: [HUMAN_PRINCIPAL],
          conversation_id: conversationId,
        });
      } catch (error) {
        return {
          status: 'error',
          code: errorCode(error) ?? 'team_log_write_failed',
          reason: errorText(error),
          logged: false,
          conversation_id: conversationId,
        };
      }
      return {
        status: 'queued',
        resolved_to: HUMAN_PRINCIPAL,
        logged: true,
        conversation_id: conversationId,
      };
    }

    const principal = placement.principal ?? to;
    let targetId: string;
    try {
      targetId = await this.resolveAddressMember(teamId, caller.id, principal);
    } catch (error) {
      return {
        status: 'error',
        code: errorCode(error) ?? 'unknown_member',
        reason: errorText(error),
        logged: false,
        conversation_id: conversationId,
      };
    }

    let posted: TeamPostResult;
    try {
      posted = await this.post({
        team_id: teamId,
        content,
        from: caller.id,
        mentions: [targetId],
        conversation_id: conversationId,
      });
    } catch (error) {
      return {
        status: 'error',
        code: errorCode(error) ?? 'team_log_write_failed',
        reason: errorText(error),
        logged: false,
        conversation_id: conversationId,
      };
    }

    const [delivery] = posted.delivered;
    if (delivery === undefined) {
      return {
        status: 'queued',
        resolved_to: targetId,
        message_id: posted.message_id,
        logged: true,
        conversation_id: conversationId,
      };
    }
    if (delivery.status === 'queued') {
      return {
        status: 'queued',
        resolved_to: targetId,
        ...(delivery.message_id !== undefined ? { message_id: delivery.message_id } : {}),
        ...(delivery.resolution !== undefined ? { resolution: delivery.resolution } : {}),
        logged: true,
        conversation_id: conversationId,
      };
    }
    return {
      status: delivery.status === 'rejected' ? 'rejected' : 'error',
      resolved_to: targetId,
      ...(delivery.code !== undefined ? { code: delivery.code } : {}),
      ...(delivery.reason !== undefined ? { reason: delivery.reason } : {}),
      logged: true,
      conversation_id: conversationId,
    };
  }

  /**
   * 目标 Team 内按 id / session 精确匹配，再按 name 唯一匹配。
   *
   * **只看目标 Team 的 present roster**：地址里的 team 段决定作用域，不能退回
   * tenant 全局查找，否则 `alice@team-b` 会打到 `team-a` 里的同名成员。
   */
  private async resolveAddressMember(
    teamId: string,
    viewer: string,
    principal: string,
  ): Promise<string> {
    const roster = await this.rosterFor(teamId, viewer);
    const exact = roster.find(
      (member) => member.agent_id === principal || member.session_id === principal,
    );
    if (exact !== undefined) return exact.agent_id;

    const byName = roster.filter((member) => member.name === principal);
    if (byName.length === 1) {
      const [match] = byName;
      if (match !== undefined) return match.agent_id;
    }
    if (byName.length > 1) {
      throw new TeamError('invalid_input', `ambiguous name: ${principal}`);
    }
    throw new TeamError('unknown_member', `unknown_member: ${principal}`);
  }

  /** send 的 to 解析：id / 当前 session 精确匹配优先，其次按调用者可见范围解析 name */
  private async resolveSendTarget(
    caller: MemberStatus,
    to: string,
    visible: MemberStatus[],
  ): Promise<ResolvedSendTarget> {
    const exact = visible.find((status) => status.id === to || status.session_id === to);
    if (exact !== undefined) {
      return {
        ok: true,
        target: {
          agent_id: exact.id,
          ...(exact.team_id !== undefined ? { team_id: exact.team_id } : {}),
        },
      };
    }

    // 有 Team 时 name 只在同 Team present roster 内解析；无 Team 用自己可见成员。
    let pool: NamedSendTarget[];
    if (caller.team_id !== undefined) {
      const roster = await this.rosterFor(caller.team_id, caller.id);
      pool = roster.map((member) => ({
        agent_id: member.agent_id,
        team_id: caller.team_id,
        ...(member.name !== undefined ? { name: member.name } : {}),
      }));
    } else {
      pool = visible.map((status) => ({
        agent_id: status.id,
        ...(status.team_id !== undefined ? { team_id: status.team_id } : {}),
        ...(status.name !== undefined ? { name: status.name } : {}),
      }));
    }
    const matches = pool.filter((member) => member.name === to);
    if (matches.length > 1) {
      return {
        ok: false,
        result: {
          status: 'error',
          code: 'invalid_input',
          reason: 'ambiguous name',
          logged: false,
        },
      };
    }
    const match = matches[0];
    return {
      ok: true,
      ...(match !== undefined
        ? {
            target: {
              agent_id: match.agent_id,
              ...(match.team_id !== undefined ? { team_id: match.team_id } : {}),
            },
          }
        : {}),
    };
  }

  private async dispatchMention(
    targetId: string,
    content: string,
    from: string,
    conversationId: string,
    originTeamId?: string,
  ): Promise<TeamDelivery> {
    try {
      const result = await this.agent.dispatch({
        to: targetId,
        content,
        from,
        conversation_id: conversationId,
        ...(originTeamId !== undefined ? { origin_team_id: originTeamId } : {}),
      });
      if (result.status === 'queued') {
        return {
          agent_id: targetId,
          status: 'queued',
          message_id: result.message_id,
          resolution: result.resolution,
        };
      }
      return {
        agent_id: targetId,
        status: 'rejected',
        code: result.code,
        reason: result.reason,
      };
    } catch (error) {
      return {
        agent_id: targetId,
        status: 'error',
        code: errorCode(error) ?? 'invalid_input',
        reason: errorText(error),
      };
    }
  }

  /** system 消息：只写日志、不 dispatch；失败只 warning（不改变生命周期） */
  private onAgentEvent(event: AgentEvent): void {
    // 0.27：先记账（早于下面所有 early return）——private / unbound 成员的退役、
    // 关闭同样要抑制其旧 Body 的 run.* 终态。
    this.noteBodyLifecycle(event);

    // Team log is team-visible. Private members (internal workers) must not leak
    // id / name / reply into the team log. Fail closed for unknown visibility.
    if (event.visibility !== 'team' && event.visibility !== 'tenant') return;

    const teamId = event.team_id;
    if (teamId === undefined || teamId.length === 0) return;

    const systemEvent = this.systemEventFor(event);
    if (systemEvent === undefined) return;
    // join 的 from 记录“谁招的”：agent.spawned 带 spawned_by 时用它，否则保持 system。
    const from =
      event.type === 'agent.spawned' &&
      typeof event.spawned_by === 'string' &&
      event.spawned_by.length > 0
        ? event.spawned_by
        : 'system';
    this.writeSystemLog({
      teamId,
      from,
      to: [event.agent_id],
      content: SYSTEM_CONTENT[systemEvent],
      systemEvent,
      eventType: event.type,
      agentId: event.agent_id,
    });
  }

  /**
   * 0.27：Body 退役 / 成员关闭记账（`agent.*` 管道）。
   *
   * 只维护 `(agent_id, session_id)` 集合；不写日志、不改变生命周期。
   * 放在 `onAgentEvent` 所有 early return 之前：private / unbound 成员的
   * 旧 Body 同样要抑制终态。
   */
  private noteBodyLifecycle(event: AgentEvent): void {
    switch (event.type) {
      case 'agent.retired':
        if (event.session_id !== undefined && event.session_id.length > 0) {
          this.markRetiredBody(event.agent_id, event.session_id);
        }
        return;
      case 'agent.closed':
        // close 关掉该成员的全部 Body，逐条记账（不用通配键：复活时无法逐条撤销）。
        if (event.session_id !== undefined && event.session_id.length > 0) {
          this.markRetiredBody(event.agent_id, event.session_id);
        }
        return;
      case 'agent.rejoined':
        // reinstate 把 close 置 closing 的 live Body 放回可跑：撤销该 Body 的记账，
        // 否则复活后的正常轮会被误判成旧 Body。
        if (event.session_id !== undefined && event.session_id.length > 0) {
          this.retiredBodies.delete(retiredBodyKey(event.agent_id, event.session_id));
        }
        return;
      default:
        return;
    }
  }

  /** 记账并维持上限（Set 保持插入顺序，超出丢最旧） */
  private markRetiredBody(agentId: string, sessionId: string): void {
    const key = retiredBodyKey(agentId, sessionId);
    this.retiredBodies.delete(key);
    this.retiredBodies.add(key);
    while (this.retiredBodies.size > MAX_RETIRED_BODIES_TRACKED) {
      const oldest = this.retiredBodies.values().next().value;
      if (oldest === undefined) return;
      this.retiredBodies.delete(oldest);
    }
  }

  /**
   * 该 Body 是否已退役 / 已关闭。没记账就当活着：`agent.retired` 与 `run.*` 终态
   * 都出自同一进程内的 `AgentService`，退役一定先记账（`retireBodyEntry` 先 emit）。
   */
  private isRetiredBody(agentId: string, sessionId: string | undefined): boolean {
    if (sessionId === undefined) return false;
    return this.retiredBodies.has(retiredBodyKey(agentId, sessionId));
  }

  /**
   * 0.27：run.* 终态写 Team 日志（成员 run 走父事件流，与 agent.* 不同管道）。
   * 归属字段由 runtime 并入 `data`；缺任一字段即放弃（fail-closed），不猜。
   * 旧 Body（已退役 / 已关闭）的终态一律不写：与旧回合事件的 `stale` 抑制等价，
   * reply / 失败 / 取消三条分支共用这一次判断。只写日志、不 dispatch。
   */
  private onRunEvent(event: RunEvent): void {
    if (typeof event.data !== 'object' || event.data === null) return;
    const data = event.data as Record<string, unknown>;
    const sessionId = typeof data.session_id === 'string' ? data.session_id : undefined;

    // Team log is team-visible. Private members must not leak id / reply.
    const visibility = data.visibility;
    if (visibility !== 'team' && visibility !== 'tenant') return;

    const teamId = data.team_id;
    if (typeof teamId !== 'string' || teamId.length === 0) return;
    const agentId = data.agent_id;
    if (typeof agentId !== 'string' || agentId.length === 0) return;
    // 旧 Body（已退役 / 已关闭）的终态不写 Team 日志。
    if (this.isRetiredBody(agentId, sessionId)) return;

    if (event.type === 'run.completed') {
      const output = data.output;
      if (typeof output !== 'string' || output.length === 0) return;
      const entry: TeamLogEntry = {
        message_id: this.newId(),
        team_id: teamId,
        from: agentId,
        to: [],
        mentions: [],
        content: truncateReplyContent(output),
        ts: event.ts,
        kind: 'reply',
      };
      this.store
        .appendLog(entry)
        .then(() => {
          this.emit({ team_id: teamId, kind: 'reply', message_id: entry.message_id });
        })
        .catch((error: unknown) => {
          this.logger.warn('team.reply_message.failed', {
            team_id: teamId,
            agent_id: agentId,
            error: errorText(error),
          });
        });
      return;
    }

    // 失败 / 取消同样要可见：否则人类只看到 Team 里的沉默。
    if (event.type === 'run.failed' || event.type === 'run.cancelled') {
      const verb = event.type === 'run.failed' ? 'turn failed' : 'turn cancelled';
      const error = typeof data.error === 'string' ? singleLine(data.error) : '';
      const reason = typeof data.reason === 'string' ? singleLine(data.reason) : '';
      const detail = error.length > 0 ? error : reason;
      this.writeSystemLog({
        teamId,
        to: [agentId],
        content: detail.length > 0 ? `${verb}: ${truncateReason(detail)}` : verb,
        eventType: event.type,
        agentId,
      });
    }
  }

  /** 唯一 system 日志写入点；失败只 warning，不改变生命周期 / roster。 */
  private writeSystemLog(input: {
    teamId: string;
    from?: string;
    to: string[];
    content: string;
    conversationId?: string;
    systemEvent?: TeamSystemEvent;
    eventType: string;
    agentId?: string;
  }): void {
    const messageId = this.newId();
    const entry: TeamLogEntry = {
      message_id: messageId,
      team_id: input.teamId,
      from: input.from ?? 'system',
      to: input.to,
      mentions: [],
      content: input.content,
      ts: this.now(),
      kind: 'system',
      ...(input.conversationId !== undefined ? { conversation_id: input.conversationId } : {}),
      ...(input.systemEvent !== undefined ? { system_event: input.systemEvent } : {}),
    };
    this.store
      .appendLog(entry)
      .then(() => {
        this.emit({ team_id: input.teamId, kind: 'system', message_id: messageId });
      })
      .catch((error: unknown) => {
        this.logger.warn('team.system_message.failed', {
          team_id: input.teamId,
          ...(input.agentId !== undefined ? { agent_id: input.agentId } : {}),
          ...(input.systemEvent !== undefined ? { system_event: input.systemEvent } : {}),
          event_type: input.eventType,
          error: errorText(error),
        });
      });
  }

  private systemEventFor(event: AgentEvent): TeamSystemEvent | undefined {
    switch (event.type) {
      case 'agent.spawned':
      case 'agent.rejoined':
        return 'join';
      case 'agent.closed':
        return this.archiveInFlight.has(event.agent_id) ? 'archive' : 'leave';
      case 'agent.rotated':
        return 'rotate';
      case 'agent.forked':
        return 'fork';
      default:
        return undefined;
    }
  }
}

/** 工厂：app 装配按此名称接线 */
export function createTeamService(options: TeamServiceOptions): DefaultTeamService {
  return new DefaultTeamService(options);
}

function toTeamSummary(record: TeamRecord, memberCount: number, onlineCount: number): TeamSummary {
  return {
    team_id: record.team_id,
    name: record.name,
    tenant_id: record.tenant_id,
    workspace: record.workspace,
    ...(record.description !== undefined ? { description: record.description } : {}),
    policy: record.policy,
    member_count: memberCount,
    online_count: onlineCount,
    created_at: record.created_at,
    ...(record.archived_at !== undefined ? { archived_at: record.archived_at } : {}),
    ...(record.spawn_frozen !== undefined ? { spawn_frozen: record.spawn_frozen } : {}),
  };
}

/** 归档 Team 只读；`post` / `members` / `budget override` 统一抛 team_archived。 */
function assertTeamNotArchived(record: TeamRecord, teamId: string): void {
  if (record.archived_at !== undefined) {
    throw new TeamError('team_archived', `team_archived: ${teamId}`);
  }
}

function toMemberSummary(status: MemberStatus): TeamMemberSummary {
  return {
    agent_id: status.id,
    ...(status.name !== undefined ? { name: status.name } : {}),
    session_id: status.session_id,
    ...(status.team_id !== undefined ? { team_id: status.team_id } : {}),
    membership: status.membership ?? 'present',
    presence: status.presence ?? 'gone',
    role: status.role,
    ...(status.owner !== undefined ? { owner: status.owner } : {}),
    visibility: status.visibility,
    state: status.state,
    epoch: status.epoch ?? 0,
    ...(status.last_seen !== undefined ? { last_seen: status.last_seen } : {}),
    ...(status.body_history !== undefined && status.body_history.length > 0
      ? { body_history: status.body_history }
      : {}),
  };
}

/** `members_limit`：缺省 20；非整数 / <1 回退 20；上限 100（DECISION-037 §7.1）。 */
const DEFAULT_MEMBERS_LIMIT = 20;
const MAX_MEMBERS_LIMIT = 100;

function normalizeMembersLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return DEFAULT_MEMBERS_LIMIT;
  }
  return Math.min(value, MAX_MEMBERS_LIMIT);
}

/**
 * TeamService 唯一 roster 顺序（DECISION-038 §2.3）：
 * live 优先 → last_seen 降序（缺失最后）→ name 字典序（缺失最后，同缺失保持稳定）。
 */
function compareRoster(left: TeamMemberSummary, right: TeamMemberSummary): number {
  const leftLive = left.presence === 'live';
  const rightLive = right.presence === 'live';
  if (leftLive !== rightLive) return leftLive ? -1 : 1;

  if (left.last_seen !== undefined || right.last_seen !== undefined) {
    if (left.last_seen === undefined) return 1;
    if (right.last_seen === undefined) return -1;
    if (left.last_seen !== right.last_seen) return right.last_seen - left.last_seen;
  }

  if (left.name !== undefined || right.name !== undefined) {
    if (left.name === undefined) return 1;
    if (right.name === undefined) return -1;
    return left.name.localeCompare(right.name);
  }
  return 0;
}

/** 只截断，不再排序：顺序唯一来源是 `rosterFor`（DECISION-038 §2.3）。 */
function windowRoster(
  members: readonly TeamMemberSummary[],
  limit: number | undefined,
): TeamMemberSummary[] {
  return members.slice(0, normalizeMembersLimit(limit));
}

/** dispatch 前置抬头（只进投递正文，不进 Team 日志） */
function federationDispatchContent(fromAddr: string, content: string): string {
  return `[federation] from ${fromAddr}\nreply with: agent(send, to="${fromAddr}", content="...")\n\n${content}`;
}

/** Team 回复日志上限：与 AgentService 一致，超限截断并加标记 */
function truncateReplyContent(content: string): string {
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

/**
 * private roster 成员判定：所有 private 成员都是 roster 成员（0.28 起不再有
 * `single` 旁路 —— 那是「无 Team 的独立 agent」才需要的例外）。
 * Team 日志对 team 可见，这类成员不得作为 actor / mention / send 目标，也不写日志。
 */
function isPrivateRosterMember(status: MemberStatus): boolean {
  return status.visibility === 'private';
}

/** 按首次出现顺序去重 */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** 消息体：非空且不超过上限；失败抛 TeamError('invalid_input') */
function readContent(content: string): string {
  if (content.length === 0) {
    throw new TeamError('invalid_input', 'content must be a non-empty string');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new TeamError('invalid_input', `content exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
  return content;
}

/** 成员解析：id / 当前 session 优先，其次唯一 name；歧义与缺失抛 TeamError */
function resolveMember(member: string, visible: readonly MemberStatus[]): MemberStatus {
  const direct = visible.find((status) => status.id === member || status.session_id === member);
  if (direct !== undefined) return direct;
  const matches = visible.filter((status) => status.name === member);
  if (matches.length === 0) {
    throw new TeamError('unknown_member', `unknown_member: ${member}`);
  }
  if (matches.length > 1) {
    throw new TeamError('invalid_input', `ambiguous name: ${member}`);
  }
  const [match] = matches;
  if (match === undefined) {
    throw new TeamError('unknown_member', `unknown_member: ${member}`);
  }
  return match;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 失败原因折成单行，避免一条 system 日志被正文换行撑开 */
function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** system 日志里的失败原因上限；超出截断并加标记 */
const MAX_SYSTEM_REASON_CHARS = 500;

function truncateReason(reason: string): string {
  return reason.length > MAX_SYSTEM_REASON_CHARS
    ? `${reason.slice(0, MAX_SYSTEM_REASON_CHARS)}...`
    : reason;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
