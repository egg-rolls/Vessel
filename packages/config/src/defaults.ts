/**
 * Vessel 默认配置
 * @module @vessel/config
 */

import type { VesselConfig } from './types.js';

/** 安全默认值 */
export const DEFAULT_CONFIG: VesselConfig = {
  provider: {
    name: 'openai',
    model: 'gpt-4',
    temperature: 0.7,
    maxTokens: 4096,
  },
  agent: {
    name: 'Vessel Agent',
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
    backend: 'memory',
    maxHistory: 100,
  },
  context: {
    maxTokens: 4096,
    maxMessages: 100,
    autoCompact: false,
    compactThreshold: 0.8,
  },
};
