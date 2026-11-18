/**
 * Model registry 解析器（model-registry P0 接缝）。
 * @module @vessel-agent/config
 *
 * 契约：docs/dev/plans/model-registry.md §2.4。纯函数、零运行期依赖、无网络、无厂商 SDK：
 * 只做「合并后 config → registry 快照 → ModelRef 解析」，不构造 provider、不读凭证值。
 * 凭证值留在原 config 路径（provider.apiKey）或加密库（credential 引用），永不进快照。
 *
 * 解析顺序（§2.4）：① 空 ref → 有效默认（models.default ?? legacy 条目 model ??
 * defaultModelForProvider）；② 别名精确命中展开；③ 首个 `/` 切分 vendorId + wireModel
 * （model id 自身可含 `/`，只切第一段）；④ 显式 `legacy:<name>/<model>`；⑤ 过渡期兜底
 * （P0–P2）：未命中字符串原样作 wireModel 透传默认 vendor（与今天字节等价），P3 删除。
 *
 * 严格面（P0 即生效）：已注册 vendor 下未注册的 model 立即报错（不走兜底）；
 * models.default 与别名目标必须命中注册条目；别名扁平（别名 → 别名拒绝）。
 * legacy 条目保留旧语义：model 字符串透传，不受注册清单约束。
 *
 * env 优先级（§2.6 冻结）：VESSEL_MODEL 与 models.default 并存时 env 赢。env 层已把
 * VESSEL_MODEL 写进合并后 config 的 provider.model；装配层把 env model 值作为 ref 传入
 * resolveModelRef 即实现该优先级（快照不新增 config 字段）。
 */

import { defaultModelForProvider } from './defaults.js';
import type { ModelEntry, ModelsConfig, VesselConfig } from './types.js';

/** 快照内的厂商条目（models 块注册条目或 legacy 合成条目）。 */
export interface RegistryVendor {
  id: string;
  protocol: string;
  baseUrl?: string;
  credentialRef?: string;
  apiKeyEnv?: string;
  /** wire model id → 每模型配置 */
  models: Record<string, ModelEntry>;
  /** legacy 合成条目（provider.* 兼容）：model 字符串透传，不受注册清单约束 */
  legacy: boolean;
}

/** Registry 快照：随 config 重载重建；只含元数据，不含任何密钥值。 */
export interface ModelRegistrySnapshot {
  vendors: Record<string, RegistryVendor>;
  aliases: Record<string, string>;
  /** models.default（未解析的 ref） */
  defaultRef?: string;
  /** legacy vendor id（synthesizeLegacyRegistry 构造上恒存在） */
  legacyVendorId: string;
  /** provider.model 原值（可能是空串；默认链保持与今天 `??` 相同的语义） */
  legacyModel?: string;
  /**
   * provider.promptCache 原值：legacy 是 vendor 级开关，对该 vendor 的任意 model 生效
   * （默认链 / env / 显式 legacy ref / 兜底透传），与今天直传 provider.promptCache 字节等价。
   */
  legacyPromptCache?: boolean;
}

/** 解析结果（§2.4）：装配层据此构造 provider；不含凭证值。 */
export interface ResolvedModel {
  vendorId: string;
  protocol: string;
  baseUrl?: string;
  credentialRef?: string;
  apiKeyEnv?: string;
  wireModel: string;
  promptCache?: boolean;
}

export type ModelRefErrorCode = 'unknown_vendor' | 'unknown_model' | 'unknown_alias';

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

function lookupVendor(
  snapshot: ModelRegistrySnapshot,
  vendorId: string,
): RegistryVendor | undefined {
  return hasOwn(snapshot.vendors, vendorId) ? snapshot.vendors[vendorId] : undefined;
}

/** legacy vendor（synthesizeLegacyRegistry 构造上恒存在）。 */
function legacyVendorOf(snapshot: ModelRegistrySnapshot): RegistryVendor {
  return snapshot.vendors[snapshot.legacyVendorId] as RegistryVendor;
}

function vendorModelRefs(vendor: RegistryVendor): string[] {
  return Object.keys(vendor.models).map((model) => `${vendor.id}/${model}`);
}

