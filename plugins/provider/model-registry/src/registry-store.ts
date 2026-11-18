/**
 * model-registry 插件：`~/.vessel/config.yaml` models 块读改写。
 *
 * 契约：docs/dev/plans/model-registry.md §3.3 + CONTRACT-model-registry-internal.md §2/§5。
 * - 写经 withConfigLock（跨进程锁，与 config.set / TUI 写路径共用），lock 内 read-modify-write；
 *   **写前 validateModels 预校验**（fail-fast RPC 错误，不落无效配置）；RPC 返回 = 写后读回。
 * - 磁盘形状 = snake_case（loader 的 snakeToCamel + preserveConfigMapKeys 是唯一映射口径，
 *   vendor id / 别名 / wire model id 是 map 键，原样保留）；RPC DTO = camelCase（同 VendorEntry）。
 * - 引用检查 = registry 内部引用（aliases / models.default / vendor.credential），不读 agent store。
 * - 只改 models 块；根对象与其它块原样保留。生效异步（config-watch），这里不做热应用。
 */

import {
  type ConfigValidationError,
  getUserConfigPath,
  loadConfig,
  type ModelRegistrySnapshot,
  type ModelsConfig,
  type ProviderConfig,
  preserveConfigMapKeys,
  readUserConfigRoot,
  snakeToCamel,
  synthesizeLegacyRegistry,
  type VendorEntry,
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
  const snapshot = synthesizeLegacyRegistry(config);
  const legacyPresent = Object.entries(sources).some(
    ([key, source]) => (key === 'provider' || key.startsWith('provider.')) && source !== 'default',
  );
  return { config, snapshot, legacyPresent };
}

/** vendor 的内部引用（§5）：指向它的别名 + models.default（别名展开后按首段 vendor id 判）。 */
export function vendorReferences(snapshot: ModelRegistrySnapshot, vendorId: string): string[] {
  const refs: string[] = [];
  for (const [alias, target] of Object.entries(snapshot.aliases)) {
    if (target.split('/')[0] === vendorId) refs.push(`alias:${alias}`);
  }
  const defaultRef = snapshot.defaultRef;
  if (defaultRef !== undefined && defaultRef !== '') {
    const expanded = Object.hasOwn(snapshot.aliases, defaultRef)
      ? (snapshot.aliases[defaultRef] as string)
      : defaultRef;
    if (expanded.split('/')[0] === vendorId) refs.push('models.default');
  }
  return refs;
}

/** credential 的内部引用（§5）：vendor.credential 指向它的 vendor id 列表。 */
export function credentialReferences(
  snapshot: ModelRegistrySnapshot,
  credentialId: string,
): string[] {
  return Object.values(snapshot.vendors)
    .filter((vendor) => vendor.credentialRef === credentialId)
    .map((vendor) => vendor.id);
}

/** 磁盘 models 块（snake_case）→ camelCase（复用 loader 映射口径，map 键原样保留）。 */
export function modelsToCamel(models: Record<string, unknown>): ModelsConfig {
  const wrapped = snakeToCamel<{ models?: ModelsConfig }>(
    { models },
    { preserveKey: preserveConfigMapKeys },
  );
  return wrapped.models ?? {};
}

/** camelCase DTO → snake_case 磁盘条目（只含已批最小字段集；map 键原样）。 */
function vendorToYaml(entry: VendorEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { protocol: entry.protocol };
  if (entry.baseUrl !== undefined) out.base_url = entry.baseUrl;
  if (entry.credential !== undefined) out.credential = entry.credential;
  if (entry.apiKeyEnv !== undefined) out.api_key_env = entry.apiKeyEnv;
  const models: Record<string, unknown> = {};
  for (const [modelId, modelEntry] of Object.entries(entry.models)) {
    models[modelId] =
      modelEntry.promptCache !== undefined ? { prompt_cache: modelEntry.promptCache } : {};
  }
  out.models = models;
  return out;
}

