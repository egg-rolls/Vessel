/**
 * engine-client 能力插件（P2 契约 §0.3）：PluginHost 接入层「协议转译 / 同步上报」的
 * 实现载体 —— 转发 handler 工厂 + 信封协议 + 注册表同步客户端 + pending 关联表。
 * 与 mcp-client 同形（ADR-039 先例）；core 零改动。
 *
 * @module @vessel-agent/engine-client
 */

export * from './protocol.js';
