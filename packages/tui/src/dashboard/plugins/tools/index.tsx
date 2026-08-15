import type { ReactNode } from 'react';
import type { DashboardData, DashboardPlugin, IDashboardService, PluginData } from '../../types';
import type { SpinnerMode } from './components/Spinner';
import { Spinner } from './components/Spinner';

export interface ToolDisplayConfig {
  enabled: boolean;
  showStatus: boolean;
  showSpinner: boolean;
}

const defaultToolDisplayConfig: ToolDisplayConfig = {
  enabled: true,
  showStatus: true,
  showSpinner: true,
};

export interface ToolDisplayState {
  currentMode: SpinnerMode;
  currentTool?: string;
  startTime: number;
  elapsed: number;
  tokenCount?: number;
}

/**
 * ToolDisplay plugin
 * Displays tool call status and spinner
 */
export class ToolDisplayPlugin implements DashboardPlugin {
  name = 'tools';
  priority = 30;
  private config: ToolDisplayConfig;
  private state: ToolDisplayState;

  constructor(config?: Partial<ToolDisplayConfig>) {
    this.config = { ...defaultToolDisplayConfig, ...config };
    this.state = {
      currentMode: 'idle',
      startTime: Date.now(),
      elapsed: 0,
    };
  }

  /**
   * Render tool display
   */
  render(_data: DashboardData): ReactNode {
    if (!this.config.enabled) {
      return null;
    }

    const elements: ReactNode[] = [];

    if (this.config.showSpinner && this.state.currentMode !== 'idle') {
      elements.push(
        <Spinner
          mode={this.state.currentMode}
          toolName={this.state.currentTool}
          elapsed={this.state.elapsed}
          tokenCount={this.state.tokenCount}
        />,
      );
    }

    return elements;
  }

  /**
   * Get plugin data
   */
  async getData(service: IDashboardService): Promise<PluginData> {
    const tools = await service.getTools();
    return { tools, state: this.state };
  }

  /**
   * Get priority
   */
  getPriority(): number {
    return this.priority;
  }

  /**
   * Update state
   */
  updateState(state: Partial<ToolDisplayState>): void {
    this.state = { ...this.state, ...state };
  }

  /**
   * Start thinking
   */
  startThinking(): void {
    this.state = {
      currentMode: 'thinking',
      startTime: Date.now(),
      elapsed: 0,
    };
  }

  /**
   * Start tool execution
   */
  startTool(toolName: string, _activityDescription?: string): void {
    this.state = {
      currentMode: 'tool',
      currentTool: toolName,
      startTime: Date.now(),
      elapsed: 0,
    };
  }

  /**
   * Complete current operation
   */
  complete(): void {
    this.state = {
      currentMode: 'idle',
      startTime: this.state.startTime,
      elapsed: Date.now() - this.state.startTime,
    };
  }

  /**
   * Update config
   */
  updateConfig(config: Partial<ToolDisplayConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export default ToolDisplayPlugin;
