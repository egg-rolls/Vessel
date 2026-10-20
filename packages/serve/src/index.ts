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
export {
  type FeishuGatewayOptions,
  type FeishuStatus,
  maskAppId,
  normalizeFeishuStatus,
} from './feishu.js';
export {
  type GatewayReloadResult,
  RELOAD_SCOPES,
  type ReloadScope,
} from './gateway/methods/admin.js';
export type { Gateway, GatewayOptions } from './gateway.js';
export { isLoopbackHostname, startGateway } from './gateway.js';
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
export {
  DEFAULT_WORKFLOW_LIMIT,
  dedupeWorkflowSummaries,
  isSafeWorkflowName,
  MAX_OUTPUT_PREVIEW,
  MAX_WORKFLOW_LIMIT,
  parseWorkflowLimit,
  parseWorkflowStatus,
  sortWorkflowSummaries,
  toWireWorkflowDetail,
  toWireWorkflowSummary,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_STEP_STATUSES,
  type WorkflowControlsLike,
  type WorkflowGatewayOptions,
  type WorkflowOutcome,
  type WorkflowRunDetail,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowStepStatus,
  type WorkflowStepSummary,
} from './workflow.js';
