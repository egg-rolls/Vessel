/**
 * model-registry 插件：`~/.vessel/config.yaml` models 块读改写（两面重构 §3.3 / §8）。
 *
 * 契约：docs/dev/design/model-registry-two-face-design.md §3/§4/§8（取代上位契约 §3.3）。
 * - 写经 withConfigLock（跨进程锁，与 config.set / TUI 写路径共用），lock 内 read-modify-write；
 *   **写前 validateModels 预校验**（fail-fast RPC 错误，不落无效配置）；RPC 返回 = 写后读回。
 * - 磁盘形状 = snake_case（loader 的 snakeToCamel + preserveConfigMapKeys 是唯一映射口径，
 *   凭证 id / 条目键 / wire model id 是 map 键，原样保留）；RPC DTO = camelCase。
 * - 引用检查 = registry 内部引用（models.default / entry.credential），不读 agent store
 *   （dangling pin 由 doctor 只读交叉检查）。
 * - 只改 models 块；根对象与其它块原样保留。生效异步（config-watch），这里不做热应用。
 * - 凭证值不在本模块：credential_set 的加密库值写入在 index.ts（先值后元数据，§3.3）。
 */

import {
  type ConfigValidationError,
  type ConfigValidationWarning,
  getUserConfigPath,
  loadConfig,
  type ModelEntry,
  type ModelRegistrySnapshot,
  type ModelsConfig,
  preserveConfigMapKeys,
  readUserConfigRoot,
  snakeToCamel,
  synthesizeLegacyRegistry,
  type VesselConfig,
  validateModels,
  withConfigLock,
  writeUserConfigRoot,
} from '@vessel-agent/config';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 一次 registry 读取：合并后 config（user/project/env 层叠）+ 快照 + legacy 存在性。 */
export interface RegistryRead {
  config: VesselConfig;
  snapshot: ModelRegistrySnapshot;
  /** provider.* 有非 default 层来源（user/project/env/cli；含 legacy 键折叠） */
  legacyPresent: boolean;
}

/** 读当前合并 config 并合成 registry 快照（list / 引用检查 / effective 的唯一读路径）。 */
export async function readRegistry(): Promise<RegistryRead> {
  const { config, sources } = await loadConfig();
  const legacyPresent = Object.entries(sources).some(
    ([key, source]) => (key === 'provider' || key.startsWith('provider.')) && source !== 'default',
  );
  const snapshot = synthesizeLegacyRegistry(config, legacyPresent);
  return { config, snapshot, legacyPresent };
}

/** 条目的内部引用：models.default（别称展开后按条目键判）。别称是条目自有字段，随条目删。 */
export function entryReferences(snapshot: ModelRegistrySnapshot, entryId: string): string[] {
  const refs: string[] = [];
  const defaultRef = snapshot.defaultRef;
  if (defaultRef !== undefined && defaultRef !== '') {
    const expanded = Object.hasOwn(snapshot.aliases, defaultRef)
      ? (snapshot.aliases[defaultRef] as string)
      : defaultRef;
    if (expanded === entryId) refs.push('models.default');
  }
  return refs;
}

/** credential 的内部引用：entry.credential 指向它的条目键列表（多对一共享）。 */
export function credentialReferences(
  snapshot: ModelRegistrySnapshot,
  credentialId: string,
): string[] {
  return Object.values(snapshot.entries)
    .filter((entry) => entry.credentialRef === credentialId)
    .map((entry) => entry.id);
}

/** 磁盘 models 块（snake_case）→ camelCase（复用 loader 映射口径，map 键原样保留）。 */
export function modelsToCamel(models: Record<string, unknown>): ModelsConfig {
  const wrapped = snakeToCamel<{ models?: ModelsConfig }>(
    { models },
    { preserveKey: preserveConfigMapKeys },
  );
  return wrapped.models ?? {};
}

