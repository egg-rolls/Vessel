/**
 * 插件注册表（ADR-028）
 *
 * 装配机制接口化：registry 只负责「发现插件对象」，不做权限/暂停/显示/条件启用等业务决策
 * （已下沉到工具对象，见 ADR-026）。实现可插拔：StaticRegistry（既有映射表，迁移期保留）/
 * BuildTimeScanner（构建时扫描生成注册表）/ DirScanner（用户目录运行时扫描）/
 * ConfigDeclared（vessel.yaml 声明连接）。
 *
 * 内置插件改构建时扫描 plugins 目录生成 src/plugin-registry.generated.ts（静态 import 字面量，
 * 可被 Bun 打包），StaticRegistry 以此为数据源。bootstrap 用 CompositeProvider 组合
 * 内置 + 用户 Provider（DirScanner/ConfigDeclared），构成完整用户扩展路径。
 */

import type { Plugin } from '../packages/core/src/index';
import { PLUGIN_DESCRIPTORS, PLUGIN_MODULES } from './plugin-registry.generated';

/**
 * PluginProvider 接口——只承诺「发现」，不做任何业务决策
 */
export interface PluginProvider {
  /** 可用的插件名（已排除 provider-*，provider 经 getProviders() 单独取） */
  getAvailablePlugins(): string[];
  /** 加载指定插件，失败或未知返回 null */
  loadPlugin(name: string): Promise<Plugin | null>;
  /** LLM provider 插件名 */
  getProviders(): string[];
}

export interface PluginRegistryConfig {
  /** 自定义插件映射（覆盖默认） */
  customMappings?: Record<string, string>;
  /** 额外插件（追加到默认列表） */
  additionalPlugins?: Record<string, string>;
}

/**
 * 迁移期保留的默认映射表。
 * 内置插件已由 plugin-registry.generated.ts 静态导入（见 PLUGIN_MODULES），
 * 此处仅作为自定义/附加映射的动态 import 回退，行为与迁移前一致。
 */
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
 * 静态注册表——构建时扫描生成的插件注册表
 */
export class StaticRegistry implements PluginProvider {
  private readonly modules: Record<string, Plugin>;
  private readonly dynamicMappings: Record<string, string>;

  constructor(config: PluginRegistryConfig = {}) {
    this.modules = { ...PLUGIN_MODULES };
    this.dynamicMappings = {
      ...DEFAULT_PLUGIN_IMPORT_MAP,
      ...config.customMappings,
      ...config.additionalPlugins,
    };
  }

  getAvailablePlugins(): string[] {
    return this.names().filter((name) => !this.isProvider(name));
  }

  getProviders(): string[] {
    return this.names().filter((name) => this.isProvider(name));
  }

  async loadPlugin(name: string): Promise<Plugin | null> {
    const module = this.modules[name];
    if (module) return module;

    const importPath = this.dynamicMappings[name];
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

  /** 全部注册条目（静态 + 动态去重） */
  private names(): string[] {
    return Array.from(
      new Set([...Object.keys(this.modules), ...Object.keys(this.dynamicMappings)]),
    );
  }

  /** provider 判定：构建时扫描的分类或 provider- 前缀 */
  private isProvider(name: string): boolean {
    const byCategory = PLUGIN_DESCRIPTORS.some((d) => d.name === name && d.category === 'provider');
    return byCategory || name.startsWith('provider-');
  }
}

/**
 * 组合 Provider——将多个 PluginProvider 组合为一个。
 * bootstrap 用它组合内置 StaticRegistry + 用户 DirScanner/ConfigDeclared。
 * loadPlugin 按 provider 顺序依次尝试；provider 声称拥有该名字（available/providers）
 * 才尝试加载，避免命中后仍落入其他 provider 的「未知插件」告警。
 */
export class CompositeProvider implements PluginProvider {
  private readonly providers: PluginProvider[];

  constructor(providers: PluginProvider[]) {
    this.providers = providers;
  }

  getAvailablePlugins(): string[] {
    return Array.from(new Set(this.providers.flatMap((p) => p.getAvailablePlugins())));
  }

  getProviders(): string[] {
    return Array.from(new Set(this.providers.flatMap((p) => p.getProviders())));
  }

  async loadPlugin(name: string): Promise<Plugin | null> {
    for (const provider of this.providers) {
      if (provider.getAvailablePlugins().includes(name) || provider.getProviders().includes(name)) {
        const plugin = await provider.loadPlugin(name);
        if (plugin) return plugin;
      }
    }
    return null;
  }
}
