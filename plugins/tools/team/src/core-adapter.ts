/**
 * TeamHostPort —— team 工具依赖的插件内端口。
 *
 * 唯一实现：CoreHostAdapter，包装 core `RuntimeHost` / `AgentHandle`。
 * 0.1 的 LegacyHostAdapter 已在 0.3 移除（ADR-037）。
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
import type { AgentSpec, AgentStatus, InboxPage, TeamMessage } from './host.js';

/** team 工具依赖的端口（与 0.1 插件 RuntimeHost 同形） */
export interface TeamHostPort {
  /** node 由路由层消费；本机适配器忽略。0.6 additive */
  spawn(spec: AgentSpec, node?: string): Promise<AgentStatus>;
  send(message: TeamMessage): Promise<void>;
  /** 直接投递到邮箱（不做成员校验；用于结果/外部消息） */
  deliver(message: TeamMessage): Promise<void>;
  inbox(id: string, cursor?: string): Promise<InboxPage>;
  cancel(id: string): Promise<void>;
  /** node 省略时为本机；node 存在且成员 id 为本机简写时按该节点解析。0.6 additive */
  status(id?: string, node?: string): Promise<AgentStatus | AgentStatus[]>;
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
export function toCoreMessage(message: TeamMessage): CoreAgentMessage {
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
export function toLegacyMessage(message: CoreAgentMessage): TeamMessage {
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
  private readonly tenantId?: string;
  /** 是否拥有 host 的生命周期：注入的共享 Host 不能被插件关闭 */
  private readonly ownsHost: boolean;
  /** 结果投递钩子：跨进程路由时替换默认的本地 Host.send */
  private readonly deliverResultHook?: (message: TeamMessage) => Promise<void>;

  constructor(
    private readonly host: CoreRuntimeHost,
    options: {
      events?: EventStream;
      ownsHost?: boolean;
      deliverResult?: (message: TeamMessage) => Promise<void>;
      tenantId?: string;
    } = {},
  ) {
    this.legacyEvents = options.events;
    this.ownsHost = options.ownsHost ?? false;
    this.deliverResultHook = options.deliverResult;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
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

  /** 直接投递到任意邮箱（含 owner 等非成员），不触发 task 执行 */
  async deliver(message: TeamMessage): Promise<void> {
    await this.host.send(toCoreMessage(message));
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
    if (this.ownsHost) {
      this.handles.clear();
      await this.host.close();
      return;
    }
    // 共享 Host（asm 注入的 owner Host）：只关闭本适配器创建的成员，不关闭整个 Host
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.allSettled(handles.map((handle) => handle.close()));
  }

  /** 异步执行一条 task，并把结果投回发送者 */
  private async processTask(handle: CoreAgentHandle, request: TeamMessage): Promise<void> {
    let run: CoreRunHandle;
    try {
      run = await handle.run(request.content);
    } catch (error) {
      // R2：busy 由 Scheduler 排队；这里只处理真正的提交失败（如 queue full）
      const text = errorText(error);
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
    const result: TeamMessage = {
      id: randomUUID(),
      from: fromId,
      to: request.from,
      kind: 'result',
      content,
      reply_to: request.id,
      ts: Date.now(),
    };
    try {
      if (this.deliverResultHook) {
        await this.deliverResultHook(result);
      } else {
        await this.host.send(toCoreMessage(result));
      }
    } catch (error) {
      // 发送者地址不可达（例如跨进程 transport 失败）：结果丢弃，不影响成员状态。
      // 0.6：用既有 team.transport.error 暴露，父端可通过 inbox/status 对账。
      const code =
        error !== null &&
        typeof error === 'object' &&
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'peer_unreachable';
      this.publish('team.transport.error', {
        code,
        message: errorText(error),
        messageId: result.id,
        replyTo: request.id,
        from: result.from,
        to: result.to,
        ...(result.to.includes(':') ? { nodeId: result.to.split(':')[0] } : {}),
        failed,
      });
    }
    this.publish('team.message.received', {
      messageId: request.id,
      from: fromId,
      to: request.from,
      failed,
    });
  }

  /**
   * 发布 team.* 事件：始终进 core Host 聚合流（gateway/owner 观察），
   * 另给的 legacy 事件流不是同一对象时再镜像一份，避免重复。
   */
  private publish(type: string, data: Record<string, unknown>): void {
    const runId =
      typeof data.runId === 'string'
        ? data.runId
        : typeof data.memberId === 'string'
          ? data.memberId
          : 'team';
    const event = {
      type,
      run_id: runId,
      data,
      ts: Date.now(),
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    };
    this.host.events.publish(event);
    if (this.legacyEvents !== undefined && this.legacyEvents !== this.host.events) {
      this.legacyEvents.publish(event);
    }
  }
}
