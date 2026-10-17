/**
 * Vessel 默认配置
 * @module @vessel/config
 */

import type { VesselConfig } from './types.js';

/**
 * provider-aware 默认 model：只给已知 provider 设默认。
 * 未知 provider 必须显式配置 model（validator 会 fail-fast），不再全局回退 gpt-4。
 */
export const PROVIDER_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  openai: 'gpt-4',
};

/** 取 provider 的默认 model；未知 provider 返回 undefined */
export function defaultModelForProvider(name: string | undefined): string | undefined {
  return name ? PROVIDER_DEFAULT_MODELS[name] : undefined;
}

/** 安全默认值 */
export const DEFAULT_CONFIG: VesselConfig = {
  provider: {
    name: 'openai',
    temperature: 0.7,
    maxTokens: 4096,
  },
  limits: {
    requestLimit: 100,
    toolCallsLimit: 50,
    inputTokensLimit: 100000,
    outputTokensLimit: 50000,
  },
  termination: {
    maxIterations: 20,
    maxRuntimeSeconds: 300,
  },
  session: {
    backend: 'sqlite',
  },
  context: {
    maxTokens: 4096,
    maxMessages: 100,
    autoCompact: false,
    compactThreshold: 0.8,
  },
};
