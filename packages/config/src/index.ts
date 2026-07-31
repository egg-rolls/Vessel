/**
 * @vessel/config - 声明式配置
 * @module @vessel/config
 *
 * 解析/校验 YAML，产出 core 可消费的配置对象。
 * 零配置起步 + 渐进披露。
 */

export { DEFAULT_CONFIG } from './defaults.js';
export {
  getUserConfigDir,
  getUserConfigPath,
  loadConfig,
  loadConfigFromEnv,
  loadConfigFromFile,
  loadUserConfig,
  mergeConfig,
} from './loader.js';
export * from './types.js';
export { findUnknownKeys, KNOWN_CONFIG_KEYS, validateConfig } from './validator.js';
