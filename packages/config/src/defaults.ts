/**
 * Vessel 默认配置
 * @module @vessel/config
 */

import type { SchedulerConfig, TransportConfig, VesselConfig } from './types.js';

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

/**
 * 0.2 Scheduler 默认值。
 * 不写入 DEFAULT_CONFIG：只有 host.enabled=true 时才被消费，
 * 未配置时保持 0.1 行为（不创建 Scheduler）。
 */
export const DEFAULT_SCHEDULER_OPTIONS: Required<SchedulerConfig> = {
  maxConcurrency: 1,
  maxQueueSize: 100,
  perAgentSerial: true,
};

/**
 * 0.2 Transport 默认值。
 * 同样不写入 DEFAULT_CONFIG；host 关闭时不创建 transport。
 */
export const DEFAULT_TRANSPORT_OPTIONS: Required<
  Pick<TransportConfig, 'kind' | 'hostname' | 'peersDir' | 'heartbeatMs' | 'peerTtlMs'>
> = {
  kind: 'in-process',
  hostname: '127.0.0.1',
  peersDir: '~/.vessel/peers',
  heartbeatMs: 5000,
  peerTtlMs: 15000,
};

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
