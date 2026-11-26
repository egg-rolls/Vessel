/**
 * @vessel-agent/model-registry — 官方 in-process 模型管理插件（两面重构 §8）。
 *
 * 契约：docs/dev/design/model-registry-two-face-design.md §3/§4/§8（取代上位契约 §3）。
 * 管理 API（models 块读改写）+ 加密凭证库 + 连通性测试。机制在 harness：装配层经
 * registerInProcessPlugin 把本插件的 `rpc` 注册进同一个 PluginRpcRegistry
 * （canonical `plugin.model-registry.<name>`，同一 DTO 校验）；这里只实现 handler 语义，
 * 不自造注册路径。
 *
 * RPC 8 方法：list / model_set / model_remove / default_set / credential_set /
 * credential_remove / credentials_list / test（vendor_set/remove、alias_set/remove 已删；
 * 别称随 model_set 写入）。
 *
 * 生效语义：写路径只落盘（config.yaml models 块 / credentials.json），热应用由
 * config-watch + applier 完成——「已保存，下一具 body/run 生效」。
 * 明文纪律：credential value 只在 credential_set 写入瞬间存在；RPC 结果永不回显。
 */

import type { ModelEntry, ModelRegistrySnapshot } from '@vessel-agent/config';
import { resolveEffectiveApiKey, resolveModelRef } from '@vessel-agent/config';
import type { Plugin } from '@vessel-agent/core';
import { defaultBaseUrlFor, testConnectivity } from './connectivity';
import { CredentialStore, resolveDataDir } from './credential-store';
import {
  credentialReferences,
  credentialRemoveMeta,
  credentialSetMeta,
  defaultSet,
  entryReferences,
  modelRemove,
  modelSet,
  modelsToCamel,
  readRegistry,
} from './registry-store';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidParams(message: string): Error {
  return new Error(`invalid_params: ${message}`);
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidParams(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidParams(`${key} must be a non-empty string when set`);
  }
  return value;
}

/**
 * model DTO 形状收敛（未知键拒绝，对齐 KNOWN_BLOCK_KEYS['models.entries']）；
 * 语义校验（credential 命中 / alias 唯一 / mode 相容 / pricing / param / info）= validateModels。
 */
function parseModelEntry(raw: unknown): ModelEntry {
  if (!isRecord(raw)) throw invalidParams('entry must be an object');
  const knownKeys = new Set([
    'name',
    'alias',
    'provider',
    'mode',
    'credential',
    'pricing',
    'param',
    'info',
  ]);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) throw invalidParams(`entry.${key} is not a known model field`);
  }
  const credential = raw.credential;
  if (typeof credential !== 'string' || credential.trim() === '') {
    throw invalidParams('entry.credential is required (a models.credentials.<id> reference)');
  }
  const entry: ModelEntry = { credential };
  for (const field of ['name', 'alias', 'provider'] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw invalidParams(`entry.${field} must be a non-empty string when set`);
    }
    entry[field] = value;
  }
  if (raw.mode !== undefined) {
    if (typeof raw.mode !== 'string' || raw.mode.trim() === '') {
      throw invalidParams('entry.mode must be a non-empty string when set');
    }
    // 枚举相容性（chat/responses/messages × provider）在 validateModels 语义校验。
    entry.mode = raw.mode as ModelEntry['mode'];
  }
  if (raw.pricing !== undefined) {
    if (!isRecord(raw.pricing)) throw invalidParams('entry.pricing must be an object');
    const pricing: Record<string, unknown> = {};
    for (const key of [
      'inputPerMillion',
      'outputPerMillion',
      'cacheReadPerMillion',
      'cacheWritePerMillion',
    ]) {
      const value = raw.pricing[key];
      if (value === undefined) continue;
      if (typeof value !== 'number') {
        throw invalidParams(`entry.pricing.${key} must be a number when set`);
      }
      pricing[key] = value;
    }
    for (const key of Object.keys(raw.pricing)) {
      if (!(key in pricing)) throw invalidParams(`entry.pricing.${key} is not a known price field`);
    }
    entry.pricing = pricing as unknown as ModelEntry['pricing'];
  }
  if (raw.param !== undefined) {
    if (!isRecord(raw.param)) throw invalidParams('entry.param must be an object');
    const param: Record<string, unknown> = {};
    for (const key of ['temperature', 'maxTokens', 'topP']) {
      const value = raw.param[key];
      if (value === undefined) continue;
      if (typeof value !== 'number') throw invalidParams(`entry.param.${key} must be a number`);
      param[key] = value;
    }
    if (raw.param.promptCache !== undefined) {
      if (typeof raw.param.promptCache !== 'boolean') {
        throw invalidParams('entry.param.promptCache must be a boolean');
      }
      param.promptCache = raw.param.promptCache;
    }
    if (raw.param.extra !== undefined) {
      if (!isRecord(raw.param.extra)) throw invalidParams('entry.param.extra must be an object');
      param.extra = raw.param.extra;
    }
    for (const key of Object.keys(raw.param)) {
      if (!(key in param)) throw invalidParams(`entry.param.${key} is not a known param field`);
    }
    entry.param = param as ModelEntry['param'];
  }
  if (raw.info !== undefined) {
    if (!isRecord(raw.info)) throw invalidParams('entry.info must be an object');
    entry.info = raw.info as ModelEntry['info'];
  }
  return entry;
}

