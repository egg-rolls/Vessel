/**
 * 配置密钥间接引用（_env）与脱敏
 * @module @vessel/config
 *
 * 规则见 DECISION-010 §2.4 / §11.5 与 PLAN-0.5.0-asm §3.3：
 * - 同层显式非空值优先；
 * - 显式为空/未设时读 `<field>_env>` 指向的环境变量；
 * - env 名必须匹配 ^[A-Za-z_][A-Za-z0-9_]{0,127}$；
 * - 未定义 / 空串报错，不静默回退；0.5 不做 `${VAR}` 插值。
 */

import type { ConfigValidationError, VesselConfig } from './types.js';

/** 合法的环境变量名 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** MCP env / headers 的间接引用键：`<NAME>_env` */
const MCP_ENV_REF_RE = /^(.+)_env$/;

/** 密钥解析状态 */
export type SecretState =
  | { state: 'set'; value: string; envRef?: string }
  | { state: 'unset'; envRef?: string }
  | {
      state: 'error';
      envRef: string;
      code: 'config_env_invalid' | 'config_env_missing' | 'config_env_empty';
      message: string;
    };

/** `resolveEnvRefsInLayer` 的结果 */
export interface ResolveEnvRefsResult {
  /** 解析后的新 layer（不修改入参） */
  layer: Partial<VesselConfig>;
  errors: ConfigValidationError[];
  /**
   * 由 `_env` 解析出的键路径（camelCase 点路径）→ 环境变量名。
   * 只记录变量名，不记录解析后的值。
   */
  resolved: Record<string, string>;
}

type EnvMap = Record<string, string | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinPath(prefix: string, key: string): string {
  return prefix === '' ? key : `${prefix}.${key}`;
}

/**
 * 解析单个密钥字段的最终值。
 *
 * 显式非空值优先；否则读 `envRef` 指向的环境变量。
 * 返回状态而不抛出，调用方决定是否把 error 累加进校验结果。
 */
export function resolveSecret(input: {
  value?: string;
  envRef?: string;
  env?: EnvMap;
}): SecretState {
  const env = input.env ?? process.env;
  const { value, envRef } = input;

  // 1. 同层显式非空值优先；`_env` 被忽略（即使名字非法也不报错）。
  if (typeof value === 'string' && value !== '') {
    return { state: 'set', value };
  }

  // 2. 未配置间接引用：交给既有必填校验决定是否报错。
  if (envRef === undefined || envRef === '') {
    return { state: 'unset' };
  }

  // 3. 变量名必须合法。
  if (typeof envRef !== 'string' || !ENV_NAME_RE.test(envRef)) {
    return {
      state: 'error',
      envRef: String(envRef),
      code: 'config_env_invalid',
      message:
        'Invalid environment variable name referenced by "_env"; expected ' +
        `^[A-Za-z_][A-Za-z0-9_]{0,127}$ (got "${String(envRef)}")`,
    };
  }

  // 4. 变量未定义 / 空串都是错误，不静默回退。
  const resolvedValue = env[envRef];
  if (resolvedValue === undefined) {
    return {
      state: 'error',
      envRef,
      code: 'config_env_missing',
      message: `Environment variable "${envRef}" is not set`,
    };
  }
  if (resolvedValue === '') {
    return {
      state: 'error',
      envRef,
      code: 'config_env_empty',
      message: `Environment variable "${envRef}" is set but empty`,
    };
  }

  return { state: 'set', value: resolvedValue, envRef };
}

/**
 * provider 实际生效的 API Key。
 *
 * 优先级（DECISION-020 §R1.2 冻结）：
 * `provider.apiKey` → `provider.apiKeyEnv` 解析值 → `config.apiKey` → `config.apiKeyEnv` 解析值。
 * 空串 / 纯空白视为未设置。`loadConfig` 已把 `_env` 解析进同层明文值，此函数同时兜住
 * 直接构造的配置（向导、测试、`doctor` 注入 env）。
 *
 * @param config 顶层配置（至少含 apiKey / apiKeyEnv / provider）
 * @param env 环境变量来源（缺省 process.env）
 */
