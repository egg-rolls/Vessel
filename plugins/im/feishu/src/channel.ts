/**
 * 飞书渠道：WebSocket 长连接、文本消息、per-chat 串行队列、AgentService 执行面。
 */

import type { PluginHost } from '@vessel-agent/core';
import { maskAppId, maskSecrets, resolveFeishuConfig } from './config.js';
import { LruSet } from './dedupe.js';
import { FeishuError } from './errors.js';
import { PerChatQueues } from './queue.js';
import { ChatMemberRunner, MemberLimitError } from './runner.js';
import { createSdkTransport } from './sdk-transport.js';
import { extractText, truncateReply } from './text.js';
import type {
  FeishuIncomingMessage,
  FeishuPlugin,
  FeishuPluginOptions,
  FeishuStatus,
  FeishuTransport,
  ResolvedFeishuConfig,
} from './types.js';

export const FEISHU_QUEUE_LIMIT = 10;
export const FEISHU_DEDUPE_SIZE = 1000;
export const FEISHU_DEFAULT_MAX_MEMBERS = 8;

export const BUSY_REPLY_TEXT = 'busy';
export const TIMEOUT_REPLY_TEXT = 'Request timed out.';
export const ERROR_REPLY_TEXT = 'Request failed.';

const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFeishuPlugin(options: FeishuPluginOptions): FeishuPlugin {
  return new FeishuChannelImpl(options);
}

class FeishuChannelImpl implements FeishuPlugin {
  readonly name = 'feishu';
  readonly version = '0.3.0';
  readonly description = 'Feishu WebSocket channel (text only, per-chat sessions)';

  private readonly config: ResolvedFeishuConfig;
  private readonly options: FeishuPluginOptions;
  private readonly tenantId?: string;
  private readonly transport: FeishuTransport;
  private readonly queues: PerChatQueues;
  private readonly dedupe = new LruSet(FEISHU_DEDUPE_SIZE);
  private readonly controllers = new Map<string, AbortController>();

  private runner?: ChatMemberRunner;
  private connected = false;
  private started = false;
  private stopping = false;
  private lastError?: string;

  constructor(options: FeishuPluginOptions) {
    this.options = options;
    if (options.tenantId !== undefined) {
      if (!TENANT_ID_RE.test(options.tenantId)) {
        throw new FeishuError(
          'channel_auth_failed',
          `invalid tenant id "${options.tenantId}"`,
          'config',
        );
      }
      this.tenantId = options.tenantId;
    }
    this.config = resolveFeishuConfig(options.config, options.env);
    this.transport =
      options.transport ??
      createSdkTransport({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        domain: this.config.domain,
      });
    this.queues = new PerChatQueues(FEISHU_QUEUE_LIMIT);
  }

  /** 不向 PluginHost 注册工具。 */
  install(_host: PluginHost): void {
    // no-op
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.config.enabled) {
      throw new FeishuError('channel_disabled', 'feishu channel is disabled', 'config');
    }
    if (this.config.appId === '' || this.config.appSecret === '') {
      throw new FeishuError('channel_auth_failed', 'feishu app id/secret is required', 'config');
    }
    // 0.27：执行面只走注入的 AgentService；装配层尚未接线时显式失败，禁止静默降级。
    if (!this.options.service) {
      throw new FeishuError(
        'channel_auth_failed',
        'feishu requires an injected AgentService (options.service); the assembly layer must wire it',
        'config',
      );
    }

    this.runner = new ChatMemberRunner({
      config: this.config,
      events: this.options.events,
      service: this.options.service,
      ...(this.options.cancelRun !== undefined ? { cancelRun: this.options.cancelRun } : {}),
    });

    try {
      await this.transport.start({
        onMessage: (message) => {
          void this.handleMessage(message);
        },
        onConnected: () => {
          this.setConnected(true);
        },
        onDisconnected: (reason) => {
          const detail = reason === undefined ? undefined : this.sanitize(reason);
          if (detail !== undefined) this.lastError = detail;
          this.setConnected(false, detail);
        },
        onError: (error) => {
          this.recordError(error);
        },
      });
      this.started = true;
      this.setConnected(true);
    } catch (error) {
      await this.runner.stop().catch(() => undefined);
      this.runner = undefined;
      const message = this.sanitize(errorMessage(error));
      this.lastError = message;
      throw new FeishuError('channel_auth_failed', message, 'runtime');
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const wasConnected = this.connected;

    try {
      this.connected = false;
      for (const controller of this.controllers.values()) {
        controller.abort(new Error('feishu stopped'));
      }
      this.controllers.clear();
      this.queues.clear();

      await this.transport.stop().catch((error) => {
        this.recordError(error);
      });
      await this.runner?.stop().catch((error) => {
        this.recordError(error);
      });
      this.runner = undefined;
      this.started = false;

      if (wasConnected) {
        this.publish('channel.feishu.disconnected', undefined, {});
      }
    } finally {
      this.stopping = false;
    }
  }

