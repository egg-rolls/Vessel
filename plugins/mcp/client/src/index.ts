/**
 * @vessel-agent/mcp-client — MCP client 插件。
 *
 * 工厂式插件：由装配层（asm）按 `mcp_servers` 配置构造。
 * 默认导出是工厂函数，因此必须列入 `FACTORY_PLUGINS`。
 */

// tools-engine P2 批次 2：host/worker 共享模块（单实现；连接/命名/预检/日志清洗）。
export { validateConfig } from './config-validate.js';
export { sanitizeLogText } from './logging.js';
export { exposedToolName } from './naming.js';
export { createMcpPlugin, createMcpPlugin as default } from './plugin.js';
export { DEFAULT_MCP_CONNECT_TIMEOUT_MS, McpServerConnection } from './server-connection.js';
export {
  type McpClientPlugin,
  type McpPlugin,
  type McpPluginControls,
  McpPluginError,
  type McpPluginErrorCode,
  type McpPluginOptions,
  type McpPromptArgumentDef,
  type McpPromptDef,
  type McpResourceDef,
  type McpServerConfig,
  type McpServerState,
  type McpServerStatus,
  type McpToolDef,
  type McpTransport,
  type McpTransportKind,
} from './types.js';
