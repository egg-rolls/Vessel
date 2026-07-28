/**
 * @vessel/provider-openai — OpenAI 兼容 Provider 插件
 * 薄工厂：实例化核心 OpenAICompatibleProvider。
 */
import { OpenAICompatibleProvider } from '@vessel/core';
import type { Plugin, PluginHost } from '@vessel/core';

const plugin: Plugin = {
  name: 'provider-openai',
  install(host: PluginHost) {
    host.registerProvider('openai', (config) => {
      const c = config as Record<string, unknown>;
      return new OpenAICompatibleProvider({
        api_key: c.api_key as string,
        base_url: (c.base_url as string) ?? 'https://api.openai.com/v1',
        model: (c.model as string) ?? 'gpt-4',
        temperature: c.temperature as number | undefined,
        max_tokens: c.max_tokens as number | undefined,
      });
    });
  },
};

export default plugin;
