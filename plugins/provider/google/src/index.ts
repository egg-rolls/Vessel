/**
 * @vessel/provider-google — Google Gemini Provider 插件
 * 薄工厂：Gemini 的 OpenAI 兼容端点 → 核心 OpenAICompatibleProvider。
 */
import { OpenAICompatibleProvider } from '@vessel/core';
import type { Plugin, PluginHost } from '@vessel/core';

const plugin: Plugin = {
  name: 'provider-google',
  install(host: PluginHost) {
    host.registerProvider('google', (config) => {
      const c = config as Record<string, unknown>;
      return new OpenAICompatibleProvider({
        api_key: c.api_key as string,
        base_url:
          (c.base_url as string) ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: (c.model as string) ?? 'gemini-pro',
        temperature: c.temperature as number | undefined,
        max_tokens: c.max_tokens as number | undefined,
      });
    });
  },
};

export default plugin;
