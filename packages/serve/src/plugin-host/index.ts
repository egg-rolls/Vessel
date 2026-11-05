/**
 * 体验型 plugin 宿主入口（CONTRACT-0.43）。
 *
 * @module @vessel-agent/serve/plugin-host
 */

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
  PLUGIN_MAX_RESTARTS,
  PLUGIN_RESTART_WINDOW_MS,
  PluginHostManager,
  type PluginHostManagerOptions,
  type PluginLogger,
  pluginListMetadata,
  renderContributions,
  toPluginListStatus,
} from './manager.js';
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
