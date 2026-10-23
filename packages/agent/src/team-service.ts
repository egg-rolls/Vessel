/**
 * Team 能力层默认实现（0.19 S3）。
 *
 * 职责：
 * - roster 由 Agent 记录派生（`team_id` + `membership`），不单独持久化；
 * - 只追加团队日志；无 `@` 的 post 绝不 dispatch（结构性保证零 run）；
 * - `@` 使用结构化 agent id，先写日志再并行 dispatch，逐条返回结果；
 * - 订阅 `agent.spawned/rejoined/closed/rotated` 写系统消息（只写日志）。
 *
 * 依赖边界：只依赖 `AgentService` 与 `TeamStore` 接口，不 import team-store.ts。
 *
 * @module @vessel-agent/agent
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from '@vessel-agent/core';
import {
  type AgentEvent,
  type AgentService,
  type AgentTeamService,
  DEFAULT_OWNER,
  MAX_MESSAGE_BYTES,
  type MemberStatus,
  type TeamAgentSendInput,
  type TeamAgentSendResult,
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
  type TeamStore,
  type TeamSummary,
  type TeamSystemEvent,
} from './types.js';

/** DefaultTeamService 构造参数（app 装配按此名称接线） */
export interface TeamServiceOptions {
  tenantId: string;
  agent: AgentService;
  store: TeamStore;
  now?: () => number;
  newId?: () => string;
  logger?: Logger;
}

