/**
 * Vessel 配置加载器
 * @module @vessel/config
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG } from './defaults.js';
import type { ConfigLoadOptions, UserConfig, VesselConfig } from './types.js';
import { KNOWN_CONFIG_KEYS, findUnknownKeys, validateConfig } from './validator.js';

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
 * 从 YAML 文件加载配置（使用完整的 yaml 解析库）
 * @param filePath 配置文件路径
 * @returns 配置对象
 */
export async function loadConfigFromFile(filePath: string): Promise<VesselConfig> {
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return {};
  }

  const content = await file.text();
  return parseYaml(content) as VesselConfig;
}

/**
 * 从用户配置目录加载 API Key 和 provider 偏好
 * (~/.vessel/config.yaml)
 */
export async function loadUserConfig(userConfigPath?: string): Promise<UserConfig> {
  const filePath = userConfigPath ?? getUserConfigPath();

  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();

    if (!exists) {
      return {};
    }

    const content = await file.text();
    return parseYaml(content) as UserConfig;
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
    config.api_key = apiKey;
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
      base_url: providerBaseUrl,
      api_key: providerApiKey ?? apiKey,
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
      config.provider.max_tokens = tokens;
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
  const result: VesselConfig = { ...base };

  if (override.api_key !== undefined) {
    result.api_key = override.api_key;
  }

  if (override.provider) {
    result.provider = {
      ...result.provider,
      ...override.provider,
    };
  }

  if (override.agent) {
    result.agent = {
      ...result.agent,
      ...override.agent,
    };
  }

  if (override.tools) {
    result.tools = override.tools;
  }

  if (override.guardrails) {
    result.guardrails = override.guardrails;
  }

  if (override.hooks) {
    result.hooks = override.hooks;
  }

  if (override.limits) {
    result.limits = {
      ...result.limits,
      ...override.limits,
    };
  }

  if (override.termination) {
    result.termination = {
      ...result.termination,
      ...override.termination,
    };
  }

  if (override.session) {
    result.session = {
      ...result.session,
      ...override.session,
    };
  }

  if (override.context) {
    result.context = {
      ...result.context,
      ...override.context,
    };
  }

  if (override.plugins) {
    result.plugins = override.plugins;
  }

  return result;
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
    if (userConfig.api_key) {
      config.api_key = userConfig.api_key;
    }

    // 应用 provider 配置（base_url、model、api_key）
    const providerName =
      userConfig.default_provider ??
      (userConfig.providers ? Object.keys(userConfig.providers)[0] : undefined);
    if (providerName && userConfig.providers?.[providerName]) {
      const p = userConfig.providers[providerName];
      const resolvedName = userConfig.default_provider ?? providerName;
      const userModel = userConfig.default_model ?? p.model;
      config.provider = {
        ...config.provider,
        // 用用户声明的 provider 名，而非 openai 默认（修：default_provider: custom 时错显 openai）
        name: resolvedName,
        api_key: config.provider?.api_key ?? p.api_key,
        base_url: p.base_url ?? config.provider?.base_url,
        // model：用户指定则用；否则仅 openai 回退到安全默认 gpt-4（SPEC §6.2.3）。
        // 非 openai provider 不继承 gpt-4——那几乎必错，交由 validateConfig 报错。
        model: userModel ?? (resolvedName === 'openai' ? config.provider?.model : undefined),
      };
    } else if (userConfig.default_provider) {
      config.provider = { ...config.provider, name: userConfig.default_provider };
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
    const unknownKeys = findUnknownKeys(fileConfig as Record<string, unknown>, KNOWN_CONFIG_KEYS);
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
