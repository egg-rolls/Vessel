/**
 * @vessel/meta-tools - 元资产工具插件
 * @module @vessel/meta-tools
 *
 * 提供元工具，让 Agent 能够自我管理自己的能力：
 * - search_assets: 搜索已有资产
 * - add_tool: 添加新工具
 * - add_skill: 添加新 Skill
 * - connect_mcp: 连接 MCP 服务器
 * - inspect_asset: 检查资产状态
 * - patch_asset: 修复资产
 * - remove_asset: 删除资产
 */

import type { Plugin, PluginHost, ToolDefinition, ToolRegistry } from '../../../packages/core/src/index';

/**
 * 元资产管理器
 * 管理 Agent 的所有资产（工具、Skill、MCP 连接等）
 */
export class AssetManager {
  private tools: Map<string, ToolDefinition> = new Map();
  private skills: Map<string, SkillAsset> = new Map();
  private mcpConnections: Map<string, MCPConnection> = new Map();
  private pluginHost: PluginHost;

  constructor(pluginHost: PluginHost) {
    this.pluginHost = pluginHost;
  }

  /**
   * 注册工具资产
   */
  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
    this.pluginHost.registerTool(tool);
  }

  /**
   * 注册 Skill 资产
   */
  registerSkill(skill: SkillAsset): void {
    this.skills.set(skill.name, skill);
  }

  /**
   * 注册 MCP 连接
   */
  registerMCPConnection(connection: MCPConnection): void {
    this.mcpConnections.set(connection.name, connection);
  }

  /**
   * 搜索资产
   */
  searchAssets(query: string): AssetSearchResult[] {
    const results: AssetSearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    // 搜索工具
    for (const [name, tool] of this.tools) {
      if (name.toLowerCase().includes(lowerQuery) || 
          tool.description.toLowerCase().includes(lowerQuery)) {
        results.push({
          type: 'tool',
          name,
          description: tool.description,
          source: 'registered',
        });
      }
    }

    // 搜索 Skill
    for (const [name, skill] of this.skills) {
      if (name.toLowerCase().includes(lowerQuery) || 
          skill.description.toLowerCase().includes(lowerQuery)) {
        results.push({
          type: 'skill',
          name,
          description: skill.description,
          source: skill.source,
        });
      }
    }

    // 搜索 MCP 连接
    for (const [name, conn] of this.mcpConnections) {
      if (name.toLowerCase().includes(lowerQuery)) {
        results.push({
          type: 'mcp',
          name,
          description: `MCP server: ${conn.serverUrl}`,
          source: 'mcp',
        });
      }
    }

    return results;
  }

  /**
   * 获取资产详情
   */
  getAsset(type: string, name: string): AssetDetail | null {
    switch (type) {
      case 'tool': {
        const tool = this.tools.get(name);
        if (!tool) return null;
        return {
          type: 'tool',
          name,
          description: tool.description,
          schema: tool.inputSchema,
          source: 'registered',
          status: 'active',
        };
      }
      case 'skill': {
        const skill = this.skills.get(name);
        if (!skill) return null;
        return {
          type: 'skill',
          name,
          description: skill.description,
          content: skill.content,
          source: skill.source,
          status: 'active',
        };
      }
      case 'mcp': {
        const conn = this.mcpConnections.get(name);
        if (!conn) return null;
        return {
          type: 'mcp',
          name,
          description: `MCP server: ${conn.serverUrl}`,
          source: 'mcp',
          status: conn.status,
        };
      }
      default:
        return null;
    }
  }

  /**
   * 删除资产
   */
  removeAsset(type: string, name: string): boolean {
    switch (type) {
      case 'tool':
        return this.tools.delete(name);
      case 'skill':
        return this.skills.delete(name);
      case 'mcp':
        return this.mcpConnections.delete(name);
      default:
        return false;
    }
  }

  /**
   * 获取所有资产列表
   */
  listAssets(): AssetSummary[] {
    const assets: AssetSummary[] = [];

    for (const [name, tool] of this.tools) {
      assets.push({
        type: 'tool',
        name,
        description: tool.description,
        source: 'registered',
      });
    }

    for (const [name, skill] of this.skills) {
      assets.push({
        type: 'skill',
        name,
        description: skill.description,
        source: skill.source,
      });
    }

    for (const [name, conn] of this.mcpConnections) {
      assets.push({
        type: 'mcp',
        name,
        description: `MCP server: ${conn.serverUrl}`,
        source: 'mcp',
      });
    }

    return assets;
  }
}

