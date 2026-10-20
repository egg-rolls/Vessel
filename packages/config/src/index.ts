/**
 * @vessel/config - 声明式配置
 * @module @vessel/config
 *
 * 解析/校验 YAML，产出 core 可消费的配置对象。
 * 零配置起步 + 渐进披露。
 */

export {
  DEFAULT_CONFIG,
  DEFAULT_DATA_DIR,
  DEFAULT_DURABLE_OPTIONS,
  DEFAULT_EVALS_OPTIONS,
  DEFAULT_FEISHU_OPTIONS,
  DEFAULT_MCP_SERVER_OPTIONS,
  DEFAULT_OBSERVABILITY_OPTIONS,
  DEFAULT_SCHEDULER_OPTIONS,
  DEFAULT_SERVE_OPTIONS,
  DEFAULT_TENANT_ID,
  DEFAULT_TRACE_OPTIONS,
  DEFAULT_TRANSPORT_OPTIONS,
  DEFAULT_WORKFLOW_OPTIONS,
  defaultModelForProvider,
  PROVIDER_DEFAULT_MODELS,
} from './defaults.js';
export {
  applyLayerWithSources,
  type ConfigLoadResult,
  getUserConfigDir,
  getUserConfigPath,
  loadConfig,
  loadConfigFromEnv,
  loadConfigFromFile,
  loadUserConfig,
  mergeConfig,
  preserveConfigMapKeys,
  preserveMcpMapKeys,
  type SnakeToCamelOptions,
  snakeToCamel,
} from './loader.js';
export {
  type ResolveEnvRefsResult,
  redactConfig,
  resolveEffectiveApiKey,
  resolveEnvRefsInLayer,
  resolveSecret,
  type SecretState,
  secretMarker,
} from './secrets.js';
export {
  type BuildConfigSnapshotInput,
  buildConfigSnapshot,
  redactSourcePaths,
} from './sources.js';
export * from './types.js';
export { deepMerge } from './utils.js';
export {
  allowedOriginError,
  findExplicitSecretPaths,
  findUnknownKeys,
  findUnknownNestedKeys,
  isLoopbackHostname,
  isValidTenantId,
  KNOWN_BLOCK_KEYS,
  KNOWN_CONFIG_KEYS,
  TENANT_OVERLAY_ALLOWED_KEYS,
  TENANT_OVERLAY_FORBIDDEN_KEYS,
  type UnknownNestedKey,
  validateConfig,
  validateServeSettings,
} from './validator.js';
