/**
 * Model registry 解析器（模型管理两面重构 §4.3 / §7.4）。
 * @module @vessel-agent/config
 *
 * 纯函数、零运行期依赖、无网络、无厂商 SDK：只做「合并后 config → registry 快照 →
 * ModelRef 解析」，不构造 provider、不读凭证值。凭证值留在原 config 路径
 * （provider.apiKey）或加密库（credential 引用），永不进快照。
 *
 * 两面形状：快照只有 credentials（凭证元数据）+ entries（扁平模型条目）两种实体。
 * ref = 别称 | 条目键（不再有 vendor/model 两段式）。解析顺序（§4.3）：
 * ① 空 ref → 有效默认（models.default ?? legacy 合成条目 ?? 协议默认模型）；
 * ② 别称精确命中（唯一索引）→ 条目；③ 条目键精确命中 → 条目；
 * ④ 未命中且 legacyPresent → ref 原样作 wire model 走 legacy 合成凭证（P0-1 字节等价）；
 * ⑤ 未命中且无 legacy → ModelRefError fail-loud + 候选（vendor 过渡兜底已删，P3 兑现）。
 *
 * legacy provider.* 兼容面（H1 保留）：读时折成合成凭证 `legacy:<provider.name>` +
 * 合成条目（键 = provider.model 原值），承接 env 层 / setup 向导 / P0-1 字符串 pin。
 * 旧 vendors/aliases 块已全量删除（§7 一次性迁移；迁移机器见 model-migration.ts）。
 *
 * env 优先级（§2.6 冻结）：VESSEL_MODEL 与 models.default 并存时 env 赢。env 层已把
 * VESSEL_MODEL 写进合并后 config 的 provider.model；装配层把 env model 值作为 ref 传入
 * resolveModelRef 即实现该优先级（快照不新增 config 字段）。
 */

import { defaultModelForProvider } from './defaults.js';
import type {
  ModelInfoConfig,
  ModelParamConfig,
  ModelPricingConfig,
  ModelsConfig,
  RequestMode,
  VesselConfig,
} from './types.js';

/** 快照内的凭证元数据（yaml models.credentials 或 legacy 合成；无密钥值）。 */
export interface RegistryCredential {
  id: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  /** legacy 合成凭证（provider.* 兼容面）：值来源 provider.apiKey/apiKeyEnv 原路径 */
  legacy: boolean;
}

/** 快照内的模型条目（models.entries 注册条目、legacy 合成条目、迁移期 vendor 折叠条目）。 */
export interface RegistryEntry {
  /** 条目键（ref 的主处理柄）；legacy 合成条目键 = provider.model 原值 */
  id: string;
  /** wire model id（请求体 model 字段）= name ?? 条目键 */
  wireModel: string;
  alias?: string;
  /** 协议/SDK 适配类型（非品牌）；缺省 openai */
  provider: string;
  /** 请求模式（缺省按 provider 推导） */
  mode: RequestMode;
  /** 访问凭证 ref（注册条目必填；legacy 合成 = legacy:<provider.name>） */
  credentialRef?: string;
  apiKeyEnv?: string;
  /** 端点（来自凭证 baseUrl；legacy 合成 = provider.baseUrl，可缺省走工厂默认） */
  baseUrl?: string;
  param?: ModelParamConfig;
  pricing?: ModelPricingConfig;
  info?: ModelInfoConfig;
  /** param.promptCache ?? legacy provider.promptCache（三态语义不变） */
  promptCache?: boolean;
  legacy: boolean;
}

/** Registry 快照：随 config 重载重建；只含元数据，不含任何密钥值。 */
export interface ModelRegistrySnapshot {
  entries: Record<string, RegistryEntry>;
  credentials: Record<string, RegistryCredential>;
  /** 别称唯一索引：alias → 条目键（条目 alias 字段聚合；迁移期含顶层 aliases 折叠） */
  aliases: Record<string, string>;
  /** models.default（未解析的 ref） */
  defaultRef?: string;
  /** legacy 合成凭证 id（synthesizeLegacyRegistry 构造上恒存在） */
  legacyCredentialId: string;
  /** provider.model 原值（可能是空串；默认链保持与今天 `??` 相同的语义） */
  legacyModel?: string;
  /** provider.promptCache 原值：legacy 合成条目任意 wire model 透传时生效（今天行为） */
  legacyPromptCache?: boolean;
  /**
   * provider.* 有非 default 层来源（registry-store 按 sources 精确判定；缺省 true =
   * 保守透传，与今天字节等价）。false 时未命中 ref 走 ModelRefError（P3 收紧）。
   */
  legacyPresent: boolean;
}

