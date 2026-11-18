/**
 * @vessel-agent/model-registry — 官方 in-process 模型管理插件（P1）。
 *
 * 契约：docs/dev/plans/model-registry.md §3 + CONTRACT-model-registry-internal.md。
 * 管理 API（models 块读改写）+ 加密凭证库 + 连通性测试。机制在 harness：装配层经
 * registerInProcessPlugin 把本插件的 `rpc` 注册进同一个 PluginRpcRegistry
 * （canonical `plugin.model-registry.<name>`，同一 DTO 校验）；这里只实现 handler 语义，
 * 不自造注册路径。P1 只声明 contributes.rpc；pages/navGroups/ui 属 P2。
 *
 * 生效语义：写路径只落盘（config.yaml models 块 / credentials.json），热应用由
 * config-watch + applier 完成（M1d 接缝）——「已保存，下一具 body/run 生效」。
 * 明文纪律：credential value 只在 credential_set 写入瞬间存在；RPC 结果永不回显。
 */

import type { ModelEntry, ModelRegistrySnapshot, VendorEntry } from '@vessel-agent/config';
import { resolveEffectiveApiKey, resolveModelRef } from '@vessel-agent/config';
import type { Plugin } from '@vessel-agent/core';
import { defaultBaseUrlFor, testConnectivity } from './connectivity';
import { CredentialStore, resolveDataDir } from './credential-store';
import {
  aliasRemove,
  aliasSet,
  credentialReferences,
  defaultSet,
  modelsToCamel,
  readRegistry,
  vendorReferences,
  vendorRemove,
  vendorSet,
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

/** vendor DTO 形状收敛（未知键拒绝，对齐 KNOWN_BLOCK_KEYS['models.vendors']）；语义校验 = validateModels。 */
function parseVendorEntry(raw: unknown): VendorEntry {
  if (!isRecord(raw)) throw invalidParams('entry must be an object');
  const knownKeys = new Set(['protocol', 'baseUrl', 'credential', 'apiKeyEnv', 'models']);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) throw invalidParams(`entry.${key} is not a known vendor field`);
  }
  const protocol = raw.protocol;
  if (typeof protocol !== 'string' || protocol.trim() === '') {
    throw invalidParams('entry.protocol must be a non-empty string');
  }
  const optionalFields = ['baseUrl', 'credential', 'apiKeyEnv'] as const;
  const entry: VendorEntry = { protocol, models: {} };
  for (const field of optionalFields) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw invalidParams(`entry.${field} must be a non-empty string when set`);
    }
    entry[field] = value;
  }
  const models = raw.models;
  if (!isRecord(models) || Object.keys(models).length === 0) {
    throw invalidParams('entry.models must register at least one model (models: { <id>: {} })');
  }
  for (const [modelId, modelRaw] of Object.entries(models)) {
    if (modelId.trim() === '') throw invalidParams('entry.models keys must be non-empty');
    if (!isRecord(modelRaw)) {
      throw invalidParams(`entry.models.${modelId} must be an object (use {} for defaults)`);
    }
    for (const key of Object.keys(modelRaw)) {
      if (key !== 'promptCache') {
        throw invalidParams(`entry.models.${modelId}.${key} is not a known model field`);
      }
    }
    const promptCache = modelRaw.promptCache;
    if (promptCache !== undefined && typeof promptCache !== 'boolean') {
      throw invalidParams(`entry.models.${modelId}.promptCache must be a boolean when set`);
    }
    const modelEntry: ModelEntry = promptCache !== undefined ? { promptCache } : {};
    entry.models[modelId] = modelEntry;
  }
  return entry;
}

/**
 * 有效默认（与装配 resolveModel 同口径，§2.6 冻结）：VESSEL_MODEL 非空则以其为 ref
 * （env 赢 models.default），否则走默认链。无效配置（default/别名未命中）时返回
 * undefined——list 仍回 registry 本身供 UI 修复，不整体报错。
 */
function effectiveOf(
  snapshot: ModelRegistrySnapshot,
): { vendorId: string; wireModel: string } | undefined {
  const envModel = process.env.VESSEL_MODEL;
  const ref = envModel !== undefined && envModel.trim() !== '' ? envModel : undefined;
  try {
    const resolved = resolveModelRef(snapshot, ref);
    if (resolved === undefined) return undefined;
    return { vendorId: resolved.vendorId, wireModel: resolved.wireModel };
  } catch {
    return undefined;
  }
}

async function handleList(): Promise<Record<string, unknown>> {
  const { config, snapshot, legacyPresent } = await readRegistry();
  const vendors = Object.values(snapshot.vendors).map((vendor) => ({
    id: vendor.id,
    protocol: vendor.protocol,
    ...(vendor.baseUrl !== undefined ? { baseUrl: vendor.baseUrl } : {}),
    ...(vendor.credentialRef !== undefined ? { credentialRef: vendor.credentialRef } : {}),
    models: vendor.models,
    inUse: vendorReferences(snapshot, vendor.id).length > 0,
  }));
  const provider = config.provider;
  const legacyRef =
    provider?.model !== undefined && provider.model !== ''
      ? `legacy:${provider.name ?? 'openai'}/${provider.model}`
      : undefined;
  const effective = effectiveOf(snapshot);
  return {
    vendors,
    aliases: snapshot.aliases,
    ...(snapshot.defaultRef !== undefined ? { default: snapshot.defaultRef } : {}),
    ...(effective !== undefined ? { effective } : {}),
    legacy: { present: legacyPresent, ...(legacyRef !== undefined ? { ref: legacyRef } : {}) },
  };
}

