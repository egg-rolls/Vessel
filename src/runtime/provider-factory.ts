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
 *
 * model-registry P0：默认 model 解析经 registry resolver（legacy 合成 → 同实例同 model，
 * 无 models 块的存量配置行为字节等价）。
 * P1-w2d：多厂商构造 / 实例缓存 / delegating wrapper 归 `model-registry-wiring`
 * （唯一构造路径）；本文件只做 mock 分支 + 默认解析适配，返回 wiring 句柄供装配层
 * 注入 resolveModel / 热应用 / in-process RPC 登记。
 */

import type { VesselConfig } from '../../packages/config/src/index';
import { type LLMProvider, MemoryLLMProvider } from '../../packages/core/src/index';
import { createScenarioProvider, type MockScenarioName } from '../mock/scenarios';
import type { PluginLoader } from '../plugin/plugin-loader';
import { createModelRegistryWiring, type ModelRegistryWiring } from './model-registry-wiring';

export interface ResolvedProvider {
  provider: LLMProvider;
  providerName: string;
  providerModel: string;
  providerBaseUrl: string;
  /**
   * P1-w2d：多厂商 wiring 句柄（mock 模式缺省）。装配层据此注入
   * `TenantRuntimeProfile.resolveModel`、config scope 热应用与 in-process RPC 登记。
   */
  registry?: ModelRegistryWiring;
}

/** 构造 provider；`useMock` 时不需要 Key、不加载 provider 插件 */
export async function createProvider(
  config: VesselConfig,
  loader: Pick<PluginLoader, 'getProviders' | 'load' | 'list'>,
  useMock: boolean,
  scenario?: MockScenarioName,
  /** provider.* 非 default 层来源（§7.4 legacyPresent；缺省 true = 保守透传） */
  legacyPresent?: boolean,
): Promise<ResolvedProvider> {
  if (useMock) {
    return {
      provider: scenario ? createScenarioProvider(scenario) : new MemoryLLMProvider(),
      providerName: 'mock',
      providerModel: 'mock-model',
      providerBaseUrl: 'memory',
    };
  }

  const registry = await createModelRegistryWiring({ config, loader, legacyPresent });
  // 默认解析经 resolver（P0 接缝）：legacy 合成 → 同实例同 model。env 优先级（契约 §2.6
  // 冻结）：VESSEL_MODEL 与 models.default 并存时 env 赢——wiring.resolveModel 把 env
  // model 值作为 ref 解析即实现该优先级。无 model 时抛 ProviderConfigError（fail-fast）。
  const resolved = registry.resolveModel(undefined);
  return {
    provider: resolved.provider,
    providerName: config.provider?.name ?? 'openai',
    providerModel: resolved.model,
    providerBaseUrl: config.provider?.baseUrl ?? '',
    registry,
  };
}
