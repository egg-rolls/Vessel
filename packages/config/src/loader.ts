/**
 * Vessel 配置加载器
 * @module @vessel/config
 *
 * YAML 文件使用用户友好的 snake_case（api_key, base_url），TS 代码使用 camelCase（ADR-019）。
 * 加载器自动将 YAML 的 snake_case 键递归映射为 camelCase。
 *
 * 0.5 优先级（DECISION-010 §2.4 / §11.4）：
 * CLI > VESSEL_* env > tenant overlay > project > user > default
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG, DEFAULT_TENANT_ID, defaultModelForProvider } from './defaults.js';
import { resolveEnvRefsInLayer } from './secrets.js';
import type {
  ConfigLoadOptions,
  ConfigSource,
  ConfigSources,
  ConfigValidationError,
  ConfigValidationResult,
  ProviderConfig,
  UserConfig,
  VesselConfig,
} from './types.js';
import { deepMerge } from './utils.js';
import {
  findExplicitSecretPaths,
  TENANT_OVERLAY_ALLOWED_KEYS,
  validateConfig,
} from './validator.js';

type EnvMap = Record<string, string | undefined>;

/** 配置加载结果（0.5：新增 sources / paths / tenantId / tenantOverlayKeys） */
export interface ConfigLoadResult {
  config: VesselConfig;
  validation: ConfigValidationResult;
  /** 叶子键（camelCase 点路径）→ 来源；tenant overlay 命中的键不在此处 */
  sources: ConfigSources;
  paths: { user: string; project: string };
  tenantId: string;
  /** tenant overlay 命中的叶子键 */
  tenantOverlayKeys: string[];
}

/** 类型守卫：判断值是否为纯对象（非 null、非数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinPath(prefix: string, key: string): string {
  return prefix === '' ? key : `${prefix}.${key}`;
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
 * 需要原样保留键名的 map 路径（0.5 扩展到 serve.tokens / tenant.tenants 等）：
 * - mcpServers 第一层：server 名
 * - mcpServers.<name>.env / .headers：环境变量 / HTTP 头名
 * - serve.tokens：token 原文
 * - tenant.tenants：tenant id（允许 `_`）
 * - tenant.tenants.<id>.mcpServers 及其 env / headers
 */
export function preserveConfigMapKeys(path: string[], _key: string): boolean {
  if (path[0] === 'mcpServers') {
    if (path.length === 1) return true;
    return path.length === 3 && (path[2] === 'env' || path[2] === 'headers');
  }
  if (path[0] === 'serve' && path.length === 2 && path[1] === 'tokens') return true;
  if (path[0] === 'tenant') {
    if (path.length === 2 && path[1] === 'tenants') return true;
    const inTenant = path.length >= 5 && path[1] === 'tenants' && path[3] === 'mcpServers';
    if (!inTenant) return false;
    // tenant.tenants.<id>.mcpServers.<name> 的下一层是 server 名
    if (path.length === 4) return true;
    return path.length === 6 && (path[5] === 'env' || path[5] === 'headers');
  }
  return false;
}

/**
 * 兼容导出：mcpServers map 键保留（保留 0.4 的公开 API）。
 * 新代码请用 `preserveConfigMapKeys`。
 */
export function preserveMcpMapKeys(path: string[], key: string): boolean {
  if (path[0] === 'mcpServers') return preserveConfigMapKeys(path, key);
  return false;
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
 * 文件不存在、空文档（0 字节/纯空白/仅注释）或根节点不是对象时返回 fallback；
 * 解析失败时向上抛出。
 */
async function loadYamlConfig<T>(filePath: string, fallback: T): Promise<T> {
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return fallback;
  }

  const content = await file.text();
  const parsed: unknown = parseYaml(content);
  // parseYaml('') / 纯空白 → null；标量/数组不是合法配置根节点。
  if (parsed === null || parsed === undefined || !isRecord(parsed)) {
    return fallback;
  }
  return snakeToCamel<T>(parsed, { preserveKey: preserveConfigMapKeys });
}

