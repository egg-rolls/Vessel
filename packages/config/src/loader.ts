/**
 * Vessel 配置加载器
 * @module @vessel/config
 *
 * YAML 文件使用用户友好的 snake_case（api_key, base_url），TS 代码使用 camelCase（ADR-019）。
 * 加载器自动将 YAML 的 snake_case 键递归映射为 camelCase。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG } from './defaults.js';
import type { ConfigLoadOptions, UserConfig, VesselConfig } from './types.js';
import { deepMerge } from './utils.js';
import { findUnknownKeys, KNOWN_CONFIG_KEYS, validateConfig } from './validator.js';

/** 类型守卫：判断值是否为纯对象（非 null、非数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 将对象的所有键从 snake_case 递归转为 camelCase。
 * 用于加载 YAML 配置后、合并前调用。
 */
export function snakeToCamel<T = unknown>(obj: unknown): T;
export function snakeToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(snakeToCamel);
  if (!isRecord(obj)) return obj;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
    result[camelKey] = snakeToCamel(value);
  }
  return result;
}

/**
 * 获取用户配置目录
 * - Windows: %USERPROFILE%/.vessel/
 * - macOS/Linux: ~/.vessel/
 */
export function getUserConfigDir(): string {
  return path.join(os.homedir(), '.vessel');
}

/**
 * 获取用户配置文件路径
 */
export function getUserConfigPath(): string {
  return path.join(getUserConfigDir(), 'config.yaml');
}

/**
 * 从 YAML 文件加载并解析配置，做 snake→camel 映射。
 * 文件不存在时返回 fallback；解析失败时向上抛出。
 */
async function loadYamlConfig<T>(filePath: string, fallback: T): Promise<T> {
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return fallback;
  }

  const content = await file.text();
  return snakeToCamel<T>(parseYaml(content));
}

/**
 * 从项目配置文件（如 ./vessel.yaml）加载配置。
 * @param filePath 配置文件路径
 * @returns 配置对象，文件不存在时返回 {}
 */
export async function loadConfigFromFile(filePath: string): Promise<VesselConfig> {
  return loadYamlConfig<VesselConfig>(filePath, {} as VesselConfig);
}

/**
 * 从用户配置目录加载 API Key 和 provider 偏好
 * (~/.vessel/config.yaml)。解析失败时静默降级为 {}。
 */
export async function loadUserConfig(userConfigPath?: string): Promise<UserConfig> {
  const filePath = userConfigPath ?? getUserConfigPath();

  try {
    return await loadYamlConfig<UserConfig>(filePath, {} as UserConfig);
  } catch {
    return {};
  }
}

/**
 * 从环境变量加载配置
 * @param prefix 环境变量前缀
 * @returns 配置对象
 */
export function loadConfigFromEnv(prefix = 'VESSEL_'): Partial<VesselConfig> {
  const config: Partial<VesselConfig> = {};

  // API Key
  const apiKey = getEnvVar(`${prefix}API_KEY`);
  if (apiKey) {
    config.apiKey = apiKey;
  }

  // Provider
  const providerName = getEnvVar(`${prefix}PROVIDER`);
  const providerModel = getEnvVar(`${prefix}MODEL`);
  const providerBaseUrl = getEnvVar(`${prefix}BASE_URL`);
  const providerApiKey = getEnvVar(`${prefix}PROVIDER_API_KEY`);

  if (providerName || providerModel || providerBaseUrl || providerApiKey) {
    config.provider = {
      name: providerName ?? 'openai',
      model: providerModel,
      baseUrl: providerBaseUrl,
      apiKey: providerApiKey ?? apiKey,
    };
  }

  // Temperature
  const temperature = getEnvVar(`${prefix}TEMPERATURE`);
  if (temperature) {
    const temp = Number.parseFloat(temperature);
    if (!Number.isNaN(temp)) {
      if (!config.provider) config.provider = { name: 'openai' };
      config.provider.temperature = temp;
    }
  }

  // Max tokens
  const maxTokens = getEnvVar(`${prefix}MAX_TOKENS`);
  if (maxTokens) {
    const tokens = Number.parseInt(maxTokens, 10);
    if (!Number.isNaN(tokens)) {
      if (!config.provider) config.provider = { name: 'openai' };
      config.provider.maxTokens = tokens;
    }
  }

  return config;
}

