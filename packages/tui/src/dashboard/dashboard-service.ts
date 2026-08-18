import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReplContext } from '../repl-context';
import type {
  AssetInfo,
  ConfigInfo,
  DashboardData,
  HealthInfo,
  IDashboardService,
  SessionInfo,
  ToolInfo,
} from './types';

/**
 * Unified data service for dashboard
 * Fetches all data from ReplContext
 */
export class DashboardService implements IDashboardService {
  private ctx: ReplContext;
  private startTime: number;

  constructor(ctx: ReplContext) {
    this.ctx = ctx;
    this.startTime = Date.now();
  }

  /**
   * Get full dashboard data
   */
  async getFullData(): Promise<DashboardData> {
    const [config, session, health, assets, tools] = await Promise.all([
      this.getConfig(),
      this.getSession(),
      this.getHealth(),
      this.getAssets(),
      this.getTools(),
    ]);

    return { config, session, health, assets, tools };
  }

  /**
   * Get configuration info
   */
  async getConfig(): Promise<ConfigInfo> {
    return {
      model: this.ctx.provider.model,
      provider: this.ctx.provider.name,
      baseUrl: this.ctx.provider.baseUrl,
      workspace: process.cwd(),
    };
  }

  /**
   * Get session info
   */
  async getSession(): Promise<SessionInfo> {
    return {
      sessionId: this.ctx.currentSessionId,
      createdAt: new Date(),
    };
  }

  /**
   * Get health status
   */
  async getHealth(): Promise<HealthInfo> {
    const memUsage = process.memoryUsage();
    const uptime = Date.now() - this.startTime;

    return {
      status: 'healthy',
      uptime,
      memoryUsage: memUsage.heapUsed,
    };
  }

  /**
   * Get asset info
   */
  async getAssets(): Promise<AssetInfo> {
    const plugins = this.ctx.plugins.map((name) => ({
      name,
      version: '1.0.0',
      enabled: true,
    }));

    // Infer MCP servers from tool names (format: mcp__<server>__<tool>)
    const toolList = this.ctx.tools.list();
    const mcpServerMap = new Map<string, number>();
    for (const tool of toolList) {
      if (tool.name.startsWith('mcp__')) {
        const parts = tool.name.split('__');
        const serverName = parts[1];
        if (serverName) {
          mcpServerMap.set(serverName, (mcpServerMap.get(serverName) ?? 0) + 1);
        }
      }
    }
    const inferredMcpServers: AssetInfo['mcpServers'] = Array.from(mcpServerMap.entries()).map(
      ([name, toolCount]) => ({
        name,
        status: 'connected' as const,
        tools: toolCount,
      }),
    );
    const mcpServers = this.ctx.mcpServers ?? inferredMcpServers;

    const skills = this.ctx.skills ?? (await discoverSkills(this.ctx.config));

    const tools = toolList.map((tool) => ({
      name: tool.name,
      description: tool.description,
      type: 'tool',
    }));

    return { plugins, mcpServers, skills, tools };
  }

  /**
   * Get tool status
   */
  async getTools(): Promise<ToolInfo> {
    const toolList = this.ctx.tools.list();
    return {
      registered: toolList.length,
      active: 0,
    };
  }
}

async function discoverSkills(config: ReplContext['config']): Promise<AssetInfo['skills']> {
  const configured = (config as { skills?: { dir?: string } }).skills?.dir;
  const root = path.resolve(configured ?? './skills');
  try {
    const files = await collectMarkdownFiles(root);
    return await Promise.all(files.map((filePath) => readSkillAsset(filePath)));
  } catch {
    return [];
  }
}

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectMarkdownFiles(fullPath);
      return entry.isFile() && entry.name.endsWith('.md') ? [fullPath] : [];
    }),
  );
  return nested.flat();
}

async function readSkillAsset(filePath: string): Promise<AssetInfo['skills'][number]> {
  const content = await readFile(filePath, 'utf8');
  const name = path.basename(filePath, '.md');
  const title = content.split('\n').find((line) => line.startsWith('# '));
  return { name, description: title?.slice(2).trim() ?? `Skill: ${name}` };
}