/** 解析结果（§4.3）：装配层据此构造 provider 并注入缺省参数；不含凭证值。 */
export interface ResolvedModel {
  /** 条目键（legacy 透传 = legacy 合成凭证 id） */
  entryId: string;
  /** 协议/SDK 适配类型（工厂 lookup + providerName 身份） */
  provider: string;
  baseUrl?: string;
  credentialRef?: string;
  apiKeyEnv?: string;
  wireModel: string;
  mode: RequestMode;
  param?: ModelParamConfig;
  pricing?: ModelPricingConfig;
  promptCache?: boolean;
  /** legacy 合成 / 透传（provider.* 兼容面） */
  legacy: boolean;
}

export type ModelRefErrorCode = 'unknown_ref';

/** 注册 ref 解析错误：带注册 ref 候选，便于改错与迁移。 */
export class ModelRefError extends Error {
  readonly code: ModelRefErrorCode;
  readonly ref: string;
  readonly candidates: string[];

  constructor(code: ModelRefErrorCode, ref: string, message: string, candidates: string[]) {
    super(message);
    this.name = 'ModelRefError';
    this.code = code;
    this.ref = ref;
    this.candidates = candidates;
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

/** mode 缺省按 provider 推导（§6.2）：anthropic → messages，其余 → chat。 */
export function defaultModeFor(provider: string): RequestMode {
  return provider === 'anthropic' ? 'messages' : 'chat';
}

/** 全部注册 ref（别称 + 条目键），用作错误候选。 */
function registeredRefs(snapshot: ModelRegistrySnapshot): string[] {
  return [...Object.keys(snapshot.aliases), ...Object.keys(snapshot.entries)];
}

function toResolved(entry: RegistryEntry): ResolvedModel {
  return {
    entryId: entry.id,
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    credentialRef: entry.credentialRef,
    apiKeyEnv: entry.apiKeyEnv,
    wireModel: entry.wireModel,
    mode: entry.mode,
    param: entry.param,
    pricing: entry.pricing,
    promptCache: entry.promptCache,
    legacy: entry.legacy,
  };
}

/** legacy 合成凭证（构造上恒存在）。 */
function legacyCredentialOf(snapshot: ModelRegistrySnapshot): RegistryCredential {
  return snapshot.credentials[snapshot.legacyCredentialId] as RegistryCredential;
}

/** legacy 透传：ref 原样作 wire model 走合成凭证（今天 legacy vendor 透传语义字节等价）。 */
function legacyPassthrough(snapshot: ModelRegistrySnapshot, wireModel: string): ResolvedModel {
  const credential = legacyCredentialOf(snapshot);
  const provider = credential.id.slice('legacy:'.length);
  return {
    entryId: credential.id,
    provider,
    baseUrl: credential.baseUrl,
    credentialRef: credential.id,
    apiKeyEnv: credential.apiKeyEnv,
    wireModel,
    mode: defaultModeFor(provider),
    promptCache: snapshot.legacyPromptCache,
    legacy: true,
  };
}

/**
 * 合并后 config → registry 快照（两面形状 + legacy 合成 + 迁移期 vendor 折叠）。
 *
 * provider.*（含 env 层覆盖后的值）折成合成凭证 `legacy:<provider.name>` + 合成条目
 * （键 = provider.model 原值）；值留原 config 路径不搬家。loader 的 legacyUserLayer
 * 与 env 层不改——合成发生在合并之后。
 *
 * @param legacyPresent provider.* 是否有非 default 层来源（缺省 true = 保守透传）
 */
export function synthesizeLegacyRegistry(
  config: VesselConfig,
  legacyPresent = true,
): ModelRegistrySnapshot {
  const providerName = config.provider?.name ?? 'openai';
  const legacyCredentialId = `legacy:${providerName}`;
  const legacyModel = config.provider?.model;
  const models: ModelsConfig | undefined = config.models;

  const credentials: Record<string, RegistryCredential> = {
    [legacyCredentialId]: {
      id: legacyCredentialId,
      baseUrl: config.provider?.baseUrl,
      apiKeyEnv: config.provider?.apiKeyEnv,
      legacy: true,
    },
  };
  if (models?.credentials !== undefined) {
    for (const [id, cred] of Object.entries(models.credentials)) {
      credentials[id] = { id, baseUrl: cred.baseUrl, apiKeyEnv: cred.apiKeyEnv, legacy: false };
    }
  }

  const entries: Record<string, RegistryEntry> = {};
  const aliases: Record<string, string> = {};

  // legacy 合成条目（键 = provider.model 原值；空串不建条目，默认链仍透传原值）。
  if (legacyModel !== undefined && legacyModel !== '') {
    entries[legacyModel] = {
      id: legacyModel,
      wireModel: legacyModel,
      provider: providerName,
      mode: defaultModeFor(providerName),
      credentialRef: legacyCredentialId,
      apiKeyEnv: config.provider?.apiKeyEnv,
      baseUrl: config.provider?.baseUrl,
      promptCache: config.provider?.promptCache,
      legacy: true,
    };
  }

  // 注册条目（models.entries）。
  if (models?.entries !== undefined) {
    for (const [key, entry] of Object.entries(models.entries)) {
      const provider = entry.provider ?? 'openai';
      const cred = credentials[entry.credential];
      entries[key] = {
        id: key,
        wireModel: entry.name ?? key,
        alias: entry.alias,
        provider,
        mode: entry.mode ?? defaultModeFor(provider),
        credentialRef: entry.credential,
        apiKeyEnv: cred?.apiKeyEnv,
        baseUrl: cred?.baseUrl,
        param: entry.param,
        pricing: entry.pricing,
        info: entry.info,
        promptCache: entry.param?.promptCache,
        legacy: false,
      };
      if (entry.alias !== undefined) aliases[entry.alias] = key;
    }
  }

  return {
    entries,
    credentials,
    aliases,
    defaultRef: models?.default,
    legacyCredentialId,
    legacyModel,
    legacyPromptCache: config.provider?.promptCache,
    legacyPresent,
  };
}

/**
 * 严格解析注册 ref（models.default 与别称目标专用）：只认别称 / 条目键 / legacy 合成条目，
 * 未命中即 ModelRefError，不走 legacy 透传。
 */
function resolveRegistered(snapshot: ModelRegistrySnapshot, ref: string): ResolvedModel {
  const target = hasOwn(snapshot.aliases, ref) ? (snapshot.aliases[ref] as string) : ref;
  const entry = hasOwn(snapshot.entries, target) ? snapshot.entries[target] : undefined;
  if (entry !== undefined) return toResolved(entry);
  // 显式 legacy:<name>/<model> ref：合成凭证透传（旧 strict 面同口径）。
  if (target.startsWith('legacy:')) return legacyPassthrough(snapshot, target);
  throw new ModelRefError(
    'unknown_ref',
    ref,
    `"${ref}" is not a registered model ref; expected an alias or entry key.`,
    registeredRefs(snapshot),
  );
}

/**
 * 解析 ModelRef（§4.3 顺序）。ref 为空（undefined/''）→ 有效默认；无任何默认时返回
 * undefined（调用方沿用既有 fail-fast）。非空 ref 未命中：legacyPresent → 原样透传
 * legacy 合成凭证（P0-1 字节等价）；否则 ModelRefError + 候选（P3 收紧，无 vendor 兜底）。
 */
export function resolveModelRef(
  snapshot: ModelRegistrySnapshot,
  ref: string | undefined,
): ResolvedModel | undefined {
  if (ref === undefined || ref === '') {
    // ① 有效默认 = models.default ?? legacy 条目 model ?? defaultModelForProvider。
    if (snapshot.defaultRef !== undefined && snapshot.defaultRef !== '') {
      return resolveRegistered(snapshot, snapshot.defaultRef);
    }
    if (snapshot.legacyModel !== undefined) {
      return legacyPassthrough(snapshot, snapshot.legacyModel);
    }
    const legacyProvider = legacyCredentialOf(snapshot).id.slice('legacy:'.length);
    const fallback = defaultModelForProvider(legacyProvider);
    if (fallback === undefined) return undefined;
    return legacyPassthrough(snapshot, fallback);
  }
  // ② 别称精确命中 → 条目（别称只指向条目，构造上无别称→别称）。
  if (hasOwn(snapshot.aliases, ref)) {
    return resolveRegistered(snapshot, ref);
  }
  // ③ 条目键精确命中。
  if (hasOwn(snapshot.entries, ref)) {
    return toResolved(snapshot.entries[ref] as RegistryEntry);
  }
  // ④ legacy 透传（provider.* 兼容面；不是 vendor 双源）。
  if (snapshot.legacyPresent) {
    return legacyPassthrough(snapshot, ref);
  }
  // ⑤ fail-loud + 候选。
  throw new ModelRefError(
    'unknown_ref',
    ref,
    `"${ref}" is not a registered model ref and no legacy provider.* config is present.`,
    registeredRefs(snapshot),
  );
}
