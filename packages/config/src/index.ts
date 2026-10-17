/**
 * @vessel/config - 声明式配置
 * @module @vessel/config
 *
 * 解析/校验 YAML，产出 core 可消费的配置对象。
 * 零配置起步 + 渐进披露。
 */

export {
  DEFAULT_CONFIG,
  DEFAULT_DURABLE_OPTIONS,
  DEFAULT_MCP_SERVER_OPTIONS,
  DEFAULT_SCHEDULER_OPTIONS,
  DEFAULT_SERVE_OPTIONS,
  DEFAULT_TRANSPORT_OPTIONS,
  defaultModelForProvider,
  PROVIDER_DEFAULT_MODELS,
} from './defaults.js';
export {
  getUserConfigDir,
  getUserConfigPath,
  loadConfig,
  loadConfigFromEnv,
  loadConfigFromFile,
  loadUserConfig,
  mergeConfig,
  preserveMcpMapKeys,
  type SnakeToCamelOptions,
  snakeToCamel,
} from './loader.js';
export * from './types.js';
export { deepMerge } from './utils.js';
export {
  findUnknownKeys,
  findUnknownNestedKeys,
  isLoopbackHostname,
  KNOWN_BLOCK_KEYS,
  KNOWN_CONFIG_KEYS,
  type UnknownNestedKey,
  validateConfig,
  validateServeSettings,
} from './validator.js';