/** 读取原始顶层对象；文件不存在或解析失败时返回 {}（保持 0.4 容错行为）。 */
async function loadRawConfig(filePath: string): Promise<Record<string, unknown>> {
  try {
    return await loadYamlConfig<Record<string, unknown>>(filePath, {});
  } catch {
    return {};
  }
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
 * @param env 环境变量来源（缺省 process.env）
 * @returns 配置对象
 */
export function loadConfigFromEnv(
  prefix = 'VESSEL_',
  env: EnvMap = process.env,
): Partial<VesselConfig> {
  const config: Partial<VesselConfig> = {};

  // API Key
  const apiKey = getEnvVar(env, `${prefix}API_KEY`);
  if (apiKey) {
    config.apiKey = apiKey;
  }

  // Provider
  const providerName = getEnvVar(env, `${prefix}PROVIDER`);
  const providerModel = getEnvVar(env, `${prefix}MODEL`);
  const providerBaseUrl = getEnvVar(env, `${prefix}BASE_URL`);
  const providerApiKey = getEnvVar(env, `${prefix}PROVIDER_API_KEY`);

  // PROVIDER_API_KEY 只配置了 provider 级 Key 时，同时回填顶层 apiKey——
  // bootstrap 只从顶层读 Key，否则这个变量会被静默忽略。
  if (providerApiKey && !config.apiKey) {
    config.apiKey = providerApiKey;
  }

  // A3：`name` 只在显式 VESSEL_PROVIDER 时写入。这里返回的是 env 层，
  // 后续与 project/user/default 深合并；若为其它字段凭空补 `openai`，
  // 会把项目配置里的 provider.name（如 anthropic）覆盖掉。
  const hasProviderFields =
    Boolean(providerName) ||
    Boolean(providerModel) ||
    Boolean(providerBaseUrl) ||
    Boolean(providerApiKey);
  const envProvider: Partial<ProviderConfig> = {};
  if (providerName) envProvider.name = providerName;
  if (providerModel) envProvider.model = providerModel;
  if (providerBaseUrl) envProvider.baseUrl = providerBaseUrl;
  // 兼容 0.x：provider 级 Key 之外的顶层 VESSEL_API_KEY 也回填到 provider。
  const providerEnvApiKey = providerApiKey ?? apiKey;
  if (hasProviderFields && providerEnvApiKey) envProvider.apiKey = providerEnvApiKey;

  // Temperature
  const temperature = getEnvVar(env, `${prefix}TEMPERATURE`);
  if (temperature) {
    const temp = Number.parseFloat(temperature);
    if (!Number.isNaN(temp)) envProvider.temperature = temp;
  }

  // Max tokens
  const maxTokens = getEnvVar(env, `${prefix}MAX_TOKENS`);
  if (maxTokens) {
    const tokens = Number.parseInt(maxTokens, 10);
    if (!Number.isNaN(tokens)) envProvider.maxTokens = tokens;
  }

  if (Object.keys(envProvider).length > 0) {
    config.provider = envProvider as ProviderConfig;
  }

  // 飞书凭据（0.4）：env 优先于配置文件；空串视为未设置，不覆盖文件值。
  const feishuAppId = getEnvVar(env, `${prefix}FEISHU_APP_ID`);
  const feishuAppSecret = getEnvVar(env, `${prefix}FEISHU_APP_SECRET`);
  if (feishuAppId || feishuAppSecret) {
    config.feishu = {
      ...(feishuAppId ? { appId: feishuAppId } : {}),
      ...(feishuAppSecret ? { appSecret: feishuAppSecret } : {}),
    };
  }

  // 0.6.1：session backend（file / sqlite / memory）。非法值留给 validator 报错。
  const sessionBackend = getEnvVar(env, `${prefix}SESSION_BACKEND`);
  if (sessionBackend !== undefined && sessionBackend.trim() !== '') {
    config.session = {
      ...(config.session ?? {}),
      backend: sessionBackend.trim() as NonNullable<VesselConfig['session']>['backend'],
    };
  }

  // 0.6.1：插件启停（逗号分隔的插件名；整体替换 YAML 列表，符合 env > config）。
  const pluginsRaw = getEnvVar(env, `${prefix}PLUGINS`);
  if (pluginsRaw !== undefined && pluginsRaw.trim() !== '') {
    config.plugins = pluginsRaw
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '')
      .map((name) => ({ name, enabled: true }));
  }

  // 0.5：全局数据根。VESSEL_TENANT 不写入 config，只参与 tenant 解析。
  const dataDir = getEnvVar(env, `${prefix}DATA_DIR`);
  if (dataDir) {
    config.dataDir = dataDir;
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

/** 删除某个叶子/子树的所有来源记录（对象被整体替换时） */
function removeSourcePrefix(sources: ConfigSources, prefix: string): void {
  for (const key of Object.keys(sources)) {
    if (key === prefix || key.startsWith(`${prefix}.`)) delete sources[key];
  }
}

/**
 * 应用一层配置并记录叶子来源。
 * - 对象递归；数组/标量整体替换（与 deepMerge 一致）；
 * - undefined 不覆盖；对象本身不出现在 sources；
 * - 就地修改 base 并返回。
 */
export function applyLayerWithSources(
  base: VesselConfig,
  layer: Partial<VesselConfig>,
  source: ConfigSource,
  sources: ConfigSources,
  prefix = '',
): VesselConfig {
  applyLayerRecord(
    base as Record<string, unknown>,
    layer as Record<string, unknown>,
    source,
    sources,
    prefix,
  );
  return base;
}

function applyLayerRecord(
  target: Record<string, unknown>,
  layer: Record<string, unknown>,
  source: ConfigSource,
  sources: ConfigSources,
  prefix: string,
): void {
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue;
    const fullPath = joinPath(prefix, key);
    const current = target[key];

    if (isRecord(value)) {
      if (isRecord(current)) {
        applyLayerRecord(current, value, source, sources, fullPath);
      } else {
        const created: Record<string, unknown> = {};
        target[key] = created;
        applyLayerRecord(created, value, source, sources, fullPath);
      }
      continue;
    }

    if (isRecord(current)) removeSourcePrefix(sources, fullPath);
    target[key] = structuredClone(value);
    sources[fullPath] = source;
  }
}

/** 应用 tenant overlay：记录命中键；覆盖的叶子从基础 sources 中移除。 */
function applyOverlayRecord(
  target: Record<string, unknown>,
  overlay: Record<string, unknown>,
  overlayKeys: string[],
  sources: ConfigSources,
  prefix: string,
): void {
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const fullPath = joinPath(prefix, key);
    const current = target[key];

    if (isRecord(value)) {
      if (isRecord(current)) {
        applyOverlayRecord(current, value, overlayKeys, sources, fullPath);
      } else {
        const created: Record<string, unknown> = {};
        target[key] = created;
        applyOverlayRecord(created, value, overlayKeys, sources, fullPath);
      }
      continue;
    }

    removeSourcePrefix(sources, fullPath);
    target[key] = structuredClone(value);
    overlayKeys.push(fullPath);
  }
}

