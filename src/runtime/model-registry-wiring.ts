/**
 * model-registry P1-w2d：多厂商路由 + 热应用装配（CONTRACT-model-registry-internal §3/§4）。
 *
 * - registry 快照（`synthesizeLegacyRegistry`）+ provider 实例缓存：
 *   键 = entryId + baseUrl + 凭证信封 updatedAt（只读元数据，不解密）+ promptCache + param 构造缺省；
 * - `resolveModel` 返回 **delegating wrapper**（实现 LLMProvider）：每请求按当前键取/建
 *   实例 → 凭证轮换后 live EU **下一请求**即用新 key，不需要插件→装配通知通道；
 * - 构造唯一路径：`providerHost.getProvider(protocol)` 工厂（snake_case 参数同
 *   provider-factory 今天）；未注册 protocol + baseUrl → 复用 openai 工厂；
 *   openai 插件缺失 → 裸 provider；未注册 + 无 baseUrl → `ProviderConfigError` fail-fast；
 * - `applyConfig(next)`：重建快照 + 清缓存（config scope applier 调用）。live EU/body 的
 *   model 是构造期只读快照（前缀不变量），热应用只影响下一具 body/EU/run。
 *
 * 明文纪律：凭证值只在实例构造瞬间短暂解密，绝不进快照 / 缓存键 / 日志 / RPC。
 * 信封形状真源 = 上位契约 §2.2（M1c 写 / M1d 读）：`{v:1, entries:{id:{iv,tag,data,
 * createdAt,updatedAt}}}`，iv/tag/data base64；AES-256-GCM key = credentials purpose
 * 派生 token 去 `vsk_` 前缀后 base64url 解码（32B）。
 *
 * @module vessel/model-registry-wiring
 */

import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ModelRefErrorInfo } from '../../packages/agent/src/index';
import {
  type ConfigSources,
  DERIVED_TOKEN_PREFIX,
  type DefaultModelIdentity,
  defaultModelForProvider,
  defaultModelRefOf,
  derivePurposeToken,
  ModelRefError,
  type ResolvedModel,
  ROOT_SECRET_BYTES,
  readRootSecret,
  resolveEffectiveApiKey,
  resolveModelRef,
  rootSecretPath,
  synthesizeLegacyRegistry,
  type VesselConfig,
} from '../../packages/config/src/index';
import {
  type LLMProvider,
  MemoryPluginHost,
  OpenAICompatibleProvider,
  type Plugin,
  writeStderrNotice,
} from '../../packages/core/src/index';
import { resolveDataDir } from '../data/data-paths';
import type { PluginDescriptor, PluginLoader } from '../plugin/plugin-loader';

