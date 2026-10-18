/**
 * 专用 Host 与 per-chat 成员生命周期（Addendum B §11.3.1-11.3.4）。
 *
 * - 不占用主 Host；成员 sessionId = <prefix>:<chat_id>；
 * - 每个 chat 懒 spawn 一个成员，复用到 stop()；
 * - 达到 max_members 后新 chat 返回 MemberLimitError（渠道回 busy，不逐出）。
 */

import {
  type AgentHandle,
  type EventStream,
  InProcessRuntimeHost,
  type LLMProvider,
  type PluginHost,
  type RunStore,
  type SessionBackend,
} from '@vessel/core';
import { fallbackAgentId, maskSecrets, sanitizeAgentId } from './config.js';
import type { ResolvedFeishuConfig } from './types.js';

export class MemberLimitError extends Error {
  constructor() {
    super('feishu member limit reached');
    this.name = 'MemberLimitError';
  }
}

export interface ChatMemberRunnerOptions {
  config: ResolvedFeishuConfig;
  events: EventStream;
  provider: LLMProvider;
  model: string;
  pluginHost: PluginHost;
  session: SessionBackend;
  contextFactory?: () => import('@vessel/core').ContextManager;
  runStore?: RunStore;
  maxConcurrency?: number;
  maxQueueSize?: number;
  perAgentSerial?: boolean;
}

export class ChatMemberRunner {
  private readonly host: InProcessRuntimeHost;
  private readonly members = new Map<string, string>();
  private readonly usedAgentIds = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly options: ChatMemberRunnerOptions) {
    const schedulerOptions: {
      maxConcurrency?: number;
      maxQueueSize?: number;
      perAgentSerial?: boolean;
    } = {};
    if (options.maxConcurrency !== undefined)
      schedulerOptions.maxConcurrency = options.maxConcurrency;
    if (options.maxQueueSize !== undefined) schedulerOptions.maxQueueSize = options.maxQueueSize;
    if (options.perAgentSerial !== undefined)
      schedulerOptions.perAgentSerial = options.perAgentSerial;

    this.host = new InProcessRuntimeHost({
      pluginHost: options.pluginHost,
      session: options.session,
      ...(options.contextFactory ? { contextFactory: options.contextFactory } : {}),
      ...(options.runStore ? { runStore: options.runStore } : {}),
      ...(Object.keys(schedulerOptions).length > 0 ? { schedulerOptions } : {}),
      defaults: {
        provider: options.provider,
        model: options.model,
        pluginHost: options.pluginHost,
      },
      maxMembers: options.config.maxMembers,
    });

    // 把专用 Host 的聚合事件转发到注入的 events（metrics / TUI / gateway）。
    this.unsubscribe = this.host.events.subscribe((event) => {
      options.events.publish(event);
    });
  }

  get memberCount(): number {
    return this.members.size;
  }

  /** 确保 chat 有成员；达到上限返回 MemberLimitError。 */
  async ensureMember(chatId: string): Promise<string> {
    const existing = this.members.get(chatId);
    if (existing !== undefined) return existing;

    const agentId = this.pickAgentId(chatId);
    const sessionId = `${this.options.config.sessionPrefix}:${chatId}`;

    try {
      await this.host.spawn({
        id: agentId,
        name: `feishu:${chatId}`,
        provider: this.options.provider,
        model: this.options.model,
        pluginHost: this.options.pluginHost,
        sessionId,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('agent limit reached')) {
        throw new MemberLimitError();
      }
      throw error;
    }

    this.members.set(chatId, agentId);
    this.usedAgentIds.add(agentId);
    return agentId;
  }

  async run(chatId: string, text: string, signal: AbortSignal): Promise<string> {
    const agentId = await this.ensureMember(chatId);
    const handle: AgentHandle | undefined = this.host.get(agentId);
    if (!handle) throw new Error(`feishu member "${agentId}" is not available`);
    const run = await handle.run(text, { signal });
    return await run.result;
  }

  async stop(): Promise<void> {
    this.unsubscribe();
    await this.host.close();
    this.members.clear();
    this.usedAgentIds.clear();
  }

  /** 诊断/测试：把错误文本中的凭据脱敏。 */
  sanitize(text: string): string {
    return maskSecrets(text, this.options.config.appId, this.options.config.appSecret);
  }

  private pickAgentId(chatId: string): string {
    const primary = sanitizeAgentId(chatId);
    if (!this.usedAgentIds.has(primary)) return primary;
    const fallback = fallbackAgentId(chatId);
    if (!this.usedAgentIds.has(fallback)) return fallback;
    let index = 2;
    while (this.usedAgentIds.has(`${fallback}_${index}`)) index += 1;
    return `${fallback}_${index}`.slice(0, 64);
  }
}
