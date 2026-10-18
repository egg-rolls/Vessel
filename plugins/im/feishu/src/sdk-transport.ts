/**
 * 官方 @larksuiteoapi/node-sdk 的 WebSocket transport。
 *
 * SDK 只在 start() 内动态 import：其它包、单测与 CI 不会加载它。
 * 所有网络交互都藏在本文件的 FeishuTransport 实现后。
 */

import { FeishuError } from './errors.js';
import type { FeishuIncomingMessage, FeishuTransport, FeishuTransportHandlers } from './types.js';

interface SdkReplyResponse {
  code?: number;
  msg?: string;
}

interface SdkClient {
  im: {
    message: {
      reply(input: {
        path: { message_id: string };
        data: { content: string; msg_type: string };
      }): Promise<SdkReplyResponse>;
    };
  };
}

interface SdkWsClient {
  start(params: { eventDispatcher: unknown }): Promise<void>;
  close(params?: { force?: boolean }): void;
}

interface SdkEventDispatcher {
  register(handlers: Record<string, (data: unknown) => void>): SdkEventDispatcher;
}

interface SdkModule {
  Client: new (config: Record<string, unknown>) => SdkClient;
  WSClient: new (config: Record<string, unknown>) => SdkWsClient;
  EventDispatcher: new (config?: Record<string, unknown>) => SdkEventDispatcher;
  Domain: { Feishu: unknown; Lark: unknown };
  LoggerLevel: { error: unknown };
}

let sdkPromise: Promise<SdkModule> | undefined;

function loadSdk(): Promise<SdkModule> {
  sdkPromise ??= import('@larksuiteoapi/node-sdk').then((module) => module as unknown as SdkModule);
  return sdkPromise;
}

export interface SdkTransportOptions {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * SDK 的 im.message.receive_v1 事件 → 内部消息。
 * 非文本消息同样返回（供渠道去重登记）；字段缺失返回 null。
 */
export function mapSdkMessage(data: unknown): FeishuIncomingMessage | null {
  if (!isRecord(data)) return null;
  const message = data.message;
  const sender = data.sender;
  if (!isRecord(message) || !isRecord(sender)) return null;

  const messageId = message.message_id;
  const chatId = message.chat_id;
  const messageType = message.message_type;
  const content = message.content;
  if (
    typeof messageId !== 'string' ||
    typeof chatId !== 'string' ||
    typeof messageType !== 'string' ||
    typeof content !== 'string'
  ) {
    return null;
  }

  const rawSenderType = sender.sender_type;
  const senderType =
    rawSenderType === 'user' || rawSenderType === 'app' || rawSenderType === 'bot'
      ? rawSenderType
      : undefined;

  const chatType =
    message.chat_type === 'p2p' || message.chat_type === 'group' ? message.chat_type : undefined;

  const createTimeRaw = message.create_time;
  const createTime =
    typeof createTimeRaw === 'string' || typeof createTimeRaw === 'number'
      ? Number(createTimeRaw)
      : undefined;

  return {
    messageId,
    chatId,
    ...(chatType !== undefined ? { chatType } : {}),
    ...(senderType !== undefined ? { senderType } : {}),
    isSelf: senderType === 'app' || senderType === 'bot',
    messageType,
    content,
    ...(createTime !== undefined && Number.isFinite(createTime) ? { createTime } : {}),
  };
}

export function createSdkTransport(options: SdkTransportOptions): FeishuTransport {
  let client: SdkClient | undefined;
  let wsClient: SdkWsClient | undefined;

  return {
    async start(handlers: FeishuTransportHandlers): Promise<void> {
      const Lark = await loadSdk();
      const domain = options.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
      const base = {
        appId: options.appId,
        appSecret: options.appSecret,
        domain,
        loggerLevel: Lark.LoggerLevel.error,
      };

      client = new Lark.Client(base);
      const dispatcher = new Lark.EventDispatcher({
        loggerLevel: Lark.LoggerLevel.error,
      }).register({
        'im.message.receive_v1': (data: unknown) => {
          const message = mapSdkMessage(data);
          if (message) handlers.onMessage(message);
        },
      });

      wsClient = new Lark.WSClient({
        ...base,
        onReady: () => handlers.onConnected?.(),
        onError: (error: Error) => handlers.onError?.(error),
        onReconnecting: () => handlers.onDisconnected?.('reconnecting'),
        onReconnected: () => handlers.onConnected?.(),
      });

      await wsClient.start({ eventDispatcher: dispatcher });
    },

    async stop(): Promise<void> {
      try {
        wsClient?.close({ force: true });
      } finally {
        wsClient = undefined;
        client = undefined;
      }
    },

    async reply(input): Promise<void> {
      if (!client) {
        throw new FeishuError(
          'channel_not_connected',
          'feishu transport is not started',
          'runtime',
        );
      }
      const response = await client.im.message.reply({
        path: { message_id: input.messageId },
        data: { content: JSON.stringify({ text: input.text }), msg_type: 'text' },
      });
      if (typeof response.code === 'number' && response.code !== 0) {
        throw new Error(`feishu reply failed: ${response.msg ?? response.code}`);
      }
    },
  };
}
