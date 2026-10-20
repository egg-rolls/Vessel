/**
 * Provider 装配（0.4 从 bootstrap 抽出，供 eval --allow-network 复用）。
 *
 * 0.10 语义：
 * - mock 模式返回 MemoryLLMProvider；
 * - provider 插件只 registerProvider；
 * - API Key 统一走 `resolveEffectiveApiKey()`（provider.apiKey / *_env / 顶层）；
 * - 未注册 provider：有 `provider.baseUrl` → OpenAI 兼容 + 一次性 stderr info；
 *   无 baseUrl → `ProviderConfigError`（fail-fast）；
 * - 已知 provider 缺 model 时 fail-fast（不全局回退 gpt-4）。
 */

import {
  defaultModelForProvider,
  resolveEffectiveApiKey,
  type VesselConfig,
} from '../packages/config/src/index';
import {
  type LLMProvider,
  MemoryLLMProvider,
  MemoryPluginHost,
  OpenAICompatibleProvider,
} from '../packages/core/src/index';
import { createScenarioProvider, type MockScenarioName } from './mock/scenarios';
import type { PluginLoader } from './plugin-loader';

export interface ResolvedProvider {
  provider: LLMProvider;
  providerName: string;
  providerModel: string;
  providerBaseUrl: string;
}

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

/** 测试重置一次性提示状态。 */
export function resetUnknownProviderNotice(): void {
  unknownProviderNoticeShown = false;
}

function notifyUnknownProvider(providerName: string, baseUrl: string, model: string): void {
  if (unknownProviderNoticeShown) return;
  unknownProviderNoticeShown = true;
  process.stderr.write(
    `[vessel] Provider "${providerName}" is not registered; using OpenAI-compatible endpoint ` +
      `"${baseUrl}" (model: ${model}).\n`,
  );
}

/** 构造 provider；`useMock` 时不需要 Key、不加载 provider 插件 */
export async function createProvider(
  config: VesselConfig,
  loader: Pick<PluginLoader, 'getProviders' | 'load'>,
  useMock: boolean,
  scenario?: MockScenarioName,
): Promise<ResolvedProvider> {
  if (useMock) {
    return {
      provider: scenario ? createScenarioProvider(scenario) : new MemoryLLMProvider(),
      providerName: 'mock',
      providerModel: 'mock-model',
      providerBaseUrl: 'memory',
    };
  }

  // provider 类插件单独装配（不进 plugins 列表）：它们只 registerProvider，贡献工厂。
  const providerHost = new MemoryPluginHost();
  for (const name of loader.getProviders()) {
    const plugin = await loader.load(name);
    if (plugin) plugin.install(providerHost);
  }

  const providerName = config.provider?.name ?? 'openai';
  const providerModel = config.provider?.model ?? defaultModelForProvider(providerName);
  if (!providerModel) {
    throw new ProviderConfigError(
      `Provider "${providerName}" has no model configured. ` +
        'Set provider.model in vessel.yaml or ~/.vessel/config.yaml.',
    );
  }

  const providerBaseUrl = config.provider?.baseUrl ?? '';
  const apiKey = resolveEffectiveApiKey(config);
  const factory = providerHost.getProvider(providerName);
  if (factory) {
    return {
      provider: factory({
        api_key: apiKey ?? '',
        base_url: providerBaseUrl,
        model: providerModel,
        temperature: config.provider?.temperature,
        max_tokens: config.provider?.maxTokens,
        timeout_ms: config.provider?.timeoutMs,
      }),
      providerName,
      providerModel,
      providerBaseUrl,
    };
  }

  // 未注册 + 无显式端点：不能猜厂商默认（DECISION-020 §R1.5）。
  if (providerBaseUrl.trim() === '') {
    throw new ProviderConfigError(
      `Provider "${providerName}" is not registered and has no provider.baseUrl. ` +
        'Use a registered provider or set provider.base_url for an OpenAI-compatible endpoint.',
    );
  }

  notifyUnknownProvider(providerName, providerBaseUrl, providerModel);
  return {
    provider: new OpenAICompatibleProvider({
      api_key: apiKey ?? '',
      base_url: providerBaseUrl,
      model: providerModel,
      temperature: config.provider?.temperature,
      max_tokens: config.provider?.maxTokens,
    }),
    providerName,
    providerModel,
    providerBaseUrl,
  };
}