/** 系统消息固定英文文案（不含正文） */
const SYSTEM_CONTENT: Record<TeamSystemEvent, string> = {
  join: 'agent joined team',
  leave: 'agent left team',
  archive: 'agent archived',
  rotate: 'agent rotated body',
};

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
  private readonly unsubscribe: () => void;
  /** members remove 期间的标记：把该次 agent.closed 写成 archive 而不是 leave */
  private readonly archiveInFlight = new Set<string>();
  private disposed = false;

  constructor(options: TeamServiceOptions) {
    this.tenantId = options.tenantId;
    this.agent = options.agent;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.unsubscribe = this.agent.subscribe((event) => this.onAgentEvent(event));
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
      team: toTeamSummary(
        record,
        members.length,
        members.filter((member) => member.presence === 'live').length,
      ),
      members,
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

  async post(input: TeamPostInput): Promise<TeamPostResult> {
    if (this.store.get(input.team_id) === undefined) {
      throw new TeamError('team_not_found', `team_not_found: ${input.team_id}`);
    }
    const content = readContent(input.content);
    const from = input.from ?? DEFAULT_OWNER;
    const mentions = dedupe(input.mentions ?? []);

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
    const messageId = this.newId();
    const ts = this.now();
    const kind: TeamPostResult['kind'] = mentions.length > 0 ? 'mention' : 'post';
    const entry: TeamLogEntry = {
      message_id: messageId,
      team_id: input.team_id,
      from,
      to: [...resolved],
      mentions: [...resolved],
      content,
      ts,
      kind,
    };
    try {
      await this.store.appendLog(entry);
    } catch (error) {
      throw new TeamError('team_log_write_failed', errorText(error));
    }

    // 3. 日志已落盘后再并行投递；单条失败不影响其它条目。
    const dispatched = await Promise.all(
      slots.map((slot) =>
        slot.targetId === undefined
          ? Promise.resolve(undefined)
          : this.dispatchMention(slot.targetId, content, from),
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
    };
  }

  async members(input: TeamMembersInput): Promise<TeamMembersResult | undefined> {
    if (this.store.get(input.team_id) === undefined) return undefined;
    const from = input.from ?? DEFAULT_OWNER;
    const visible = await this.listVisible(from);
    const target = resolveMember(input.member, visible);

    if (input.action === 'add') {
      if (target.owner === target.id) {
        throw new TeamError('team_owner_not_rosterable', `team_owner_not_rosterable: ${target.id}`);
      }
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

    const visible = await this.listVisible(caller.id);
    if (!visible.some((status) => status.id === caller.id)) visible.push(caller);
    const resolved = await this.resolveSendTarget(caller, input.to, visible);
    if (!resolved.ok) return resolved.result;
    const target = resolved.target;

    // 有 Team 的调用者：name 只在同 Team roster 内解析；未命中不得把原始 name
    // 交给 tenant 全局 dispatch（否则会绕过 roster 解析到别的 Team）。
    if (caller.team_id !== undefined && target === undefined) {
      return {
        status: 'error',
        code: 'unknown_member',
        reason: `unknown_member: ${input.to}`,
        logged: false,
      };
    }

    let logged = false;
    if (target !== undefined && caller.team_id !== undefined && target.team_id === caller.team_id) {
      const entry: TeamLogEntry = {
        message_id: this.newId(),
        team_id: caller.team_id,
        from: caller.id,
        to: [target.agent_id],
        mentions: [target.agent_id],
        content,
        ts: this.now(),
        kind: 'mention',
      };
      try {
        await this.store.appendLog(entry);
      } catch (error) {
        return {
          status: 'error',
          code: 'team_log_write_failed',
          reason: errorText(error),
          logged: false,
        };
      }
      logged = true;
    }

    try {
      const result = await this.agent.dispatch({
        to: target?.agent_id ?? input.to,
        content,
        from: caller.id,
      });
      if (result.status === 'queued') {
        return {
          status: 'queued',
          resolved_to: result.resolved_to,
          message_id: result.message_id,
          resolution: result.resolution,
          logged,
        };
      }
      return {
        status: 'rejected',
        ...(target !== undefined ? { resolved_to: target.agent_id } : {}),
        code: result.code,
        reason: result.reason,
        logged,
      };
    } catch (error) {
      return {
        status: 'error',
        ...(target !== undefined ? { resolved_to: target.agent_id } : {}),
        code: errorCode(error) ?? 'invalid_input',
        reason: errorText(error),
        logged,
      };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  private async listVisible(viewer?: string): Promise<MemberStatus[]> {
    return viewer === undefined ? this.agent.list() : this.agent.list({ viewer });
  }

  private async rosterFor(teamId: string, viewer?: string): Promise<TeamMemberSummary[]> {
    const statuses = await this.listVisible(viewer);
    return statuses
      .filter((status) => status.team_id === teamId && status.membership === 'present')
      .map(toMemberSummary);
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
  ): Promise<TeamDelivery> {
    try {
      const result = await this.agent.dispatch({ to: targetId, content, from });
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
    if (event.team_id === undefined || event.team_id.length === 0) return;

    // 0.19 S6：成员完成一轮的最终文本。AgentService 只发事件；TeamService 是
    // 唯一日志写入点，且**不 dispatch / 不唤醒任何人**。message_id 与事件一致，
    // 供 Web 按 id 合并。
    if (event.type === 'agent.reply.posted') {
      if (typeof event.content !== 'string' || event.content.length === 0) return;
      const entry: TeamLogEntry = {
        message_id: event.message_id ?? this.newId(),
        team_id: event.team_id,
        from: event.agent_id,
        to: [],
        mentions: [],
        content: truncateReplyContent(event.content),
        ts: event.ts,
        kind: 'reply',
      };
      this.store.appendLog(entry).catch((error: unknown) => {
        this.logger.warn('team.reply_message.failed', {
          team_id: event.team_id,
          agent_id: event.agent_id,
          error: errorText(error),
        });
      });
      return;
    }

    const systemEvent = this.systemEventFor(event);
    if (systemEvent === undefined) return;
    const entry: TeamLogEntry = {
      message_id: this.newId(),
      team_id: event.team_id,
      from: 'system',
      to: [event.agent_id],
      mentions: [],
      content: SYSTEM_CONTENT[systemEvent],
      ts: this.now(),
      kind: 'system',
      system_event: systemEvent,
    };
    this.store.appendLog(entry).catch((error: unknown) => {
      this.logger.warn('team.system_message.failed', {
        team_id: event.team_id,
        agent_id: event.agent_id,
        system_event: systemEvent,
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
    ...(record.handoff_path !== undefined ? { handoff_path: record.handoff_path } : {}),
    policy: record.policy,
    member_count: memberCount,
    online_count: onlineCount,
    created_at: record.created_at,
  };
}

function toMemberSummary(status: MemberStatus): TeamMemberSummary {
  return {
    agent_id: status.id,
    ...(status.name !== undefined ? { name: status.name } : {}),
    session_id: status.session_id,
    ...(status.team_id !== undefined ? { team_id: status.team_id } : {}),
    membership: status.membership ?? 'present',
    presence: status.presence ?? 'gone',
    visibility: status.visibility,
    state: status.state,
    epoch: status.epoch ?? 0,
    ...(status.body_history !== undefined && status.body_history.length > 0
      ? { body_history: status.body_history }
      : {}),
  };
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

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
