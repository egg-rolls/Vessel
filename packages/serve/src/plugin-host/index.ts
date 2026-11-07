/**
 * 体验型 plugin 宿主入口（CONTRACT-0.43）。
 *
 * @module @vessel-agent/serve/plugin-host
 */

export {
  buildPluginCatalog,
  type PluginCatalogDescriptor,
  type PluginCatalogEntry,
  type PluginCatalogInput,
  type PluginCatalogItem,
  type PluginCatalogKind,
  type PluginCatalogScope,
  type PluginCatalogStatusEntry,
} from './catalog.js';
export {
  buildPluginEnv,
  type ChildExitInfo,
  ChildPluginProcess,
  type ChildProcessHooks,
  type ChildProcessOptions,
  type ChildStatus,
  isDeniedHostApi,
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_TIMEOUTS,
} from './child.js';
export {
  ensureJsonDto,
  ensurePayload,
  jsonByteLength,
  jsonDtoViolation,
  MAX_PLUGIN_EVENT_BYTES,
  MAX_PLUGIN_MESSAGE_BYTES,
  normalizePluginEventDto,
  redactPluginValue,
  toPluginEventDto,
} from './dto.js';
export { PluginHostError, pluginError, pluginErrorCodeOf } from './errors.js';
export {
  createHubPluginEventSource,
  DEFAULT_EVENTS_PER_SECOND,
  EventRateLimiter,
  type HubEventSourceOptions,
  matchesEventFilter,
  type PluginHubLike,
  preparePluginEvent,
} from './events.js';
export {
  isCliCommandExposed,
  isHttpRouteExposed,
  type PluginExposeConfig,
  type PluginSurfaceCliEntry,
  type PluginSurfaceHttpEntry,
  type PluginSurfaceSummary,
  resolveEffectiveSurface,
  surfaceSummaryFromManifest,
} from './expose.js';
export {
  buildPluginHttpRouteTable,
  isHostReservedPath,
  isPluginHttpPathReserved,
  matchPluginHttpRoute,
  normalizePluginHttpDeclarations,
  normalizePluginHttpEndpoint,
  PLUGIN_HTTP_METHODS,
  PLUGIN_HTTP_RESERVED_PATHS,
  PLUGIN_HTTP_RESERVED_PREFIXES,
  type PluginHttpAuditEvent,
  type PluginHttpAuth,
  type PluginHttpConflictReason,
  type PluginHttpConflictScope,
  type PluginHttpDeclaration,
  type PluginHttpDisconnectAudit,
  type PluginHttpHostLike,
  type PluginHttpLimits,
  type PluginHttpMatch,
  type PluginHttpMethod,
  type PluginHttpRequestAudit,
  type PluginHttpResolution,
  type PluginHttpResponseMode,
  type PluginHttpRoute,
  type PluginHttpRouteConflict,
  type PluginHttpRouteInput,
  type PluginHttpRouteTable,
  type PluginHttpScope,
  type PluginHttpSegment,
  type PluginHttpTarget,
  type PluginHttpUpgrade,
  type PluginWebSocketAccounting,
  type PluginWebSocketHandle,
  resolvePluginHttpLimits,
} from './http.js';
export {
  PLUGIN_MAX_RESTARTS,
  PLUGIN_RESTART_WINDOW_MS,
  PluginHostManager,
  type PluginHostManagerOptions,
  type PluginLogger,
  type PluginWebSocketStats,
  pluginListMetadata,
  renderContributions,
  toPluginListStatus,
} from './manager.js';
export {
  type PluginHttpProxyOptions,
  proxyPluginHttpRequest,
} from './proxy.js';
export {
  PLUGIN_ID_PATTERN,
  PLUGIN_METHOD_NAME_PATTERN,
  type PluginRpcHandler,
  PluginRpcRegistry,
  pluginRpcName,
} from './registry.js';
export { PLUGIN_CSP, pluginStaticId, servePluginAsset } from './static.js';
export type {
  PluginBuiltinNav,
  PluginCommandContribution,
  PluginContributionsSnapshot,
  PluginDependencies,
  PluginDescriptor,
  PluginErrorCode,
  PluginEventDto,
  PluginEventSource,
  PluginHostManagerLike,
  PluginI18n,
  PluginIconName,
  PluginListMetadata,
  PluginListStatus,
  PluginLocale,
  PluginManifestContributions,
  PluginMode,
  PluginNav,
  PluginNavGroup,
  PluginPageContribution,
  PluginPanelContribution,
  PluginPermissions,
  PluginReloadError,
  PluginReloadResult,
  PluginRenderContributions,
  PluginRpcContribution,
  PluginRuntimeStatus,
  PluginSide,
  PluginStaticMount,
  PluginStatusEntry,
} from './types.js';
export {
  PLUGIN_BUILTIN_NAV,
  PLUGIN_I18N_LOCALES,
  PLUGIN_ICON_NAMES,
} from './types.js';
export {
  mapPluginWsCloseCode,
  PLUGIN_WS_HIGH_WATER_BYTES,
  PLUGIN_WS_MAX_CLOSE_REASON_BYTES,
  type PluginWsClient,
  PluginWsConnection,
  type PluginWsConnectionOptions,
  type PluginWsUpstream,
  truncatePluginWsReason,
} from './ws-proxy.js';
