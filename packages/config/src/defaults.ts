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
    max_tokens: 4096,
  },
  agent: {
    name: 'Vessel Agent',
    temperature: 0.7,
    max_tokens: 4096,
  },
  limits: {
    request_limit: 100,
    tool_calls_limit: 50,
    input_tokens_limit: 100000,
    output_tokens_limit: 50000,
  },
  termination: {
    max_iterations: 20,
    max_runtime_seconds: 300,
  },
  session: {
    backend: 'memory',
    max_history: 100,
  },
  context: {
    max_tokens: 4096,
    max_messages: 100,
    auto_compact: false,
    compact_threshold: 0.8,
  },
};

/** Provider 预设列表 */
export const PROVIDER_PRESETS: Record<string, { base_url: string; models: string[] }> = {
  openai: {
    base_url: 'https://api.openai.com/v1',
    models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  },
  anthropic: {
    base_url: 'https://api.anthropic.com',
    models: ['claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'],
  },
  google: {
    base_url: 'https://generativelanguage.googleapis.com',
    models: ['gemini-pro', 'gemini-pro-vision'],
  },
  mistral: {
    base_url: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
  },
  cohere: {
    base_url: 'https://api.cohere.ai/v1',
    models: ['command-r-plus', 'command-r', 'command'],
  },
  ollama: {
    base_url: 'http://localhost:11434/v1',
    models: ['llama3', 'mistral', 'gemma2'],
  },
};
