/**
 * 首启配置向导
 * @module @vessel/tui
 */

import * as readline from 'readline';
import { loadConfig, mergeConfig, PROVIDER_PRESETS } from '@vessel/config';
import type { VesselConfig } from '@vessel/config';

/** 向导配置 */
export interface SetupWizardConfig {
  /** 配置文件路径 */
  configPath?: string;
  /** 是否跳过确认 */
  skipConfirm?: boolean;
}

/** Provider 选项 */
interface ProviderOption {
  name: string;
  label: string;
  description: string;
}

/** 可用的 Provider 列表 */
const PROVIDER_OPTIONS: ProviderOption[] = [
  { name: 'openai', label: 'OpenAI', description: 'GPT-4, GPT-3.5-turbo, etc.' },
  { name: 'anthropic', label: 'Anthropic', description: 'Claude 3 Opus, Sonnet, Haiku' },
  { name: 'google', label: 'Google', description: 'Gemini Pro, Gemini Pro Vision' },
  { name: 'mistral', label: 'Mistral', description: 'Mistral Large, Medium, Small' },
  { name: 'local', label: 'Local', description: 'Ollama, llama.cpp, MLX' },
];

/**
 * 首启配置向导
 */
export class SetupWizard {
  private config: SetupWizardConfig;
  private rl: readline.Interface;

