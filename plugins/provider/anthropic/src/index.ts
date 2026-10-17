/**
 * @vessel/provider-anthropic — Anthropic Claude Provider 插件
 * 薄工厂：实例化核心 AnthropicProvider。
 */

import type { Plugin, PluginHost } from '@vessel/core';
import { AnthropicProvider } from '@vessel/core';
import { withTimeout } from './timeout.js';

/** 默认服务端点 */
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** 默认模型（仅当配置未给 model 时使用） */
const DEFAULT_MODEL = 'claude-3-opus-20240229';

/** 去掉尾斜杠，避免拼出 `//v1/messages` */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

const plugin: Plugin = {
  name: 'provider-anthropic',
  install(host: PluginHost) {
    host.registerProvider('anthropic', (config) => {
      const c = config as Record<string, unknown>;
      // 注意 `||` 而非 `??`：bootstrap 未配置时会传空字符串
      const baseUrl = normalizeBaseUrl((c.base_url as string) || DEFAULT_BASE_URL);
      const model = (c.model as string) || DEFAULT_MODEL;
      const provider = new AnthropicProvider({
        api_key: c.api_key as string,
        base_url: baseUrl,
        model,
      });
      return withTimeout(provider, c.timeout_ms as number | undefined);
    });
  },
};

export default plugin;
