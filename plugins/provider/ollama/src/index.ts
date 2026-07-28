/**
 * @vessel/provider-ollama — Ollama 本地模型 Provider 插件
 * 薄工厂：Ollama 的 OpenAI 兼容端点 → 核心 OpenAICompatibleProvider。
 * api_key 可选（Ollama 本地跑，无需鉴权；核心已处理空 key 跳 Authorization）。
 */
import { OpenAICompatibleProvider } from '@vessel/core';
import type { Plugin, PluginHost } from '@vessel/core';

const plugin: Plugin = {
  name: 'provider-ollama',
  install(host: PluginHost) {
    host.registerProvider('ollama', (config) => {
      const c = config as Record<string, unknown>;
      return new OpenAICompatibleProvider({
        api_key: (c.api_key as string) ?? '',
        base_url: (c.base_url as string) ?? 'http://localhost:11434/v1',
        model: (c.model as string) ?? 'llama3',
        temperature: c.temperature as number | undefined,
        max_tokens: c.max_tokens as number | undefined,
      });
    });
  },
};

export default plugin;
