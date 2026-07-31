/**
 * @vessel/provider-openai — OpenAI 兼容 Provider 插件
 *
 * 注册所有 OpenAI 兼容的 provider（openai / google / mistral / ollama / cohere），
 * 全部走核心 OpenAICompatibleProvider，仅 base_url 与默认 model 不同。
 */

import type { Plugin, PluginHost } from '@vessel/core';
import { OpenAICompatibleProvider } from '@vessel/core';

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
  { name: 'cohere', baseUrl: 'https://api.cohere.ai/v1', model: 'command-r-plus' },
];

const plugin: Plugin = {
  name: 'provider-openai',
  install(host: PluginHost) {
    for (const p of PROVIDERS) {
      host.registerProvider(p.name, (config) => {
        const c = config as Record<string, unknown>;
        return new OpenAICompatibleProvider({
          api_key: c.api_key as string,
          base_url: (c.base_url as string) ?? p.baseUrl,
          model: (c.model as string) ?? p.model,
          temperature: c.temperature as number | undefined,
          max_tokens: c.max_tokens as number | undefined,
        });
      });
    }
  },
};

export default plugin;
