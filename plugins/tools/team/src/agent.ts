/**
 * 0.16 `agent` 工具 + 成员事件/权限桥（DECISION-031 E2–E4）。
 *
 * 模型工具面只保留一个 `agent` schema，动作 spawn / send / close；
 * `send` 入队即返回，不提供 wait / inbox / status / cancel。
 */

import { randomUUID } from 'node:crypto';
import type {
  EventStream,
  LLMProvider,
  PluginHost,
  RunEvent,
  TerminationPolicy,
  ToolContext,
  ToolDefinition,
  Usage,
  UsageLimits,
} from '@vessel-agent/core';
import type { TeamHostPort } from './core-adapter.js';
import type {
  AgentSpec,
  MemberPermissionMode,
  MemberStatus,
  MemberVisibility,
  TeamMessage,
} from './host.js';
import { type MemberRecord, type MemberRegistry, toMemberStatus } from './registry.js';

/** 消息大小上限（DESIGN §7） */
const MAX_MESSAGE_BYTES = 64 * 1024;

const VISIBILITIES: readonly MemberVisibility[] = ['private', 'team', 'tenant'];

/** 类型守卫 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 读字符串参数 */
function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** 从事件 data 读取 requestId（core 交互事件约定字段） */
function readRequestId(data: Record<string, unknown>): string | undefined {
  return typeof data.requestId === 'string' ? data.requestId : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** agent 工具的事件/端口依赖 */
export interface AgentToolOptions {
  port: TeamHostPort;
  registry: MemberRegistry;
  providerFactory: () => LLMProvider;
  model: string;
  ownerId: string;
  tenantId?: string;
  /** 父事件流（UI / owner 观察 agent.* 事件） */
  events: EventStream;
  /** 父事件流与 Host 聚合流是否为同一条；同流时不重复转发原始权限请求 */
  hostEvents: EventStream;
  /** 按权限模式构造成员插件宿主 */
  buildHost: (permissionMode: MemberPermissionMode) => PluginHost;
  defaultVisibility: MemberVisibility;
  permissionMode: MemberPermissionMode;
  memberLimits?: UsageLimits;
  memberTermination?: TerminationPolicy;
}

/** 发布 agent.* 事件（开放字符串，run_id 固定为成员 id） */
function publish(
  events: EventStream,
  type: string,
  memberId: string,
  data: Record<string, unknown>,
  tenantId?: string,
): void {
  events.publish({
    type,
    run_id: memberId,
    data,
    ts: Date.now(),
    ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
  });
}

/** 权限请求 data：补 E4 关联字段；已有字段不覆盖 */
function permissionRequestData(
  data: Record<string, unknown>,
  member: MemberRecord,
): Record<string, unknown> {
  const requestId = readRequestId(data);
  return {
    ...data,
    ...(requestId !== undefined ? { request_id: requestId } : {}),
    agent_id: member.id,
    session_id: typeof data.session_id === 'string' ? data.session_id : member.sessionId,
    ...(member.parentSessionId !== undefined ? { parent_session_id: member.parentSessionId } : {}),
    delegate_path: member.parentId !== undefined ? [member.parentId, member.id] : [member.id],
    state: 'waiting_permission',
  };
}

/** 构造 agent 工具 */
export function makeAgentTool(options: AgentToolOptions): ToolDefinition {
  const { registry } = options;

  async function spawn(args: Record<string, unknown>, ctx: ToolContext): Promise<MemberStatus> {
    const rawVisibility = readString(args, 'visibility');
    if (rawVisibility !== '' && !VISIBILITIES.includes(rawVisibility as MemberVisibility)) {
      throw new Error(`invalid visibility "${rawVisibility}" (expected private|team|tenant)`);
    }
    const visibility = (rawVisibility || options.defaultVisibility) as MemberVisibility;
    const id = randomUUID();
    const name = readString(args, 'name') || undefined;
    const record: MemberRecord = {
      id,
      // session 即成员：默认 1:1，send 也可用 session_id 寻址
      sessionId: id,
      ...(name !== undefined ? { name } : {}),
      parentId: options.ownerId,
      ...(ctx.session_id !== undefined ? { parentSessionId: ctx.session_id } : {}),
      owner: options.ownerId,
      visibility,
      permissionMode: options.permissionMode,
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
      state: 'created',
    };
    registry.add(record);

    const spec: AgentSpec = {
      id,
      sessionId: record.sessionId,
      ...(name !== undefined ? { name } : {}),
      provider: options.providerFactory(),
      model: readString(args, 'model') || options.model,
      pluginHost: options.buildHost(options.permissionMode),
      ...(readString(args, 'system_prompt') !== ''
        ? { systemPrompt: readString(args, 'system_prompt') }
        : {}),
      visibility,
      permissionMode: options.permissionMode,
      parentId: options.ownerId,
      ...(record.parentSessionId !== undefined ? { parentSessionId: record.parentSessionId } : {}),
      owner: options.ownerId,
      ...(options.memberLimits !== undefined ? { limits: options.memberLimits } : {}),
      ...(options.memberTermination !== undefined
        ? { termination: options.memberTermination }
        : {}),
    };

    try {
      await options.port.spawn(spec);
    } catch (error) {
      registry.remove(id);
      throw error;
    }
    registry.setState(id, 'idle');
    const status = toMemberStatus(registry.get(id) ?? record);
    // 同一事件流时 core 已发 agent.spawned，再发会重复计数
    if (options.events !== options.hostEvents) {
      publish(options.events, 'agent.spawned', id, { ...status }, options.tenantId);
    }
    return status;
  }

  async function send(
    args: Record<string, unknown>,
  ): Promise<{ queued: true; message_id: string }> {
    const to = readString(args, 'to');
    const content = readString(args, 'content');
    if (to === '') throw new Error('agent send requires a non-empty to');
    if (content === '') throw new Error('agent send requires a non-empty content');
    if (Buffer.byteLength(content, 'utf8') > MAX_MESSAGE_BYTES) {
      throw new Error(`message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    }

    const target = registry.resolve(to);
    if (!target) throw new Error(`unknown team member: ${to}`);
    if (target.state === 'closed') throw new Error(`member closed: ${to}`);
    if (!registry.canAddress(target, options.ownerId)) {
      throw new Error(`member not visible: ${to}`);
    }

    const message: TeamMessage = {
      id: randomUUID(),
      from: options.ownerId,
      to: target.id,
      kind: 'task',
      content,
      ts: Date.now(),
    };
    await options.port.send(message);
    registry.setState(target.id, 'running');
    publish(
      options.events,
      'agent.message.queued',
      target.id,
      {
        agent_id: target.id,
        message_id: message.id,
        from: message.from,
        to: target.id,
        kind: message.kind,
      },
      options.tenantId,
    );
    return { queued: true, message_id: message.id };
  }

  async function close(args: Record<string, unknown>): Promise<{ state: 'closed' }> {
    const member = readString(args, 'member') || readString(args, 'to');
    if (member === '') throw new Error('agent close requires a non-empty member');
    const target = registry.resolve(member);
    if (!target) throw new Error(`unknown team member: ${member}`);
    if (target.owner !== options.ownerId) throw new Error(`member not visible: ${member}`);
    if (target.state === 'closed') return { state: 'closed' };

    await options.port.closeMember(target.id);
    registry.setState(target.id, 'closed');
    // 同一事件流时 core 已发 agent.closed
    if (options.events !== options.hostEvents) {
      publish(
        options.events,
        'agent.closed',
        target.id,
        { agent_id: target.id, session_id: target.sessionId, state: 'closed' },
        options.tenantId,
      );
    }
    return { state: 'closed' };
  }

  return {
    name: 'agent',
    description:
      'Manage team members. action=spawn creates a member session and returns its status; ' +
      'action=send queues a message to a member and returns immediately (no wait); ' +
      'action=close releases a member (idempotent).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['spawn', 'send', 'close'],
          description: 'spawn | send | close',
        },
        name: { type: 'string', description: 'spawn: display name' },
        model: { type: 'string', description: 'spawn: model override' },
        system_prompt: { type: 'string', description: 'spawn: optional system prompt' },
        visibility: {
          type: 'string',
          enum: ['private', 'team', 'tenant'],
          description: 'spawn: visibility (default private)',
        },
        to: { type: 'string', description: 'send: member id or session id' },
        content: { type: 'string', description: 'send: message text' },
        member: { type: 'string', description: 'close: member id or session id' },
      },
      required: ['action'],
    },
    handler: async (args: unknown, ctx: ToolContext) => {
      const record = isRecord(args) ? args : {};
      const action = readString(record, 'action');
      try {
        if (action === 'spawn') return JSON.stringify(await spawn(record, ctx));
        if (action === 'send') return JSON.stringify(await send(record));
        if (action === 'close') return JSON.stringify(await close(record));
        return 'Error: agent requires action spawn|send|close';
      } catch (error) {
        return `Error: ${errorText(error)}`;
      }
    },
  };
}

/** 成员生命周期/权限事件的观察器依赖 */
export interface AgentObserverOptions {
  registry: MemberRegistry;
  /** 父事件流 */
  events: EventStream;
  /** Host 聚合流（成员事件、交互请求） */
  hostEvents: EventStream;
  tenantId?: string;
}

/**
 * 订阅 Host 聚合流：
 * - `tool.permission.request` / `ask.user.requested` → 补 E4 字段并转发到父事件流；
 * - `agent.run.*` → 成员状态 + `agent.turn.*`；
 * - 父流上的应答 → 回灌 Host 聚合流（同流时由 core 自行路由）。
 *
 * 返回取消订阅函数（供插件 dispose 回收）。
 */
export function installAgentObservers(options: AgentObserverOptions): () => void {
  const { registry, events, hostEvents } = options;
  const sameStream = events === hostEvents;
  const forwarded = new WeakSet<object>();
  /** requestId → memberId；应答后更新状态 */
  const pending = new Map<string, string>();

  const publishTo = (type: string, memberId: string, data: Record<string, unknown>): void => {
    publish(events, type, memberId, data, options.tenantId);
  };

  const unsubscribeHost = hostEvents.subscribe((event) => {
    if (forwarded.has(event)) return;
    const data = isRecord(event.data) ? event.data : {};

    if (event.type === 'tool.permission.request' || event.type === 'ask.user.requested') {
      const memberId = typeof data.agentId === 'string' ? data.agentId : undefined;
      if (memberId === undefined) return;
      const member = registry.get(memberId);
      if (member === undefined || member.permissionMode !== 'bridge' || member.state === 'closed') {
        return;
      }

      const requestId = readRequestId(data);
      if (requestId !== undefined) pending.set(requestId, memberId);
      registry.setState(
        memberId,
        'waiting_permission',
        typeof data.tool === 'string' ? data.tool : undefined,
      );
      const enriched = permissionRequestData(data, member);
      publishTo('agent.permission.requested', memberId, enriched);
      // 同流时 core 已把原始请求送到父流；再发一次会让 UI 出现两张卡片。
      if (!sameStream) {
        const copy: RunEvent = { ...event, data: enriched };
        forwarded.add(copy);
        events.publish(copy);
      }
      return;
    }

    if (event.type === 'agent.run.started') {
      const memberId = typeof data.agentId === 'string' ? data.agentId : undefined;
      const member = memberId !== undefined ? registry.get(memberId) : undefined;
      if (memberId === undefined || member === undefined || member.state === 'closed') return;
      registry.setState(memberId, 'running');
      publishTo('agent.turn.started', memberId, {
        agent_id: memberId,
        run_id: data.runId,
        session_id: data.sessionId ?? member.sessionId,
      });
      return;
    }

    if (
      event.type === 'agent.run.completed' ||
      event.type === 'agent.run.failed' ||
      event.type === 'agent.run.cancelled'
    ) {
      const memberId = typeof data.agentId === 'string' ? data.agentId : undefined;
      const member = memberId !== undefined ? registry.get(memberId) : undefined;
      // close 后到达的 run 终态不得把 closed 状态覆盖掉
      if (memberId === undefined || member === undefined || member.state === 'closed') return;
      const failed = event.type === 'agent.run.failed';
      const cancelled = event.type === 'agent.run.cancelled';
      registry.setState(memberId, failed ? 'failed' : cancelled ? 'cancelled' : 'completed');
      const type = failed
        ? 'agent.turn.failed'
        : cancelled
          ? 'agent.turn.cancelled'
          : 'agent.turn.completed';
      publishTo(type, memberId, {
        agent_id: memberId,
        run_id: data.runId,
        session_id: data.sessionId ?? member.sessionId,
        ...(failed && typeof data.error === 'string' ? { error: data.error } : {}),
      });
      return;
    }

    if (event.type === 'run.completed' && isRecord(data.usage)) {
      const memberId = typeof data.agentId === 'string' ? data.agentId : undefined;
      if (memberId !== undefined) registry.setUsage(memberId, data.usage as unknown as Usage);
    }
  });

  const unsubscribeParent = events.subscribe((event) => {
    if (forwarded.has(event)) return;
    if (event.type !== 'tool.permission.response' && event.type !== 'ask.user.answered') return;
    const data = isRecord(event.data) ? { ...event.data } : { value: event.data };
    const requestId = readRequestId(data);
    const memberId = requestId !== undefined ? pending.get(requestId) : undefined;
    if (requestId !== undefined) pending.delete(requestId);
    if (memberId !== undefined) {
      registry.setState(memberId, 'running');
      publishTo('agent.permission.responded', memberId, {
        ...data,
        ...(requestId !== undefined ? { request_id: requestId } : {}),
        agent_id: memberId,
      });
    }
    if (!sameStream) {
      const copy: RunEvent = { ...event };
      forwarded.add(copy);
      hostEvents.publish(copy);
    }
  });

  return () => {
    unsubscribeHost();
    unsubscribeParent();
  };
}
