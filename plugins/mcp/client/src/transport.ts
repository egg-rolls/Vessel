/**
 * 传输工厂：按配置选择 stdio 或 Streamable HTTP。
 */

import { HttpTransport } from './http-transport.js';
import { StdioTransport } from './stdio-transport.js';
import type { McpServerConfig, McpTransport } from './types.js';

export function createTransport(config: McpServerConfig): McpTransport {
  return config.transport === 'stdio' ? new StdioTransport(config) : new HttpTransport(config);
}
