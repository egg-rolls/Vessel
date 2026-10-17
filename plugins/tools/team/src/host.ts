/**
 * Team 的最小 runtime host 契约 + 进程内实现。
 *
 * 这是 0.1.0 原型：只依赖 DECISION-002 允许的最小形状
 * spawn / send / inbox / cancel / status，不把 AgentRuntime 的内部细节固化进接口。
 * 0.2 由 core 的一等 RuntimeHost 替换本实现的适配层，工具面保持不变。
 */

import { randomUUID } from 'node:crypto';
import type {
  EventStream,
  LLMProvider,
  PluginHost,
  TerminationPolicy,
  UsageLimits,
} from '@vessel/core';
import { AgentRuntime, MemoryContextManager, MemoryEventStream } from '@vessel/core';

/** 成员状态 */
export type AgentState = 'idle' | 'running' | 'cancelled' | 'error' | 'closed';

/** 消息类型 */
export type TeamMessageKind = 'message' | 'task' | 'result' | 'cancel';

/** 成员消息 */
export interface TeamMessage {
  id: string;
  from: string;
  to: string | '*';
  kind: TeamMessageKind;
  content: string;
  reply_to?: string;
  ts: number;
}

/** spawn 规格 */
export interface AgentSpec {
  id?: string;
  name?: string;
  provider: LLMProvider;
  model: string;
  pluginHost: PluginHost;
  systemPrompt?: string;
  limits?: UsageLimits;
  termination?: TerminationPolicy;
}

/** 成员状态视图 */
export interface AgentStatus {
  id: string;
  name?: string;
  state: AgentState;
  toolNames: string[];
  lastError?: string;
}

/** 收件箱分页 */
export interface InboxPage {
  messages: TeamMessage[];
  cursor: string;
}

/**
 * 最小 RuntimeHost 形状（DECISION-002 §4.2）。
 * 只暴露成员生命周期与消息，不暴露 runtime 内部对象。
 */
export interface RuntimeHost {
  spawn(spec: AgentSpec): Promise<AgentStatus>;
  send(message: TeamMessage): Promise<void>;
  inbox(id: string, cursor?: string): Promise<InboxPage>;
  cancel(id: string): Promise<void>;
  status(id?: string): Promise<AgentStatus | AgentStatus[]>;
  close(): Promise<void>;
}

/** 进程内实现选项 */
export interface InProcessRuntimeHostOptions {
  /** 观测事件流（团队事件发布到这里） */
  events?: EventStream;
  /** 成员上限（默认 8） */
  maxMembers?: number;
}

/** 成员记录（内部） */
interface AgentRecord {
  id: string;
  name?: string;
  spec: AgentSpec;
  runtime: AgentRuntime;
  events: MemoryEventStream;
  state: AgentState;
  inbox: TeamMessage[];
  controller?: AbortController;
  lastError?: string;
}

/** 进程内 RuntimeHost：每个成员一个 AgentRuntime + 独立 context */
export class InProcessRuntimeHost implements RuntimeHost {
  private readonly members = new Map<string, AgentRecord>();
  /** 非成员收件箱（例如 owner）：只收结果，不承载 runtime */
  private readonly extraInboxes = new Map<string, TeamMessage[]>();
  private readonly events: EventStream | undefined;
  private readonly maxMembers: number;

  constructor(options: InProcessRuntimeHostOptions = {}) {
    this.events = options.events;
    this.maxMembers = options.maxMembers ?? 8;
  }

  async spawn(spec: AgentSpec): Promise<AgentStatus> {
    if (this.members.size >= this.maxMembers) {
      throw new Error(`team member limit reached (max ${this.maxMembers})`);
    }
    const id = spec.id ?? randomUUID();
    if (this.members.has(id)) throw new Error(`team member already exists: ${id}`);

    const events = new MemoryEventStream();
    const runtime = await AgentRuntime.create({
      provider: spec.provider,
      model: spec.model,
      context: new MemoryContextManager(),
      events,
      pluginHost: spec.pluginHost,
      limits: spec.limits ?? {},
      termination: spec.termination ?? { maxIterations: 10, maxRuntimeSeconds: 60 },
      systemPrompt: spec.systemPrompt,
    });

    const record: AgentRecord = {
      id,
      name: spec.name,
      spec,
      runtime,
      events,
      state: 'idle',
      inbox: [],
    };
    this.members.set(id, record);

    this.publish('team.member.spawned', { memberId: id, name: spec.name });
    return this.toStatus(record);
  }

