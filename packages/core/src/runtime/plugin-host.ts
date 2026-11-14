/**
 * PluginHost 实现
 * @module @vessel-agent/core/runtime
 */

import type { Guardrail } from '../types/guardrail.js';
import type { Hook } from '../types/hook.js';
import type { MemberBodyContribution, PluginPortName } from '../types/member-port.js';
import type { PluginHost, PluginInstallScope, ReadSideMasker } from '../types/plugin.js';
import type { ProviderFactory } from '../types/provider.js';
import type { ToolDefinition } from '../types/tool.js';

/** 一次插件安装期间记录的注册条目（0.9）；回滚按身份匹配，不影响既有条目 */
type PluginRegistration =
  | { kind: 'tool'; name: string; def: ToolDefinition }
  | { kind: 'provider'; name: string; factory: ProviderFactory }
  | { kind: 'guardrail'; value: Guardrail }
  | { kind: 'hook'; value: Hook }
  /**
   * 0.51：成员面贡献。`previous` 是同名被覆盖的旧贡献 —— 回滚要把旧的那个放回去，
   * 而不是留个洞（重新登记同一个名字是热应用里的正常动作，不是错误）。
   */
  | {
      kind: 'memberBody';
      name: string;
      value: MemberBodyContribution<PluginPortName>;
      previous?: MemberBodyContribution<PluginPortName>;
    }
  /**
   * 0.52：读侧脱敏器。按 `name` 去重，`previous` 是要复原的同名旧值。
   */
  | { kind: 'readSideMasker'; name: string; value: ReadSideMasker; previous?: ReadSideMasker };

/**
 * 内存 PluginHost 实现
 */
export class MemoryPluginHost implements PluginHost {
  private tools: Map<string, ToolDefinition> = new Map();
  private providers: Map<string, ProviderFactory> = new Map();
  private guardrails: Guardrail[] = [];
  private hooks: Hook[] = [];
  /**
   * 0.51：成员身体贡献（name → 贡献）。用 Map 而不是数组：`name` 是去重键（重新登记
   * = 覆盖，热应用 / 重复装配都要幂等），Map 同时保住登记顺序。
   */
  private memberBodies: Map<string, MemberBodyContribution<PluginPortName>> = new Map();
  /**
   * 0.52：读侧脱敏器（name → masker）。同 `memberBodies` 口径：name 是去重键，
   * 同 Map 保住登记顺序。它们只在请求构建 / 展示投影被调用，落盘路径绝不经过。
   */
  private readSideMaskers: Map<string, ReadSideMasker> = new Map();
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
   * 登记一个成员身体贡献（0.51）。
   *
   * 同一个 `name` 再登记一次 = 覆盖（保留第一次的登记位置），并记下被覆盖的那个，
   * 好让安装回滚把它复原。节点侧的 `listTools()` / `getHooks()` 完全不受影响：
   * 贡献是「给成员 body 的东西」，要由 body 宿主自己实例化。
   * @param contribution 贡献（name / ports / tools / hooks）
   */
  registerMemberBodyContribution(contribution: MemberBodyContribution<PluginPortName>): void {
    const previous = this.memberBodies.get(contribution.name);
    this.memberBodies.set(contribution.name, contribution);
    this.record({
      kind: 'memberBody',
      name: contribution.name,
      value: contribution,
      ...(previous !== undefined ? { previous } : {}),
    });
  }

  /**
   * 已登记的全部成员身体贡献，按登记顺序。
   * 返回副本：调用方遍历时不会看到登记 / 回滚的半途状态。
   */
  getMemberBodyContributions(): readonly MemberBodyContribution<PluginPortName>[] {
    return [...this.memberBodies.values()];
  }

  /**
   * 登记一个读侧脱敏器（0.52 pii-guard）。
   *
   * 同一个 `name` 再登记 = 覆盖（保留第一次的位置），并记下被覆盖的那个供回滚复原。
   * 它**不是** guardrail：不参与任何写侧阶段，只在请求构建 / 展示投影时被调用。
   * @param masker 脱敏器（name / mask）
   */
  registerReadSideMasker(masker: ReadSideMasker): void {
    const previous = this.readSideMaskers.get(masker.name);
    this.readSideMaskers.set(masker.name, masker);
    this.record({
      kind: 'readSideMasker',
      name: masker.name,
      value: masker,
      ...(previous !== undefined ? { previous } : {}),
    });
  }

  /** 本宿主上已登记的读侧脱敏器，按登记顺序（副本：遍历时看不到半途状态） */
  getReadSideMaskers(): readonly ReadSideMasker[] {
    return [...this.readSideMaskers.values()];
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
      case 'memberBody': {
        // 只撤销「仍是当前值」的那次登记：后来者若又覆盖了同一个 name，回滚不该把
        // 更新的那个一起拔掉（与 tool/provider 的按身份判定同一口径）。
        if (this.memberBodies.get(entry.name) !== entry.value) break;
        if (entry.previous === undefined) this.memberBodies.delete(entry.name);
        else this.memberBodies.set(entry.name, entry.previous);
        break;
      }
      case 'readSideMasker': {
        // 0.52：同 memberBody 的按身份判定 —— 只撤销「仍是当前值」的那次登记。
        if (this.readSideMaskers.get(entry.name) !== entry.value) break;
        if (entry.previous === undefined) this.readSideMaskers.delete(entry.name);
        else this.readSideMaskers.set(entry.name, entry.previous);
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
