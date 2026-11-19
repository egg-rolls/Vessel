/**
 * MCP 工具注册语义（单实现；plugin.ts 插件壳与 tools-engine P2 批次 2 host shell 共用）。
 *
 * 自 plugin.ts registerTools / registerResourceTools 抽出，library 模式行为逐字不变：
 * 碰撞跳过 + 告警 / external:true / source mcp:<server> / checkPermission = autoApprove
 * 原始名精确匹配否则 ask / 注册顺序与辅助工具 schema。连接活性与晚绑定由 ports 实现方
 * 保证（插件壳的 callTool 在调用期读当前连接——reconnect 换连接不换定义）。
 *
 * @module @vessel-agent/mcp-client/registration
 */

import type { PluginHost, ToolDefinition } from '@vessel-agent/core';
import { exposedToolName } from './naming.js';
import type { McpPromptDef, McpResourceDef, McpServerConfig, McpToolDef } from './types.js';

/** 注册端口：连接调用 / 资源 / prompts 能力面 + 告警出口（由实现方注入）。 */
export interface McpRegistrationPorts {
  callTool(
    originalName: string,
    exposedName: string,
    args: unknown,
    signal: AbortSignal | undefined,
    runId: string,
  ): Promise<string>;
  readResource(uri: string, signal?: AbortSignal): Promise<string>;
  resources(): McpResourceDef[];
  prompts(): McpPromptDef[];
  supportsResources: boolean;
  supportsPrompts: boolean;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** 与今日 registerTools 逐字同语义：碰撞跳过+告警 / external:true / source mcp:<server> /
 *  checkPermission = autoApprove 原始名精确匹配否则 ask / handler 调 ports.callTool。 */
export function registerMcpTools(
  host: PluginHost,
  server: McpServerConfig,
  tools: McpToolDef[],
  ports: McpRegistrationPorts,
  registered: string[],
): void {
  const autoApprove = new Set(server.autoApproveTools ?? []);
  const toolPrefix = server.toolPrefix !== false;
  for (const tool of tools) {
    const exposed = exposedToolName(server.name, tool.name, toolPrefix);
    if (host.getTool(exposed) !== undefined) {
      // 同一插件的重复重连不算冲突；与既有工具（含其它 server）碰撞才告警
      if (!registered.includes(exposed)) {
        ports.warn(
          'Skipping MCP tool: a tool with this name is already registered; the existing tool is kept',
          { tool: exposed },
        );
      }
      continue;
    }

    const toolDefinition: ToolDefinition = {
      name: exposed,
      description: tool.description ?? `MCP tool "${server.name}/${tool.name}"`,
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      handler: async (args, ctx) =>
        ports.callTool(tool.name, exposed, args, ctx.signal, ctx.run_id),
      // Addendum A §5：原始工具名、大小写敏感、精确匹配
      checkPermission: async () => (autoApprove.has(tool.name) ? 'allow' : 'ask'),
    };

    // 0.55：MCP 工具名是**外部名字**——原样透传，不改写；注册表照样校验它，
    // 但不合规只记 warning（装配日志可见），不阻断装配。
    host.registerTool(toolDefinition, {
      external: true,
      source: `mcp:${server.name}`,
    });
    registered.push(exposed);
  }
}

/** 与今日 registerResourceTools 逐字同语义（list_resources/read_resource/list_prompts）；
 *  能力未广告时不注册。 */
export function registerMcpResourceTools(
  host: PluginHost,
  server: McpServerConfig,
  ports: McpRegistrationPorts,
  registered: string[],
): void {
  const toolPrefix = server.toolPrefix !== false;
  const register = (definition: ToolDefinition): void => {
    if (host.getTool(definition.name) !== undefined) {
      if (!registered.includes(definition.name)) {
        ports.warn(
          'Skipping MCP tool: a tool with this name is already registered; the existing tool is kept',
          { tool: definition.name },
        );
      }
      return;
    }
    // 0.55：resources / prompts 辅助工具名同样是外部来源（server 报什么就是什么）。
    host.registerTool(definition, {
      external: true,
      source: `mcp:${server.name}`,
    });
    registered.push(definition.name);
  };

  if (ports.supportsResources) {
    register({
      name: exposedToolName(server.name, 'list_resources', toolPrefix),
      description: `List resources exposed by MCP server "${server.name}"`,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(ports.resources()),
      checkPermission: async () => 'ask',
    });
    register({
      name: exposedToolName(server.name, 'read_resource', toolPrefix),
      description: `Read a resource (by uri) from MCP server "${server.name}"`,
      inputSchema: {
        type: 'object',
        properties: { uri: { type: 'string', description: 'Resource uri' } },
        required: ['uri'],
      },
      handler: async (args, ctx) => {
        if (typeof args !== 'object' || args === null) {
          return 'Error: read_resource requires { uri: string }';
        }
        const uri = (args as Record<string, unknown>).uri;
        if (typeof uri !== 'string' || uri === '') {
          return 'Error: read_resource requires a non-empty uri';
        }
        return ports.readResource(uri, ctx.signal);
      },
      checkPermission: async () => 'ask',
    });
  }

  if (ports.supportsPrompts) {
    register({
      name: exposedToolName(server.name, 'list_prompts', toolPrefix),
      description: `List prompts exposed by MCP server "${server.name}"`,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(ports.prompts()),
      checkPermission: async () => 'ask',
    });
  }
}
