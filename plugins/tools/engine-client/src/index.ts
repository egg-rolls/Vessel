/**
 * engine-client 能力插件（P2 契约 §0.3）：PluginHost 接入层「协议转译 / 同步上报」的
 * 实现载体 —— 转发 handler 工厂 + 信封协议 + 注册表同步客户端 + pending 关联表。
 * 与 mcp-client 同形（ADR-039 先例）；core 零改动。
 *
 * @module @vessel-agent/engine-client
 */

export * from './client.js';
/** 池 S8/S9：pending 状态类型最小导出（oracle 签名用；表实现保持内部）。 */
export type { PendingState } from './pending.js';
/** 池 S8：PoolTransport（TCP loopback 数据面客户端；实现 EngineTransport 端口，消费面零改动）。 */
export {
  createPoolTransport,
  type PoolTransport,
  type PoolTransportOptions,
} from './pool.js';
export * from './protocol.js';
