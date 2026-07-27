/**
 * PluginHost 实现
 * @module @vessel/core/runtime
 */

import type { Guardrail } from '../types/guardrail.js';
import type { Hook } from '../types/hook.js';
import type { PluginHost } from '../types/plugin.js';
import type { ProviderFactory } from '../types/provider.js';
import type { ToolDefinition } from '../types/tool.js';

/**
 * 内存 PluginHost 实现
 */
export class MemoryPluginHost implements PluginHost {
  private tools: Map<string, ToolDefinition> = new Map();
  private providers: Map<string, ProviderFactory> = new Map();
  private guardrails: Guardrail[] = [];
  private hooks: Hook[] = [];

  /**
   * 注册工具
   * @param def 工具定义
   * @throws 如果工具名已存在则抛出错误
   */
  registerTool(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool "${def.name}" is already registered`);
    }
    this.tools.set(def.name, def);
  }

  /**
   * 注册 Provider
   * @param name Provider 名称
   * @param factory Provider 工厂
   * @throws 如果 Provider 名称已存在则抛出错误
   */
  registerProvider(name: string, factory: ProviderFactory): void {
    if (this.providers.has(name)) {
      throw new Error(`Provider "${name}" is already registered`);
    }
    this.providers.set(name, factory);
  }

  /**
   * 注册 Guardrail
   * @param guardrail Guardrail 定义
   */
  registerGuardrail(guardrail: Guardrail): void {
    // 按优先级排序（数字越小优先级越高）
    const index = this.guardrails.findIndex(
      (g) => (g.priority ?? 100) > (guardrail.priority ?? 100),
    );
    if (index === -1) {
      this.guardrails.push(guardrail);
    } else {
      this.guardrails.splice(index, 0, guardrail);
    }
  }

  /**
   * 注册 Hook
   * @param hook Hook 定义
   */
  registerHook(hook: Hook): void {
    // 按优先级排序（数字越小优先级越高）
    const index = this.hooks.findIndex((h) => (h.priority ?? 100) > (hook.priority ?? 100));
    if (index === -1) {
      this.hooks.push(hook);
    } else {
      this.hooks.splice(index, 0, hook);
    }
  }

  /**
   * 获取工具定义
   * @param name 工具名称
   * @returns 工具定义或 undefined
   */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取 Provider 工厂
   * @param name Provider 名称
   * @returns Provider 工厂或 undefined
   */
  getProvider(name: string): ProviderFactory | undefined {
    return this.providers.get(name);
  }

  /**
   * 获取所有 Guardrail
   * @returns Guardrail 数组
   */
  getGuardrails(): Guardrail[] {
    return [...this.guardrails];
  }

  /**
   * 获取所有 Hook
   * @returns Hook 数组
   */
  getHooks(): Hook[] {
    return [...this.hooks];
  }

  /**
   * 列出所有工具
   * @returns 工具定义数组
   */
  listTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * 列出所有 Provider 名称
   * @returns Provider 名称数组
   */
  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * 获取工具数量
   */
  get toolCount(): number {
    return this.tools.size;
  }

  /**
   * 获取 Provider 数量
   */
  get providerCount(): number {
    return this.providers.size;
  }

  /**
   * 获取 Guardrail 数量
   */
  get guardrailCount(): number {
    return this.guardrails.length;
  }

  /**
   * 获取 Hook 数量
   */
  get hookCount(): number {
    return this.hooks.length;
  }
}

export type { PluginHost };
