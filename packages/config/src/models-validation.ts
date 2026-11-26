/**
 * models 块两面形状校验（模型管理两面重构 §3.3 / §4.4）。
 *
 * 凭证面（models.credentials）+ 模型面（models.entries）的字段级校验；
 * 由 validator.ts 的 validateModels 调用（与旧 vendors/aliases 校验并存于迁移期，
 * 一次性迁移后旧块校验删除）。纯函数、无运行期依赖：不读加密库、不查插件注册表
 * （credential 值存在性解析期 fail-fast；provider 工厂存在性解析期 fail-fast）。
 *
 * @module @vessel-agent/config/models-validation
 */

import { RESERVED_BODY_KEYS_ANTHROPIC, RESERVED_BODY_KEYS_OPENAI } from '@vessel-agent/core';
import type { ConfigValidationError, ConfigValidationWarning, ProviderConfig } from './types.js';

/** 凭证 id 字符集（§3.1：字母/数字/连字符，大小写均可；`legacy:` 前缀保留给合成凭证） */
export const CREDENTIAL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;

/** 模型条目键字符集（§4.1：wire 名可直接作键，允许 `/` `.` `_` `-`；`legacy:` 前缀保留） */
export const ENTRY_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;

/** 请求模式枚举（§6）；responses 本期保留（unsupported_mode） */
export const REQUEST_MODES = ['chat', 'responses', 'messages'] as const;

/** openai 系协议（mode 相容判定用；品牌工厂名传输等价 openai） */
export const OPENAI_FAMILY_PROVIDERS: ReadonlySet<string> = new Set([
  'openai',
  'openai-compatible',
  'gemini',
  'google',
  'mistral',
  'ollama',
  'cohere',
]);

/** 是否为纯对象（非数组、非 null） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 合法环境变量名（与 validator 同口径） */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function validateEnvName(path: string, value: unknown, errors: ConfigValidationError[]): void {
  if (typeof value !== 'string' || !ENV_NAME_RE.test(value)) {
    errors.push({
      path,
      message:
        'Must be a valid environment variable name (letters, digits, underscore; not starting with a digit)',
      value,
    });
  }
}

/** param.extra 的 reserved 键集（按 entry.provider；未知 provider 保守按 openai 系）。 */
export function reservedBodyKeysFor(provider: string | undefined): readonly string[] {
  return provider === 'anthropic' ? RESERVED_BODY_KEYS_ANTHROPIC : RESERVED_BODY_KEYS_OPENAI;
}

/** 新形状 ref 命中判定：条目键 / 条目别称 / legacy 合成条目键（provider.model 原值 / legacy: 前缀）。 */
export function hitsEntryRef(
  ref: string,
  entries: Record<string, unknown> | undefined,
  provider: ProviderConfig | undefined,
): boolean {
  if (entries !== undefined && Object.hasOwn(entries, ref)) return true;
  if (entries !== undefined) {
    for (const raw of Object.values(entries)) {
      if (isPlainObject(raw) && raw.alias === ref) return true;
    }
  }
  if (provider?.model !== undefined && provider.model !== '' && ref === provider.model) return true;
  if (ref.startsWith('legacy:')) return true;
  return false;
}

/** 价格四元组校验（§10.1：与 pricing.models 同口径；出现时 input/output 必填、四项 ≥0）。 */
function validatePricingQuadruple(
  prefix: string,
  raw: Record<string, unknown>,
  errors: ConfigValidationError[],
): void {
  for (const [key, label] of [
    ['inputPerMillion', 'Input price'],
    ['outputPerMillion', 'Output price'],
  ] as const) {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      errors.push({
        path: `${prefix}.${key}`,
        message: `${label} must be a non-negative number (per 1M tokens)`,
        value,
      });
    }
  }
  for (const key of ['cacheReadPerMillion', 'cacheWritePerMillion'] as const) {
    const value = raw[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    ) {
      errors.push({
        path: `${prefix}.${key}`,
        message: 'Cache price must be a non-negative number (per 1M tokens)',
        value,
      });
    }
  }
}

