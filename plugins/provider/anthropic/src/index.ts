/**
 * @vessel/provider-anthropic — Anthropic Claude Provider 插件
 * 薄工厂：实例化核心 AnthropicProvider。
 */

import type { Plugin, PluginHost } from '@vessel/core';
import { AnthropicProvider } from '@vessel/core';

const plugin: Plugin = {
  name: 'provider-anthropic',
  install(host: PluginHost) {
    host.registerProvider('anthropic', (config) => {
      const c = config as Record<string, unknown>;
      return new AnthropicProvider({
        api_key: c.api_key as string,
        base_url: (c.base_url as string) ?? 'https://api.anthropic.com',
        model: (c.model as string) ?? 'claude-3-opus-20240229',
      });
    });
  },
};

export default plugin;
