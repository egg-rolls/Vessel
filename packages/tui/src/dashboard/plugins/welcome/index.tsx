import type { ReactNode } from 'react';
import type { DashboardData, DashboardPlugin, IDashboardService, PluginData } from '../../types';
import { AsciiArt } from './components/AsciiArt';
import { ConfigInfo } from './components/ConfigInfo';
import { HealthStatus } from './components/HealthStatus';
import { defaultWelcomeConfig, type WelcomeConfig } from './default-config';

/**
 * Welcome plugin
 * Displays startup dashboard with ASCII art and system info
 */
export class WelcomePlugin implements DashboardPlugin {
  name = 'welcome';
  priority = 10;
  private config: WelcomeConfig;

  constructor(config?: Partial<WelcomeConfig>) {
    this.config = { ...defaultWelcomeConfig, ...config };
  }

  /**
   * Render welcome dashboard
   */
  render(data: DashboardData): ReactNode {
    if (!this.config.enabled) {
      return null;
    }

    const elements: ReactNode[] = [];

    if (this.config.showAsciiArt) {
      elements.push(<AsciiArt />);
    }

    if (this.config.showConfig) {
      elements.push(<ConfigInfo config={data.config} />);
    }

    if (this.config.showHealth) {
      elements.push(<HealthStatus health={data.health} />);
    }

    return elements;
  }

  /**
   * Get plugin data
   */
  async getData(service: IDashboardService): Promise<PluginData> {
    const config = await service.getConfig();
    return { config };
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
  updateConfig(config: Partial<WelcomeConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export default WelcomePlugin;
