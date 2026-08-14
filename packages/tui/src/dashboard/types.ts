import type { ReactNode } from 'react';

/**
 * Dashboard plugin interface
 * All dashboard features implement this interface
 */
export interface DashboardPlugin {
  /** Plugin name */
  name: string;

  /** Priority (lower number = higher priority) */
  priority: number;

  /** Render component */
  render(data: DashboardData): ReactNode;

  /** Get plugin data */
  getData(service: IDashboardService): Promise<PluginData>;

  /** Get priority */
  getPriority(): number;
}

/**
 * Plugin data container
 */
export interface PluginData {
  [key: string]: unknown;
}

/**
 * Complete dashboard data
 */
export interface DashboardData {
  /** Configuration info */
  config: ConfigInfo;

  /** Session info */
  session: SessionInfo;

  /** Health status */
  health: HealthInfo;

  /** Asset info */
  assets: AssetInfo;

  /** Tool status */
  tools: ToolInfo;
}

/**
 * Configuration info
 */
export interface ConfigInfo {
  model: string;
  provider: string;
  baseUrl: string;
  workspace: string;
}

/**
 * Session info
 */
export interface SessionInfo {
  sessionId: string;
  createdAt: Date;
}

/**
 * Health status
 */
export interface HealthInfo {
  status: 'healthy' | 'warning' | 'error';
  uptime: number;
  memoryUsage: number;
}

/**
 * Asset info
 */
export interface AssetInfo {
  plugins: PluginAsset[];
  mcpServers: McpAsset[];
  skills: SkillAsset[];
  tools: ToolAsset[];
}

/**
 * Plugin asset
 */
export interface PluginAsset {
  name: string;
  version: string;
  enabled: boolean;
}

/**
 * MCP server asset
 */
export interface McpAsset {
  name: string;
  status: 'connected' | 'disconnected';
  tools: number;
  latency?: number;
}

/**
 * Skill asset
 */
export interface SkillAsset {
  name: string;
  description: string;
}

/**
 * Tool asset
 */
export interface ToolAsset {
  name: string;
  description: string;
  type: string;
}

/**
 * Tool info
 */
export interface ToolInfo {
  registered: number;
  active: number;
}

/**
 * DashboardService interface
 */
export interface IDashboardService {
  /** Get full data */
  getFullData(): Promise<DashboardData>;

  /** Get config info */
  getConfig(): Promise<ConfigInfo>;

  /** Get session info */
  getSession(): Promise<SessionInfo>;

  /** Get health status */
  getHealth(): Promise<HealthInfo>;

  /** Get asset info */
  getAssets(): Promise<AssetInfo>;

  /** Get tool status */
  getTools(): Promise<ToolInfo>;
}

/**
 * DashboardManager interface
 */
export interface IDashboardManager {
  /** Register plugin */
  registerPlugin(plugin: DashboardPlugin): void;

  /** Unregister plugin */
  unregisterPlugin(name: string): void;

  /** Render dashboard */
  renderDashboard(): Promise<ReactNode>;
}
