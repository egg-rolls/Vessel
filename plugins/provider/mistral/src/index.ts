/**
 * @vessel/provider-mistral — Mistral AI Provider 插件
 * 薄工厂：Mistral 的 OpenAI 兼容端点 → 核心 OpenAICompatibleProvider。
 */
import { OpenAICompatibleProvider } from '@vessel/core';
import type { Plugin, PluginHost } from '@vessel/core';

const plugin: Plugin = {
  name: 'provider-mistral',
  install(host: PluginHost) {
    host.registerProvider('mistral', (config) => {
      const c = config as Record<string, unknown>;
      return new OpenAICompatibleProvider({
        api_key: c.api_key as string,
        base_url: (c.base_url as string) ?? 'https://api.mistral.ai/v1',
        model: (c.model as string) ?? 'mistral-large-latest',
        temperature: c.temperature as number | undefined,
        max_tokens: c.max_tokens as number | undefined,
      });
    });
  },
};

export default plugin;