/** 模型级缺省请求参数校验（§10.2）。 */
function validateEntryParam(
  prefix: string,
  raw: Record<string, unknown>,
  provider: string | undefined,
  errors: ConfigValidationError[],
): void {
  const temperature = raw.temperature;
  if (
    temperature !== undefined &&
    (typeof temperature !== 'number' ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2)
  ) {
    errors.push({
      path: `${prefix}.temperature`,
      message: 'param.temperature must be a number in [0, 2]',
      value: temperature,
    });
  }
  const maxTokens = raw.maxTokens;
  if (
    maxTokens !== undefined &&
    (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0)
  ) {
    errors.push({
      path: `${prefix}.maxTokens`,
      message: 'param.maxTokens must be a positive integer',
      value: maxTokens,
    });
  }
  const topP = raw.topP;
  if (
    topP !== undefined &&
    (typeof topP !== 'number' || !Number.isFinite(topP) || topP <= 0 || topP > 1)
  ) {
    errors.push({
      path: `${prefix}.topP`,
      message: 'param.topP must be a number in (0, 1]',
      value: topP,
    });
  }
  if (raw.promptCache !== undefined && typeof raw.promptCache !== 'boolean') {
    errors.push({
      path: `${prefix}.promptCache`,
      message:
        'param.promptCache must be a boolean (true = force on, false = force off, omit = auto)',
      value: raw.promptCache,
    });
  }
  if (raw.extra !== undefined) {
    if (!isPlainObject(raw.extra)) {
      errors.push({
        path: `${prefix}.extra`,
        message:
          'param.extra must be a plain object (merged into the request body at request time)',
        value: raw.extra,
      });
    } else {
      const reserved = reservedBodyKeysFor(provider);
      for (const key of Object.keys(raw.extra)) {
        if (reserved.includes(key)) {
          errors.push({
            path: `${prefix}.extra.${key}`,
            message: `param.extra.${key} is a reserved request-body key for provider "${provider ?? 'openai'}"; core owns the request shape`,
          });
        }
      }
    }
  }
}

/** 模型元数据校验（§10.3：已知键校验类型，未知键读容忍；永不进 wire 请求体）。 */
function validateEntryInfo(
  prefix: string,
  raw: Record<string, unknown>,
  errors: ConfigValidationError[],
): void {
  for (const key of ['displayName', 'description'] as const) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      errors.push({
        path: `${prefix}.${key}`,
        message: `info.${key} must be a non-empty string when set`,
        value,
      });
    }
  }
  for (const key of ['contextWindow', 'maxOutputTokens'] as const) {
    const value = raw[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
    ) {
      errors.push({
        path: `${prefix}.${key}`,
        message: `info.${key} must be a positive integer when set`,
        value,
      });
    }
  }
  if (raw.capabilities !== undefined) {
    if (!isPlainObject(raw.capabilities)) {
      errors.push({
        path: `${prefix}.capabilities`,
        message: 'info.capabilities must be an object ({ vision?, thinking?, tools? })',
        value: raw.capabilities,
      });
    } else {
      for (const key of ['vision', 'thinking', 'tools'] as const) {
        const value = raw.capabilities[key];
        if (value !== undefined && typeof value !== 'boolean') {
          errors.push({
            path: `${prefix}.capabilities.${key}`,
            message: `info.capabilities.${key} must be a boolean when set`,
            value,
          });
        }
      }
    }
  }
}