/** 全部注册 ref（别名 + vendor/model），用作错误候选。 */
function registeredRefs(snapshot: ModelRegistrySnapshot): string[] {
  const refs = Object.keys(snapshot.aliases);
  for (const vendor of Object.values(snapshot.vendors)) refs.push(...vendorModelRefs(vendor));
  return refs;
}

function toResolved(
  vendor: RegistryVendor,
  wireModel: string,
  legacyPromptCache?: boolean,
): ResolvedModel {
  const entry = hasOwn(vendor.models, wireModel) ? vendor.models[wireModel] : undefined;
  return {
    vendorId: vendor.id,
    protocol: vendor.protocol,
    baseUrl: vendor.baseUrl,
    credentialRef: vendor.credentialRef,
    apiKeyEnv: vendor.apiKeyEnv,
    wireModel,
    // legacy vendor：entry 缺省回落 vendor 级 provider.promptCache（今天的行为）；
    // registered vendor：只取每模型 flag，auto 保持 undefined 交给插件默认。
    promptCache: entry?.promptCache ?? (vendor.legacy ? legacyPromptCache : undefined),
  };
}

/**
 * 合并后 config → registry 快照。
 *
 * 把 provider.*（含 env 层覆盖后的值）折成 id = `legacy:<provider.name>` 的隐式 vendor：
 * models = [provider.model]，凭证来源 = provider.apiKey/apiKeyEnv（值留原 config 路径，
 * 不搬家）。loader 的 legacyUserLayer 与 env 层不改——合成发生在合并之后。
 */
export function synthesizeLegacyRegistry(config: VesselConfig): ModelRegistrySnapshot {
  const providerName = config.provider?.name ?? 'openai';
  const legacyVendorId = `legacy:${providerName}`;
  const legacyModel = config.provider?.model;
  const legacyModels: Record<string, ModelEntry> = {};
  if (legacyModel !== undefined && legacyModel !== '') {
    legacyModels[legacyModel] =
      config.provider?.promptCache !== undefined
        ? { promptCache: config.provider.promptCache }
        : {};
  }
  const vendors: Record<string, RegistryVendor> = {
    [legacyVendorId]: {
      id: legacyVendorId,
      protocol: providerName,
      baseUrl: config.provider?.baseUrl,
      apiKeyEnv: config.provider?.apiKeyEnv,
      models: legacyModels,
      legacy: true,
    },
  };
  const models: ModelsConfig | undefined = config.models;
  if (models?.vendors !== undefined) {
    for (const [id, entry] of Object.entries(models.vendors)) {
      vendors[id] = {
        id,
        protocol: entry.protocol,
        baseUrl: entry.baseUrl,
        credentialRef: entry.credential,
        apiKeyEnv: entry.apiKeyEnv,
        models: entry.models ?? {},
        legacy: false,
      };
    }
  }
  return {
    vendors,
    aliases: { ...(models?.aliases ?? {}) },
    defaultRef: models?.default,
    legacyVendorId,
    legacyModel,
    legacyPromptCache: config.provider?.promptCache,
  };
}

/** 兜底透传的「默认 vendor」：models.default 指向的 vendor；缺省 = legacy vendor（今天的行为）。 */
function fallbackVendor(snapshot: ModelRegistrySnapshot): RegistryVendor {
  const defaultRef = snapshot.defaultRef;
  if (defaultRef !== undefined && defaultRef !== '') {
    const target = hasOwn(snapshot.aliases, defaultRef)
      ? (snapshot.aliases[defaultRef] as string)
      : defaultRef;
    const slash = target.indexOf('/');
    if (slash !== -1) {
      const vendor = lookupVendor(snapshot, target.slice(0, slash));
      if (vendor) return vendor;
    }
  }
  return legacyVendorOf(snapshot);
}

/**
 * 严格解析注册 ref（models.default 与别名目标专用）：只认别名 / vendor/model / legacy 条目，
 * 未命中即 ModelRefError，不走过渡期兜底。viaAlias 标记用于拒绝别名 → 别名。
 */
