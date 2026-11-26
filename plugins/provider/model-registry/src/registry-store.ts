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
 * - 凭证值不在本模块：credential_set 的加密库值写入在 index.ts（先值后元数据，§3.3）；
 *   yaml 半失败可能留 store-only 孤儿值，credential_remove 容忍 yaml 缺失并清掉库值。
 */

import {
  type ConfigValidationError,
  type ConfigValidationWarning,
  credentialToYaml,
  entryToYaml,
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

/** 删空 credentials/entries map，避免在 yaml 里留空壳。 */
function pruneEmptyMaps(models: Record<string, unknown>): void {
  for (const key of ['credentials', 'entries']) {
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