/** mode 与 provider 相容校验（§6）；responses 本期保留枚举。 */
function validateEntryMode(
  prefix: string,
  mode: unknown,
  provider: string | undefined,
  errors: ConfigValidationError[],
): void {
  if (typeof mode !== 'string' || !(REQUEST_MODES as readonly string[]).includes(mode)) {
    errors.push({
      path: `${prefix}.mode`,
      message: `mode must be one of ${REQUEST_MODES.join(' | ')}`,
      value: mode,
    });
    return;
  }
  if (mode === 'responses') {
    errors.push({
      path: `${prefix}.mode`,
      message:
        'unsupported_mode: "responses" is a reserved enum (OpenAI Responses API adapter not implemented yet); use "chat"',
      value: mode,
    });
    return;
  }
  const protocol = provider ?? 'openai';
  if (protocol === 'anthropic' && mode !== 'messages') {
    errors.push({
      path: `${prefix}.mode`,
      message: `mode "${mode}" is incompatible with provider "anthropic" (legal: messages)`,
      value: mode,
    });
  } else if (OPENAI_FAMILY_PROVIDERS.has(protocol) && mode !== 'chat') {
    errors.push({
      path: `${prefix}.mode`,
      message: `mode "${mode}" is incompatible with provider "${protocol}" (legal: chat | responses)`,
      value: mode,
    });
  }
  // 未知 provider（自定义插件工厂）：wire 形状插件定义，config 层只认枚举（responses 已拒）。
}

/**
 * 凭证面校验（§3.3）：id 形状 / base_url 必填 http(s) / api_key_env 非空。
 * 不校验加密库值存在性（纯 config 层看不到 dataDir；解析期 fail-fast + hasValue 展示）。
 */
export function validateCredentialsBlock(
  credentials: Record<string, unknown>,
  errors: ConfigValidationError[],
): void {
  for (const [id, raw] of Object.entries(credentials)) {
    const prefix = `models.credentials.${id}`;
    if (id.startsWith('legacy:')) {
      errors.push({
        path: prefix,
        message: `Credential id "${id}" uses the reserved "legacy:" prefix (only synthesized legacy credentials may use it).`,
      });
      continue;
    }
    if (!CREDENTIAL_ID_RE.test(id)) {
      errors.push({
        path: prefix,
        message: `Credential id "${id}" must match ^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$ (letters, digits, hyphens).`,
      });
    }
    if (!isPlainObject(raw)) {
      errors.push({ path: prefix, message: 'Credential entry must be an object', value: raw });
      continue;
    }
    const baseUrl = raw.baseUrl;
    if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
      errors.push({
        path: `${prefix}.baseUrl`,
        message:
          'Credential baseUrl is required (a non-empty http(s) URL; the endpoint travels with the credential)',
        value: baseUrl,
      });
    } else if (!/^https?:\/\//i.test(baseUrl.trim())) {
      errors.push({
        path: `${prefix}.baseUrl`,
        message: 'Credential baseUrl must be an http(s) URL',
        value: baseUrl,
      });
    }
    if (raw.apiKeyEnv !== undefined) validateEnvName(`${prefix}.apiKeyEnv`, raw.apiKeyEnv, errors);
  }
} /**
 * 模型面校验（§4.4）：entries 扁平条目。
 * credential 必填且命中 credentials（或 legacy 合成）；alias 唯一/不含 `/`/不撞条目键；
 * name 非空；provider 非空（工厂存在性解析期 fail-fast）；mode 枚举且相容；
 * pricing/param/info 各自校验。entries 可为空（凭证先行工作流）。
 * H4：同 wire 名多 entry 价格冲突 → 确定性取键序首个 + warning（计量合并 D7 口径不变）。
 */
