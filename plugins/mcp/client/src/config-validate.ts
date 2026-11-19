/**
 * MCP server 配置预检（单实现；host 插件壳与 engine worker 共用）。
 *
 * 原在 plugin.ts（tools-engine P2 批次 2 抽出，语义逐字不变）：
 * 返回 undefined = 合法；否则返回稳定错误文本（调用方标 failed / 告警）。
 *
 * @module @vessel-agent/mcp-client/config-validate
 */

import type { McpServerConfig } from './types.js';

export function validateConfig(config: McpServerConfig): string | undefined {
  if (typeof config.name !== 'string' || config.name === '') {
    return 'server name is required';
  }
  if (config.transport !== 'stdio' && config.transport !== 'http') {
    return `unsupported transport "${String(config.transport)}"`;
  }
  if (config.transport === 'stdio') {
    if (typeof config.command !== 'string' || config.command === '') {
      return 'stdio transport requires "command"';
    }
    return undefined;
  }
  if (typeof config.url !== 'string' || config.url === '') {
    return 'http transport requires "url"';
  }
  try {
    const parsed = new URL(config.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'http url must use http or https';
    }
  } catch {
    return `invalid url "${config.url}"`;
  }
  return undefined;
}
