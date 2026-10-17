/**
 * TeamHostPort —— team 工具依赖的插件内端口。
 *
 * 两个实现：
 * - CoreHostAdapter：包装 core `RuntimeHost` / `AgentHandle`（0.2 首选）
 * - LegacyHostAdapter：包装插件旧 `RuntimeHost`（0.1 兼容，@deprecated）
 *
 * 端口只服务于插件内部，**不是**平台扩展机制；对外工具面保持不变。
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentHandle as CoreAgentHandle,
  AgentMessage as CoreAgentMessage,
  AgentSpec as CoreAgentSpec,
  AgentStatus as CoreAgentStatus,
  InboxPage as CoreInboxPage,
  RunHandle as CoreRunHandle,
  RuntimeHost as CoreRuntimeHost,
  EventStream,
  Usage,
} from '@vessel/core';
import type {
  AgentSpec,
  AgentStatus,
  InboxPage,
  RuntimeHost as LegacyRuntimeHost,
  TeamMessage,
} from './host.js';

/** team 工具依赖的端口（与 0.1 插件 RuntimeHost 同形） */
export interface TeamHostPort {
  spawn(spec: AgentSpec): Promise<AgentStatus>;
  send(message: TeamMessage): Promise<void>;
  inbox(id: string, cursor?: string): Promise<InboxPage>;
  cancel(id: string): Promise<void>;
  status(id?: string): Promise<AgentStatus | AgentStatus[]>;
  close(): Promise<void>;
}

/** 旧 AgentSpec → core AgentSpec（legacy limits 映射到 run 级） */
function toCoreSpec(spec: AgentSpec): CoreAgentSpec {
  return {
    ...(spec.id !== undefined ? { id: spec.id } : {}),
    ...(spec.name !== undefined ? { name: spec.name } : {}),
    provider: spec.provider,
    model: spec.model,
    pluginHost: spec.pluginHost,
    ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.limits !== undefined ? { limits: { run: spec.limits } } : {}),
    ...(spec.termination !== undefined ? { termination: spec.termination } : {}),
  };
}

/** core AgentStatus → 0.1 输出形状（丢弃 currentRunId 等新增字段，保持输出兼容） */
function toLegacyStatus(status: CoreAgentStatus): AgentStatus {
  return {
    id: status.id,
    ...(status.name !== undefined ? { name: status.name } : {}),
    state: status.state,
    toolNames: status.toolNames,
    ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
  };
}

/** 旧 TeamMessage → core AgentMessage（reply_to → replyTo） */
function toCoreMessage(message: TeamMessage): CoreAgentMessage {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    kind: message.kind,
    content: message.content,
    ...(message.reply_to !== undefined ? { replyTo: message.reply_to } : {}),
    ts: message.ts,
  };
}

/** core AgentMessage → 旧 TeamMessage（replyTo → reply_to，对外 JSON 不变） */
function toLegacyMessage(message: CoreAgentMessage): TeamMessage {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    kind: message.kind as TeamMessage['kind'],
    content: message.content,
    ...(message.replyTo !== undefined ? { reply_to: message.replyTo } : {}),
    ts: message.ts,
  };
}

/** 错误文本提取 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * core Host 适配器。
 * 成员注册/调度/消息由 core 负责；这里只做 0.1 工具面的形状映射与 task 结果回投。
 */
export class CoreHostAdapter implements TeamHostPort {
  private readonly handles = new Map<string, CoreAgentHandle>();
  private readonly legacyEvents?: EventStream;

  constructor(
    private readonly host: CoreRuntimeHost,
    options: { events?: EventStream } = {},
  ) {
    this.legacyEvents = options.events;
  }

  async spawn(spec: AgentSpec): Promise<AgentStatus> {
    const handle = await this.host.spawn(toCoreSpec(spec));
    this.handles.set(handle.id, handle);
    const status = handle.status();
    this.publish('team.member.spawned', {
      memberId: handle.id,
      ...(status.name !== undefined ? { name: status.name } : {}),
    });
    return toLegacyStatus(status);
  }

  async send(message: TeamMessage): Promise<void> {
    if (message.to === '*') {
      await this.host.send(toCoreMessage(message));
      for (const status of this.host.list()) {
        if (status.id === message.from) continue;
        this.publish('team.message.sent', {
          messageId: message.id,
          from: message.from,
          to: status.id,
          kind: message.kind,
        });
        if (message.kind === 'task') {
          const handle = this.host.get(status.id);
          if (handle) void this.processTask(handle, message);
        }
      }
      return;
    }

    const target = this.host.get(message.to);
    if (!target) throw new Error(`unknown team member: ${message.to}`);

    await this.host.send(toCoreMessage(message));
    this.publish('team.message.sent', {
      messageId: message.id,
      from: message.from,
      to: target.id,
      kind: message.kind,
    });
    if (message.kind === 'task') void this.processTask(target, message);
  }

