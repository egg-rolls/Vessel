/**
 * Vessel 配置加载器
 * @module @vessel/config
 */

import type { VesselConfig, ConfigLoadOptions } from './types.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { validateConfig, findUnknownKeys, KNOWN_CONFIG_KEYS } from './validator.js';

/**
 * 从 YAML 文件加载配置
 * @param filePath 配置文件路径
 * @returns 配置对象
 */
export async function loadConfigFromFile(filePath: string): Promise<VesselConfig> {
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    
    if (!exists) {
      return {};
    }

    const content = await file.text();
    
    // 使用 Bun 内置的 YAML 解析（如果可用）或简单解析
    // 这里使用简单的 JSON 解析作为示例
    // 实际实现应该使用 YAML 解析库
    try {
      return JSON.parse(content);
    } catch {
      // 如果不是 JSON，尝试简单解析 YAML
      return parseSimpleYaml(content);
    }
  } catch (error) {
    throw new Error(`Failed to load config from ${filePath}: ${error}`);
  }
}

/**
 * 从环境变量加载配置
 * @param prefix 环境变量前缀
 * @returns 配置对象
 */
export function loadConfigFromEnv(prefix: string = 'VESSEL_'): Partial<VesselConfig> {
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
 * 优先级：CLI flag > env > file > defaults
 * @param options 加载选项
 * @returns 配置对象和校验结果
 */
export async function loadConfig(options: ConfigLoadOptions = {}): Promise<{
  config: VesselConfig;
  validation: ReturnType<typeof validateConfig>;
}> {
  // 1. 加载默认配置
  let config: VesselConfig = { ...DEFAULT_CONFIG };

  // 2. 加载文件配置
  const filePath = options.configPath ?? 'vessel.yaml';
  try {
    const fileConfig = await loadConfigFromFile(filePath);
    config = mergeConfig(config, fileConfig);
  } catch {
    // 文件不存在或解析失败，忽略
  }

  // 3. 加载环境变量配置
  const envPrefix = options.envPrefix ?? 'VESSEL_';
  const envConfig = loadConfigFromEnv(envPrefix);
  config = mergeConfig(config, envConfig);

  // 4. 应用默认值
  if (options.defaults) {
    config = mergeConfig(config, options.defaults);
  }

  // 5. 校验配置
  const validation = validateConfig(config);

  // 6. 检查未知键
  const fileConfig = await loadConfigFromFile(filePath).catch(() => ({}));
  const unknownKeys = findUnknownKeys(fileConfig as Record<string, unknown>, KNOWN_CONFIG_KEYS);
  if (unknownKeys.length > 0) {
    validation.warnings.push({
      path: 'root',
      message: `Unknown configuration keys: ${unknownKeys.join(', ')}`,
      value: unknownKeys,
    });
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

/**
 * 简单的 YAML 解析（仅支持基本语法）
 * 注意：生产环境应使用完整的 YAML 解析库
 * @param content YAML 内容
 * @returns 解析后的对象
 */
function parseSimpleYaml(content: string): VesselConfig {
  const config: Record<string, unknown> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    // 跳过空行和注释
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // 解析 key: value
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmed.substring(0, colonIndex).trim();
      const value = trimmed.substring(colonIndex + 1).trim();

      // 尝试解析值
      if (value === 'true') {
        config[key] = true;
      } else if (value === 'false') {
        config[key] = false;
      } else if (!Number.isNaN(Number(value))) {
        config[key] = Number(value);
      } else {
        config[key] = value;
      }
    }
  }

  return config as VesselConfig;
}