export function resolveEffectiveApiKey(
  config: Pick<VesselConfig, 'apiKey' | 'apiKeyEnv' | 'provider'>,
  env: EnvMap = process.env,
): string | undefined {
  const provider = config.provider;
  return (
    nonEmptySecret(provider?.apiKey) ??
    nonEmptySecret(provider?.apiKeyEnv ? env[provider.apiKeyEnv] : undefined) ??
    nonEmptySecret(config.apiKey) ??
    nonEmptySecret(config.apiKeyEnv ? env[config.apiKeyEnv] : undefined)
  );
}

/** 非空字符串（纯空白不算；返回值不 trim，避免改动密钥本身） */
function nonEmptySecret(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 解析一对明文/间接字段（camelCase：valueKey / refKey）。 */
function resolvePair(
  owner: Record<string, unknown>,
  valueKey: string,
  refKey: string,
  pathPrefix: string,
  env: EnvMap,
  errors: ConfigValidationError[],
  resolved: Record<string, string>,
): void {
  const current = owner[valueKey];
  const envRef = owner[refKey];

  // 显式非空值优先（非字符串定义值同样视为显式，交给 validator 报类型错误）。
  if (current !== undefined && current !== '') return;
  if (typeof envRef !== 'string' || envRef === '') return;

  const state = resolveSecret({
    value: typeof current === 'string' ? current : undefined,
    envRef,
    env,
  });
  const refPath = joinPath(pathPrefix, refKey);

  if (state.state === 'error') {
    errors.push({ path: refPath, message: state.message });
    return;
  }
  if (state.state === 'set') {
    owner[valueKey] = state.value;
    resolved[joinPath(pathPrefix, valueKey)] = envRef;
  }
}

/** 在 headers map 中按大小写不敏感查找已存在的目标键（保留原文）。 */
function findHeaderKey(map: Record<string, unknown>, target: string): string | undefined {
  const lowered = target.toLowerCase();
  return Object.keys(map).find((key) => key.toLowerCase() === lowered);
}

/**
 * 处理一个 MCP server 的 env / headers map：
 * `<NAME>_env` → 解析为 `<NAME>`，并从最终配置中移除 `_env` 键。
 */
function resolveMcpMap(
  server: Record<string, unknown>,
  mapKey: 'env' | 'headers',
  basePath: string,
  env: EnvMap,
  errors: ConfigValidationError[],
  resolved: Record<string, string>,
): void {
  const map = server[mapKey];
  if (!isRecord(map)) return;

  const mapPath = joinPath(basePath, mapKey);

  for (const refKey of Object.keys(map)) {
    if (!MCP_ENV_REF_RE.test(refKey)) continue;

    const target = refKey.slice(0, -'_env'.length);
    const envRef = map[refKey];
    const refPath = joinPath(mapPath, refKey);

    // `_env` 只是间接引用，不进入最终配置。
    delete map[refKey];

    if (typeof envRef !== 'string' || envRef === '') {
      errors.push({
        path: refPath,
        message: `Environment variable name referenced by "${refKey}" must be a non-empty string`,
      });
      continue;
    }

    // 同层显式目标键优先（headers 大小写不敏感）。
    const targetKey = mapKey === 'headers' ? findHeaderKey(map, target) : target;
    const current = targetKey === undefined ? undefined : map[targetKey];
    if (current !== undefined && current !== '') continue;

    const state = resolveSecret({
      value: typeof current === 'string' ? current : undefined,
      envRef,
      env,
    });
    if (state.state === 'error') {
      errors.push({ path: refPath, message: state.message });
      continue;
    }
    if (state.state === 'set') {
      const finalKey = targetKey ?? target;
      map[finalKey] = state.value;
      resolved[joinPath(mapPath, finalKey)] = envRef;
    }
  }
}

/** 解析一个配置对象内的简单 `_env` 字段（含 tenant overlay 前缀）。 */
function resolveSimpleSecrets(
  config: Record<string, unknown>,
  prefix: string,
  env: EnvMap,
  errors: ConfigValidationError[],
  resolved: Record<string, string>,
): void {
  resolvePair(config, 'apiKey', 'apiKeyEnv', prefix, env, errors, resolved);

  const provider = config.provider;
  if (isRecord(provider)) {
    resolvePair(
      provider,
      'apiKey',
      'apiKeyEnv',
      joinPath(prefix, 'provider'),
      env,
      errors,
      resolved,
    );
  }

  const feishu = config.feishu;
  if (isRecord(feishu)) {
    resolvePair(
      feishu,
      'appSecret',
      'appSecretEnv',
      joinPath(prefix, 'feishu'),
      env,
      errors,
      resolved,
    );
  }

  const serve = config.serve;
  if (isRecord(serve)) {
    const servePath = joinPath(prefix, 'serve');
    resolvePair(serve, 'token', 'tokenEnv', servePath, env, errors, resolved);
    resolvePair(serve, 'adminToken', 'adminTokenEnv', servePath, env, errors, resolved);
  }

  // 0.6：connect.token_env → connect.token
  const connect = config.connect;
  if (isRecord(connect)) {
    resolvePair(connect, 'token', 'tokenEnv', joinPath(prefix, 'connect'), env, errors, resolved);
  }

  // 0.6：transport.nodes[i].token_env → token（数组路径用于错误定位）
  const transport = config.transport;
  if (isRecord(transport) && Array.isArray(transport.nodes)) {
    transport.nodes.forEach((node, index) => {
      if (!isRecord(node)) return;
      resolvePair(
        node,
        'token',
        'tokenEnv',
        joinPath(joinPath(prefix, 'transport'), `nodes[${index}]`),
        env,
        errors,
        resolved,
      );
    });
  }
}

/** 解析一个配置对象内的 mcpServers（含 tenant overlay 前缀）。 */
function resolveMcpServers(
  config: Record<string, unknown>,
  prefix: string,
  env: EnvMap,
  errors: ConfigValidationError[],
  resolved: Record<string, string>,
): void {
  const servers = config.mcpServers;
  if (!isRecord(servers)) return;

  for (const [name, server] of Object.entries(servers)) {
    if (!isRecord(server)) continue;
    const basePath = joinPath(joinPath(prefix, 'mcpServers'), name);
    resolveMcpMap(server, 'env', basePath, env, errors, resolved);
    resolveMcpMap(server, 'headers', basePath, env, errors, resolved);
  }
}

/**
 * 按层解析 `_env` 间接引用，返回新 layer（入参不被修改）。
 *
 * 支持：
 * - `apiKey` / `provider.apiKey` / `feishu.appSecret` / `serve.token` / `serve.adminToken`
 * - `mcpServers.<name>.env.<KEY>` 与 `.headers.<Header>`
 * - tenant overlay：`tenant.tenants.<id>.config.*` 内的同名路径
 */
export function resolveEnvRefsInLayer(
  layer: Partial<VesselConfig>,
  env: EnvMap = process.env,
): ResolveEnvRefsResult {
  const cloned = structuredClone(layer) as Record<string, unknown>;
  const errors: ConfigValidationError[] = [];
  const resolved: Record<string, string> = {};

  resolveSimpleSecrets(cloned, '', env, errors, resolved);
  resolveMcpServers(cloned, '', env, errors, resolved);

  // 注意：不解析 `tenant.tenants.<id>.config` 内的 `_env`。
  // overlay 必须保持 `_env` 原样，validator 才能执行“tenant 密钥只允许 _env”；
  // 选中 tenant 时由 loader 单独解析该 overlay（A-4 §11.4 / A6-23）。

  return { layer: cloned as Partial<VesselConfig>, errors, resolved };
}

/** 密钥字段的展示标记：永不输出解析后的值。 */
export function secretMarker(value: string | undefined): '<set>' | '<unset>' {
  return typeof value === 'string' && value !== '' ? '<set>' : '<unset>';
}

function mask(value: unknown): string {
  if (value === undefined) return '<unset>';
  if (typeof value === 'string') return secretMarker(value);
  return '<set>';
}

function endsWithPath(path: string[], suffix: string[]): boolean {
  if (path.length < suffix.length) return false;
  const offset = path.length - suffix.length;
  return suffix.every((segment, index) => path[offset + index] === segment);
}

/** 固定密钥字段（含 tenant overlay 内的同名路径）。 */
const FIXED_SECRET_PATHS: readonly string[][] = [
  ['apiKey'],
  ['provider', 'apiKey'],
  ['feishu', 'appSecret'],
  ['serve', 'token'],
  ['serve', 'adminToken'],
  ['transport', 'token'],
  ['connect', 'token'],
];

/** mcpServers.<name>.env|headers.<KEY> 的值（值本身是密钥）。 */
function isMcpSecretValue(path: string[]): boolean {
  if (path.length < 4) return false;
  const mapKey = path[path.length - 2];
  return (mapKey === 'env' || mapKey === 'headers') && path[path.length - 4] === 'mcpServers';
}

/** 递归键名兜底：匹配常见密钥键名，但跳过 `*Env`（变量名不是密钥）。 */
function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  if (normalized.endsWith('env')) return false;
  if (
    normalized === 'apikey' ||
    normalized === 'token' ||
    normalized === 'secret' ||
    normalized === 'password' ||
    normalized === 'authorization' ||
    normalized === 'appsecret' ||
    normalized === 'clientsecret' ||
    normalized === 'accesstoken' ||
    normalized === 'refreshtoken'
  ) {
    return true;
  }
  return (
    normalized.endsWith('apikey') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('password') ||
    normalized.endsWith('authorization') ||
    normalized.endsWith('accesstoken') ||
    normalized.endsWith('refreshtoken')
  );
}