/**
 * 有效默认（与装配 resolveModel 同口径，§2.6 冻结）：VESSEL_MODEL 非空则以其为 ref
 * （env 赢 models.default），否则走默认链。无效配置（default/别称未命中）时返回
 * undefined——list 仍回 registry 本身供 UI 修复，不整体报错。
 */
function effectiveOf(
  snapshot: ModelRegistrySnapshot,
): { entryId: string; wireModel: string } | undefined {
  const envModel = process.env.VESSEL_MODEL;
  const ref = envModel !== undefined && envModel.trim() !== '' ? envModel : undefined;
  try {
    const resolved = resolveModelRef(snapshot, ref);
    if (resolved === undefined) return undefined;
    return { entryId: resolved.entryId, wireModel: resolved.wireModel };
  } catch {
    return undefined;
  }
}

/** 凭证 DTO（§3.3）：yaml 元数据 ∪ 加密库元数据；值永不回显。 */
async function credentialDtos(
  config: Parameters<typeof resolveDataDir>[0],
  snapshot: ModelRegistrySnapshot,
): Promise<Record<string, unknown>[]> {
  const store = new CredentialStore(resolveDataDir(config));
  const metas = await store.list();
  const metaById = new Map(metas.map((meta) => [meta.id, meta]));
  const ids = new Set<string>([
    ...Object.values(snapshot.credentials)
      .filter((cred) => !cred.legacy)
      .map((cred) => cred.id),
    ...metas.map((meta) => meta.id),
  ]);
  return [...ids].sort().map((id) => {
    const cred = snapshot.credentials[id];
    const meta = metaById.get(id);
    return {
      id,
      ...(cred?.baseUrl !== undefined ? { baseUrl: cred.baseUrl } : {}),
      ...(cred?.apiKeyEnv !== undefined ? { apiKeyEnv: cred.apiKeyEnv } : {}),
      hasValue: meta !== undefined,
      ...(meta !== undefined ? { createdAt: meta.createdAt, updatedAt: meta.updatedAt } : {}),
      usedBy: credentialReferences(snapshot, id),
    };
  });
}

async function handleList(): Promise<Record<string, unknown>> {
  const { config, snapshot, legacyPresent } = await readRegistry();
  const entries = Object.values(snapshot.entries).map((entry) => ({
    id: entry.id,
    name: entry.wireModel,
    ...(entry.alias !== undefined ? { alias: entry.alias } : {}),
    provider: entry.provider,
    mode: entry.mode,
    ...(entry.credentialRef !== undefined ? { credential: entry.credentialRef } : {}),
    ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
    ...(entry.pricing !== undefined ? { pricing: entry.pricing } : {}),
    ...(entry.param !== undefined ? { param: entry.param } : {}),
    ...(entry.info !== undefined ? { info: entry.info } : {}),
    inUse: entryReferences(snapshot, entry.id).length > 0,
    legacy: entry.legacy,
  }));
  const effective = effectiveOf(snapshot);
  return {
    credentials: await credentialDtos(config, snapshot),
    entries,
    ...(snapshot.defaultRef !== undefined ? { default: snapshot.defaultRef } : {}),
    ...(effective !== undefined ? { effective } : {}),
    legacyPresent,
  };
}