/**
 * 合并配置（深度合并）
 * @param base 基础配置
 * @param override 覆盖配置
 * @returns 合并后的配置
 */
export function mergeConfig(base: VesselConfig, override: Partial<VesselConfig>): VesselConfig {
  return deepMerge(
    base as Record<string, unknown>,
    override as Record<string, unknown>,
  ) as VesselConfig;
}

/**
 * 加载配置（综合加载）
 * 优先级：CLI flag > env (VESSEL_*) > vessel.yaml > ~/.vessel/config.yaml > 安全默认
 * @param options 加载选项
 * @returns 配置对象和校验结果
 */
export async function loadConfig(options: ConfigLoadOptions = {}): Promise<{
  config: VesselConfig;
  validation: ReturnType<typeof validateConfig>;
}> {
  // 1. 加载默认配置
  let config: VesselConfig = { ...DEFAULT_CONFIG };

  // 2. 加载用户配置 (~/.vessel/config.yaml)
  try {
    const userConfig = await loadUserConfig(options.userConfigPath);
    if (userConfig.apiKey) {
      config.apiKey = userConfig.apiKey;
    }

    // 应用 provider 配置
    const providerName =
      userConfig.defaultProvider ??
      (userConfig.providers ? Object.keys(userConfig.providers)[0] : undefined);
    if (providerName && userConfig.providers?.[providerName]) {
      const p = userConfig.providers[providerName];
      const resolvedName = userConfig.defaultProvider ?? providerName;
      const userModel = userConfig.defaultModel ?? p.model;
      config.provider = {
        ...config.provider,
        name: resolvedName,
        apiKey: config.provider?.apiKey ?? p.apiKey,
        baseUrl: p.baseUrl ?? config.provider?.baseUrl,
        model: userModel ?? (resolvedName === 'openai' ? config.provider?.model : undefined),
      };
    } else if (userConfig.defaultProvider) {
      config.provider = { ...config.provider, name: userConfig.defaultProvider };
    }
  } catch {
    // 用户配置不存在或解析失败，忽略
  }

  // 3. 加载项目文件配置 (./vessel.yaml)
  const filePath = options.configPath ?? 'vessel.yaml';
  try {
    const fileConfig = await loadConfigFromFile(filePath);
    config = mergeConfig(config, fileConfig);
  } catch {
    // 文件不存在或解析失败，忽略
  }

  // 4. 加载环境变量配置 (VESSEL_*)
  const envPrefix = options.envPrefix ?? 'VESSEL_';
  const envConfig = loadConfigFromEnv(envPrefix);
  config = mergeConfig(config, envConfig);

  // 5. 应用 CLI 覆盖
  if (options.defaults) {
    config = mergeConfig(config, options.defaults);
  }

  // 6. 校验配置
  const validation = validateConfig(config);

  // 7. 检查项目配置文件中的未知键
  try {
    const fileConfig = await loadConfigFromFile(filePath);
    const unknownKeys = findUnknownKeys(fileConfig, KNOWN_CONFIG_KEYS);
    if (unknownKeys.length > 0) {
      validation.warnings.push({
        path: 'root',
        message: `Unknown configuration keys: ${unknownKeys.join(', ')}`,
        value: unknownKeys,
      });
    }
  } catch {
    // 文件不存在，跳过
  }

  return { config, validation };
}

/**
 * 获取环境变量
 * @param name 变量名
 * @returns 变量值或 undefined
 */
function getEnvVar(name: string): string | undefined {
  return process.env[name];
}
