/**
 * @vessel/config - 声明式配置
 * @module @vessel/config
 *
 * 解析/校验 YAML，产出 core 可消费的配置对象。
 * 零配置起步 + 渐进披露。
 */

export * from './types.js';
export { DEFAULT_CONFIG } from './defaults.js';
export { validateConfig, findUnknownKeys, KNOWN_CONFIG_KEYS } from './validator.js';
export {
  loadConfig,
  loadConfigFromFile,
  loadConfigFromEnv,
  loadUserConfig,
  getUserConfigDir,
  getUserConfigPath,
  mergeConfig,
} from './loader.js';