/** camelCase 价格四元组 → snake_case 磁盘形状。 */
function pricingToYaml(pricing: NonNullable<ModelEntry['pricing']>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    input_per_million: pricing.inputPerMillion,
    output_per_million: pricing.outputPerMillion,
  };
  if (pricing.cacheReadPerMillion !== undefined) {
    out.cache_read_per_million = pricing.cacheReadPerMillion;
  }
  if (pricing.cacheWritePerMillion !== undefined) {
    out.cache_write_per_million = pricing.cacheWritePerMillion;
  }
  return out;
}

/** camelCase param → snake_case 磁盘形状（extra 子树原样）。 */
function paramToYaml(param: NonNullable<ModelEntry['param']>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (param.temperature !== undefined) out.temperature = param.temperature;
  if (param.maxTokens !== undefined) out.max_tokens = param.maxTokens;
  if (param.topP !== undefined) out.top_p = param.topP;
  if (param.promptCache !== undefined) out.prompt_cache = param.promptCache;
  if (param.extra !== undefined) out.extra = param.extra;
  return out;
}

/** camelCase info → snake_case 磁盘形状（已知键映射；未知键读容忍原样，§10.3）。 */
function infoToYaml(info: NonNullable<ModelEntry['info']>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(info)) {
    if (value === undefined) continue;
    if (key === 'displayName') out.display_name = value;
    else if (key === 'contextWindow') out.context_window = value;
    else if (key === 'maxOutputTokens') out.max_output_tokens = value;
    else out[key] = value;
  }
  return out;
}

/** camelCase DTO → snake_case 磁盘条目（map 键原样）。 */
function entryToYaml(entry: ModelEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { credential: entry.credential };
  if (entry.name !== undefined) out.name = entry.name;
  if (entry.alias !== undefined) out.alias = entry.alias;
  if (entry.provider !== undefined) out.provider = entry.provider;
  if (entry.mode !== undefined) out.mode = entry.mode;
  if (entry.pricing !== undefined) out.pricing = pricingToYaml(entry.pricing);
  if (entry.param !== undefined) out.param = paramToYaml(entry.param);
  if (entry.info !== undefined) out.info = infoToYaml(entry.info);
  return out;
}

