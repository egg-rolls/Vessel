/**
 * @vessel-agent/feishu 公开类型（DECISION-009 §5.3 / Addendum B §11.3）。
 */

import type { AgentService } from '@vessel-agent/agent';
import type { EventStream, Plugin } from '@vessel-agent/core';

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
  /** 渠道成员上限；默认 8，范围 1..64（Addendum B §11.3.1）。 */
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
  /** 0.5：可选；缺失视为 default。 */
  tenant_id?: string;
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
  /**
   * 0.5：tenant 作用域（可选）。缺省 = 0.4 兼容，不写 tenant_id。
   * tenant 实例由 asm 注入 `env: {}`，避免 ambient VESSEL_FEISHU_* 串用。
   */
  tenantId?: string;
  /** 事件出口（与注入 service 的父事件流同源）；渠道读取 run.* 终态。 */
  events: EventStream;
  /**
   * 0.27：注入的 AgentService；成员创建与 admit 执行面。
   * 缺失时 start() 显式失败（禁止静默降级）。
   */
  service: AgentService;
  /** 0.27：取消在途 run（装配层接线）；缺省只放弃等待。 */
  cancelRun?: (runId: string, reason?: string) => boolean;
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