/** serve.tokens 特例：永不输出 token 键或值，tenant/role 保留。 */
function redactServeTokens(value: unknown): unknown {
  if (!isRecord(value)) return '<unset>';
  const entries = Object.values(value);
  const out: Record<string, unknown> = {};
  entries.forEach((entry, index) => {
    const key = entries.length === 1 ? '<set>' : `<set#${index + 1}>`;
    out[key] = isRecord(entry) ? { ...entry } : {};
  });
  return out;
}

/** feishu.appId：只保留前 4 位 + `***`。 */
function redactAppId(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value === '') return '<unset>';
  return `${value.slice(0, 4)}***`;
}

function redactNode(node: unknown, path: string[]): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => redactNode(item, path));
  }
  if (!isRecord(node)) return node;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const fullPath = [...path, key];

    if (endsWithPath(fullPath, ['serve', 'tokens'])) {
      result[key] = redactServeTokens(value);
      continue;
    }
    if (endsWithPath(fullPath, ['feishu', 'appId'])) {
      result[key] = redactAppId(value);
      continue;
    }
    if (isMcpSecretValue(fullPath)) {
      // `_env` 是变量名而非密钥，保留（解析后的配置里通常已移除）。
      result[key] = key.endsWith('_env') ? value : mask(value);
      continue;
    }
    if (FIXED_SECRET_PATHS.some((suffix) => endsWithPath(fullPath, suffix))) {
      result[key] = mask(value);
      continue;
    }
    if (isSensitiveKey(key)) {
      result[key] = mask(value);
      continue;
    }

    result[key] = redactNode(value, fullPath);
  }
  return result;
}

/**
 * 返回脱敏后的配置副本。
 *
 * 固定字段（apiKey / provider.apiKey / feishu.appSecret / serve.token /
 * serve.adminToken / transport.token / MCP env+headers 值）输出 `<set>` / `<unset>`；
 * `serve.tokens` 输出按 entry 的 `<set>`，永不输出 token 键或值。
 */
export function redactConfig(config: VesselConfig): VesselConfig {
  return redactNode(structuredClone(config), []) as VesselConfig;
}