async function handleModelSet(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = requireString(params, 'id');
  const entry = parseModelEntry(params.entry);
  const { models: readBack, warnings } = await modelSet(id, entry);
  const written = modelsToCamel(readBack).entries?.[id];
  if (written === undefined) {
    throw new Error(`model_set_readback_missing: "${id}" not found after write`);
  }
  return { ok: true, entry: written, ...(warnings.length > 0 ? { warnings } : {}) };
}

async function handleDefaultSet(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ref = requireString(params, 'ref');
  await defaultSet(ref);
  // 写后读回：重新合并（user/project/env）再解析 effective。
  const { snapshot } = await readRegistry();
  const effective = effectiveOf(snapshot);
  return { ok: true, ...(effective !== undefined ? { effective } : {}) };
}

/**
 * credential_set：一次写两处（§3.3）——先加密库值、后 yaml 元数据（withConfigLock 内）。
 * 值失败不写 yaml；yaml 失败留孤儿值（无害，credentials_list 可见未引用条目）。
 * apiKey 缺省 = 不改值（编辑态）；baseUrl 必填。明文纪律：值永不回显。
 */
async function handleCredentialSet(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = requireString(params, 'id');
  const baseUrl = requireString(params, 'baseUrl');
  const apiKeyEnv = optionalString(params, 'apiKeyEnv');
  // 迁移期兼容：旧 UI/CLI 的 value 参数 = apiKey（C6 UI 收敛后删除）。
  const apiKey = optionalString(params, 'apiKey') ?? optionalString(params, 'value');
  const { config } = await readRegistry();
  let updatedAt: string | undefined;
  if (apiKey !== undefined) {
    const store = new CredentialStore(resolveDataDir(config));
    updatedAt = (await store.set(id, apiKey)).updatedAt;
  }
  await credentialSetMeta(id, { baseUrl, ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}) });
  return { ok: true, ...(updatedAt !== undefined ? { updatedAt } : {}) };
}

async function handleCredentialRemove(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = requireString(params, 'id');
  const { config, snapshot } = await readRegistry();
  const refs = credentialReferences(snapshot, id);
  if (refs.length > 0) {
    throw new Error(
      `credential_in_use: "${id}" is referenced by entries: ${refs.join(', ')}; ` +
        'remove those references first',
    );
  }
  // 先删 yaml 元数据，再删库值（库值缺失 = env-only 凭证，容忍）。
  await credentialRemoveMeta(id);
  const store = new CredentialStore(resolveDataDir(config));
  try {
    await store.remove(id);
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('unknown_credential'))) throw error;
  }
  return { ok: true };
}

async function handleCredentialsList(): Promise<Record<string, unknown>[]> {
  const { config, snapshot } = await readRegistry();
  return credentialDtos(config, snapshot);
}

/** 凭证值解析：库值优先（D10 解密失败 fail-loud）；缺值回落 env 间接；legacy 走 provider.*。 */
async function apiKeyForCredential(
  config: Parameters<typeof resolveDataDir>[0],
  credentialId: string,
  apiKeyEnv: string | undefined,
  legacy: boolean,
): Promise<string> {
  if (legacy) return resolveEffectiveApiKey(config) ?? '';
  const store = new CredentialStore(resolveDataDir(config));
  try {
    return await store.reveal(credentialId);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('unknown_credential')) {
      if (apiKeyEnv !== undefined) {
        const value = process.env[apiKeyEnv];
        if (typeof value === 'string' && value.trim() !== '') return value;
      }
      return '';
    }
    throw error;
  }
}

