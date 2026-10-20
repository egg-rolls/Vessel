/**
 * @vessel/provider-openai — OpenAI 兼容 Provider 插件
 *
 * 注册所有 OpenAI 兼容的 provider（openai / google / mistral / ollama / cohere），
 * 全部走核心 OpenAICompatibleProvider，仅 base_url 与默认 model 不同。
 */

import type { Plugin, PluginHost } from '@vessel/core';
import { OpenAICompatibleProvider } from '@vessel/core';
import { type RetryEvent, type RetryOptions, resolveRetryOptions, withRetry } from './retry.js';
import { withTimeout } from './timeout.js';

/** E1：插件级配置（core Plugin 类型尚未声明第二参数时的窄类型） */
export interface ProviderPluginOptions {
  config?: Record<string, unknown>;
}

/** Provider 注册项：名字 + 默认 base_url + 默认 model */
const PROVIDERS: Array<{ name: string; baseUrl: string; model: string }> = [
  { name: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4' },
  {
    name: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-pro',
  },
  { name: 'mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' },
  { name: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
  // Cohere 的 OpenAI 兼容端点在 /compatibility/v1；/v1 不是兼容端点
  { name: 'cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1', model: 'command-r-plus' },
];

/** 去掉尾斜杠，避免拼出 `//chat/completions` */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** 兼容 core factory 的 snake_case 与程序化注入的 camelCase */
function readTimeoutMs(config: Record<string, unknown>): number | undefined {
  const value = config.timeout_ms ?? config.timeoutMs;
  return typeof value === 'number' ? value : undefined;
}

/** 程序化注入的重试观测回调（YAML 配置无法携带函数） */
function readRetryHook(config: Record<string, unknown>): ((event: RetryEvent) => void) | undefined {
  const hook = config.on_retry ?? config.onRetry;
  return typeof hook === 'function' ? (hook as (event: RetryEvent) => void) : undefined;
}

const plugin: Plugin = {
  name: 'provider-openai',
  install(host: PluginHost, options?: ProviderPluginOptions) {
    const installConfig = options?.config ?? {};
    for (const p of PROVIDERS) {
      host.registerProvider(p.name, (config) => {
        const c = { ...installConfig, ...(config as Record<string, unknown>) };
        // 注意 `||` 而非 `??`：bootstrap 未配置时会传空字符串
        const baseUrl = normalizeBaseUrl((c.base_url as string) || p.baseUrl);
        const model = (c.model as string) || p.model;
        const provider = new OpenAICompatibleProvider({
          api_key: c.api_key as string,
          base_url: baseUrl,
          model,
          temperature: c.temperature as number | undefined,
          max_tokens: c.max_tokens as number | undefined,
        });
        const retryOptions: RetryOptions = { ...resolveRetryOptions(c), provider: p.name };
        const onRetry = readRetryHook(c);
        if (onRetry) retryOptions.onRetry = onRetry;
        // timeout 在外层：总时限覆盖全部重试与退避
        return withTimeout(withRetry(provider, retryOptions), readTimeoutMs(c));
      });
    }
  },
};

export default plugin;
