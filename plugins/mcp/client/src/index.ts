/**
 * @vessel/mcp-client — MCP client 插件。
 *
 * 工厂式插件：由装配层（asm）按 `mcp_servers` 配置构造。
 * 默认导出是工厂函数，因此必须列入 `FACTORY_PLUGINS`。
 */

export { createMcpPlugin, createMcpPlugin as default } from './plugin.js';
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
  type McpTransport,
  type McpTransportKind,
} from './types.js';
