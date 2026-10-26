/**
 * PluginHost 实现
 * @module @vessel-agent/core/runtime
 */

import type { Guardrail } from '../types/guardrail.js';
import type { Hook } from '../types/hook.js';
import type { PluginHost, PluginInstallScope } from '../types/plugin.js';
import type { ProviderFactory } from '../types/provider.js';
import type { ToolDefinition } from '../types/tool.js';

/** 一次插件安装期间记录的注册条目（0.9）；回滚按身份匹配，不影响既有条目 */
type PluginRegistration =
  | { kind: 'tool'; name: string; def: ToolDefinition }
  | { kind: 'provider'; name: string; factory: ProviderFactory }
  | { kind: 'guardrail'; value: Guardrail }
  | { kind: 'hook'; value: Hook };

/**
 * 内存 PluginHost 实现
 */
export class MemoryPluginHost implements PluginHost {
  private tools: Map<string, ToolDefinition> = new Map();
  private providers: Map<string, ProviderFactory> = new Map();
  private guardrails: Guardrail[] = [];
  private hooks: Hook[] = [];
  /** 安装记录栈：栈顶是当前安装；每个 scope 独立回滚（0.9） */
  private installScopes: PluginRegistration[][] = [];

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
    this.record({ kind: 'tool', name: def.name, def });
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
    this.record({ kind: 'provider', name, factory });
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
    this.record({ kind: 'guardrail', value: guardrail });
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
    this.record({ kind: 'hook', value: hook });
  }

  /**
   * 开始记录一次插件安装的注册（0.9）。
   * `commit()` 丢弃记录；`rollback()` 撤销本次安装的条目，保持已存在条目不变。
   * @returns 本次安装的记录 scope
   */
  beginPluginInstall(): PluginInstallScope {
    const entries: PluginRegistration[] = [];
    this.installScopes.push(entries);
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      const index = this.installScopes.indexOf(entries);
      if (index !== -1) this.installScopes.splice(index, 1);
    };
    return {
      commit: settle,
      rollback: () => {
        if (settled) return;
        try {
          for (let i = entries.length - 1; i >= 0; i -= 1) {
            this.removeRegistration(entries[i] as PluginRegistration);
          }
        } finally {
          settle();
        }
      },
    };
  }

  /** 记录到当前安装 scope（无安装进行中时忽略） */
  private record(entry: PluginRegistration): void {
    this.installScopes[this.installScopes.length - 1]?.push(entry);
  }

  /** 按身份移除一个注册条目；已有同名/同身份条目优先，不会被误删 */
  private removeRegistration(entry: PluginRegistration): void {
    switch (entry.kind) {
      case 'tool':
        if (this.tools.get(entry.name) === entry.def) this.tools.delete(entry.name);
        break;
      case 'provider':
        if (this.providers.get(entry.name) === entry.factory) this.providers.delete(entry.name);
        break;
      case 'guardrail': {
        const index = this.guardrails.indexOf(entry.value);
        if (index !== -1) this.guardrails.splice(index, 1);
        break;
      }
      case 'hook': {
        const index = this.hooks.indexOf(entry.value);
        if (index !== -1) this.hooks.splice(index, 1);
        break;
      }
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
   * 注销工具（热应用用）。下一轮 `listTools()` 不再返回它。
   * 安装记录里的 tool 条目一并移除，避免安装失败回滚时把已删的工具“复活”。
   */
  unregisterTool(name: string): boolean {
    if (!this.tools.delete(name)) return false;
    for (const scope of this.installScopes) {
      const index = scope.findIndex((entry) => entry.kind === 'tool' && entry.name === name);
      if (index >= 0) scope.splice(index, 1);
    }
    return true;
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
