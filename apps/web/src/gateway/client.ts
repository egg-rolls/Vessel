/**
 * Browser gateway client —— 连接 Vessel gateway（vessel.gateway/1）。
 *
 * 协议（见 packages/serve/src/gateway.ts）：
 *   - WS    `/v1/events?since=<seq>`，首帧 `{kind:'auth', token}`；服务端回 `hello`
 *   - 帧    `event` / `gap` / `res` / `ping`（见 packages/serve/src/protocol.ts）
 *   - REST  `/v1/sessions` / `/v1/tools`（Bearer 头，仅在 WS 不可用时兜底）
 *
 * 浏览器默认同源（gateway 托管 dist，或 Vite proxy）；也可在运行时指定远端 gateway
 * （见 gatewayUrl.ts）。跨 Origin 时 gateway 必须配置 `serve.allowed_origins`。
 *
 * S1：实现按域拆到 `./client/*`；本文件只做 barrel，导出面与拆分前一致。
 */

export { GatewayClient } from './client/index';
export type { ConnectionState, EventMeta } from './client/protocol';
export { GatewayHttpError } from './client/protocol';
