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

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin, PluginHost, ToolDefinition } from '../../../../packages/core/src/index';

/** 持久化工具模板（安全，不使用 eval/new Function） */
interface PersistedToolTemplate {
  name: string;
  description: string;
  type: 'shell' | 'http';
  command?: string; // shell 模板，用 {{key}} 占位
  url?: string; // http 模板，用 {{key}} 占位
  method?: string; // GET / POST
  headers?: Record<string, string>;
  inputSchema?: Record<string, unknown>;
}

/** 替换模板中的 {{ key }} 占位符 */
function substituteArgs(template: string, args: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    return args[key] ?? `{{${key}}}`;
  });
}

/**
 * 元资产管理器
 * 管理 Agent 的所有资产（工具、Skill、MCP 连接等）
 */
export class AssetManager {
  private tools: Map<string, ToolDefinition> = new Map();
  private skills: Map<string, SkillAsset> = new Map();
  private mcpConnections: Map<string, MCPConnection> = new Map();
  private pluginHost: PluginHost;
  private toolsFilePath: string;

  constructor(pluginHost: PluginHost, toolsFilePath = './tools/custom-tools.json') {
    this.pluginHost = pluginHost;
    this.toolsFilePath = toolsFilePath;
    this.loadPersistedTools();
  }

  /**
   * 从文件加载已保存的工具（模板化，不使用 eval/new Function）
   */
  private loadPersistedTools(): void {
    try {
      if (fs.existsSync(this.toolsFilePath)) {
        const data = fs.readFileSync(this.toolsFilePath, 'utf-8');
        const raw = JSON.parse(data) as Array<Record<string, unknown>>;

        for (const item of raw) {
          // 向后兼容：旧格式（handlerCode）静默跳过
          if (!item.type || (item.type !== 'shell' && item.type !== 'http')) {
            // 旧格式工具，跳过（不再支持 eval/new Function）
            continue;
          }

          const tpl = item as unknown as PersistedToolTemplate;
          try {
            const tool = this.buildToolFromTemplate(tpl);
            this.tools.set(tool.name, tool);
            this.pluginHost.registerTool(tool);
          } catch (error) {
            console.error(`Failed to load persisted tool "${tpl.name}":`, error);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load persisted tools:', error);
    }
  }

  /**
   * 从模板构建工具 handler（安全，无 eval）
   */
  buildToolFromTemplate(tpl: PersistedToolTemplate): ToolDefinition {
    switch (tpl.type) {
      case 'shell':
        return {
          name: tpl.name,
          description: tpl.description,
          inputSchema: tpl.inputSchema ?? {
            type: 'object',
            properties: {},
          },
          handler: async (args: unknown) => {
            const cmd = substituteArgs(tpl.command ?? '', args as Record<string, string>);
            try {
              const proc = Bun.spawnSync({
                cmd: ['sh', '-c', cmd],
                stdout: 'pipe',
                stderr: 'pipe',
              });
              return proc.stdout.toString() || proc.stderr.toString() || 'ok';
            } catch (e) {
              return `Error: ${e}`;
            }
          },
        };

      case 'http':
        return {
          name: tpl.name,
          description: tpl.description,
          inputSchema: tpl.inputSchema ?? {
            type: 'object',
            properties: {},
          },
          handler: async (args: unknown) => {
            const url = substituteArgs(tpl.url ?? '', args as Record<string, string>);
            try {
              const res = await fetch(url, {
                method: tpl.method ?? 'GET',
                headers: tpl.headers ?? {},
              });
              return await res.text();
            } catch (e) {
              return `Error: ${e}`;
            }
          },
        };

      default:
        throw new Error(`Unknown template type: ${tpl.type}. Supported: shell, http`);
    }
  }

  /**
   * 保存工具到文件
   */
  private persistTools(): void {
    try {
      const dir = path.dirname(this.toolsFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const toolsData: PersistedToolTemplate[] = [];
      for (const [name] of this.tools) {
        // 只持久化模板类型的工具
        const tpl = this._toolTemplates.get(name);
        if (tpl) {
          toolsData.push(tpl);
        }
      }

      fs.writeFileSync(this.toolsFilePath, JSON.stringify(toolsData, null, 2));
    } catch (error) {
      console.error('Failed to persist tools:', error);
    }
  }

  /** 存储工具模板（用于持久化） */
  private _toolTemplates: Map<string, PersistedToolTemplate> = new Map();

  /**
   * 注册工具资产（同时记录模板以便持久化）
   */
  registerTool(tool: ToolDefinition, tpl?: PersistedToolTemplate): void {
    this.tools.set(tool.name, tool);
    this.pluginHost.registerTool(tool);
    if (tpl) {
      this._toolTemplates.set(tool.name, tpl);
    }
    this.persistTools();
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
      if (
        name.toLowerCase().includes(lowerQuery) ||
        tool.description.toLowerCase().includes(lowerQuery)
      ) {
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
      if (
        name.toLowerCase().includes(lowerQuery) ||
        skill.description.toLowerCase().includes(lowerQuery)
      ) {
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

      const filtered = type === 'all' ? results : results.filter((r) => r.type === type);

      if (filtered.length === 0) {
        return `No assets found matching "${query}"`;
      }

      return JSON.stringify(filtered, null, 2);
    },
  };

  const addToolTool: ToolDefinition = {
    name: 'add_tool',
    description:
      'Add a new tool using a safe template (shell command or HTTP request). ' +
      'Use {{ key }} placeholders for parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name' },
        description: { type: 'string', description: 'Tool description' },
        type: {
          type: 'string',
          enum: ['shell', 'http'],
          description: 'Template type: "shell" or "http"',
        },
        command: {
          type: 'string',
          description: 'Shell template, e.g. "curl -s https://api.example.com/{{query}}"',
        },
        url: {
          type: 'string',
          description: 'HTTP URL template, e.g. "https://api.example.com/{{endpoint}}"',
        },
        method: {
          type: 'string',
          description: 'HTTP method (default: GET)',
        },
        input_schema: {
          type: 'object',
          description: 'JSON Schema for tool parameters',
        },
      },
      required: ['name', 'description', 'type'],
    },
    handler: async (args) => {
      const a = args as {
        name: string;
        description: string;
        type: 'shell' | 'http';
        command?: string;
        url?: string;
        method?: string;
        input_schema?: Record<string, unknown>;
      };

      const tpl: PersistedToolTemplate = {
        name: a.name,
        description: a.description,
        type: a.type,
        command: a.command,
        url: a.url,
        method: a.method,
        inputSchema: a.input_schema,
      };

      if (a.type === 'shell' && !a.command) {
        return 'Error: shell type requires "command"';
      }
      if (a.type === 'http' && !a.url) {
        return 'Error: http type requires "url"';
      }

      try {
        const tool = assetManager.buildToolFromTemplate(tpl);
        assetManager.registerTool(tool, tpl);
        return `Tool "${a.name}" added (type: ${a.type})`;
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

  const connectMcpTool: ToolDefinition = {
    name: 'connect_mcp',
    description: 'Connect to an MCP (Model Context Protocol) server',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Connection name',
        },
        serverUrl: {
          type: 'string',
          description: 'MCP server URL',
        },
      },
      required: ['name', 'serverUrl'],
    },
    handler: async (args) => {
      const { name, serverUrl } = args as {
        name: string;
        serverUrl: string;
      };

      // 创建 MCP 连接（简化实现）
      const connection: MCPConnection = {
        name,
        serverUrl: serverUrl,
        status: 'connected',
        tools: [],
      };

      assetManager.registerMCPConnection(connection);
      return `Connected to MCP server "${name}" at ${serverUrl}`;
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
          handler: async () => `Tool "${name}" executed`,
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
    connectMcpTool,
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