/** 去掉 overlay 内的 null（null 不进入合并，由校验报错） */
function stripNulls(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) {
    const items = value.filter((item) => item !== null);
    return items.length === value.length ? value : items;
  }
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const stripped = stripNulls(child);
    if (stripped !== undefined) result[key] = stripped;
  }
  return result;
}

/** overlay 只合并白名单内的块；tools/quota 由 tenant 层单独消费。 */
function sanitizeTenantOverlay(overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of TENANT_OVERLAY_ALLOWED_KEYS) {
    if (key === 'tools' || key === 'quota') continue;
    const value = overlay[key];
    if (value === undefined) continue;
    const stripped = stripNulls(value);
    if (stripped !== undefined) result[key] = stripped;
  }
  return result;
}

/**
 * 0.4 legacy 用户键 → VesselConfig 层。
 * 白名单：default_provider / default_model / providers（camelCase 等价）。
 */
function legacyUserLayer(user: Record<string, unknown>): Partial<VesselConfig> {
  const layer: Partial<VesselConfig> = {};

  if (typeof user.apiKey === 'string' && user.apiKey !== '') {
    layer.apiKey = user.apiKey;
  }

  const providers = isRecord(user.providers) ? user.providers : undefined;
  const defaultProvider =
    typeof user.defaultProvider === 'string' ? user.defaultProvider : undefined;
  const providerName = defaultProvider ?? (providers ? Object.keys(providers)[0] : undefined);

  if (providerName !== undefined && providers && isRecord(providers[providerName])) {
    const provider = providers[providerName] as Record<string, unknown>;
    const model =
      (typeof user.defaultModel === 'string' ? user.defaultModel : undefined) ??
      (typeof provider.model === 'string' ? provider.model : undefined);
    layer.provider = {
      name: defaultProvider ?? providerName,
      ...(typeof provider.apiKey === 'string' ? { apiKey: provider.apiKey } : {}),
      ...(typeof provider.baseUrl === 'string' ? { baseUrl: provider.baseUrl } : {}),
      ...(model !== undefined ? { model } : {}),
    };
  } else if (defaultProvider !== undefined) {
    layer.provider = { name: defaultProvider };
  }

  return layer;
}

/** 去掉 legacy-only 键，剩余的完整 VesselConfig 键作为 user 层 */
function fullUserLayer(user: Record<string, unknown>): Record<string, unknown> {
  const layer: Record<string, unknown> = { ...user };
  delete layer.defaultProvider;
  delete layer.defaultModel;
  delete layer.providers;
  return layer;
}

function prefixErrors(errors: ConfigValidationError[], prefix: string): ConfigValidationError[] {
  if (prefix === '') return errors;
  return errors.map((error) => ({ ...error, path: joinPath(prefix, error.path) }));
}

