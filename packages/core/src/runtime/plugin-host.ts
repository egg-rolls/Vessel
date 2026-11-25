/**
 * PluginHost 实现
 * @module @vessel-agent/core/runtime
 */

import type { Guardrail } from '../types/guardrail.js';
import type { Hook } from '../types/hook.js';
import type { MemberBodyContribution, PluginPortName } from '../types/member-port.js';
import type {
  PluginHost,
  PluginInstallScope,
  ReadSideMasker,
  RegisterToolOptions,
} from '../types/plugin.js';
import type { ProviderFactory } from '../types/provider.js';
import type { ToolDefinition } from '../types/tool.js';
import type { ToolNameAlias, ToolNameAudit } from '../types/tool-name.js';
import {
  auditToolNames,
  describeToolNameProblem,
  findToolNameAlias,
  PROVIDER_SAFE_TOOL_NAME,
  TOOL_NAME_ALIASES,
} from './tool-name.js';

/**
 * Provider 对工具名的硬约束（OpenAI 兼容接口与 Anthropic 都是这个形状）——
 * 判据在 `./tool-name.ts`（单一真源，`PROVIDER_SAFE_TOOL_NAME`）。
 *
 * 工具名原样进 `tools[].function.name`；带 `.` 等字符会让**整个请求** 400
 * （不是调用时才失败）。所以在注册期就拒绝，把问题从「运行时 opaque 400」
 * 提前成「启动/门禁时的明确错误」，而不是依赖各 Provider 的错误信息。
 *
 * 0.55 起这条只是**下限**：本仓工具名还要满足 snake_case（`TOOL_NAME_RULE`）。
 */

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
   * 0.55 别名表（旧名 → 现行名）。**唯一解析点**：`getTool` 命中别名时回落到现行名，
   * `tool-pipeline` 据此在结果里附一行弃用提示（不静默）。
   *
   * 表内容是数据（`TOOL_NAME_ALIASES`），不是每个工具一份 if；改名的登记处只有一处。
   */
  private toolAliases: Map<string, ToolNameAlias> = new Map(
    TOOL_NAME_ALIASES.map((entry) => [entry.alias, entry]),
  );
  /**
   * 0.55：外部来源（MCP / 第三方通道）注册的工具名。它们同样过名字校验，但**只告警不阻断**
   * —— 名字由外部系统决定，我们原样透传；这一集只用来区分「谁该 warning」。
   */
  private externalTools: Map<string, string> = new Map();

  /**
   * 注册工具
   *
   * 名字校验在这里就做（唯一入口，一处），两条口径：
   * - 内置 / 本仓插件：必须 snake_case（`^[a-z][a-z0-9_]*$`），不合规**直接抛错**并给出建议名；
   * - `options.external`（MCP 等外部来源）：同样校验，但只登记告警（装配期由
   *   `auditToolNames()` 汇总写日志），不改写名字、不阻断。
   *
   * @param def 工具定义
   * @param options 注册选项（外部通道标记）
   * @throws 工具名不合规 / 已存在
   */
  registerTool(def: ToolDefinition, options?: RegisterToolOptions): void {
    if (options?.external === true) {
      this.externalTools.set(def.name, options.source ?? 'external');
    } else {
      const problem = describeToolNameProblem(def.name);
      if (problem !== undefined) {
        throw new Error(
          `${problem}\n(工具名原样进 provider 的 tools[].function.name；不合规会让**整个请求**被拒，` +
            '所以在注册期就拦，不等模型调用时才发现。)',
        );
      }
      // provider 硬约束的兜底（snake_case 是它的子集，这里只兜长度 / 历史调用方）。
      if (!PROVIDER_SAFE_TOOL_NAME.test(def.name)) {
        throw new Error(
          `Tool name "${def.name}" is not provider-safe: it must match ${PROVIDER_SAFE_TOOL_NAME.source} ` +
            '(letters, digits, underscore, hyphen; 1-64 chars). OpenAI-compatible APIs and Anthropic ' +
            'reject other characters in tools[].function.name, which fails the whole request.',
        );
      }
    }
    if (this.tools.has(def.name)) {
      throw new Error(`Tool "${def.name}" is already registered`);
    }
    this.tools.set(def.name, def);
    this.record({ kind: 'tool', name: def.name, def });
  }

  /**
   * 0.55：登记一条改名别名（一般不需要调用 —— 默认表 `TOOL_NAME_ALIASES` 已在构造时装载；
   * 这里给「插件自己改了个名、想临时保留旧名」以及驱动 / 校验用）。
   */
  registerToolAlias(alias: ToolNameAlias): void {
    this.toolAliases.set(alias.alias, alias);
  }

  /**
   * 0.55：按旧名查别名。**目标已注册**才算命中 —— 名字表里有、工具却没装（权限层
   * 关掉了插件 / headless 口径不同）时不该假装能解析，否则失败原因会被藏起来。
   */
  getToolAlias(name: string): ToolNameAlias | undefined {
    const found = this.toolAliases.get(name) ?? findToolNameAlias(name);
    if (found === undefined) return undefined;
    return this.tools.has(found.target) ? found : undefined;
  }

  /** 0.55：本宿主认识的全部别名（别名表 + 运行时补登的），按登记顺序 */
  listToolAliases(): ToolNameAlias[] {
    return [...this.toolAliases.values()];
  }

  /**
   * 0.55：工具名审计（装配期调用）。
   *
   * 内置 / 插件工具不合规 ⇒ `violations`（装配方据此抛错）；
   * 外部工具不合规 ⇒ `warnings`（装配方写日志，名字原样透传）。
   */
  auditToolNames(): ToolNameAudit {
    return auditToolNames(
      this.listTools().map((tool) => {
        const source = this.externalTools.get(tool.name);
        return source === undefined
          ? { name: tool.name }
          : { name: tool.name, external: true, source };
      }),
    );
  }

  /** 0.55：某个名字是否来自外部通道（MCP 等），用于工具面展示 / 诊断 */
  isExternalTool(name: string): boolean {
    return this.externalTools.has(name);
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
      // 生命周期审计：本次安装登记过的注册面种类（去重）。entries 的 kind 与
      // PluginSurfaceKind 同集；commit/rollback 后仍可读（审计只关心「装过什么」）。
      surfaces: () => new Set(entries.map((entry) => entry.kind)),
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
   *
   * 0.55：旧名（`TOOL_NAME_ALIASES` 里登记的）也能查到 —— 别名解析只在这里做一处，
   * 调用方（管道 / 权限 / 执行单元）不必各自 if。弃用提示由 `getToolAlias()` 取。
   *
   * @param name 工具名称（现行名或已登记的旧名）
   * @returns 工具定义或 undefined
   */
  getTool(name: string): ToolDefinition | undefined {
    const direct = this.tools.get(name);
    if (direct !== undefined) return direct;
    const alias = this.getToolAlias(name);
    return alias === undefined ? undefined : this.tools.get(alias.target);
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
    this.externalTools.delete(name);
    if (!this.tools.delete(name)) return false;
    this.purgeScopeEntries((entry) => entry.kind === 'tool' && entry.name === name);
    return true;
  }

  /**
   * 按名注销 hook（q-plugin-lifecycle §6.3）。同名可能多条，全部移除；安装记录里的
   * 对应条目一并清掉，避免安装回滚把已注销的 hook「复活」。未注册过返回 false。
   */
  unregisterHook(name: string): boolean {
    const next = this.hooks.filter((hook) => hook.name !== name);
    if (next.length === this.hooks.length) return false;
    this.hooks = next;
    this.purgeScopeEntries((entry) => entry.kind === 'hook' && entry.value.name === name);
    return true;
  }

  /** 按名注销 guardrail（同 `unregisterHook` 口径）。 */
  unregisterGuardrail(name: string): boolean {
    const next = this.guardrails.filter((guardrail) => guardrail.name !== name);
    if (next.length === this.guardrails.length) return false;
    this.guardrails = next;
    this.purgeScopeEntries((entry) => entry.kind === 'guardrail' && entry.value.name === name);
    return true;
  }

  /** 按名注销 provider（同 `unregisterTool` 口径；provider 热替换仍属结构性 restart）。 */
  unregisterProvider(name: string): boolean {
    if (!this.providers.delete(name)) return false;
    this.purgeScopeEntries((entry) => entry.kind === 'provider' && entry.name === name);
    return true;
  }

  /** 按名注销读侧脱敏器（pii-guard 热启停要把脱敏面与工具面一起摘干净）。 */
  unregisterReadSideMasker(name: string): boolean {
    if (!this.readSideMaskers.delete(name)) return false;
    this.purgeScopeEntries((entry) => entry.kind === 'readSideMasker' && entry.name === name);
    return true;
  }

  /** 从所有安装 scope 里清掉满足判据的注册条目（注销时同步，防回滚复活）。 */
  private purgeScopeEntries(match: (entry: PluginRegistration) => boolean): void {
    for (const scope of this.installScopes) {
      for (let i = scope.length - 1; i >= 0; i -= 1) {
        if (match(scope[i] as PluginRegistration)) scope.splice(i, 1);
      }
    }
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
