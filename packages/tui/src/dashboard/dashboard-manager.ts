import type { ReactNode } from 'react';
import type { DashboardData, DashboardPlugin, IDashboardManager, IDashboardService } from './types';

/**
 * Dashboard plugin manager
 * Manages plugins and renders dashboard
 */
export class DashboardManager implements IDashboardManager {
  private plugins: Map<string, DashboardPlugin> = new Map();
  private service: IDashboardService;

  constructor(service: IDashboardService) {
    this.service = service;
  }

  /**
   * Register a dashboard plugin
   */
  registerPlugin(plugin: DashboardPlugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  /**
   * Unregister a dashboard plugin
   */
  unregisterPlugin(name: string): void {
    this.plugins.delete(name);
  }

  /**
   * Get plugin by name
   */
  getPlugin(name: string): DashboardPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all registered plugin names
   */
  getPluginNames(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * Render complete dashboard
   */
  async renderDashboard(): Promise<ReactNode> {
    const data = await this.service.getFullData();
    const sortedPlugins = this.getSortedPlugins();

    const renders: ReactNode[] = [];
    for (const plugin of sortedPlugins) {
      const canRender = await this.canPluginRender(plugin, data);
      if (canRender) {
        renders.push(plugin.render(data));
      }
    }

    return renders;
  }

  /**
   * Render specific plugin
   */
  async renderPlugin(name: string): Promise<ReactNode | null> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      return null;
    }

    const data = await this.service.getFullData();
    const canRender = await this.canPluginRender(plugin, data);
    if (!canRender) {
      return null;
    }

    return plugin.render(data);
  }

  /**
   * Get plugins sorted by priority
   */
  private getSortedPlugins(): DashboardPlugin[] {
    return Array.from(this.plugins.values()).sort((a, b) => a.getPriority() - b.getPriority());
  }

  /**
   * Check if plugin can render
   */
  private async canPluginRender(plugin: DashboardPlugin, _data: DashboardData): Promise<boolean> {
    try {
      await plugin.getData(this.service);
      return true;
    } catch {
      return false;
    }
  }
}