  async send(message: TeamMessage): Promise<void> {
    const targets =
      message.to === '*'
        ? [...this.members.values()].filter((member) => member.id !== message.from)
        : [this.requireMember(message.to)];

    for (const target of targets) {
      target.inbox.push(message);
      this.publish('team.message.sent', {
        messageId: message.id,
        from: message.from,
        to: target.id,
        kind: message.kind,
      });
      if (message.kind === 'task') void this.processTask(target, message);
    }
  }

  async inbox(id: string, cursor?: string): Promise<InboxPage> {
    const inbox = this.inboxFor(id);
    const start = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0);
    return {
      messages: inbox.slice(start),
      cursor: String(inbox.length),
    };
  }

  async cancel(id: string): Promise<void> {
    const member = this.requireMember(id);
    member.controller?.abort(new Error('team member cancelled'));
    member.state = 'cancelled';
  }

  async status(id?: string): Promise<AgentStatus | AgentStatus[]> {
    if (id !== undefined) return this.toStatus(this.requireMember(id));
    return [...this.members.values()].map((member) => this.toStatus(member));
  }

  async close(): Promise<void> {
    for (const member of this.members.values()) {
      member.controller?.abort(new Error('team host closed'));
      member.runtime.dispose();
      member.state = 'closed';
    }
    this.members.clear();
  }

  /** 异步执行一条 task，并把结果投回发送者 */
  private async processTask(member: AgentRecord, message: TeamMessage): Promise<void> {
    if (member.state === 'running') return;

    const controller = new AbortController();
    member.controller = controller;
    member.state = 'running';
    this.publish('team.run.started', { memberId: member.id, messageId: message.id });

    try {
      const text = await member.runtime.run(message.content, undefined, {
        signal: controller.signal,
      });
      this.pushResult(member, message, text, false);
      member.state = controller.signal.aborted ? 'cancelled' : 'idle';
      this.publish('team.run.completed', { memberId: member.id, messageId: message.id });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      member.lastError = messageText;
      member.state = controller.signal.aborted ? 'cancelled' : 'error';
      this.pushResult(member, message, `Error: ${messageText}`, true);
      this.publish('team.run.failed', {
        memberId: member.id,
        messageId: message.id,
        error: messageText,
      });
    } finally {
      member.controller = undefined;
    }
  }

  /** 把结果投回发送者（owner 可以不是成员，用独立收件箱） */
  private pushResult(
    member: AgentRecord,
    request: TeamMessage,
    content: string,
    failed: boolean,
  ): void {
    this.inboxFor(request.from).push({
      id: randomUUID(),
      from: member.id,
      to: request.from,
      kind: 'result',
      content,
      reply_to: request.id,
      ts: Date.now(),
    });
    this.publish('team.message.received', {
      messageId: request.id,
      from: member.id,
      to: request.from,
      failed,
    });
  }

  /** 取收件箱：成员优先，其次非成员收件箱（owner） */
  private inboxFor(id: string): TeamMessage[] {
    const member = this.members.get(id);
    if (member) return member.inbox;
    let inbox = this.extraInboxes.get(id);
    if (!inbox) {
      inbox = [];
      this.extraInboxes.set(id, inbox);
    }
    return inbox;
  }

  /** 取成员，不存在则抛错 */
  private requireMember(id: string): AgentRecord {
    const member = this.members.get(id);
    if (!member) throw new Error(`unknown team member: ${id}`);
    return member;
  }

  /** 状态视图 */
  private toStatus(member: AgentRecord): AgentStatus {
    const status: AgentStatus = {
      id: member.id,
      state: member.state,
      toolNames: member.spec.pluginHost.listTools().map((tool) => tool.name),
    };
    if (member.name !== undefined) status.name = member.name;
    if (member.lastError !== undefined) status.lastError = member.lastError;
    return status;
  }

  /** 发布团队事件（未注入事件流时静默） */
  private publish(type: string, data: Record<string, unknown>): void {
    this.events?.publish({
      type,
      run_id: typeof data.memberId === 'string' ? data.memberId : 'team',
      data,
      ts: Date.now(),
    });
  }
}