/** 凭证元数据 camelCase DTO → snake_case 磁盘形状（无密钥值）。 */
export function credentialToYaml(meta: {
  baseUrl: string;
  apiKeyEnv?: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { base_url: meta.baseUrl };
  if (meta.apiKeyEnv !== undefined) out.api_key_env = meta.apiKeyEnv;
  return out;
}

/**
 * 写前预校验：validateModels（camelCase 口径）；有错即抛，不落盘。
 * credential 引用命中按合并后 credentials 判（project 层凭证可被 user 层条目引用）；
 * 返回 warnings（H4 同 wire 价格冲突等）供 RPC 回传。
 */
function assertModelsValid(
  candidate: Record<string, unknown>,
  merged: VesselConfig,
): ConfigValidationWarning[] {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationWarning[] = [];
  const camel = modelsToCamel(candidate);
  const forValidation = {
    ...camel,
    credentials: { ...(merged.models?.credentials ?? {}), ...(camel.credentials ?? {}) },
  };
  validateModels(
    forValidation as unknown as Record<string, unknown>,
    merged.provider,
    errors,
    warnings,
  );
  if (errors.length > 0) {
    throw new Error(`models_invalid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  }
  return warnings;
}

/** 删空 credentials/entries map，避免在 yaml 里留空壳（迁移期 vendors/aliases 同）。 */
function pruneEmptyMaps(models: Record<string, unknown>): void {
  for (const key of ['credentials', 'entries', 'vendors', 'aliases']) {
    const value = models[key];
    if (isRecord(value) && Object.keys(value).length === 0) delete models[key];
  }
}

/**
 * models 块写事务：lock 内 读合并 config（provider 校验口径）→ 读 YAML 根 → 改目标块 →
 * 预校验 → 原子写 → 读回。返回读回的 models 块（snake_case；块被清空时为 {}）+ warnings。
 */
async function mutateModels(
  mutate: (models: Record<string, unknown>, merged: VesselConfig) => void,
): Promise<{ models: Record<string, unknown>; warnings: ConfigValidationWarning[] }> {
  const configPath = getUserConfigPath();
  return withConfigLock(configPath, async () => {
    const { config: merged } = await loadConfig();
    const root = await readUserConfigRoot(configPath);
    // 既有块形状非法 → fail-fast，不静默替换（避免把用户的手写内容覆盖掉）。
    for (const [key, value] of [
      ['models', root.models],
      ['models.credentials', isRecord(root.models) ? root.models.credentials : undefined],
      ['models.entries', isRecord(root.models) ? root.models.entries : undefined],
      ['models.vendors', isRecord(root.models) ? root.models.vendors : undefined],
      ['models.aliases', isRecord(root.models) ? root.models.aliases : undefined],
    ] as const) {
      if (value !== undefined && !isRecord(value)) {
        throw new Error(`models_invalid: existing ${key} block is not an object; fix it first`);
      }
    }
    const models = isRecord(root.models) ? { ...root.models } : {};
    mutate(models, merged);
    pruneEmptyMaps(models);
    const warnings = assertModelsValid(models, merged);
    const nextRoot = { ...root };
    if (Object.keys(models).length === 0) delete nextRoot.models;
    else nextRoot.models = models;
    await writeUserConfigRoot(configPath, nextRoot);
    const readBack = await readUserConfigRoot(configPath);
    return { models: isRecord(readBack.models) ? readBack.models : {}, warnings };
  });
}

/** model_set：整条替换（增改合一，继承 vendorSet 纪律）。返回写后读回 + warnings。 */
export async function modelSet(
  id: string,
  entry: ModelEntry,
): Promise<{ models: Record<string, unknown>; warnings: ConfigValidationWarning[] }> {
  return mutateModels((models) => {
    const entries = isRecord(models.entries) ? { ...models.entries } : {};
    entries[id] = entryToYaml(entry);
    models.entries = entries;
  });
}

/** model_remove：用户层存在性 + 合并 registry 引用检查（被引用 → 报错列引用，不级联删）。 */
export async function modelRemove(id: string): Promise<void> {
  await mutateModels((models, merged) => {
    const entries = isRecord(models.entries) ? models.entries : {};
    if (!Object.hasOwn(entries, id)) {
      throw new Error(`unknown_entry: "${id}" is not in the user config models.entries block`);
    }
    const refs = entryReferences(synthesizeLegacyRegistry(merged), id);
    if (refs.length > 0) {
      throw new Error(
        `entry_in_use: "${id}" is referenced by ${refs.join(', ')}; remove those references first`,
      );
    }
    const next = { ...entries };
    delete next[id];
    models.entries = next;
  });
}

/** default_set：ref 必须命中注册条目（validateModels 严格面）。 */
export async function defaultSet(ref: string): Promise<void> {
  await mutateModels((models) => {
    models.default = ref;
  });
}

/** credential_set 的 yaml 元数据半（值半在 index.ts 先写；§3.3 事务顺序）。 */
export async function credentialSetMeta(
  id: string,
  meta: { baseUrl: string; apiKeyEnv?: string },
): Promise<void> {
  await mutateModels((models) => {
    const credentials = isRecord(models.credentials) ? { ...models.credentials } : {};
    credentials[id] = credentialToYaml(meta);
    models.credentials = credentials;
  });
}

/** credential_remove 的 yaml 元数据半（引用检查在 index.ts；库值半随后删）。 */
export async function credentialRemoveMeta(id: string): Promise<void> {
  await mutateModels((models) => {
    const credentials = isRecord(models.credentials) ? models.credentials : {};
    if (!Object.hasOwn(credentials, id)) {
      throw new Error(
        `unknown_credential: "${id}" is not in the user config models.credentials block`,
      );
    }
    const next = { ...credentials };
    delete next[id];
    models.credentials = next;
  });
}
