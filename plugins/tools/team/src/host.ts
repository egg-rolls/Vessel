/**
 * team 插件旧宿主契约 + 0.1 兼容适配层。
 *
 * 0.2 起 core `RuntimeHost` 是唯一宿主实现；本文件只保留公开类型与
 * `InProcessRuntimeHost` 兼容壳（内部包装 core Host）。
 *
 * @deprecated 0.3 移除本文件中的 RuntimeHost / InProcessRuntimeHost。
 */

import type {
  RuntimeHost as CoreRuntimeHost,
  EventStream,
  LLMProvider,
  PluginHost,
  TerminationPolicy,
  UsageLimits,
} from '@vessel/core';
import { InProcessRuntimeHost as CoreInProcessRuntimeHost } from '@vessel/core';
import { CoreHostAdapter, type TeamHostPort } from './core-adapter.js';

/** 成员状态 */
export type AgentState = 'idle' | 'running' | 'cancelled' | 'error' | 'closed';

/** 消息类型（team 语义由插件声明；core 的 kind 是开放 string） */
export type TeamMessageKind = 'message' | 'task' | 'result' | 'cancel';

/** 成员消息（对外 JSON 字段保持 0.1：reply_to 为 snake_case） */
export interface TeamMessage {
  id: string;
  from: string;
  to: string | '*';
  kind: TeamMessageKind;
  content: string;
  reply_to?: string;
  ts: number;
}

/** spawn 规格（0.1 形状；适配层翻译成 core AgentSpec） */
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

/** 成员状态视图（保持 0.1 字段，不暴露 currentRunId） */
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
 * 插件旧 RuntimeHost 形状。
 * @deprecated 使用 core `RuntimeHost`；0.3 移除。
 */
export interface RuntimeHost {
  spawn(spec: AgentSpec): Promise<AgentStatus>;
  send(message: TeamMessage): Promise<void>;
  inbox(id: string, cursor?: string): Promise<InboxPage>;
  cancel(id: string): Promise<void>;
  status(id?: string): Promise<AgentStatus | AgentStatus[]>;
  close(): Promise<void>;
}

/** 兼容层构造选项（加法：可注入 core Host） */
export interface InProcessRuntimeHostOptions {
  /** 旧事件流：team.* 事件发布到这里 */
  events?: EventStream;
  /** 成员上限（默认 8） */
  maxMembers?: number;
  /** 注入 core Host；缺省新建 core InProcessRuntimeHost */
  host?: CoreRuntimeHost;
}

/**
 * 0.1 兼容宿主：内部就是 core Host 的适配器。
 *
 * @deprecated Use core `RuntimeHost`; removed in 0.3.
 * 构造函数保留 0.1 形状；所有调用转给 `CoreHostAdapter`。
 */
export class InProcessRuntimeHost implements RuntimeHost {
  private readonly port: TeamHostPort;

  constructor(options: InProcessRuntimeHostOptions = {}) {
    const ownsHost = options.host === undefined;
    const host =
      options.host ??
      new CoreInProcessRuntimeHost({
        maxMembers: options.maxMembers,
      });
    this.port = new CoreHostAdapter(host, { events: options.events, ownsHost });
  }

  spawn(spec: AgentSpec): Promise<AgentStatus> {
    return this.port.spawn(spec);
  }

  send(message: TeamMessage): Promise<void> {
    return this.port.send(message);
  }

  deliver(message: TeamMessage): Promise<void> {
    return this.port.deliver(message);
  }

  inbox(id: string, cursor?: string): Promise<InboxPage> {
    return this.port.inbox(id, cursor);
  }

  cancel(id: string): Promise<void> {
    return this.port.cancel(id);
  }

  status(id?: string): Promise<AgentStatus | AgentStatus[]> {
    return this.port.status(id);
  }

  close(): Promise<void> {
    return this.port.close();
  }
}
