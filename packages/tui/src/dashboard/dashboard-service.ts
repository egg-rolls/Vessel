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

    // TODO: Get MCP servers from plugin host
    const mcpServers: AssetInfo['mcpServers'] = [];

    // TODO: Get skills from skills-loader
    const skills: AssetInfo['skills'] = [];

    // Get tools from tool registry
    const toolList = this.ctx.tools.list();
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