  constructor(config: SetupWizardConfig = {}) {
    this.config = config;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  /**
   * 运行向导
   */
  async run(): Promise<VesselConfig> {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 Welcome to Vessel Setup Wizard');
    console.log('='.repeat(50) + '\n');

    // 检查是否已有配置
    const existingConfig = await loadConfig({
      configPath: this.config.configPath,
    });

    if (existingConfig.config.api_key) {
      console.log('Existing configuration detected.');
      const useExisting = await this.prompt('Use existing configuration? (y/n): ');
      if (useExisting.toLowerCase() === 'y') {
        this.rl.close();
        return existingConfig.config;
      }
    }

    // 选择 Provider
    const provider = await this.selectProvider();

    // 输入 API Key
    const apiKey = await this.inputApiKey(provider);

    // 选择模型
    const model = await this.selectModel(provider);

    // 配置其他选项
    const advanced = await this.prompt('\nConfigure advanced options? (y/n): ');
    let advancedConfig: Partial<VesselConfig> = {};

    if (advanced.toLowerCase() === 'y') {
      advancedConfig = await this.configureAdvanced();
    }

    // 构建配置
    const config: VesselConfig = mergeConfig(existingConfig.config, {
      api_key: apiKey,
      provider: {
        name: provider,
        api_key: apiKey,
        model,
        base_url: PROVIDER_PRESETS[provider]?.base_url,
      },
      ...advancedConfig,
    });

    // 显示配置摘要
    this.showSummary(config);

    // 确认保存
    if (!this.config.skipConfirm) {
      const save = await this.prompt('\nSave configuration? (y/n): ');
      if (save.toLowerCase() !== 'y') {
        console.log('Configuration not saved.');
        this.rl.close();
        return {};
      }
    }

    // 保存配置
    await this.saveConfig(config);

    console.log('\n✅ Configuration saved successfully!');
    console.log('You can now start using Vessel.\n');

    this.rl.close();
    return config;
  }

  /**
   * 选择 Provider
   */
  private async selectProvider(): Promise<string> {
    console.log('Select a provider:\n');

    for (let i = 0; i < PROVIDER_OPTIONS.length; i++) {
      const option = PROVIDER_OPTIONS[i];
      console.log(`  ${i + 1}. ${option.label} - ${option.description}`);
    }

    const answer = await this.prompt('\nEnter number (1-5): ');
    const index = Number.parseInt(answer) - 1;

    if (index >= 0 && index < PROVIDER_OPTIONS.length) {
      return PROVIDER_OPTIONS[index].name;
    }

    console.log('Invalid selection, defaulting to OpenAI.');
    return 'openai';
  }

  /**
   * 输入 API Key
   */
  private async inputApiKey(provider: string): Promise<string> {
    console.log(`\nEnter your ${provider.toUpperCase()} API Key:`);
    console.log('(This will be saved securely in your local config file)\n');

    const apiKey = await this.prompt('API Key: ');

    if (!apiKey.trim()) {
      console.log('Warning: No API Key provided. You will need to set it later.');
      return '';
    }

    return apiKey.trim();
  }

  /**
   * 选择模型
   */
  private async selectModel(provider: string): Promise<string> {
    const preset = PROVIDER_PRESETS[provider];
    
    if (!preset || !preset.models || preset.models.length === 0) {
      const model = await this.prompt('\nEnter model name: ');
      return model || 'gpt-4';
    }

    console.log(`\nSelect a model for ${provider}:\n`);

    for (let i = 0; i < preset.models.length; i++) {
      console.log(`  ${i + 1}. ${preset.models[i]}`);
    }

    const answer = await this.prompt('\nEnter number: ');
    const index = Number.parseInt(answer) - 1;

    if (index >= 0 && index < preset.models.length) {
      return preset.models[index];
    }

    console.log(`Invalid selection, defaulting to ${preset.models[0]}.`);
    return preset.models[0];
  }

  /**
   * 配置高级选项
   */
  private async configureAdvanced(): Promise<Partial<VesselConfig>> {
    const config: Partial<VesselConfig> = {};

    // Temperature
    const temp = await this.prompt('\nTemperature (0-2, default 0.7): ');
    if (temp) {
      const tempNum = Number.parseFloat(temp);
      if (!Number.isNaN(tempNum) && tempNum >= 0 && tempNum <= 2) {
        config.provider = { ...config.provider, name: config.provider?.name ?? 'openai', temperature: tempNum };
      }
    }

    // Max tokens
    const maxTokens = await this.prompt('Max tokens (default 4096): ');
    if (maxTokens) {
      const tokensNum = Number.parseInt(maxTokens);
      if (!Number.isNaN(tokensNum) && tokensNum > 0) {
        config.provider = { ...config.provider, name: config.provider?.name ?? 'openai', max_tokens: tokensNum };
      }
    }

    // Max iterations
    const maxIter = await this.prompt('Max iterations (default 20): ');
    if (maxIter) {
      const iterNum = Number.parseInt(maxIter);
      if (!Number.isNaN(iterNum) && iterNum > 0) {
        config.termination = { max_iterations: iterNum, stop_on_no_tool_calls: true };
      }
    }

    return config;
  }

  /**
   * 显示配置摘要
   */
  private showSummary(config: VesselConfig): void {
    console.log('\n' + '='.repeat(50));
    console.log('📋 Configuration Summary');
    console.log('='.repeat(50));
    console.log(`Provider: ${config.provider?.name ?? 'openai'}`);
    console.log(`Model: ${config.provider?.model ?? 'gpt-4'}`);
    console.log(`API Key: ${config.api_key ? '****' + config.api_key.slice(-4) : 'Not set'}`);
    
    if (config.provider?.temperature) {
      console.log(`Temperature: ${config.provider.temperature}`);
    }
    if (config.provider?.max_tokens) {
      console.log(`Max Tokens: ${config.provider.max_tokens}`);
    }
    if (config.termination?.max_iterations) {
      console.log(`Max Iterations: ${config.termination.max_iterations}`);
    }
    console.log('='.repeat(50));
  }

  /**
   * 保存配置
   */
  private async saveConfig(config: VesselConfig): Promise<void> {
    const configPath = this.config.configPath ?? 'vessel.yaml';
    
    // 转换为 YAML 格式（简单实现）
    const yaml = this.toYaml(config);
    
    await Bun.write(configPath, yaml);
    console.log(`\nConfiguration saved to: ${configPath}`);
  }

  /**
   * 简单的 YAML 转换
   */
  private toYaml(obj: unknown, indent = 0): string {
    const lines: string[] = [];
    const prefix = '  '.repeat(indent);

    if (typeof obj === 'object' && obj !== null) {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null) {
          lines.push(`${prefix}${key}:`);
          lines.push(this.toYaml(value, indent + 1));
        } else {
          lines.push(`${prefix}${key}: ${value}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * 提示用户输入
   */
  private prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => {
        resolve(answer);
      });
    });
  }
}

/**
 * 运行设置向导
 */
export async function runSetupWizard(config?: SetupWizardConfig): Promise<VesselConfig> {
  const wizard = new SetupWizard(config);
  return wizard.run();
}

export type { SetupWizardConfig };