  async inbox(id: string, cursor?: string): Promise<InboxPage> {
    const page: CoreInboxPage = await this.host.inbox(id, cursor);
    return { messages: page.messages.map(toLegacyMessage), cursor: page.cursor };
  }

  async cancel(id: string): Promise<void> {
    const handle = this.host.get(id);
    if (!handle) throw new Error(`unknown team member: ${id}`);
    handle.cancel();
  }

  async status(id?: string): Promise<AgentStatus | AgentStatus[]> {
    if (id !== undefined) {
      const handle = this.host.get(id);
      if (!handle) throw new Error(`unknown team member: ${id}`);
      return toLegacyStatus(handle.status());
    }
    return this.host.list().map(toLegacyStatus);
  }

  async close(): Promise<void> {
    this.handles.clear();
    await this.host.close();
  }

  /** 异步执行一条 task，并把结果投回发送者 */
  private async processTask(handle: CoreAgentHandle, request: TeamMessage): Promise<void> {
    let run: CoreRunHandle;
    try {
      run = await handle.run(request.content);
    } catch (error) {
      const text = errorText(error);
      // R1 单成员串行：已有 run 时与 0.1 一致——不排队、不投递（R2 队列接管）
      if (text.includes('already has a running run')) return;
      this.deliverResult(handle.id, request, `Error: ${text}`, true);
      this.publish('team.run.failed', {
        memberId: handle.id,
        messageId: request.id,
        error: text,
      });
      return;
    }

    this.publish('team.run.started', { memberId: handle.id, messageId: request.id });
    try {
      const text = await run.result;
      this.deliverResult(handle.id, request, text, false);
      this.publish('team.run.completed', {
        memberId: handle.id,
        messageId: request.id,
        runId: run.id,
        ...(run.usage() !== undefined ? { usage: run.usage() as Usage } : {}),
      });
    } catch (error) {
      const text = errorText(error);
      this.deliverResult(handle.id, request, `Error: ${text}`, true);
      this.publish('team.run.failed', {
        memberId: handle.id,
        messageId: request.id,
        runId: run.id,
        error: text,
      });
    }
  }

  /** 结果投回发送者（owner 可以不是成员，core 支持非成员邮箱） */
  private async deliverResult(
    fromId: string,
    request: TeamMessage,
    content: string,
    failed: boolean,
  ): Promise<void> {
    try {
      await this.host.send({
        id: randomUUID(),
        from: fromId,
        to: request.from,
        kind: 'result',
        content,
        replyTo: request.id,
        ts: Date.now(),
      });
    } catch {
      // 发送者地址不可达（例如跨进程未注入 transport）：结果丢弃，不影响成员状态
    }
    this.publish('team.message.received', {
      messageId: request.id,
      from: fromId,
      to: request.from,
      failed,
    });
  }

  /** 发布 team.* 事件：优先发到旧事件流，否则进 Host 聚合流 */
  private publish(type: string, data: Record<string, unknown>): void {
    const runId =
      typeof data.runId === 'string'
        ? data.runId
        : typeof data.memberId === 'string'
          ? data.memberId
          : 'team';
    const event = { type, run_id: runId, data, ts: Date.now() };
    if (this.legacyEvents) {
      this.legacyEvents.publish(event);
    } else {
      this.host.events.publish(event);
    }
  }
}

/** 旧 RuntimeHost → TeamHostPort（0.1 兼容路径，@deprecated） */
export class LegacyHostAdapter implements TeamHostPort {
  constructor(private readonly host: LegacyRuntimeHost) {}

  spawn(spec: AgentSpec): Promise<AgentStatus> {
    return this.host.spawn(spec);
  }

  send(message: TeamMessage): Promise<void> {
    return this.host.send(message);
  }

  inbox(id: string, cursor?: string): Promise<InboxPage> {
    return this.host.inbox(id, cursor);
  }

  cancel(id: string): Promise<void> {
    return this.host.cancel(id);
  }

  status(id?: string): Promise<AgentStatus | AgentStatus[]> {
    return this.host.status(id);
  }

  close(): Promise<void> {
    return this.host.close();
  }
}