  async close(): Promise<void> {
    await this.stop();
  }

  status(): FeishuStatus {
    return {
      connected: this.connected,
      appIdMasked: maskAppId(this.config.appId),
      active_chats: this.queues.activeChats(),
      queued_messages: this.queues.pendingCount(),
      ...(this.lastError !== undefined ? { last_error: this.lastError } : {}),
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    };
  }

  private async handleMessage(message: FeishuIncomingMessage): Promise<void> {
    // 去重先于业务过滤；非文本也登记。
    if (this.dedupe.seen(message.messageId)) return;
    if (!this.connected) return;
    if (message.isSelf === true) return;
    if (message.senderType !== undefined && message.senderType !== 'user') return;
    if (message.messageType !== 'text') return;

    if (
      this.config.allowedChatIds.length > 0 &&
      !this.config.allowedChatIds.includes(message.chatId)
    ) {
      return;
    }

    const text = extractText(message.messageType, message.content);
    if (text === null) return;

    this.publish('channel.feishu.message.received', message.chatId, {
      chat_id: message.chatId,
      message_id: message.messageId,
      message_type: message.messageType,
    });

    const accepted = this.queues.enqueue(message.chatId, () => this.process(message, text));
    if (!accepted) {
      void this.reply(message, BUSY_REPLY_TEXT).catch(() => undefined);
    }
  }

  private async process(message: FeishuIncomingMessage, text: string): Promise<void> {
    if (this.stopping || !this.connected) return;
    const runner = this.runner;
    if (!runner) return;

    const controller = new AbortController();
    this.controllers.set(message.messageId, controller);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('feishu reply timeout'));
    }, this.config.replyTimeoutMs);

    try {
      const output = await runner.run(message.chatId, text, controller.signal);
      if (controller.signal.aborted && !timedOut) return;
      await this.reply(message, output);
    } catch (error) {
      if (timedOut) {
        await this.safeReply(message, TIMEOUT_REPLY_TEXT);
      } else if (controller.signal.aborted) {
        // stop()/interrupt 导致的取消：不回复。
      } else if (error instanceof MemberLimitError) {
        await this.safeReply(message, BUSY_REPLY_TEXT);
      } else {
        this.recordError(error);
        await this.safeReply(message, ERROR_REPLY_TEXT);
      }
    } finally {
      clearTimeout(timer);
      this.controllers.delete(message.messageId);
    }
  }

  private async reply(message: FeishuIncomingMessage, text: string): Promise<void> {
    if (!this.connected) {
      throw new FeishuError('channel_not_connected', 'feishu channel is not connected', 'runtime');
    }

    const truncated = truncateReply(text, this.config.maxReplyChars);
    await this.transport.reply({
      messageId: message.messageId,
      chatId: message.chatId,
      text: truncated,
    });
    this.publish('channel.feishu.reply.sent', message.chatId, {
      chat_id: message.chatId,
      message_id: message.messageId,
      length: truncated.length,
    });
  }

  private async safeReply(message: FeishuIncomingMessage, text: string): Promise<void> {
    try {
      await this.reply(message, text);
    } catch (error) {
      if (error instanceof FeishuError && error.code === 'channel_not_connected') return;
      this.recordError(error);
    }
  }

  private setConnected(connected: boolean, detail?: string): void {
    if (connected && this.stopping) return;
    if (connected === this.connected) return;
    this.connected = connected;
    if (connected) {
      this.publish('channel.feishu.connected', undefined, {});
    } else {
      this.publish('channel.feishu.disconnected', undefined, {
        ...(detail !== undefined ? { reason: detail } : {}),
      });
    }
  }

  private recordError(error: unknown): void {
    const message = this.sanitize(errorMessage(error));
    this.lastError = message;
    this.publish('channel.feishu.error', undefined, { error: message });
  }

  private sanitize(text: string): string {
    return maskSecrets(text, this.config.appId, this.config.appSecret);
  }

  private publish(type: string, chatId: string | undefined, data: Record<string, unknown>): void {
    this.options.events.publish({
      type,
      run_id: chatId === undefined ? 'feishu' : `feishu:${chatId}`,
      data,
      ts: Date.now(),
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    });
  }
}
