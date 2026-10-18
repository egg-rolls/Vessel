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
import { DEFAULT_CONFIG, defaultModelForProvider } from './defaults.js';
import type { ConfigLoadOptions, UserConfig, VesselConfig } from './types.js';
import { deepMerge } from './utils.js';
import {
  findUnknownKeys,
  findUnknownNestedKeys,
  KNOWN_BLOCK_KEYS,
  KNOWN_CONFIG_KEYS,
  validateConfig,
} from './validator.js';

/** 类型守卫：判断值是否为纯对象（非 null、非数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * snake→camel 映射选项。
 * `preserveKey` 返回 true 时保留原键（用于用户自定义 map 键，如 mcp_servers 的
 * server 名、env/headers 的变量名）。
 */
export interface SnakeToCamelOptions {
  /** @param path 从根到当前对象的路径（已按 camelCase 转换） */
  preserveKey?: (path: string[], key: string) => boolean;
}

/**
 * 将对象的所有键从 snake_case 递归转为 camelCase。
 * 用于加载 YAML 配置后、合并前调用。
 */
export function snakeToCamel<T = unknown>(obj: unknown, options?: SnakeToCamelOptions): T;
export function snakeToCamel(obj: unknown, options?: SnakeToCamelOptions): unknown {
  return convertKeys(obj, [], options);
}

function convertKeys(
  obj: unknown,
  path: string[],
  options: SnakeToCamelOptions | undefined,
): unknown {
  if (Array.isArray(obj)) return obj.map((item) => convertKeys(item, path, options));
  if (!isRecord(obj)) return obj;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey =
      options?.preserveKey?.(path, key) === true
        ? key
        : key.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
    result[camelKey] = convertKeys(value, [...path, camelKey], options);
  }
  return result;
}

/**
 * mcp_servers 是用户自定义的 map：
 * - 第一层键是 server 名（`my_server` 不能被改写，否则工具前缀变化）；
 * - `env` / `headers` 的键是环境变量/HTTP 头名，同样保留原样。
 * 其余配置键（transport、connect_timeout_ms 等）照常转 camelCase。
 */
export function preserveMcpMapKeys(path: string[], _key: string): boolean {
  if (path[0] !== 'mcpServers') return false;
  if (path.length === 1) return true;
  return path.length === 3 && (path[2] === 'env' || path[2] === 'headers');
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
  return snakeToCamel<T>(parseYaml(content), { preserveKey: preserveMcpMapKeys });
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

  // PROVIDER_API_KEY 只配置了 provider 级 Key 时，同时回填顶层 apiKey——
  // bootstrap 只从顶层读 Key，否则这个变量会被静默忽略。
  if (providerApiKey && !config.apiKey) {
    config.apiKey = providerApiKey;
  }

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

  // 飞书凭据（0.4）：env 优先于配置文件；空串视为未设置，不覆盖文件值。
  const feishuAppId = getEnvVar(`${prefix}FEISHU_APP_ID`);
  const feishuAppSecret = getEnvVar(`${prefix}FEISHU_APP_SECRET`);
  if (feishuAppId || feishuAppSecret) {
    config.feishu = {
      ...(feishuAppId ? { appId: feishuAppId } : {}),
      ...(feishuAppSecret ? { appSecret: feishuAppSecret } : {}),
    };
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
  // 1. 加载默认配置（深拷贝：嵌套对象不能跨调用共享，否则消费方改写会污染后续加载）
  let config: VesselConfig = structuredClone(DEFAULT_CONFIG);

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

  // 6. provider-aware 默认 model：只给已知 provider 补默认。
  //    未知 provider 保持 undefined，由 validator fail-fast，不再全局回退 gpt-4。
  if (config.provider && !config.provider.model) {
    const fallback = defaultModelForProvider(config.provider.name ?? 'openai');
    if (fallback) config.provider.model = fallback;
  }

  // 7. 校验配置
  const validation = validateConfig(config);

  // 8. 检查项目配置文件中的未知键（顶层未知键是配置写错，按 error 处理）
  try {
    const fileConfig = await loadConfigFromFile(filePath);
    const unknownKeys = findUnknownKeys(fileConfig, KNOWN_CONFIG_KEYS);
    for (const key of unknownKeys) {
      const suggestion = closestKey(key, KNOWN_CONFIG_KEYS);
      validation.errors.push({
        path: key,
        message: suggestion
          ? `Unknown configuration key "${key}". Did you mean "${suggestion}"?`
          : `Unknown configuration key "${key}".`,
        value: key,
      });
    }

    // 已知块内的未知键（0.3）：delegate.via_host、durable.*、serve.tls.*、mcpServers.<name>.* 等。
    const unknownNested = findUnknownNestedKeys(fileConfig as unknown as Record<string, unknown>);
    for (const { path, key, block } of unknownNested) {
      const candidates = KNOWN_BLOCK_KEYS[block] ?? [];
      const suggestion = closestKey(key, [...candidates]);
      validation.errors.push({
        path,
        message: suggestion
          ? `Unknown configuration key "${path}". Did you mean "${suggestion}"?`
          : `Unknown configuration key "${path}".`,
        value: key,
      });
    }
    validation.valid = validation.errors.length === 0;
  } catch {
    // 文件不存在，跳过
  }

  return { config, validation };
}

/** 简单编辑距离（用于未知键的拼写建议） */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(above + 1, (prev[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return prev[b.length] ?? 0;
}

/** 取编辑距离最近的已知键（距离 <= 3 才建议） */
function closestKey(key: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 4;
  for (const candidate of candidates) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 获取环境变量
 * @param name 变量名
 * @returns 变量值或 undefined
 */
function getEnvVar(name: string): string | undefined {
  return process.env[name];
}