function resolveRegistered(
  snapshot: ModelRegistrySnapshot,
  ref: string,
  viaAlias: boolean,
): ResolvedModel {
  if (hasOwn(snapshot.aliases, ref)) {
    if (viaAlias) {
      throw new ModelRefError(
        'unknown_alias',
        ref,
        `Alias target "${ref}" is another alias; aliases must be flat (alias -> vendor/model).`,
        registeredRefs(snapshot),
      );
    }
    return resolveRegistered(snapshot, snapshot.aliases[ref] as string, true);
  }
  const slash = ref.indexOf('/');
  if (slash !== -1) {
    const vendorId = ref.slice(0, slash);
    const wireModel = ref.slice(slash + 1);
    const vendor = lookupVendor(snapshot, vendorId);
    if (!vendor) {
      throw new ModelRefError(
        'unknown_vendor',
        ref,
        `Vendor "${vendorId}" is not registered.`,
        registeredRefs(snapshot),
      );
    }
    if (vendor.legacy || hasOwn(vendor.models, wireModel)) {
      return toResolved(vendor, wireModel, snapshot.legacyPromptCache);
    }
    throw new ModelRefError(
      'unknown_model',
      ref,
      `Model "${wireModel}" is not registered under vendor "${vendorId}".`,
      vendorModelRefs(vendor),
    );
  }
  throw new ModelRefError(
    'unknown_alias',
    ref,
    `"${ref}" is not a registered model ref; expected an alias or "vendor/model".`,
    registeredRefs(snapshot),
  );
}

/**
 * 解析 ModelRef（§2.4 顺序）。ref 为空（undefined/''）→ 有效默认；无任何默认时返回
 * undefined（调用方沿用既有 fail-fast）。非空 ref 未命中时走过渡期兜底（P0–P2），
 * 但「已注册 vendor 下未注册的 model」立即抛 ModelRefError（严格面）。
 */
export function resolveModelRef(
  snapshot: ModelRegistrySnapshot,
  ref: string | undefined,
): ResolvedModel | undefined {
  if (ref === undefined || ref === '') {
    // ① 有效默认 = models.default ?? legacy 条目 model ?? defaultModelForProvider。
    if (snapshot.defaultRef !== undefined && snapshot.defaultRef !== '') {
      return resolveRegistered(snapshot, snapshot.defaultRef, false);
    }
    const legacy = legacyVendorOf(snapshot);
    if (snapshot.legacyModel !== undefined) {
      return toResolved(legacy, snapshot.legacyModel, snapshot.legacyPromptCache);
    }
    const fallback = defaultModelForProvider(legacy.protocol);
    if (fallback === undefined) return undefined;
    return toResolved(legacy, fallback, snapshot.legacyPromptCache);
  }
  // ② 别名精确命中 → 展开为 vendor/model（扁平，别名 → 别名拒绝）。
  if (hasOwn(snapshot.aliases, ref)) {
    return resolveRegistered(snapshot, snapshot.aliases[ref] as string, true);
  }
  // ③④ 首个 `/` 切分：vendorId + wireModel（model id 自身可含 `/`，只切第一段）。
  const slash = ref.indexOf('/');
  if (slash !== -1) {
    const vendorId = ref.slice(0, slash);
    const wireModel = ref.slice(slash + 1);
    const vendor = lookupVendor(snapshot, vendorId);
    if (vendor) {
      // legacy 条目保留旧语义：任意 model 字符串透传（显式钉住旧行为）。
      if (vendor.legacy || hasOwn(vendor.models, wireModel)) {
        return toResolved(vendor, wireModel, snapshot.legacyPromptCache);
      }
      // 严格面：已注册 vendor 下未注册的 model 立即报错，不走兜底。
      throw new ModelRefError(
        'unknown_model',
        ref,
        `Model "${wireModel}" is not registered under vendor "${vendorId}".`,
        vendorModelRefs(vendor),
      );
    }
  }
  // ⑤ 过渡期兜底（P0–P2）：未命中字符串原样作 wireModel 透传默认 vendor（与今天字节等价）。
  return toResolved(fallbackVendor(snapshot), ref, snapshot.legacyPromptCache);
}