export function validateEntriesBlock(
  entries: Record<string, unknown>,
  credentials: Record<string, unknown> | undefined,
  errors: ConfigValidationError[],
  warnings: ConfigValidationWarning[],
): void {
  const aliasOwners = new Map<string, string>();
  const pricingByWire = new Map<string, { key: string; pricing: Record<string, unknown> }>();
  for (const [key, raw] of Object.entries(entries)) {
    const prefix = `models.entries.${key}`;
    if (key.startsWith('legacy:')) {
      errors.push({
        path: prefix,
        message: `Entry key "${key}" uses the reserved "legacy:" prefix (only synthesized legacy entries may use it).`,
      });
      continue;
    }
    if (!ENTRY_KEY_RE.test(key)) {
      errors.push({
        path: prefix,
        message: `Entry key "${key}" must match ^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$ (wire names may be used as keys).`,
      });
    }
    if (!isPlainObject(raw)) {
      errors.push({ path: prefix, message: 'Model entry must be an object', value: raw });
      continue;
    }
    if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.trim() === '')) {
      errors.push({
        path: `${prefix}.name`,
        message:
          'name must be a non-empty string when set (the wire model id; omit it to use the entry key)',
        value: raw.name,
      });
    }
    const alias = raw.alias;
    if (alias !== undefined) {
      if (typeof alias !== 'string' || alias.trim() === '' || alias.includes('/')) {
        errors.push({
          path: `${prefix}.alias`,
          message: 'alias must be a non-empty string without "/" (a flat unique ref)',
          value: alias,
        });
      } else if (alias.startsWith('legacy:')) {
        errors.push({
          path: `${prefix}.alias`,
          message: 'alias must not use the reserved "legacy:" prefix',
          value: alias,
        });
      } else if (Object.hasOwn(entries, alias)) {
        errors.push({
          path: `${prefix}.alias`,
          message: `alias "${alias}" collides with an entry key; aliases and keys share one flat ref namespace`,
          value: alias,
        });
      } else if (aliasOwners.has(alias)) {
        errors.push({
          path: `${prefix}.alias`,
          message: `alias "${alias}" is already used by entry "${aliasOwners.get(alias)}"; aliases must be globally unique`,
          value: alias,
        });
      } else {
        aliasOwners.set(alias, key);
      }
    }
    const entryProvider = raw.provider;
    if (
      entryProvider !== undefined &&
      (typeof entryProvider !== 'string' || entryProvider.trim() === '')
    ) {
      errors.push({
        path: `${prefix}.provider`,
        message:
          'provider must be a non-empty string when set (a registered protocol factory name; omit for "openai")',
        value: entryProvider,
      });
    }
    const protocol = typeof entryProvider === 'string' ? entryProvider : undefined;
    if (raw.mode !== undefined) validateEntryMode(prefix, raw.mode, protocol, errors);
    const credential = raw.credential;
    if (typeof credential !== 'string' || credential.trim() === '') {
      errors.push({
        path: `${prefix}.credential`,
        message:
          'credential is required (a models.credentials.<id> reference; define the credential first)',
        value: credential,
      });
    } else if (
      !credential.startsWith('legacy:') &&
      (credentials === undefined || !Object.hasOwn(credentials, credential))
    ) {
      const registered =
        credentials !== undefined ? Object.keys(credentials).join(', ') || '<none>' : '<none>';
      errors.push({
        path: `${prefix}.credential`,
        message: `credential "${credential}" does not hit models.credentials (registered: ${registered})`,
        value: credential,
      });
    }
    if (raw.pricing !== undefined) {
      if (!isPlainObject(raw.pricing)) {
        errors.push({
          path: `${prefix}.pricing`,
          message:
            'pricing must be an object ({ inputPerMillion, outputPerMillion, cacheReadPerMillion?, cacheWritePerMillion? })',
          value: raw.pricing,
        });
      } else {
        validatePricingQuadruple(`${prefix}.pricing`, raw.pricing, errors);
        const wire = typeof raw.name === 'string' && raw.name !== '' ? raw.name : key;
        const prior = pricingByWire.get(wire);
        if (prior === undefined) {
          pricingByWire.set(wire, { key, pricing: raw.pricing });
        } else if (JSON.stringify(prior.pricing) !== JSON.stringify(raw.pricing)) {
          warnings.push({
            path: `${prefix}.pricing`,
            message: `wire model "${wire}" is registered by multiple entries with different pricing ("${prior.key}" and "${key}"); usage merges by wire name (D7) and costs deterministically use the first entry in key order ("${prior.key}")`,
            value: wire,
          });
        }
      }
    }
    if (raw.param !== undefined) {
      if (!isPlainObject(raw.param)) {
        errors.push({
          path: `${prefix}.param`,
          message: 'param must be an object',
          value: raw.param,
        });
      } else {
        validateEntryParam(`${prefix}.param`, raw.param, protocol, errors);
      }
    }
    if (raw.info !== undefined) {
      if (!isPlainObject(raw.info)) {
        errors.push({ path: `${prefix}.info`, message: 'info must be an object', value: raw.info });
      } else {
        validateEntryInfo(`${prefix}.info`, raw.info, errors);
      }
    }
  }
}
