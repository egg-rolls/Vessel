/**
 * @vessel/feishu 公开类型（DECISION-009 §5.3 / Addendum B §11.3）。
 */

import type {
  ContextManager,
  EventStream,
  LLMProvider,
  Plugin,
  PluginHost,
  RunStore,
  SessionBackend,
} from '@vessel/core';

export interface FeishuConfig {
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  /** feishu | lark；仅切换域名。 */
  domain?: 'feishu' | 'lark';
  /** 空 = 机器人所在的所有群/单聊。 */
  allowedChatIds?: string[];
  sessionPrefix?: string;
  replyTimeoutMs?: number;
  maxReplyChars?: number;
  /** 专用 Host 成员上限；默认 8，范围 1..64（Addendum B §11.3.1）。 */
  maxMembers?: number;
}

export interface ResolvedFeishuConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  allowedChatIds: string[];
  sessionPrefix: string;
  replyTimeoutMs: number;
  maxReplyChars: number;
  maxMembers: number;
}

export interface FeishuStatus {
  connected: boolean;
  appIdMasked: string;
  active_chats: number;
  queued_messages: number;
  last_error?: string;
}

export interface FeishuChannel {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): FeishuStatus;
}

export interface FeishuIncomingMessage {
  messageId: string;
  chatId: string;
  chatType?: 'p2p' | 'group';
  senderType?: 'user' | 'app' | 'bot';
  isSelf?: boolean;
  /** 'text' | 'image' | ...；非文本也上报，供去重登记。 */
  messageType: string;
  /** 原始 content JSON。 */
  content: string;
  createTime?: number;
}

export interface FeishuTransportHandlers {
  onMessage(message: FeishuIncomingMessage): void;
  onConnected?(): void;
  onDisconnected?(reason?: string): void;
  onError?(error: Error): void;
}

/** 所有网络交互藏在实现后；测试用 mock transport，CI 零网络。 */
export interface FeishuTransport {
  /** 建立 WebSocket 长连接；凭据/SDK/连接失败必须 reject。 */
  start(handlers: FeishuTransportHandlers): Promise<void>;
  stop(): Promise<void>;
  /** im.message.reply 到原消息。 */
  reply(input: { messageId: string; chatId: string; text: string }): Promise<void>;
}

export interface FeishuPluginOptions {
  config: FeishuConfig;
  /** 专用 Host 的事件出口；渠道把专用 Host 事件转发到这里。 */
  events: EventStream;
  /** 专用 Host 的成员依赖（Addendum B §11.3.3）；不注入主 Host。 */
  provider: LLMProvider;
  model: string;
  pluginHost: PluginHost;
  session: SessionBackend;
  contextFactory?: () => ContextManager;
  /** durable 开启时注入；专用 Host 用于 checkpoint / resume。 */
  runStore?: RunStore;
  /** 来自全局 scheduler 配置；未给用 core 默认（默认跨 chat 串行）。 */
  maxConcurrency?: number;
  maxQueueSize?: number;
  perAgentSerial?: boolean;
  /** 测试/嵌入注入；缺省用官方 SDK transport。 */
  transport?: FeishuTransport;
  /** 环境变量覆盖（默认 process.env；测试注入）。 */
  env?: Record<string, string | undefined>;
}

export interface FeishuPlugin extends Plugin, FeishuChannel {
  close(): Promise<void>;
}

export type FeishuErrorCode = 'channel_disabled' | 'channel_not_connected' | 'channel_auth_failed';

/** config = 退出码 2；runtime = 退出码 1（Addendum B §11.3.8）。 */
export type FeishuErrorPhase = 'config' | 'runtime';
