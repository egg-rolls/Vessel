/**
 * @vessel/feishu — WebSocket 长连接文本 bot。
 *
 * 工厂式插件：asm 注入 provider/model/pluginHost/session/events 等；
 * 渠道自建专用 InProcessRuntimeHost，不占用主 Host。
 * 默认导出是工厂函数，因此列入 `FACTORY_PLUGINS`（短名 feishu）。
 */

export {
  BUSY_REPLY_TEXT,
  createFeishuPlugin,
  createFeishuPlugin as default,
  ERROR_REPLY_TEXT,
  FEISHU_DEDUPE_SIZE,
  FEISHU_DEFAULT_MAX_MEMBERS,
  FEISHU_QUEUE_LIMIT,
  TIMEOUT_REPLY_TEXT,
} from './channel.js';
export {
  fallbackAgentId,
  maskAppId,
  maskSecrets,
  resolveFeishuConfig,
  sanitizeAgentId,
} from './config.js';
export { LruSet } from './dedupe.js';
export { FeishuError } from './errors.js';
export { PerChatQueues } from './queue.js';
export { ChatMemberRunner, MemberLimitError } from './runner.js';
export { createSdkTransport, mapSdkMessage } from './sdk-transport.js';
export { extractText, TRUNCATED_SUFFIX, truncateReply } from './text.js';
export type {
  FeishuChannel,
  FeishuConfig,
  FeishuErrorCode,
  FeishuErrorPhase,
  FeishuIncomingMessage,
  FeishuPlugin,
  FeishuPluginOptions,
  FeishuStatus,
  FeishuTransport,
  FeishuTransportHandlers,
  ResolvedFeishuConfig,
} from './types.js';