async function handleVendorSet(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = requireString(params, 'id');
  const entry = parseVendorEntry(params.entry);
  const readBack = await vendorSet(id, entry);
  const vendor = modelsToCamel(readBack).vendors?.[id];
  if (vendor === undefined) {
    throw new Error(`vendor_set_readback_missing: "${id}" not found after write`);
  }
  return { ok: true, vendor };
}

async function handleDefaultSet(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ref = requireString(params, 'ref');
  await defaultSet(ref);
  // 写后读回：重新合并（user/project/env）再解析 effective。
  const { snapshot } = await readRegistry();
  const effective = effectiveOf(snapshot);
  return { ok: true, ...(effective !== undefined ? { effective } : {}) };
}

async function handleCredentialSet(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = requireString(params, 'id');
  const value = requireString(params, 'value');
  const { config } = await readRegistry();
  const store = new CredentialStore(resolveDataDir(config));
  const { updatedAt } = await store.set(id, value);
  return { ok: true, updatedAt };
}

async function handleCredentialRemove(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = requireString(params, 'id');
  const { config, snapshot } = await readRegistry();
  const refs = credentialReferences(snapshot, id);
  if (refs.length > 0) {
    throw new Error(
      `credential_in_use: "${id}" is referenced by vendors: ${refs.join(', ')}; ` +
        'remove those references first',
    );
  }
  const store = new CredentialStore(resolveDataDir(config));
  await store.remove(id);
  return { ok: true };
}

async function handleCredentialsList(): Promise<Record<string, unknown>[]> {
  const { config, snapshot } = await readRegistry();
  const store = new CredentialStore(resolveDataDir(config));
  const metas = await store.list();
  return metas.map((meta) => ({ ...meta, usedBy: credentialReferences(snapshot, meta.id) }));
}

/** test：只接受已保存 vendor；未保存草稿 = 先保存再测（明文 key 不出现在 test 参数）。 */
async function handleTest(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const vendorId = requireString(params, 'vendor');
  const requestedModel = optionalString(params, 'model');
  const { config, snapshot } = await readRegistry();
  const vendor = Object.hasOwn(snapshot.vendors, vendorId) ? snapshot.vendors[vendorId] : undefined;
  if (vendor === undefined) {
    throw new Error(`unknown_vendor: "${vendorId}" is not registered; save the vendor first`);
  }

  // model 校验：注册 vendor 必须命中清单（legacy 条目透传）；anthropic 无 /models 端点，
  // 未指定 model 时取清单首个（确定性选择）。
  let model = requestedModel;
  if (model !== undefined) {
    if (!vendor.legacy && !Object.hasOwn(vendor.models, model)) {
      throw new Error(
        `unknown_model: "${model}" is not registered under vendor "${vendorId}" ` +
          `(registered: ${Object.keys(vendor.models).join(', ') || '<none>'})`,
      );
    }
  } else if (vendor.protocol === 'anthropic') {
    model = Object.keys(vendor.models)[0];
    if (model === undefined) {
      throw new Error(`no_model: vendor "${vendorId}" has no registered model to test`);
    }
  }

  const baseUrl = vendor.baseUrl ?? defaultBaseUrlFor(vendor.protocol);
  if (baseUrl === undefined) {
    throw new Error(
      `unsupported_protocol: connectivity test supports openai-compatible ` +
        `(openai/google/mistral/ollama/cohere) and anthropic protocols; ` +
        `"${vendor.protocol}" is a custom provider plugin protocol`,
    );
  }

  // 凭证解析（已存凭证）：credential 引用 → 解密；apiKeyEnv → env；legacy → provider.*。
  let apiKey: string | undefined;
  if (vendor.credentialRef !== undefined) {
    const store = new CredentialStore(resolveDataDir(config));
    apiKey = await store.reveal(vendor.credentialRef);
  } else if (vendor.apiKeyEnv !== undefined) {
    apiKey = process.env[vendor.apiKeyEnv];
  } else if (vendor.legacy) {
    // 与请求路径同口径（wiring apiKeyFor legacy 分支）：provider.apiKey / *_env / 顶层。
    apiKey = resolveEffectiveApiKey(config) ?? undefined;
  }
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new Error(
      `no_credential: vendor "${vendorId}" has no usable credential; ` +
        'set a credential (credential_set) or an apiKeyEnv first',
    );
  }

  const result = await testConnectivity({
    protocol: vendor.protocol,
    baseUrl,
    apiKey,
    ...(model !== undefined ? { model } : {}),
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
      case 'vendor_set':
        return handleVendorSet(params);
      case 'vendor_remove':
        await vendorRemove(requireString(params, 'id'));
        return { ok: true };
      case 'alias_set':
        await aliasSet(requireString(params, 'alias'), requireString(params, 'ref'));
        return { ok: true };
      case 'alias_remove':
        await aliasRemove(requireString(params, 'alias'));
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