/** 写前预校验：validateModels（camelCase 口径）；有错即抛，不落盘。 */
function assertModelsValid(
  candidate: Record<string, unknown>,
  provider: ProviderConfig | undefined,
): void {
  const errors: ConfigValidationError[] = [];
  // 同 validateConfig 调用点口径（validator.ts）：ModelsConfig → Record<string, unknown>。
  validateModels(modelsToCamel(candidate) as unknown as Record<string, unknown>, provider, errors);
  if (errors.length > 0) {
    throw new Error(`models_invalid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  }
}

/** 删空 vendors/aliases map，避免在 yaml 里留空壳。 */
function pruneEmptyMaps(models: Record<string, unknown>): void {
  for (const key of ['vendors', 'aliases']) {
    const value = models[key];
    if (isRecord(value) && Object.keys(value).length === 0) delete models[key];
  }
}

/**
 * models 块写事务：lock 内 读合并 config（provider 校验口径）→ 读 YAML 根 → 改目标块 →
 * 预校验 → 原子写 → 读回。返回读回的 models 块（snake_case；块被清空时为 {}）。
 */
async function mutateModels(
  mutate: (models: Record<string, unknown>, merged: VesselConfig) => void,
): Promise<Record<string, unknown>> {
  const configPath = getUserConfigPath();
  return withConfigLock(configPath, async () => {
    const { config: merged } = await loadConfig();
    const root = await readUserConfigRoot(configPath);
    // 既有块形状非法 → fail-fast，不静默替换（避免把用户的手写内容覆盖掉）。
    for (const [key, value] of [
      ['models', root.models],
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
    assertModelsValid(models, merged.provider);
    const nextRoot = { ...root };
    if (Object.keys(models).length === 0) delete nextRoot.models;
    else nextRoot.models = models;
    await writeUserConfigRoot(configPath, nextRoot);
    const readBack = await readUserConfigRoot(configPath);
    return isRecord(readBack.models) ? readBack.models : {};
  });
}

/** vendor_set：整条替换（增改合一）。返回写后读回的 models 块。 */
export async function vendorSet(id: string, entry: VendorEntry): Promise<Record<string, unknown>> {
  return mutateModels((models) => {
    const vendors = isRecord(models.vendors) ? { ...models.vendors } : {};
    vendors[id] = vendorToYaml(entry);
    models.vendors = vendors;
  });
}

/** vendor_remove：用户层存在性 + 合并 registry 引用检查（被引用 → 报错列引用，不级联删）。 */
export async function vendorRemove(id: string): Promise<void> {
  await mutateModels((models, merged) => {
    const vendors = isRecord(models.vendors) ? models.vendors : {};
    if (!Object.hasOwn(vendors, id)) {
      throw new Error(`unknown_vendor: "${id}" is not in the user config models block`);
    }
    const refs = vendorReferences(synthesizeLegacyRegistry(merged), id);
    if (refs.length > 0) {
      throw new Error(
        `vendor_in_use: "${id}" is referenced by ${refs.join(', ')}; remove those references first`,
      );
    }
    const next = { ...vendors };
    delete next[id];
    models.vendors = next;
  });
}

/** alias_set：扁平别名（语义校验 = validateModels：目标命中注册条目、拒绝别名→别名）。 */
export async function aliasSet(alias: string, ref: string): Promise<void> {
  await mutateModels((models) => {
    const aliases = isRecord(models.aliases) ? { ...models.aliases } : {};
    aliases[alias] = ref;
    models.aliases = aliases;
  });
}

/** alias_remove：只删用户层条目；不存在即报错。 */
export async function aliasRemove(alias: string): Promise<void> {
  await mutateModels((models) => {
    const aliases = isRecord(models.aliases) ? models.aliases : {};
    if (!Object.hasOwn(aliases, alias)) {
      throw new Error(`unknown_alias: "${alias}" is not in the user config models block`);
    }
    const next = { ...aliases };
    delete next[alias];
    models.aliases = next;
  });
}

/** default_set：ref 必须命中注册条目（validateModels 严格面）。 */
export async function defaultSet(ref: string): Promise<void> {
  await mutateModels((models) => {
    models.default = ref;
  });
}
