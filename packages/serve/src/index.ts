/**
 * @vessel/serve — 本地 HTTP/WS 服务网关（vessel.gateway/1）
 * @module @vessel/serve
 *
 * 把 runtime 的 EventStream 暴露为 WS + SSE 广播，并提供 /v1 控制端点。
 * R3 增加：LoopbackTransport + peer 注册表 + /v1/team/*。
 * 是 EventStream 的消费者（与 TUI 的 StreamRenderer 同构），不经过 PluginHost、不修改 core。
 */

export { type EventGap, type SeqEvent, SeqEventBuffer } from './event-buffer.js';
export type { Gateway, GatewayOptions } from './gateway.js';
export { startGateway } from './gateway.js';
export {
  type ClientFrame,
  type NodeInfo,
  PROTOCOL_VERSION,
  type ProtocolError,
  type ProtocolErrorCode,
  type ProtocolInfo,
  protocolError,
  type RunStatus,
  type ServerFrame,
  type ToolInfo,
} from './protocol.js';
export {
  fromWireMessage,
  isTeamEvent,
  parseAddress,
  TEAM_MESSAGE_KINDS,
  type TeamGatewayOptions,
  type TeamHostLike,
  TeamProtocolError,
  type TeamSpawnRequest,
  toWireAgentStatus,
  toWireEvent,
  toWireMessage,
  toWirePeer,
  type WireAgentMessage,
  type WireAgentStatus,
  type WirePeerInfo,
} from './team.js';
export {
  createLoopbackTransport,
  ensurePeersDir,
  isLoopbackEndpoint,
  LoopbackTransport,
  type LoopbackTransportOptions,
  type PeerFileRecord,
  PeerRegistry,
  type PeerRegistryOptions,
  PeerTransportError,
  type PeerTransportErrorCode,
} from './transport/index.js';
