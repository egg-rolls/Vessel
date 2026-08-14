/**
 * @vessel/serve — 本地 HTTP/WS 服务网关
 * @module @vessel/serve
 *
 * 把 runtime 的 EventStream 暴露为 SSE + WebSocket 广播，并提供 /health /sessions /run 控制端点。
 * 是 EventStream 的消费者（与 TUI 的 StreamRenderer 同构），不经过 PluginHost、不修改 core。
 */

export type { Gateway, GatewayOptions } from './gateway.js';
export { startGateway } from './gateway.js';