/** Skill 资产 */
export interface SkillAsset {
  name: string;
  description: string;
  content: string;
  source: string;
  metadata?: Record<string, unknown>;
}

/** MCP 连接 */
export interface MCPConnection {
  name: string;
  serverUrl: string;
  status: 'connected' | 'disconnected' | 'error';
  tools?: ToolDefinition[];
}

/** 资产搜索结果 */
export interface AssetSearchResult {
  type: 'tool' | 'skill' | 'mcp';
  name: string;
  description: string;
  source: string;
}

/** 资产详情 */
export interface AssetDetail {
  type: 'tool' | 'skill' | 'mcp';
  name: string;
  description: string;
  schema?: Record<string, unknown>;
  content?: string;
  source: string;
  status: string;
}

/** 资产摘要 */
export interface AssetSummary {
  type: 'tool' | 'skill' | 'mcp';
  name: string;
  description: string;
  source: string;
}

/**
 * 创建元工具
 */
export function createMetaTools(assetManager: AssetManager): ToolDefinition[] {
  const searchAssetsTool: ToolDefinition = {
    name: 'search_assets',
    description: 'Search for available assets (tools, skills, MCP connections)',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (name or description)',
        },
        type: {
          type: 'string',
          enum: ['tool', 'skill', 'mcp', 'all'],
          description: 'Filter by asset type (default: all)',
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const { query, type = 'all' } = args as { query: string; type?: string };
      const results = assetManager.searchAssets(query);
      
      const filtered = type === 'all' 
        ? results 
        : results.filter(r => r.type === type);

      if (filtered.length === 0) {
        return `No assets found matching "${query}"`;
      }

      return JSON.stringify(filtered, null, 2);
    },
  };

  const addToolTool: ToolDefinition = {
    name: 'add_tool',
    description: 'Add a new tool to the asset registry',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tool name',
        },
        description: {
          type: 'string',
          description: 'Tool description',
        },
        handler_code: {
          type: 'string',
          description: 'Tool handler function code (JavaScript)',
        },
      },
      required: ['name', 'description', 'handler_code'],
    },
    handler: async (args) => {
      const { name, description, handler_code } = args as {
        name: string;
        description: string;
        handler_code: string;
      };

      try {
        // 创建工具处理器
        const handler = new Function('args', handler_code) as (args: unknown) => Promise<string>;

        const tool: ToolDefinition = {
          name,
          description,
          inputSchema: {
            type: 'object',
            properties: {},
          },
          handler: async (args) => handler(args),
        };

        assetManager.registerTool(tool);
        return `Tool "${name}" added successfully`;
      } catch (error) {
        return `Failed to add tool: ${error}`;
      }
    },
  };

  const addSkillTool: ToolDefinition = {
    name: 'add_skill',
    description: 'Add a new skill (Markdown document) to the asset registry',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name',
        },
        description: {
          type: 'string',
          description: 'Skill description',
        },
        content: {
          type: 'string',
          description: 'Skill content (Markdown)',
        },
      },
      required: ['name', 'description', 'content'],
    },
    handler: async (args) => {
      const { name, description, content } = args as {
        name: string;
        description: string;
        content: string;
      };

      const skill: SkillAsset = {
        name,
        description,
        content,
        source: 'user-created',
      };

      assetManager.registerSkill(skill);
      return `Skill "${name}" added successfully`;
    },
  };

  const connectMCPTool: ToolDefinition = {
    name: 'connect_mcp',
    description: 'Connect to an MCP (Model Context Protocol) server',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Connection name',
        },
        server_url: {
          type: 'string',
          description: 'MCP server URL',
        },
      },
      required: ['name', 'server_url'],
    },
    handler: async (args) => {
      const { name, server_url } = args as {
        name: string;
        server_url: string;
      };

      // 创建 MCP 连接（简化实现）
      const connection: MCPConnection = {
        name,
        serverUrl: server_url,
        status: 'connected',
        tools: [],
      };

      assetManager.registerMCPConnection(connection);
      return `Connected to MCP server "${name}" at ${server_url}`;
    },
  };

  const inspectAssetTool: ToolDefinition = {
    name: 'inspect_asset',
    description: 'Inspect an asset (tool, skill, or MCP connection)',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['tool', 'skill', 'mcp'],
          description: 'Asset type',
        },
        name: {
          type: 'string',
          description: 'Asset name',
        },
      },
      required: ['type', 'name'],
    },
    handler: async (args) => {
      const { type, name } = args as { type: string; name: string };
      const asset = assetManager.getAsset(type, name);

      if (!asset) {
        return `Asset not found: ${type}/${name}`;
      }

      return JSON.stringify(asset, null, 2);
    },
  };

  const patchAssetTool: ToolDefinition = {
    name: 'patch_asset',
    description: 'Update or fix an existing asset',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['tool', 'skill'],
          description: 'Asset type',
        },
        name: {
          type: 'string',
          description: 'Asset name',
        },
        updates: {
          type: 'object',
          description: 'Fields to update',
        },
      },
      required: ['type', 'name', 'updates'],
    },
    handler: async (args) => {
      const { type, name, updates } = args as {
        type: string;
        name: string;
        updates: Record<string, unknown>;
      };

      if (type === 'tool') {
        const existing = assetManager.getAsset('tool', name);
        if (!existing) {
          return `Tool "${name}" not found`;
        }

        // 重新创建工具
        const tool: ToolDefinition = {
          name: (updates.name as string) ?? name,
          description: (updates.description as string) ?? existing.description,
          inputSchema: (updates.schema as Record<string, unknown>) ?? existing.schema ?? {},
          handler: async (args) => `Tool "${name}" executed`,
        };

        assetManager.registerTool(tool);
        return `Tool "${name}" updated`;
      }

      if (type === 'skill') {
        const existing = assetManager.getAsset('skill', name);
        if (!existing) {
          return `Skill "${name}" not found`;
        }

        const skill: SkillAsset = {
          name: (updates.name as string) ?? name,
          description: (updates.description as string) ?? existing.description,
          content: (updates.content as string) ?? existing.content ?? '',
          source: existing.source,
        };

        assetManager.registerSkill(skill);
        return `Skill "${name}" updated`;
      }

      return `Unsupported asset type: ${type}`;
    },
  };

  const removeAssetTool: ToolDefinition = {
    name: 'remove_asset',
    description: 'Remove an asset from the registry',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['tool', 'skill', 'mcp'],
          description: 'Asset type',
        },
        name: {
          type: 'string',
          description: 'Asset name',
        },
      },
      required: ['type', 'name'],
    },
    handler: async (args) => {
      const { type, name } = args as { type: string; name: string };
      const removed = assetManager.removeAsset(type, name);

      if (removed) {
        return `Asset ${type}/${name} removed`;
      }
      return `Asset ${type}/${name} not found`;
    },
  };

  return [
    searchAssetsTool,
    addToolTool,
    addSkillTool,
    connectMCPTool,
    inspectAssetTool,
    patchAssetTool,
    removeAssetTool,
  ];
}

/**
 * 元工具插件
 */
export const metaToolsPlugin: Plugin = {
  name: 'meta-tools',
  version: '0.1.0',
  description: 'Meta-tools for asset management (search, add, modify, remove tools/skills/MCP)',
  install(host: PluginHost) {
    const assetManager = new AssetManager(host);
    const metaTools = createMetaTools(assetManager);

    for (const tool of metaTools) {
      host.registerTool(tool);
    }

    // 将 assetManager 存储在 host 上，供其他插件使用
    (host as any).__assetManager = assetManager;
  },
};

export default metaToolsPlugin;
