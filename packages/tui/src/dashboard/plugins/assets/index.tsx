import type { ReactNode } from 'react';
import type { DashboardData, DashboardPlugin, IDashboardService, PluginData } from '../../types';
import { McpList } from './components/McpList';
import { PluginList } from './components/PluginList';
import { SkillsList } from './components/SkillsList';
import { ToolsList } from './components/ToolsList';

export interface AssetsConfig {
  enabled: boolean;
  showPlugins: boolean;
  showMcp: boolean;
  showSkills: boolean;
  showTools: boolean;
}

const defaultAssetsConfig: AssetsConfig = {
  enabled: true,
  showPlugins: true,
  showMcp: true,
  showSkills: true,
  showTools: true,
};

/**
 * AssetManager plugin
 * Displays asset management dashboard
 */
export class AssetManagerPlugin implements DashboardPlugin {
  name = 'assets';
  priority = 20;
  private config: AssetsConfig;

  constructor(config?: Partial<AssetsConfig>) {
    this.config = { ...defaultAssetsConfig, ...config };
  }

  /**
   * Render asset dashboard
   */
  render(data: DashboardData): ReactNode {
    if (!this.config.enabled) {
      return null;
    }

    const elements: ReactNode[] = [];

    if (this.config.showPlugins) {
      elements.push(<PluginList plugins={data.assets.plugins} />);
    }

    if (this.config.showMcp) {
      elements.push(<McpList mcpServers={data.assets.mcpServers} />);
    }

    if (this.config.showSkills) {
      elements.push(<SkillsList skills={data.assets.skills} />);
    }

    if (this.config.showTools) {
      elements.push(<ToolsList tools={data.assets.tools} />);
    }

    return elements;
  }

  /**
   * Get plugin data
   */
  async getData(service: IDashboardService): Promise<PluginData> {
    const assets = await service.getAssets();
    return { assets };
  }

  /**
   * Get priority
   */
  getPriority(): number {
    return this.priority;
  }

  /**
   * Update config
   */
  updateConfig(config: Partial<AssetsConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export default AssetManagerPlugin;