/**
 * test（§8.1 换形）：{ entry }（注册模型：provider+凭证+name 齐备）或
 * { credential, provider?, model? }（凭证级 ping；无 model → GET /models 探测）。
 * 端点恒取凭证 baseUrl（defaultBaseUrlFor 仅 test 兜底）；明文 key 不出现在 test 参数。
 */
async function handleTest(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const entryId = optionalString(params, 'entry');
  const credentialId = optionalString(params, 'credential');
  const { config, snapshot } = await readRegistry();

  let protocol: string;
  let baseUrl: string | undefined;
  let model: string | undefined;
  let apiKey: string;

  if (entryId !== undefined) {
    const entry = Object.hasOwn(snapshot.entries, entryId) ? snapshot.entries[entryId] : undefined;
    if (entry === undefined) {
      throw new Error(`unknown_entry: "${entryId}" is not registered; save the model first`);
    }
    protocol = entry.provider;
    baseUrl = entry.baseUrl ?? defaultBaseUrlFor(protocol);
    model = entry.legacy ? (optionalString(params, 'model') ?? entry.wireModel) : entry.wireModel;
    const cred =
      entry.credentialRef !== undefined ? snapshot.credentials[entry.credentialRef] : undefined;
    apiKey = await apiKeyForCredential(
      config,
      entry.credentialRef ?? '',
      entry.apiKeyEnv ?? cred?.apiKeyEnv,
      entry.legacy || (entry.credentialRef?.startsWith('legacy:') ?? false),
    );
  } else if (credentialId !== undefined) {
    const cred = Object.hasOwn(snapshot.credentials, credentialId)
      ? snapshot.credentials[credentialId]
      : undefined;
    if (cred === undefined) {
      throw new Error(`unknown_credential: "${credentialId}" is not registered; save it first`);
    }
    protocol = optionalString(params, 'provider') ?? 'openai';
    baseUrl = cred.baseUrl ?? defaultBaseUrlFor(protocol);
    model = optionalString(params, 'model');
    apiKey = await apiKeyForCredential(config, credentialId, cred.apiKeyEnv, cred.legacy);
  } else {
    throw invalidParams('test requires { entry } or { credential, provider?, model? }');
  }

  if (baseUrl === undefined) {
    throw new Error(
      `unsupported_protocol: connectivity test supports openai-compatible ` +
        `(openai/openai-compatible/gemini/google/mistral/ollama/cohere) and anthropic protocols; ` +
        `"${protocol}" is a custom provider plugin protocol`,
    );
  }
  if (apiKey.trim() === '') {
    throw new Error(
      `no_credential: "${entryId ?? credentialId}" has no usable credential value; ` +
        'record it via credential_set or set an api_key_env first',
    );
  }
  if (protocol === 'anthropic' && (model === undefined || model === '')) {
    throw new Error('no_model: anthropic connectivity test requires a model (no /models endpoint)');
  }

  const result = await testConnectivity({
    protocol,
    baseUrl,
    apiKey,
    ...(model !== undefined && model !== '' ? { model } : {}),
  });
  return { ...result };
}

const plugin: Plugin = {
  name: 'model-registry',
  // RPC-only 能力插件：无 tool/provider 注册；rpc handler 由装配层 registerInProcessPlugin
  // 接进宿主 PluginRpcRegistry（install 之后），这里无需消费 host。
  install() {},
  async rpc(name: string, params: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'list':
        return handleList();
      case 'model_set':
        return handleModelSet(params);
      case 'model_remove':
        await modelRemove(requireString(params, 'id'));
        return { ok: true };
      case 'default_set':
        return handleDefaultSet(params);
      case 'credential_set':
        return handleCredentialSet(params);
      case 'credential_remove':
        return handleCredentialRemove(params);
      case 'credentials_list':
        return handleCredentialsList();
      case 'test':
        return handleTest(params);
      default:
        throw new Error(`unknown_method: ${name}`);
    }
  },
};

export default plugin;
