/**
 * Vessel 配置加载器
 * @module @vessel-agent/config
 *
 * YAML 文件使用用户友好的 snake_case（api_key, base_url），TS 代码使用 camelCase（ADR-019）。
 * 加载器自动将 YAML 的 snake_case 键递归映射为 camelCase。
 *
 * 0.5 优先级（DECISION-010 §2.4 / §11.4）：
 * CLI > VESSEL_* env > project > user > default
 *
 * 0.49 T4：tenant 块 / overlay / 单 id 输入已删除；解析结果 `tenantId` 是内部
 * 单公司常量（C0），不再是用户可配置维度。
 */

import { stat } from 'node:fs/promises';
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
  ConfigValidationWarning,
  ProviderConfig,
  UserConfig,
  VesselConfig,
} from './types.js';
import { deepMerge } from './utils.js';
import { findExplicitSecretPaths, validateConfig } from './validator.js';

type EnvMap = Record<string, string | undefined>;

/** 配置加载结果（0.5：sources / paths / tenantId；0.49 T4 删除 tenantOverlayKeys） */
export interface ConfigLoadResult {
  config: VesselConfig;
  validation: ConfigValidationResult;
  /** 叶子键（camelCase 点路径）→ 来源 */
  sources: ConfigSources;
  paths: { user: string; project: string };
  /** 内部单公司 id（C0：供路径段 / principal 使用，不是用户可配置维度） */
  tenantId: string;
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
 * 需要原样保留键名的 map 路径（0.5）：
 * - mcpServers 第一层：server 名
 * - mcpServers.<name>.env / .headers：环境变量 / HTTP 头名
 * - serve.tokens：token 原文
 * - pricing.models：模型名（常含 `/`、`.`，不能按 snake_case 改写）
 */
export function preserveConfigMapKeys(path: string[], _key: string): boolean {
  if (path[0] === 'mcpServers') {
    if (path.length === 1) return true;
    return path.length === 3 && (path[2] === 'env' || path[2] === 'headers');
  }
  if (path[0] === 'serve' && path.length === 2 && path[1] === 'tokens') return true;
  if (path[0] === 'pricing' && path.length === 2 && path[1] === 'models') return true;
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
/**
 * 用户配置路径（`~/.vessel/config.yaml`）。
 *
 * `VESSEL_USER_CONFIG` 可以整体替换它 —— 这是给**隔离运行**用的（同一台机器上跑
 * 第二套环境、或端到端验证「用户什么都没配」）。`vessel --user-config <path>`
 * 就是把参数落到这个环境变量上，从而对所有命令、以及它们 spawn 的子进程
 * （daemon / node / hub）一致生效。
 *
 * 注意：显式指定时**必须存在**，`loadConfig` 会对「显式给了但读不到」直接报错
 * —— 否则会出现「以为验的是空配置，其实还是读了真配置」这种假绿。
 */
export function getUserConfigPath(): string {
  const override = (process.env.VESSEL_USER_CONFIG ?? '').trim();
  if (override !== '') return path.resolve(override);
  return path.join(getUserConfigDir(), 'config.yaml');
}

/**
 * 从 YAML 文件加载并解析配置，做 snake→camel 映射。
 * 文件不存在（ENOENT）、空文档（0 字节/纯空白/仅注释）或根节点不是对象时返回 fallback；
 * 其它读取/解析错误向上抛出（DECISION-020 §R1.3：不得静默回落默认配置）。
 */
async function loadYamlConfig<T>(filePath: string, fallback: T): Promise<T> {
  let content: string;
  try {
    content = await Bun.file(filePath).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }

  const parsed: unknown = parseYaml(content);
  // parseYaml('') / 纯空白 → null；标量/数组不是合法配置根节点。
  if (parsed === null || parsed === undefined || !isRecord(parsed)) {
    return fallback;
  }
  return snakeToCamel<T>(parsed, { preserveKey: preserveConfigMapKeys });
}

/** 把 YAML / IO 错误转成带文件路径（与行号）的校验错误。 */
function configFileError(filePath: string, error: unknown): ConfigValidationError {
  const message = error instanceof Error ? error.message : String(error);
  // yaml 的 YAMLParseError.message 首行形如
  // `Map keys must be unique at line 2, column 1:`，已包含位置。
  const firstLine = message.split('\n', 1)[0] ?? 'Unknown parse error';
  return { path: filePath, message: `YAML parse error: ${firstLine}` };
}

/** 文件是否存在（只判存在，不读内容；ENOENT → false）。 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 读取原始顶层对象；只有 ENOENT 当缺省，其它读取/解析错误记入 validation。 */
async function loadRawConfig(
  filePath: string,
): Promise<{ raw: Record<string, unknown>; error?: ConfigValidationError }> {
  try {
    return { raw: await loadYamlConfig<Record<string, unknown>>(filePath, {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: {} };
    return { raw: {}, error: configFileError(filePath, error) };
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

  // 0.6：connect 客户端 token / CA。CLI 层由 `cliOverrides` 覆盖；
  // `VESSEL_GATEWAY_TOKEN` 作为 token 的最后 env 回退（与 0.6 行为一致）。
  const connectToken = getEnvVar(env, `${prefix}CONNECT_TOKEN`);
  const gatewayToken = getEnvVar(env, `${prefix}GATEWAY_TOKEN`);
  const connectCa = getEnvVar(env, `${prefix}CONNECT_CA`);
  if (connectToken || gatewayToken || connectCa) {
    config.connect = {
      ...(connectToken ? { token: connectToken } : gatewayToken ? { token: gatewayToken } : {}),
      ...(connectCa ? { caFile: connectCa } : {}),
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

/**
 * 0.56：`node:` 段归一化。
 *
 * `node:` 是规范新名（对应 `vessel node start`；`vessel serve` 早已不存在），
 * `serve:` 退化为兼容别名。归一化规则（冻结）：
 *
 * - 两段都不在 → 什么都不做；
 * - 只有 `node:` → 内容搬到 `serve:`（**不警告**：这是规范写法）；
 * - 两段都在 → **`node:` 赢**，被覆盖的 `serve:` 键逐项列进 warning；
 * - 只有 `serve:` → 原样保留，并给一条弃用警告（0.57 移除）。
 *
 * 为什么在**每一层**归一化而不是合并后归一化：`_env` 解析（`node.token_env` →
 * `node.token`）与分层优先级都作用在层上；先归一化能让 `node:` 拿到与 `serve:`
 * 完全一致的语义，运行时也只有一份真源（`config.serve`）。
 */
function normalizeNodeLayer(layer: Record<string, unknown>): {
  layer: Record<string, unknown>;
  shadowed: string[];
  hadServe: boolean;
  hadNode: boolean;
} {
  const hadServe = isRecord(layer.serve);
  const hadNode = isRecord(layer.node);
  if (!hadNode) return { layer, shadowed: [], hadServe, hadNode };

  const nodeBlock = layer.node as Record<string, unknown>;
  const serveBlock = hadServe ? (layer.serve as Record<string, unknown>) : {};
  const shadowed = Object.keys(nodeBlock).filter((key) => key in serveBlock);
  const merged: Record<string, unknown> = { ...serveBlock, ...nodeBlock };
  const next: Record<string, unknown> = { ...layer, serve: merged };
  // `node` 不进入运行时的配置对象：只保留一份真源，避免两处不一致。
  delete next.node;
  return {
    layer: next,
    shadowed: shadowed.filter((key) => nodeBlock[key] !== undefined),
    hadServe,
    hadNode,
  };
}

/**
 * 0.56：一层的 `node:` / `serve:` 相关警告（不回显任何 token 值）。
 *
 * @param label 人类可读的来源名（"user config" / "project config"），进文案。
 */
function nodeAliasWarnings(
  normalized: { shadowed: string[]; hadServe: boolean; hadNode: boolean },
  label: string,
): ConfigValidationWarning[] {
  if (!normalized.hadNode && !normalized.hadServe) return [];
  if (normalized.hadNode && normalized.shadowed.length > 0) {
    return [
      {
        path: 'node',
        message:
          `Both "node:" and "serve:" are set in the ${label}; "node:" wins and ` +
          `serve.{${normalized.shadowed.join(',')}} is ignored. Delete the "serve:" block ` +
          '(0.57 removes the "serve:" alias).',
      },
    ];
  }
  if (normalized.hadNode) return [];
  return [
    {
      path: 'serve',
      message:
        `The "serve:" block in the ${label} is deprecated: there is no "vessel serve" ` +
        'command any more. Rename "serve:" to "node:" (same keys, same behaviour). ' +
        '0.57 removes "serve:".',
    },
  ];
}

/** 用户配置中出现的 legacy provider 键（snake_case 名称，用于 warning）。 */
function legacyProviderKeys(user: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const has = (key: string): boolean => Object.hasOwn(user, key);
  if (has('defaultProvider')) keys.push('default_provider');
  if (has('defaultModel')) keys.push('default_model');
  if (has('providers')) keys.push('providers');
  return keys;
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

/** 项目层显式密钥 → error（A-3 §10.6；消息不带值） */
function projectSecretErrors(layer: Record<string, unknown>): ConfigValidationError[] {
  return findExplicitSecretPaths(layer).map((path) => ({
    path,
    message: 'Project config must not contain secrets; use the _env form instead',
  }));
}

/**
 * 加载配置（综合加载）
 * 优先级：CLI flag > env (VESSEL_*) > vessel.yaml > ~/.vessel/config.yaml > 安全默认
 * @param options 加载选项
 * @returns 配置对象、校验结果、来源与内部单公司 id
 */
export async function loadConfig(options: ConfigLoadOptions = {}): Promise<ConfigLoadResult> {
  const env: EnvMap = options.env ?? process.env;
  const envPrefix = options.envPrefix ?? 'VESSEL_';
  const projectPath = options.configPath ?? 'vessel.yaml';
  // `options.userConfigPath`（程序入口显式给）或 `VESSEL_USER_CONFIG`（CLI
  // `--user-config` 落到这里，好让 spawn 的子进程也一致）：两者都算「显式指定」，
  // 显式指定但文件不存在 → 报错，**绝不**静默回落成空配置（那会读出真配置还以为在验空配置）。
  const explicitUserPath = (() => {
    const fromOption = options.userConfigPath;
    if (fromOption !== undefined && fromOption.trim() !== '') return path.resolve(fromOption);
    const fromEnv = (env.VESSEL_USER_CONFIG ?? '').trim();
    return fromEnv !== '' ? path.resolve(fromEnv) : undefined;
  })();
  const userPath = explicitUserPath ?? getUserConfigPath();

  const sources: ConfigSources = {};
  const preErrors: ConfigValidationError[] = [];
  const preWarnings: ConfigValidationWarning[] = [];

  // 1. 默认配置（source=default）
  const config = applyLayerWithSources({} as VesselConfig, DEFAULT_CONFIG, 'default', sources);

  // 2. 用户层：legacy 映射 + 完整 config 键（source=user）
  const userFile = await loadRawConfig(userPath);
  if (userFile.error) preErrors.push(userFile.error);
  if (explicitUserPath !== undefined && !(await pathExists(explicitUserPath))) {
    preErrors.push({
      path: 'user_config',
      message:
        `user config ${explicitUserPath} does not exist. ` +
        'It was given explicitly (--user-config or VESSEL_USER_CONFIG), so it must exist; ' +
        'refusing to fall back — an empty/missing explicit file almost always means you are ' +
        'still validating the real config by accident. Create it (an empty file is fine) or ' +
        'drop the flag.',
    });
  }
  const rawUser = userFile.raw;
  // 同层出现新版 `provider:` 时 legacy 键整体忽略（DECISION-020 §R1.4）。
  const hasNewProvider = isRecord(rawUser.provider);
  const legacyKeys = legacyProviderKeys(rawUser);
  if (!hasNewProvider) {
    applyLayerWithSources(config, legacyUserLayer(rawUser), 'user', sources);
  }
  if (legacyKeys.length > 0) {
    preWarnings.push({
      path: 'provider',
      message: hasNewProvider
        ? `Legacy provider keys (${legacyKeys.join(', ')}) are ignored because "provider:" is configured in the same file.`
        : `Legacy provider keys (${legacyKeys.join(', ')}) are deprecated; migrate to the "provider:" block.`,
    });
  }

  const fullUser = fullUserLayer(rawUser);
  // 0.56：`node:`（规范名）→ `serve:`（运行时真源），并给出弃用 / 覆盖警告。
  const userAlias = normalizeNodeLayer(fullUser);
  preWarnings.push(...nodeAliasWarnings(userAlias, 'user config'));
  const resolvedUser = resolveEnvRefsInLayer(userAlias.layer as Partial<VesselConfig>, env);
  applyLayerWithSources(config, resolvedUser.layer, 'user', sources);
  for (const key of Object.keys(resolvedUser.resolved)) sources[key] = 'env';
  preErrors.push(...resolvedUser.errors);

  // 3. 项目层：./vessel.yaml（source=project；_env 按层解析）
  const projectFile = await loadRawConfig(projectPath);
  if (projectFile.error) preErrors.push(projectFile.error);
  const rawProject = projectFile.raw;
  const projectAlias = normalizeNodeLayer(rawProject);
  preWarnings.push(...nodeAliasWarnings(projectAlias, 'project config'));
  const resolvedProject = resolveEnvRefsInLayer(projectAlias.layer as Partial<VesselConfig>, env);
  applyLayerWithSources(config, resolvedProject.layer, 'project', sources);
  for (const key of Object.keys(resolvedProject.resolved)) sources[key] = 'env';
  preErrors.push(...resolvedProject.errors);
  preErrors.push(...projectSecretErrors(rawProject));

  // 4. 单公司 id：T4 删除 tenant 块 / --tenant / VESSEL_TENANT 输入后，
  //    解析结果固定为内部常量（C0），仅供路径段与 principal 使用。
  const tenantId = DEFAULT_TENANT_ID;

  // 5. env 层（source=env）
  const envConfig = loadConfigFromEnv(envPrefix, env);
  const resolvedEnv = resolveEnvRefsInLayer(envConfig, env);
  applyLayerWithSources(config, resolvedEnv.layer, 'env', sources);
  for (const key of Object.keys(resolvedEnv.resolved)) sources[key] = 'env';
  preErrors.push(...resolvedEnv.errors);

  // 6. CLI 层（source=cli）：`defaults`（deprecated）先应用，`cliOverrides` 覆盖。
  for (const cliLayer of [options.defaults, options.cliOverrides]) {
    if (!cliLayer) continue;
    const resolvedCli = resolveEnvRefsInLayer(cliLayer, env);
    applyLayerWithSources(config, resolvedCli.layer, 'cli', sources);
    for (const key of Object.keys(resolvedCli.resolved)) sources[key] = 'env';
    preErrors.push(...resolvedCli.errors);
  }

  // 7. provider-aware 默认 model：只给已知 provider 补默认。
  if (config.provider && !config.provider.model) {
    const fallback = defaultModelForProvider(config.provider.name ?? 'openai');
    if (fallback) {
      config.provider.model = fallback;
      sources['provider.model'] = 'default';
    }
  }

  // 8. 校验配置（含未知键、项目密钥、已删除的 tenant 键 fail-fast）
  const validation = validateConfig(config);
  if (preErrors.length > 0) {
    validation.errors.push(...preErrors);
    validation.valid = validation.errors.length === 0;
  }
  if (preWarnings.length > 0) validation.warnings.push(...preWarnings);

  return {
    config,
    validation,
    sources,
    paths: { user: userPath, project: projectPath },
    tenantId,
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