/** provider 配置错误（调用方决定退出码：0.3 入口 1 / 新子命令 2） */
export class ProviderConfigError extends Error {
  readonly code = 'provider_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

/** 未知 provider 的 OpenAI 兼容提示只打一次（进程内）。 */
let unknownProviderNoticeShown = false;
/** openai 插件缺失时的裸 fallback warning 只打一次（进程内）。 */
let bareFallbackNoticeShown = false;

function notifyUnknownProvider(providerName: string, baseUrl: string, model: string): void {
  if (unknownProviderNoticeShown) return;
  unknownProviderNoticeShown = true;
  // 走统一 sink 入口：sink 坏掉时静默丢弃，绝不因为「打不出提示」而影响进程。
  writeStderrNotice(
    `[vessel] Provider "${providerName}" is not registered; using OpenAI-compatible endpoint ` +
      `"${baseUrl}" (model: ${model}).\n`,
  );
}

/** 裸 fallback 没有 withRetry/withTimeout；文案只含 provider 名与端点，不含密钥。 */
function notifyBareFallback(providerName: string, baseUrl: string): void {
  if (bareFallbackNoticeShown) return;
  bareFallbackNoticeShown = true;
  writeStderrNotice(
    `[vessel] Provider "${providerName}" fallback uses a bare OpenAI-compatible client ` +
      `without retry/timeout (endpoint: "${baseUrl}"); install the provider-openai plugin ` +
      'to enable retries and the default 120s timeout.\n',
  );
}

/**
 * provider.* 显式值判定（legacyPresent 热应用近似口径）：默认层只给
 * name='openai' / temperature=0.7 / maxTokens=4096；其余键出现或值偏离默认即视为
 * legacy 兼容面存在（保守方向：宁可透传，不误杀存量 pin）。
 */
function hasExplicitProvider(config: VesselConfig): boolean {
  const p = config.provider;
  if (p === undefined) return false;
  if (p.apiKey !== undefined || p.apiKeyEnv !== undefined || p.baseUrl !== undefined) return true;
  if (p.promptCache !== undefined || p.timeoutMs !== undefined) return true;
  if (p.name !== undefined && p.name !== 'openai') return true;
  if (p.temperature !== undefined && p.temperature !== 0.7) return true;
  if (p.maxTokens !== undefined && p.maxTokens !== 4096) return true;
  const fallback = defaultModelForProvider(p.name ?? 'openai');
  return p.model !== undefined && p.model !== '' && p.model !== fallback;
}

/** 凭证信封条目（形状冻结于上位契约 §2.2；与插件写侧同形）。 */
interface CredentialEnvelopeEntry {
  iv: string;
  tag: string;
  data: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 信封读取三态（CHAIN-08）：ok = 条目在库且形状完整；absent = 文件 / 条目不存在；
 * corrupt = 文件在但读不出 / 形状损坏。**损坏 ≠ 不存在**——与写侧
 * CredentialStore.readEnvelope 同一纪律（写侧抛 credentials_corrupt 不静默覆盖，
 * 读侧此前却把损坏静默折成 undefined → 闸误报「未配置 API Key」、请求侧误报
 * 「凭证缺失，请重录」，而重录单条凭证根本修不好损坏的库）。
 */
type CredentialEnvelopeRead =
  | { kind: 'ok'; entry: CredentialEnvelopeEntry }
  | { kind: 'absent' }
  | { kind: 'corrupt'; reason: string };

/** 读信封条目（只读元数据路径）。启动闸与请求侧共用；损坏显式成态，不静默。 */
function readCredentialEnvelope(dataDir: string, id: string): CredentialEnvelopeRead {
  const file = path.join(dataDir, 'credentials.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'corrupt', reason: `credentials_read_failed: ${file}: ${messageOf(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: 'corrupt', reason: `credentials_corrupt: ${file}: ${messageOf(error)}` };
  }
  const envelope = parsed as { v?: unknown; entries?: unknown } | null;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    envelope?.v !== 1 ||
    typeof envelope?.entries !== 'object' ||
    envelope.entries === null ||
    Array.isArray(envelope.entries)
  ) {
    return { kind: 'corrupt', reason: `credentials_corrupt: ${file}: unexpected envelope shape` };
  }
  const entries = (parsed as { entries: Record<string, unknown> }).entries;
  const entry = entries[id] as CredentialEnvelopeEntry | undefined;
  if (entry === undefined) return { kind: 'absent' };
  // 条目形状与写侧逐字段同口径（iv/tag/data/createdAt/updatedAt 全 string）：
  // 此前只查 updatedAt，残缺条目会流到解密步再误报「root secret 已轮换」。
  if (
    typeof entry !== 'object' ||
    entry === null ||
    typeof entry.iv !== 'string' ||
    typeof entry.tag !== 'string' ||
    typeof entry.data !== 'string' ||
    typeof entry.createdAt !== 'string' ||
    typeof entry.updatedAt !== 'string'
  ) {
    return {
      kind: 'corrupt',
      reason: `credentials_corrupt: ${file}: entry "${id}" has invalid shape`,
    };
  }
  return { kind: 'ok', entry };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 损坏信封的 fail-loud 文案（闸与请求侧共用；稳定前缀与写侧一致，可 grep）。 */
function corruptStoreError(reason: string): ProviderConfigError {
  return new ProviderConfigError(
    `${reason} — the credential store is unreadable; repair or restore credentials.json ` +
      '(re-recording a single credential does not fix a corrupt store).',
  );
}

/**
 * provider.* 是否有非 default 层来源（§7.4 legacyPresent 精确口径，与
 * tenant-runtime-factory / registry-store 同一公式）。启动闸与运行期装配共用，
 * 不再各持一份判定（CHAIN-05）。
 */
export function legacyPresentFromSources(sources: ConfigSources | undefined): boolean {
  return Object.entries(sources ?? {}).some(
    ([key, source]) => (key === 'provider' || key.startsWith('provider.')) && source !== 'default',
  );
}

/**
 * 启动闸的 registry 侧判定：有效默认解析到注册条目时，其凭证是否「已配置」
 * （信封在库，或 env 间接值非空）。与请求侧 apiKeyFor 同源选路：legacy 链路由
 * resolveEffectiveApiKey 判定，此处只看注册条目；只查存在性、不解密——解密失败
 * 仍由请求侧 D10 fail-loud 负责。纯 registry 配置（无 legacy provider.* 块）
 * 由此通过启动闸，不再被误判「未配置 API Key」。
 *
 * `legacyPresent` 必须传运行期同口径的精确值（legacyPresentFromSources）：
 * 缺省 true 只是无 sources 时的保守回落（CHAIN-05：闸此前恒用缺省 true，
 * 与运行期精确判定分裂——纯 registry 配置下闸按幻影 legacy 透传判凭证）。
 */
export function hasBootRegistryKey(
  config: VesselConfig,
  dataDir: string,
  legacyPresent = true,
): boolean {
  const snapshot = synthesizeLegacyRegistry(config, legacyPresent);
  // CHAIN-04：与运行期 resolveModel 同一 env 优先级（§2.6 冻结）——VESSEL_MODEL 非空
  // 以其为 ref（env 赢 models.default）。闸此前只解析 models.default：env 指向的注册
  // 条目凭证已配置时仍被误判「未配置 API Key」，或查错条目的凭证。
  const envModel = process.env.VESSEL_MODEL;
  const effectiveRef = envModel !== undefined && envModel !== '' ? envModel : undefined;
  let resolved: ResolvedModel | undefined;
  try {
    resolved = resolveModelRef(snapshot, effectiveRef);
  } catch {
    return false;
  }
  if (
    resolved === undefined ||
    resolved.legacy ||
    resolved.credentialRef?.startsWith('legacy:') === true
  ) {
    return false;
  }
  if (resolved.credentialRef !== undefined) {
    const read = readCredentialEnvelope(dataDir, resolved.credentialRef);
    // CHAIN-08：损坏 fail-loud（精确文案），不再静默折成「未配置 API Key」。
    if (read.kind === 'corrupt') throw corruptStoreError(read.reason);
    if (read.kind === 'ok') return true;
    // CHAIN-03：库值缺失时落 env 间接判定（env-only 凭证是一等形态：管理面
    // credential_remove 容忍库值缺失、test 面 apiKeyForCredential 缺值回落 env）。
    // 闸此前只查信封，env only 凭证被误判「未配置 API Key」而拒启动。
  }
  if (resolved.apiKeyEnv !== undefined) {
    const value = process.env[resolved.apiKeyEnv];
    return typeof value === 'string' && value.trim() !== '';
  }
  return false;
}

/** install 后待登记 RPC / 贡献面的 in-process 能力插件（descriptor + 原始 plugin）。 */
export interface InProcessPluginEntry {
  descriptor: PluginDescriptor;
  plugin: Plugin;
}

/** 多厂商路由装配面（每 bundle 一份；mock 模式不构造）。 */
export interface ModelRegistryWiring {
  /**
   * ModelRef → provider + wire model（w1a 接缝 `TenantRuntimeProfile.resolveModel`）。
   * ref 非空 = 成员 pin；ref 空 → env `VESSEL_MODEL` 赢 models.default（§2.6 冻结），
   * 再走默认链。返回的 provider 是 delegating wrapper（凭证轮换下一请求生效）。
   * `ref` = 本次解析的规范化可重解析 ref（第 6 修：注册条目 → 条目键；legacy →
   * wire 透传或显式 legacy ref，见 defaultModelRefOf）——宿主缺省身份存它而非 wire，
   * spawn 继承才不会在 legacyPresent=false 时 ModelRefError。
   */
  resolveModel: (ref: string | undefined) => { provider: LLMProvider; model: string; ref: string };
  /**
   * 热应用预览（第 6 修 SPAWN-03）：按 next 配置解析缺省身份，口径与 applyConfig 后的
   * 运行期一致（legacyPresent 单向闸 `legacyPresent || hasExplicitProvider(next)`）。
   * 解析不出 / ModelRefError → undefined（调用方落 requires_restart，不假装生效、
   * 不把不可重解析的 wire 名装进宿主缺省）。只读解析、不构造 provider、不改快照。
   */
  previewDefaultModel: (next: VesselConfig) => DefaultModelIdentity | undefined;
  /**
   * 纯校验（P3 收紧，§11.1）：ref 未命中注册表且无 legacy 透传 → 错误文案 + 候选；
   * 命中 / 透传 → undefined。不构造 provider、不解密凭证（gateway 参数闸用）。
   * q-error-e2 起为 validateModelRefDetailed 的薄封装（校验逻辑单源，裁定 A）。
   */
  validateModelRef: (ref: string) => string | undefined;
  /**
   * 结构化纯校验（q-error-e2 §3.6，裁定 A 单源内核）：直接透传 ModelRefError
   * 字段（code/ref/message/candidates），不拼 string；modelRefError 端口注入面。
   * 形状与 validateModelRef 自身均不动（q-registry-hardening 红线），merge 冲突面留 main。
   */
  validateModelRefDetailed: (ref: string) => ModelRefErrorInfo | undefined;
  /** config scope 热应用：重建快照 + 清缓存；下一具 body/EU/run 生效，不动 live 请求。 */
  applyConfig: (next: VesselConfig) => void;
  /** provider 类 in-process 插件中声明 capabilityManifest 的（装配层 install 后登记）。 */
  readonly inProcessPlugins: readonly InProcessPluginEntry[];
}

/**
 * 构造多厂商路由装配面：加载 provider 插件 → 合成快照 → 缓存 + delegating wrapper。
 * provider 插件只 registerProvider（与今天 createProvider 同一装配 loop）；声明
 * capabilityManifest 的（如 model-registry 管理插件）顺带收集，交装配层登记 RPC。
 */
export async function createModelRegistryWiring(options: {
  config: VesselConfig;
  loader: Pick<PluginLoader, 'getProviders' | 'load' | 'list'>;
  /**
   * provider.* 是否有非 default 层来源（装配层按 configSources 精确判定，§7.4）。
   * 缺省 true = 保守透传（与今天字节等价）；false 时未命中 ref 走 ModelRefError。
   */
  legacyPresent?: boolean;
}): Promise<ModelRegistryWiring> {
  let config = options.config;
  let dataDir = resolveDataDir(config);
  let legacyPresent = options.legacyPresent ?? true;

  // provider 类插件单独装配（不进 plugins 列表）：它们只 registerProvider，贡献工厂。
  const providerHost = new MemoryPluginHost();
  const inProcessPlugins: InProcessPluginEntry[] = [];
  for (const name of options.loader.getProviders()) {
    const plugin = await options.loader.load(name);
    if (!plugin) continue;
    plugin.install(providerHost);
    const descriptor = options.loader.list().find((candidate) => candidate.name === name);
    if (descriptor?.mode === 'in-process' && descriptor.capabilityManifest !== undefined) {
      inProcessPlugins.push({ descriptor, plugin });
    }
  }

  let snapshot = synthesizeLegacyRegistry(config, legacyPresent);
  /** 实例缓存：键 = entryId + baseUrl + 凭证 updatedAt + promptCache + param 构造缺省。 */
  const cache = new Map<string, LLMProvider>();

  /** 解密取明文：只在实例构造瞬间存在；失败（root-secret 轮换，D10 需重录）→ undefined。 */
  function decryptCredential(entry: CredentialEnvelopeEntry): string | undefined {
    const read = readRootSecret(rootSecretPath(dataDir));
    if (!read.ok) return undefined;
    const token = derivePurposeToken(read.value.secret, { kind: 'credentials' });
    const key = Buffer.from(token.slice(DERIVED_TOKEN_PREFIX.length), 'base64url');
    if (key.length !== ROOT_SECRET_BYTES) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(entry.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return undefined;
    }
  }

  /** 凭证解析：legacy 走 resolveEffectiveApiKey（今天口径）；注册条目走信封 / env 间接。 */
  function apiKeyFor(resolved: ResolvedModel, entry: CredentialEnvelopeEntry | undefined): string {
    // 用保留前缀判定而非当前快照 legacyCredentialId：provider.name 热切换后，live EU 的
    // wrapper 仍持旧 legacy 凭证 ref，凭证来源仍是全局 provider.*（live 凭证语义）。
    if (resolved.legacy || resolved.credentialRef?.startsWith('legacy:') === true) {
      return resolveEffectiveApiKey(config) ?? '';
    }
    if (resolved.credentialRef !== undefined) {
      // CHAIN-03：env-only 凭证（库值缺失 + apiKeyEnv 间接非空）与启动闸 / 管理 test 面
      // 同口径可用（apiKeyForCredential 对 unknown_credential 回落 env）。库值仍优先；
      // 解密失败保持 D10 fail-loud，不回落 env（与 test 面同一纪律）。
      if (entry === undefined) {
        const envValue =
          resolved.apiKeyEnv !== undefined ? process.env[resolved.apiKeyEnv] : undefined;
        if (typeof envValue === 'string' && envValue.trim() !== '') return envValue;
        // fail-loud（D10）：库值与 env 间接皆无 → 明确本地错误，不发空 key 拿 401。
        throw new ProviderConfigError(
          `Credential "${resolved.credentialRef}" has no stored value in credentials.json` +
            (resolved.apiKeyEnv !== undefined
              ? ` and environment variable "${resolved.apiKeyEnv}" is unset or empty`
              : '') +
            '; record it via the model-registry credential store' +
            (resolved.apiKeyEnv !== undefined ? ' or set the environment variable' : '') +
            '.',
        );
      }
      const value = decryptCredential(entry);
      if (value === undefined) {
        throw new ProviderConfigError(
          `Credential "${resolved.credentialRef}" cannot be decrypted ` +
            '(the root secret may have been rotated; re-record the credential).',
        );
      }
      return value;
    }
    if (resolved.apiKeyEnv !== undefined) {
      const value = process.env[resolved.apiKeyEnv];
      return typeof value === 'string' && value.trim() !== '' ? value : '';
    }
    return '';
  }

  function cacheKeyOf(resolved: ResolvedModel, updatedAt: string | undefined): string {
    const promptCache =
      resolved.promptCache === undefined ? 'auto' : resolved.promptCache ? 'on' : 'off';
    // param 构造缺省（temperature/maxTokens/topP）进缓存键：热应用改 param → 键变 → 重建。
    // extra 是请求期注入（不进构造），不参与键。分隔符 '|' 安全：entryId 限形状字符 /
    // legacy: 前缀，updatedAt 是 ISO 字符串，数值无 '|'。
    const p = resolved.param;
    const paramKey = `${p?.temperature ?? ''}|${p?.maxTokens ?? ''}|${p?.topP ?? ''}`;
    return `${resolved.entryId}|${resolved.baseUrl ?? ''}|${updatedAt ?? ''}|${promptCache}|${paramKey}`;
  }

  /**
   * 唯一构造路径：工厂 → legacy 未注册 + baseUrl 复用 openai → 裸 fallback。
   * 注册条目未知 provider 严格 fail-fast + 候选（§5.1；宽容复用只保留给 legacy 路径）。
   * param 缺省注入（§10.2）：temperature/maxTokens/topP → 构造缺省（请求显式覆盖）。
   */
  function buildInstance(
    resolved: ResolvedModel,
    entry: CredentialEnvelopeEntry | undefined,
  ): LLMProvider {
    const apiKey = apiKeyFor(resolved, entry);
    const baseUrl = resolved.baseUrl ?? '';
    const params = {
      api_key: apiKey,
      base_url: baseUrl,
      model: resolved.wireModel,
      temperature: resolved.param?.temperature ?? config.provider?.temperature,
      max_tokens: resolved.param?.maxTokens ?? config.provider?.maxTokens,
      top_p: resolved.param?.topP,
      timeout_ms: config.provider?.timeoutMs,
      prompt_cache: resolved.promptCache,
    };
    const factory = providerHost.getProvider(resolved.provider);
    if (factory) return factory(params);

    // 注册条目：未知 provider 不猜兼容复用（比 legacy 路径更严，§5.1）。
    if (!resolved.legacy) {
      const candidates = providerHost.listProviders().join(', ');
      throw new ProviderConfigError(
        `Provider "${resolved.provider}" of model entry "${resolved.entryId}" is not registered ` +
          `(registered: ${candidates || '<none>'}). Use a registered protocol factory name ` +
          '(openai / openai-compatible / anthropic / gemini) or install the provider plugin.',
      );
    }

    // legacy 未注册 + 无显式端点：不能猜厂商默认（DECISION-020 §R1.5）。
    if (baseUrl.trim() === '') {
      throw new ProviderConfigError(
        `Provider "${resolved.provider}" is not registered and has no provider.baseUrl. ` +
          'Use a registered provider or set provider.base_url for an OpenAI-compatible endpoint.',
      );
    }

    notifyUnknownProvider(resolved.provider, baseUrl, resolved.wireModel);
    // 复用 openai 工厂，让未知 provider 与已知 provider 走同一层 withRetry/withTimeout。
    const openaiFactory = providerHost.getProvider('openai');
    if (openaiFactory) return openaiFactory(params);

    // 损坏安装（provider-openai 缺失）：保留裸构造，但没有 retry/timeout。
    notifyBareFallback(resolved.provider, baseUrl);
    return new OpenAICompatibleProvider({
      api_key: apiKey,
      base_url: baseUrl,
      model: resolved.wireModel,
      temperature: resolved.param?.temperature ?? config.provider?.temperature,
      max_tokens: resolved.param?.maxTokens ?? config.provider?.maxTokens,
      top_p: resolved.param?.topP,
      prompt_cache: resolved.promptCache,
    });
  }

  /** 按当前键取/建实例：凭证信封 updatedAt 每请求只读元数据，轮换 → 键变 → 重建。 */
  function currentInstance(resolved: ResolvedModel): LLMProvider {
    // legacy 链凭证值来自 provider.*，不消费加密库：不读信封（损坏的库不得拖垮
    // legacy 请求，缓存键也与今天一致恒无 updatedAt）。注册凭证区分损坏与缺失
    // （CHAIN-08）：损坏 fail-loud 精确文案，不再静默按「缺凭证」误导重录。
    const legacyChain = resolved.legacy || resolved.credentialRef?.startsWith('legacy:') === true;
    let entry: CredentialEnvelopeEntry | undefined;
    if (resolved.credentialRef !== undefined && !legacyChain) {
      const read = readCredentialEnvelope(dataDir, resolved.credentialRef);
      if (read.kind === 'corrupt') throw corruptStoreError(read.reason);
      entry = read.kind === 'ok' ? read.entry : undefined;
    }
    const key = cacheKeyOf(resolved, entry?.updatedAt);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const instance = buildInstance(resolved, entry);
    cache.set(key, instance);
    return instance;
  }

  /**
   * delegating wrapper：chat 逐请求转发到当前键实例。param.extra 在请求期并入
   * req.extra_params（§10.2：hook requestExtras 已在 req 里 → 会话级赢静态缺省；
   * adapter 的 mergeExtraParams 做 RESERVED 保护）。messages 一个字节不改——前缀不变量。
   * vision 读当前实例能力。model 由 EU 构造期快照经 req.model 传入。
   */
  function delegatingProvider(resolved: ResolvedModel): LLMProvider {
    const extra = resolved.param?.extra;
    const hasExtra = extra !== undefined && Object.keys(extra).length > 0;
    return {
      chat: (req) => {
        const effective = hasExtra
          ? { ...req, extra_params: { ...extra, ...req.extra_params } }
          : req;
        return currentInstance(resolved).chat(effective);
      },
      get vision() {
        return currentInstance(resolved).vision;
      },
      // q-thinking-plugin：身份是路由事实（resolved.provider），挂 wrapper 级，不随实例
      // 缓存键（凭证 updatedAt）变——轮换凭证不换身份。legacy 未知 protocol 复用 openai
      // 工厂时仍挂原 protocol（dashscope 走 openai 传输但身份可以是 'dashscope'）。
      providerName: resolved.provider,
    };
  }

  const resolveModel = (
    ref: string | undefined,
  ): { provider: LLMProvider; model: string; ref: string } => {
    // env 优先级（§2.6 冻结）：ref 空时 VESSEL_MODEL 非空以其为 ref，否则 undefined
    // → 默认链（models.default ?? legacy model ?? defaultModelForProvider）。
    const envModel = process.env.VESSEL_MODEL;
    const effectiveRef =
      ref !== undefined && ref !== ''
        ? ref
        : envModel !== undefined && envModel !== ''
          ? envModel
          : undefined;
    const resolved = resolveModelRef(snapshot, effectiveRef);
    if (!resolved?.wireModel) {
      throw new ProviderConfigError(
        `Provider "${config.provider?.name ?? 'openai'}" has no model configured. ` +
          'Set provider.model in vessel.yaml or ~/.vessel/config.yaml.',
      );
    }
    return {
      provider: delegatingProvider(resolved),
      model: resolved.wireModel,
      ref: defaultModelRefOf(resolved, legacyPresent),
    };
  };

  const previewDefaultModel = (next: VesselConfig): DefaultModelIdentity | undefined => {
    // 与 applyConfig 同一单向闸口径：预览结果 = 应用后运行期能解析出的缺省身份。
    const present = legacyPresent || hasExplicitProvider(next);
    const snap = synthesizeLegacyRegistry(next, present);
    const envModel = process.env.VESSEL_MODEL;
    let resolved: ResolvedModel | undefined;
    try {
      resolved = resolveModelRef(
        snap,
        envModel !== undefined && envModel !== '' ? envModel : undefined,
      );
    } catch {
      // models.default 指向已删条目等：fail-loud 交调用方落 requires_restart。
      return undefined;
    }
    if (!resolved?.wireModel) return undefined;
    return { ref: defaultModelRefOf(resolved, present), wireModel: resolved.wireModel };
  };

  // E2 §3.6 单源内核（裁定 A）：结构化校验唯一实现；validateModelRef 是其薄封装。
  const validateModelRefDetailed = (ref: string): ModelRefErrorInfo | undefined => {
    try {
      resolveModelRef(snapshot, ref);
      return undefined;
    } catch (error) {
      if (error instanceof ModelRefError) {
        return {
          code: error.code,
          ref: error.ref,
          message: error.message,
          candidates: [...error.candidates],
        };
      }
      return {
        code: 'internal',
        ref,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const validateModelRef = (ref: string): string | undefined => {
    const info = validateModelRefDetailed(ref);
    if (info === undefined) return undefined;
    return info.candidates !== undefined
      ? `${info.message} Candidates: ${info.candidates.join(', ') || '<none>'}`
      : info.message;
  };

  const applyConfig = (next: VesselConfig): void => {
    config = next;
    dataDir = resolveDataDir(next);
    // legacyPresent 单向闸：一旦 provider.* 出现过就保持透传（保守，字节等价）；
    // 初始 false 时按新 config 显式值重判（热应用 sources 不经过这里，近似判定）。
    legacyPresent = legacyPresent || hasExplicitProvider(next);
    snapshot = synthesizeLegacyRegistry(next, legacyPresent);
    cache.clear();
  };

  return {
    resolveModel,
    previewDefaultModel,
    validateModelRef,
    validateModelRefDetailed,
    applyConfig,
    inProcessPlugins,
  };
}
