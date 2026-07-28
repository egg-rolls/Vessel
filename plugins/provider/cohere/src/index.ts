/**
 * @vessel/provider-cohere — Cohere Provider 插件
 * 薄工厂：Cohere 的 OpenAI 兼容端点 → 核心 OpenAICompatibleProvider。
 */
import { OpenAICompatibleProvider } from '@vessel/core';
import type { Plugin, PluginHost } from '@vessel/core';

const plugin: Plugin = {
  name: 'provider-cohere',
  install(host: PluginHost) {
    host.registerProvider('cohere', (config) => {
      const c = config as Record<string, unknown>;
      return new OpenAICompatibleProvider({
        api_key: c.api_key as string,
        base_url: (c.base_url as string) ?? 'https://api.cohere.ai/v1',
        model: (c.model as string) ?? 'command-r-plus',
        temperature: c.temperature as number | undefined,
        max_tokens: c.max_tokens as number | undefined,
      });
    });
  },
};

export default plugin;
