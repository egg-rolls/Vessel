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
    const mcpServers: AssetInfo['mcpServers'] = Array.from(mcpServerMap.entries()).map(
      ([name, toolCount]) => ({
        name,
        status: 'connected' as const,
        tools: toolCount,
      }),
    );

    // Skills: no data source available in ReplContext
    const skills: AssetInfo['skills'] = [];

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
