/**
 * @vessel-agent/serve — 本地 HTTP/WS 服务网关（vessel.gateway/1）
 * @module @vessel-agent/serve
 *
 * 把 runtime 的 EventStream 暴露为 WS + SSE 广播，并提供 /v1 控制端点。
 * R3 增加：LoopbackTransport + peer 注册表 + /v1/team/*。
 * 是 EventStream 的消费者（与 TUI 的 StreamRenderer 同构），不经过 PluginHost、不修改 core。
 */

export {
  type BackpressureThresholds,
  ClientBackpressure,
} from './backpressure.js';
export {
  DEFAULT_DURABLE_LIMIT,
  DURABLE_RUN_STATUSES,
  type DurableCheckpointLike,
  type DurableGatewayOptions,
  type DurableRunStatus,
  type DurableRunSummary,
  type DurableStoreLike,
  dedupeCheckpoints,
  isResumableStatus,
  MAX_DURABLE_LIMIT,
  parseLimit,
  parseStatusFilter,
  sortCheckpoints,
  toRunSummary,
} from './durable.js';
export {
  type EvalCaseAssertion,
  type EvalCaseResult,
  type EvalReport,
  type EvalsGatewayOptions,
  type EvalUsage,
  normalizeEvalReport,
} from './evals.js';
export { type EventGap, type SeqEvent, SeqEventBuffer } from './event-buffer.js';
export { BROADCAST_PREVIEW_LIMIT, summarizeBroadcastEvent } from './event-summary.js';
export {
  createFederationRoute,
  FEDERATION_DEFAULT_MEMBERS_LIMIT,
  FEDERATION_DEFAULT_RATE_LIMIT,
  FEDERATION_MEMBERS_LIMIT_MAX,
  FEDERATION_MESSAGES_PATH,
  FEDERATION_PROTOCOL,
  FEDERATION_TEAM_INFO_PATH,
  type FederationDirection,
  type FederationGatewayOptions,
  type FederationGatewayPeer,
  type FederationResolution,
  type FederationRoute,
  type FederationRouteOptions,
  type FederationTeamInfo,
  type FederationTeamInfoMember,
} from './federation.js';
export {
  type FeishuGatewayOptions,
  type FeishuStatus,
  maskAppId,
  normalizeFeishuStatus,
} from './feishu.js';
export {
  corsHeaders,
  hostAllowed,
  isWildcardHostname,
  loadTlsMaterial,
  normalizeAllowedOrigins,
  originAllowed,
} from './gateway/auth.js';
export {
  type GatewayReloadResult,
  RELOAD_SCOPES,
  type ReloadScope,
} from './gateway/methods/admin.js';
export type { Gateway, GatewayOptions, GatewayReconfigureOptions } from './gateway.js';
export { isLoopbackHostname, startGateway } from './gateway.js';
export {
  HUB_MAX_AGENTS,
  HUB_MAX_TEAMS,
  type HubAgentMeta,
  type HubControlChange,
  type HubControlLike,
  type HubNodeSnapshotInput,
  type HubPointerInput,
  type HubPointerReason,
  type HubTeamMeta,
  type HubTeamScopeLike,
} from './hub-control.js';
export {
  buildHubAuthFrame,
  buildHubHelloFrame,
  buildHubPingFrame,
  buildHubPointerFrame,
  buildHubPongFrame,
  buildHubSnapshotFrame,
  decodeHubFrame,
  type HubEnvelope,
  type HubEnvelopeResult,
  type HubFrameIdentity,
  type HubFrameParse,
  parseHubAuthFrame,
  parseHubCounts,
  parseHubHelloFrame,
  parseHubPingFrame,
  parseHubPointerFrame,
  parseHubPongFrame,
  parseHubSnapshotFrame,
  readHubEnvelope,
} from './hub-frames.js';
export {
  HUB_NODE_CONTROL_PATH,
  HUB_PROTOCOL,
  type HubAuthFrame,
  type HubClientFrame,
  type HubDialer,
  type HubHelloFrame,
  type HubPingFrame,
  type HubPointerFrame,
  type HubPongFrame,
  type HubServerFrame,
  type HubSnapshotFrame,
  isHubDialer,
  isHubProtocol,
  parseHubAgentMeta,
  parseHubPointerReason,
  parseHubTeamMeta,
} from './hub-protocol.js';
export {
  createLocalRpcDispatcher,
  type LocalRpcDispatcher,
  type LocalRpcOptions,
} from './local.js';
export {
  MCP_SERVER_STATES,
  type McpGatewayOptions,
  type McpServerState,
  type McpServerStatus,
  normalizeMcpServers,
  type WireMcpServerStatus,
} from './mcp.js';
export {
  type MetricsProvider,
  type MetricsSnapshot,
  normalizeMetricsSnapshot,
} from './metrics.js';
export {
  CONTROL_TOKEN_DEFAULT_TTL_S,
  CONTROL_TOKEN_MAX_TTL_S,
  type ExchangeTokenInput,
  type IssuedNodeToken,
  type MintPairingTokensInput,
  type NodeTokenAuthenticator,
  type NodeTokenControlLike,
  type NodeTokenMeta,
  type NodeTokenScope,
  PAIRING_TOKEN_TTL_MS,
  type PairingTokenPair,
  type RevokeTokenResult,
} from './node-token-control.js';
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
  buildCapabilityManifest,
  type CapabilityManifest,
  createRpcDispatcher,
  defineMethods,
  type MethodPermission,
  RPC_VERSION,
  type RpcDispatcher,
  RpcError,
  type RpcErrorBody,
  type RpcErrorCode,
  type RpcFailureResponse,
  type RpcMethodContext,
  type RpcMethodDefinition,
  type RpcMethodTable,
  type RpcRequest,
  type RpcResponse,
  type RpcSuccessResponse,
  toEventNotification,
  validateParams,
} from './rpc.js';
export {
  DEFAULT_SESSION_SEARCH_LIMIT,
  MAX_SESSION_SEARCH_LIMIT,
  normalizeSearchQuery,
  parseSearchLimit,
  type SessionSearchHit,
  searchSessions,
} from './session-search.js';
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
export type {
  BudgetDimensionLike,
  ConversationBudgetStatusLike,
  TeamBudgetResultLike,
  TeamControlLike,
  TeamDeliveryLike,
  TeamDetailLike,
  TeamMemberLike,
  TeamMembersResultLike,
  TeamMessageLike,
  TeamPostResultLike,
  TeamSummaryLike,
} from './team-control.js';
export {
  type ConfigGatewayOptionsLike,
  type ConfigSnapshotLike,
  DEFAULT_TENANT_ID,
  eventTenantId,
  eventVisible,
  extractToken,
  type GatewayAuthLike,
  isWildcardPrincipal,
  mapTenantError,
  normalizeTenantInfo,
  QuotaExceededError,
  resolveLocalPrincipal,
  resolvePrincipal,
  resolveTenantScope,
  TENANT_ID_PATTERN,
  type TenantControlLike,
  type TenantInfo,
  TenantLockedError,
  type TenantPrincipal,
  type TenantQuota,
  type TenantRole,
} from './tenant.js';
export {
  createGatewayEventHub,
  createTenantEventHub,
  type GatewayEventHubOptions,
  type TenantEventHub,
  type TenantEventHubOptions,
  type TenantEventSource,
} from './tenant-event-hub.js';
export { capToolEvent, capToolPayload, TOOL_EVENT_PAYLOAD_LIMIT } from './tool-events.js';
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
