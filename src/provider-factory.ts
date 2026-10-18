/**
 * Provider 装配（0.4 从 bootstrap 抽出，供 eval --allow-network 复用）。
 *
 * 保持 0.3 语义：
 * - mock 模式返回 MemoryLLMProvider；
 * - provider 插件只 registerProvider；
 * - 未注册的 provider 按 OpenAI-compatible 处理并告警；
 * - 已知 provider 缺 model 时 fail-fast（不全局回退 gpt-4）。
 */

import { defaultModelForProvider, type VesselConfig } from '../packages/config/src/index';
import {
  type LLMProvider,
  MemoryLLMProvider,
  MemoryPluginHost,
  OpenAICompatibleProvider,
} from '../packages/core/src/index';
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

/** 构造 provider；`useMock` 时不需要 Key、不加载 provider 插件 */
export async function createProvider(
  config: VesselConfig,
  loader: Pick<PluginLoader, 'getProviders' | 'load'>,
  useMock: boolean,
): Promise<ResolvedProvider> {
  if (useMock) {
    return {
      provider: new MemoryLLMProvider(),
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
  const factory = providerHost.getProvider(providerName);
  if (factory) {
    return {
      provider: factory({
        api_key: config.apiKey ?? '',
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

  console.warn(
    `Provider "${providerName}" not registered; treating as OpenAI-compatible` +
      ` (base_url: ${providerBaseUrl || 'default'}, model: ${providerModel}).`,
  );
  return {
    provider: new OpenAICompatibleProvider({
      api_key: config.apiKey ?? '',
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
