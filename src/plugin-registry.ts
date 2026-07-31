/**
 * 插件注册表
 *
 * 管理插件名称到模块路径的映射，支持动态加载
 * 从 cli.ts 中提取，解决 #16 issue
 */

import type { Plugin } from '../packages/core/src/index';

export interface PluginRegistryConfig {
  /** 自定义插件映射（覆盖默认） */
  customMappings?: Record<string, string>;
  /** 额外插件（追加到默认列表） */
  additionalPlugins?: Record<string, string>;
}

const DEFAULT_PLUGIN_IMPORT_MAP: Record<string, string> = {
  'meta-tools': '../plugins/tools/meta-tools/src/index',
  'skills-loader': '../plugins/tools/skills-loader/src/index',
  'file-ops': '../plugins/tools/file-ops/src/index',
  'provider-openai': '../plugins/provider/openai/src/index',
  'provider-anthropic': '../plugins/provider/anthropic/src/index',
  'memory-project': '../plugins/memory/project/src/index',
  'memory-auto': '../plugins/memory/auto/src/index',
  'guardrail-pii': '../plugins/security/guardrail-pii/src/index',
  'redact-secrets': '../plugins/security/redact-secrets/src/index',
  'tool-policy': '../plugins/security/tool-policy/src/index',
  'mcp-client': '../plugins/integration/mcp-client/src/index',
  'hook-logging': '../plugins/observability/hook-logging/src/index',
};

/**
 * 插件注册表
 *
 * 管理插件名称到模块路径的映射，支持动态加载
 */
export class PluginRegistry {
  private mappings: Record<string, string>;

  constructor(config?: PluginRegistryConfig) {
    this.mappings = {
      ...DEFAULT_PLUGIN_IMPORT_MAP,
      ...config?.customMappings,
      ...config?.additionalPlugins,
    };
  }

  /**
   * 获取插件路径
   */
  getPath(name: string): string | undefined {
    return this.mappings[name];
  }

  /**
   * 获取所有插件名称
   */
  getNames(): string[] {
    return Object.keys(this.mappings);
  }

  /**
   * 检查插件是否存在
   */
  has(name: string): boolean {
    return name in this.mappings;
  }

  /**
   * 加载插件
   */
  async loadPlugin(name: string): Promise<Plugin | null> {
    const importPath = this.mappings[name];
    if (!importPath) {
      console.warn(`Unknown plugin "${name}" — not in import map. Skipping.`);
      return null;
    }
    try {
      const mod = (await import(importPath)) as { default?: Plugin };
      const plugin = mod.default;
      if (!plugin || typeof plugin.install !== 'function') {
        console.warn(`Plugin "${name}" has no default export with install().`);
        return null;
      }
      return plugin;
    } catch (e) {
      console.warn(`Failed to load plugin "${name}": ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }
}