/** 项目层显式密钥 → error（A-3 §10.6；消息不带值） */
function projectSecretErrors(layer: Record<string, unknown>): ConfigValidationError[] {
  return findExplicitSecretPaths(layer).map((path) => ({
    path,
    message: 'Project config must not contain secrets; use the _env form instead',
  }));
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * 加载配置（综合加载）
 * 优先级：CLI flag > env (VESSEL_*) > tenant overlay > vessel.yaml >
 *         ~/.vessel/config.yaml > 安全默认
 * @param options 加载选项
 * @returns 配置对象、校验结果、来源与 tenant 信息
 */
export async function loadConfig(options: ConfigLoadOptions = {}): Promise<ConfigLoadResult> {
  const env: EnvMap = options.env ?? process.env;
  const envPrefix = options.envPrefix ?? 'VESSEL_';
  const projectPath = options.configPath ?? 'vessel.yaml';
  const userPath = options.userConfigPath ?? getUserConfigPath();

  const sources: ConfigSources = {};
  const overlayKeys: string[] = [];
  const preErrors: ConfigValidationError[] = [];

  // 1. 默认配置（source=default）
  const config = applyLayerWithSources({} as VesselConfig, DEFAULT_CONFIG, 'default', sources);

  // 2. 用户层：legacy 映射 + 完整 config 键（source=user）
  const rawUser = await loadRawConfig(userPath);
  const legacyLayer = legacyUserLayer(rawUser);
  applyLayerWithSources(config, legacyLayer, 'user', sources);

  const fullUser = fullUserLayer(rawUser);
  const resolvedUser = resolveEnvRefsInLayer(fullUser, env);
  applyLayerWithSources(config, resolvedUser.layer, 'user', sources);
  for (const key of Object.keys(resolvedUser.resolved)) sources[key] = 'env';
  preErrors.push(...resolvedUser.errors);

  // 3. 项目层：./vessel.yaml（source=project；_env 按层解析）
  const rawProject = await loadRawConfig(projectPath);
  const resolvedProject = resolveEnvRefsInLayer(rawProject as Partial<VesselConfig>, env);
  applyLayerWithSources(config, resolvedProject.layer, 'project', sources);
  for (const key of Object.keys(resolvedProject.resolved)) sources[key] = 'env';
  preErrors.push(...resolvedProject.errors);
  preErrors.push(...projectSecretErrors(rawProject));

  // 4. 解析 tenant id（CLI > VESSEL_TENANT > config.tenant.default > default）
  //    VESSEL_TENANT 不写入 config。
  const tenantId =
    firstNonEmpty(options.tenantId, env[`${envPrefix}TENANT`], config.tenant?.default) ??
    DEFAULT_TENANT_ID;

  // 5. tenant overlay（只覆盖 project/user；env/CLI 仍在其后入层）
  const overlay = config.tenant?.tenants?.[tenantId]?.config;
  if (overlay && isRecord(overlay)) {
    const overlayPath = `tenant.tenants.${tenantId}.config`;
    const resolvedOverlay = resolveEnvRefsInLayer(overlay as Partial<VesselConfig>, env);
    preErrors.push(...prefixErrors(resolvedOverlay.errors, overlayPath));

    const sanitized = sanitizeTenantOverlay(resolvedOverlay.layer as Record<string, unknown>);
    applyOverlayRecord(
      config as unknown as Record<string, unknown>,
      sanitized,
      overlayKeys,
      sources,
      '',
    );
  }

  // 6. env 层（source=env）
  const envConfig = loadConfigFromEnv(envPrefix, env);
  const resolvedEnv = resolveEnvRefsInLayer(envConfig, env);
  applyLayerWithSources(config, resolvedEnv.layer, 'env', sources);
  for (const key of Object.keys(resolvedEnv.resolved)) sources[key] = 'env';
  preErrors.push(...resolvedEnv.errors);

  // 7. CLI 层（source=cli）
  if (options.defaults) {
    const resolvedCli = resolveEnvRefsInLayer(options.defaults, env);
    applyLayerWithSources(config, resolvedCli.layer, 'cli', sources);
    for (const key of Object.keys(resolvedCli.resolved)) sources[key] = 'env';
    preErrors.push(...resolvedCli.errors);
  }

  // 8. provider-aware 默认 model：只给已知 provider 补默认。
  if (config.provider && !config.provider.model) {
    const fallback = defaultModelForProvider(config.provider.name ?? 'openai');
    if (fallback) {
      config.provider.model = fallback;
      sources['provider.model'] = 'default';
    }
  }

  // 9. 校验配置（含未知键、项目密钥、overlay 白名单）
  const validation = validateConfig(config);
  if (preErrors.length > 0) {
    validation.errors.push(...preErrors);
    validation.valid = validation.errors.length === 0;
  }

  return {
    config,
    validation,
    sources,
    paths: { user: userPath, project: projectPath },
    tenantId,
    tenantOverlayKeys: overlayKeys,
  };
}

/**
 * 获取环境变量
 * @param env 环境变量来源
 * @param name 变量名
 * @returns 变量值或 undefined
 */
function getEnvVar(env: EnvMap, name: string): string | undefined {
  return env[name];
}
