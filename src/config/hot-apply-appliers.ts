/**
 * `gateway.reload` 的 permission / tools / mcp applier（CONTRACT-hot-apply §4）。
 *
 * 每个 applier 是 `() => Promise<string[]>`：返回**要广播的差异摘要行**，
 * 由 `src/cli.ts` 注入到 `createGatewayReloadRunner({ appliers })`。
 * applier 之间互不依赖，可脱离 CLI 单独测试（见 `src/__tests__/hot-apply-appliers.test.ts`）。
 *
 * ## 语义边界
 *
 * - `permission`：对**所有存活 runtime** 调 `applyPermissionRules`（owner + 成员 ExecutionUnit）；
 *   下一轮工具调用即按新规则判定。已记住的 "always" 不受影响（core 语义）。
 * - `tools`：先在**旁路**注册到临时 host 求出目标工具集，再一次性替换真实宿主；
 *   注册失败只回滚已发生的差异，绝不留下半更新状态。
 * - `mcp`：复用现有 `mcp.reconnect`，并补 enable / disable（断开连接 + 注销该 server 的
 *   工具）。没有 MCP 控制面时不注册该 applier（请求即 `unknown reload scope`）。
 *
 * @module vessel/hot-apply-appliers
 */

import type {
  Guardrail,
  Hook,
  Plugin,
  PluginHost,
  ReadSideMasker,
  RuntimePermissionConfig,
  ToolDefinition,
} from '../../packages/core/src/index';
import type { McpControl, McpServerSummary } from '../plugin/mcp-wiring';
import { VESSEL_BRIDGE_GUARDRAIL_NAME, VESSEL_TOOL_NAME } from '../runtime/vessel-meta';
import type { AssembledPluginRegistrations } from './hot-apply-assembly';

/** 一条差异摘要（`scope: <detail>` 的一行文本） */
export type ApplierSummaryLine = string;

/** `permission` applier 的注入面 */
export interface PermissionApplierOptions {
  /** 重新读取配置（已通过校验）；失败抛错 */
  loadPermission: () => Promise<RuntimePermissionConfig>;
  /** 把规则应用到所有存活 runtime；返回实际生效的 runtime 数量 */
  apply: (rules: RuntimePermissionConfig) => Promise<number>;
}

/**
 * 规则 → 人类可读差异行。
 *
 * 只描述「配置里显式出现了什么」，不猜工具的实际判定：`default` 变化用单独一行，
 * 两个数组按加入 / 移除逐条列出（`+` / `-`）。
 */
export function describePermissionRules(
  before: RuntimePermissionConfig | undefined,
  after: RuntimePermissionConfig,
): ApplierSummaryLine[] {
  const lines: ApplierSummaryLine[] = [];
  const beforeDefault = before?.default;
  if (after.default !== undefined && after.default !== beforeDefault) {
    lines.push(`permission: default ${after.default}`);
  }
  const beforeAuto = new Set(before?.autoApprove ?? []);
  const afterAuto = new Set(after.autoApprove ?? []);
  for (const name of afterAuto) {
    if (!beforeAuto.has(name)) lines.push(`permission: ${name} auto allow`);
  }
  for (const name of beforeAuto) {
    if (!afterAuto.has(name)) lines.push(`permission: ${name} no longer auto allow`);
  }
  const beforeNever = new Set(before?.neverAutoApprove ?? []);
  const afterNever = new Set(after.neverAutoApprove ?? []);
  for (const name of afterNever) {
    if (!beforeNever.has(name)) lines.push(`permission: ${name} always ask`);
  }
  for (const name of beforeNever) {
    if (!afterNever.has(name)) lines.push(`permission: ${name} no longer always ask`);
  }
  return lines;
}

export interface PermissionApplierState {
  /** 上一次应用（或启动时）的规则；用于算差异。可变。 */
  current?: RuntimePermissionConfig;
}

/**
 * 构造 `permission` applier。
 *
 * 先算差异再应用：没有任何变化时仍然应用（幂等，成本低），但摘要为空，
 * 不会给用户/模型发无意义通知。
 */
export function createPermissionApplier(
  options: PermissionApplierOptions,
  state: PermissionApplierState = {},
): () => Promise<ApplierSummaryLine[]> {
  return async () => {
    const next = await options.loadPermission();
    const lines = describePermissionRules(state.current, next);
    const applied = await options.apply(next);
    // 应用成功才更新基线：失败时保留旧值，下一次仍能报出差异。
    state.current = next;
    if (applied === 0) {
      lines.push('permission: no live runtime (applies at next start)');
    }
    return lines;
  };
}

// ── tools ────────────────────────────────────────

export interface ToolsApplierOptions {
  /** 真实宿主（下一轮 loop 从它 `listTools()`） */
  host: PluginHost;
  /**
   * 计算目标工具集。实现可在内部用旁路 host 装配插件；返回的工具定义随后被
   * 一次性同步到 `host`。抛错时不做任何变更。
   */
  computeTargetTools: () => Promise<ToolDefinition[]>;
  /**
   * 本 applier 拥有的工具名（上一次装配的插件工具集）。
   *
   * 真实宿主上还有非插件来源的工具（`agent`、MCP 工具等）：它们不在本 applier 的
   * 管辖范围，必须原样保留。缺省只按目标名推断（即「只增改、不删」）。
   */
  managedNames?: () => Promise<string[]> | string[];
  /**
   * 影响工具**行为**但不体现在定义上的配置摘要（插件安装配置等）。
   *
   * 例如 `basic-tools` 的 `cwd`：name / description / schema 都不变，但 handler 行为
   * 变了。摘要变化时把管辖内的工具全部按「刷新」重注册。缺省视为无变化。
   */
  targetKey?: () => Promise<string> | string;
  /** 上一次调用的 `targetKey`（跨次调用保留；缺省不比较） */
  previousKey?: { value?: string };
}

/**
 * 一次 `tools` applier 的结果（摘要 + 明细，便于测试断言）。
 *
 * `added` / `removed` / `updated` 是**目标与现状的差异**；宿主不支持注销时，
 * `removed` / `updated` 里的名字实际被保留（见 `kept`），不会从宿主上消失。
 */
export interface ToolsApplyResult {
  summaries: ApplierSummaryLine[];
  added: string[];
  removed: string[];
  updated: string[];
  /**
   * 宿主不支持注销而未能移除 / 更新的工具名（`restart to remove`）。
   * 仅降级路径出现；正常路径不返回该字段（optional additive）。
   */
  kept?: string[];
}

/**
 * 本 applier 实际管辖的插件工具名（启动装配产出）。
 *
 * 宿主上还有非插件来源的工具，必须排除：
 * - `agent` / `ask` 由入口按能力注册，不属于插件配置；
 * - `vessel` 由装配层注册（控制面桥，P1 单工具面），同属入口注册；
 * - MCP 工具由 `mcp` applier 管理（`toolSource` 非 null）。
 *
 * 用它们初始化管辖域，之后的 tools reload 才不会把自己的工具判成 `removed`。
 */
export function pluginManagedToolNames(
  host: PluginHost,
  mcp?: { toolSource(name: string): unknown },
): string[] {
  return host
    .listTools()
    .map((tool) => tool.name)
    .filter(
      (name) =>
        name !== 'agent' &&
        // `ask` 是入口注册的内置工具；`ask_user` 是它的历史名（0.52 前），
        // 外部插件或旧装配仍可能带着旧名，一并排除，免得被当成插件工具管理。
        name !== 'ask' &&
        name !== 'ask_user' &&
        name !== VESSEL_TOOL_NAME &&
        (mcp?.toolSource(name) ?? null) === null,
    );
}

/**
 * 本 applier 实际管辖的插件 guardrail 名（启动装配产出）。
 *
 * 宿主上还有非插件来源的 core guardrail，必须排除：
 * - `vessel-bridge` 由装配层注册（bootstrap，vessel call_tool fail-closed 翻译桥，
 *   C-05 配对），不属于插件配置。旁路目标集只由插件 install 组装、永不含它，
 *   不排除则每次热应用都把它判成 `removed` 注销（ISSUE-PL5-1，与 tools 面 D1 同构）。
 *
 * 与 `pluginManagedToolNames` 排除入口注册工具同口径：只增删插件来源的面。
 */
export function pluginManagedGuardrailNames(host: PluginHost): string[] {
  return host
    .getGuardrails()
    .map((guardrail) => guardrail.name)
    .filter((name) => name !== VESSEL_BRIDGE_GUARDRAIL_NAME);
}

/**
 * 工具定义的稳定签名：旁路重新装配出来的定义对象总是新的引用，
 * 只有内容真的不同才算「刷新」，否则每次配置写入都会重注册全部插件工具。
 */
function toolSignature(definition: ToolDefinition): string {
  return JSON.stringify([
    definition.name,
    definition.description,
    definition.inputSchema,
    typeof definition.checkPermission === 'function',
  ]);
}

/**
 * 旁路构建 + 一次性替换。
 *
 * 顺序保证「要么全成、要么回到原状」：
 * 1. 旁路求目标集（此时不碰真实宿主）；
 * 2. 先注销要移除 / 要更新的工具，再注册新增 / 更新的工具；
 * 3. 任一步失败 → 按记录逆序回滚（恢复旧定义、注销新注册），再抛错。
 *
 * `unregisterTool` 是可选的（自定义宿主可能没有）：缺少时降级为“只增不删”——
 * 新增工具照常注册，待移除 / 待更新的旧定义原样保留并进 `kept`，摘要明确写
 * `restart to remove`；不抛错，也不假装已删除。旧错误码
 * `tools_hot_apply_unsupported` 仅保留为外部契约文案，正常路径不再抛出。
 */
export async function applyTools(
  options: ToolsApplierOptions,
  host: PluginHost = options.host,
): Promise<ToolsApplyResult> {
  const target = await options.computeTargetTools();
  const targetByName = new Map(target.map((tool) => [tool.name, tool]));
  const currentByName = new Map(host.listTools().map((tool) => [tool.name, tool]));
  // 管辖范围：显式给出时只在该集合内增删改；缺省按目标名推断（只增改）。
  const managed = new Set(await (options.managedNames?.() ?? []));

  // 插件安装配置变了（例如 basic-tools 的 cwd）→ 定义相同但行为不同，整体刷新。
  const key = await options.targetKey?.();
  const keyChanged =
    key !== undefined && options.previousKey !== undefined && options.previousKey.value !== key;
  if (options.previousKey !== undefined && key !== undefined) options.previousKey.value = key;

  const added = [...targetByName.keys()].filter((name) => !currentByName.has(name));
  const removed = [...currentByName.keys()].filter(
    (name) => !targetByName.has(name) && (options.managedNames === undefined || managed.has(name)),
  );
  // 同名且（定义内容变了，或插件配置变了）→ 视为更新（先注销再注册）。
  const updated = [...targetByName.keys()].filter((name) => {
    const existing = currentByName.get(name);
    const definition = targetByName.get(name);
    if (existing === undefined || definition === undefined) return false;
    const inScope = options.managedNames === undefined || managed.has(name);
    if (!inScope) return false;
    if (existing === definition) return false;
    if (keyChanged) return true;
    return toolSignature(existing) !== toolSignature(definition);
  });

  if (added.length === 0 && removed.length === 0 && updated.length === 0) {
    return { summaries: [], added, removed, updated };
  }

  const unregister = host.unregisterTool?.bind(host);
  const toUnregister = [...new Set([...removed, ...updated])];
  // 宿主不支持注销：只增不删。待移除 / 待更新的旧定义保留进 `kept`（重启才能清掉）。
  const degraded = unregister === undefined;
  const kept = degraded ? [...toUnregister] : undefined;
  const toRegister = degraded ? added : [...added, ...updated];

  /** 回滚记录：注销了什么（用于恢复）+ 注册了什么（用于撤销） */
  const unregistered: ToolDefinition[] = [];
  const registered: string[] = [];
  const rollback = (): void => {
    // 先撤销新注册，再恢复旧定义（顺序相反才算真正回到原状）。
    for (const name of registered.splice(0).reverse()) {
      try {
        host.unregisterTool?.(name);
      } catch {
        // 回滚是 best-effort：不掩盖原始错误
      }
    }
    for (const definition of unregistered.splice(0).reverse()) {
      try {
        host.registerTool(definition);
      } catch {
        // 同上
      }
    }
  };

  try {
    if (!degraded) {
      for (const name of toUnregister) {
        const existing = currentByName.get(name);
        const removable = unregister?.(name) ?? false;
        // 每个真正移除的定义都记下来：回滚时要按原样放回去（含纯 removed）。
        if (removable && existing !== undefined) unregistered.push(existing);
      }
    }
    for (const name of toRegister) {
      const definition = targetByName.get(name);
      if (definition === undefined) continue;
      host.registerTool(definition);
      registered.push(name);
    }
  } catch (error) {
    rollback();
    throw new Error(
      `tools_hot_apply_failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (degraded) {
    const summaries: ApplierSummaryLine[] = [`tools: +${added.length}`];
    if (added.length > 0) summaries.push(`tools: added ${added.join(', ')}`);
    if (kept !== undefined && kept.length > 0) {
      summaries.push(`tools: kept ${kept.join(', ')} (restart to remove)`);
    }
    return { summaries, added, removed, updated, ...(kept !== undefined ? { kept } : {}) };
  }

  // `+N -M` 只数真正的增删；同名刷新单独一行，避免把「改定义」算成新增。
  const summaries: ApplierSummaryLine[] = [`tools: +${added.length} -${removed.length}`];
  if (removed.length > 0) summaries.push(`tools: removed ${removed.join(', ')}`);
  if (added.length > 0) summaries.push(`tools: added ${added.join(', ')}`);
  if (updated.length > 0) summaries.push(`tools: refreshed ${updated.join(', ')}`);
  return { summaries, added, removed, updated };
}

/** 构造 `tools` applier（摘要交给 `applyTools`）。 */
export function createToolsApplier(
  options: ToolsApplierOptions,
): () => Promise<ApplierSummaryLine[]> {
  return async () => {
    const result = await applyTools(options);
    return result.summaries;
  };
}

// ── registrations（tool / hook / guardrail / readSideMasker 全注册面差量） ──────────

/**
 * 一个注册面的差量 / 应用适配器（q-plugin-lifecycle §6.3）。把四面统一成
 * 「按名增删改 + 回滚」，避免每个面各写一份差量逻辑。`unregister` 返回 undefined
 * 表示宿主不支持注销该面 → 该面降级「只增不删」（与 applyTools 同口径）。
 */
interface RegistrationFace<T> {
  label: string;
  target: T[];
  current: () => T[];
  name: (item: T) => string;
  register: (item: T) => void;
  unregister?: (name: string) => boolean;
  managed: Set<string>;
  /** 内容签名（可选）：同名且签名变了也算刷新；缺省只按 keyChanged 刷新。 */
  signature?: (item: T) => string;
}

/** 管辖域（插件来源的注册面名；非插件来源如 notice hook / agent / MCP 不在内）。 */
export interface ManagedRegistrationNames {
  tools: Set<string>;
  hooks: Set<string>;
  guardrails: Set<string>;
  maskers: Set<string>;
}

export interface RegistrationsApplierOptions {
  host: PluginHost;
  /** 旁路装配目标集（fresh 新实例 + per-plugin 注册面名）。抛错时不做任何变更。 */
  computeTarget: () => Promise<AssembledPluginRegistrations>;
  managed: ManagedRegistrationNames;
  /**
   * 当前生效的插件实例（插件名 → 实例）。启动用 bundle.plugins 初始化；热应用采纳
   * 新实例 / dispose 旧实例都在这里记账。只含本 applier 管辖的插件（provider / 工厂
   * 不经此路径），故 dispose 不会误伤结构性插件。
   */
  liveInstances: Map<string, Plugin>;
  /** 插件安装配置摘要（变了 → 管辖注册面整体刷新）。 */
  targetKey?: () => Promise<string> | string;
  previousKey?: { value?: string };
}

export interface RegistrationsApplyResult {
  summaries: ApplierSummaryLine[];
  /** 采纳为新 live 实例的插件名（新增 / 配置刷新）。 */
  adopted: string[];
  /** dispose 掉的旧实例插件名（移除 / 被刷新替换 / 未采纳的旁路新实例）。 */
  disposed: string[];
}

/** 安全 dispose（best-effort，不掩盖原始错误）。 */
async function disposePlugin(plugin: Plugin | undefined): Promise<void> {
  if (plugin === undefined || typeof plugin.dispose !== 'function') return;
  try {
    await plugin.dispose();
  } catch {
    // dispose 失败不阻断热应用；实例已被摘除注册面，残留由重启清理。
  }
}

/**
 * 全注册面差量热应用（q-plugin-lifecycle §6.3，`applyTools` 的推广）。
 *
 * 一个插件的 tool / hook / guardrail / readSideMasker **整体**增删改 —— 消除
 * 「pii_reveal 工具进了但脱敏 guardrail / masker 没进」的危险半态。顺序保证
 * 「要么全成、要么回到原状」：旁路求目标集 → 先注销 removed/updated 再注册 added/updated
 * → 任一步失败按记录逆序回滚。注册成功后才做实例采纳 / dispose（回滚不 dispose）。
 *
 * 实例生命周期（R-C）：新增 / 配置刷新的插件采纳旁路 fresh 实例并 dispose 旧实例；
 * 被移除的插件 dispose 旧实例；未变化的插件保留旧实例、dispose 旁路那份未采纳的新实例
 * （旁路 install 起的 watcher 等副作用随之清理，不泄漏）。
 */
export async function applyRegistrations(
  options: RegistrationsApplierOptions,
): Promise<RegistrationsApplyResult> {
  const host = options.host;
  const target = await options.computeTarget();

  const key = await options.targetKey?.();
  const keyChanged =
    key !== undefined && options.previousKey !== undefined && options.previousKey.value !== key;
  if (options.previousKey !== undefined && key !== undefined) options.previousKey.value = key;

  const faces: RegistrationFace<unknown>[] = [
    {
      label: 'tools',
      target: target.tools,
      current: () => host.listTools(),
      name: (item) => (item as ToolDefinition).name,
      register: (item) => host.registerTool(item as ToolDefinition),
      unregister: host.unregisterTool?.bind(host),
      managed: options.managed.tools,
      signature: (item) => toolSignature(item as ToolDefinition),
    },
    {
      label: 'hooks',
      target: target.hooks,
      current: () => host.getHooks(),
      name: (item) => (item as Hook).name,
      register: (item) => host.registerHook(item as Hook),
      unregister: host.unregisterHook?.bind(host),
      managed: options.managed.hooks,
    },
    {
      label: 'guardrails',
      target: target.guardrails,
      current: () => host.getGuardrails(),
      name: (item) => (item as Guardrail).name,
      register: (item) => host.registerGuardrail(item as Guardrail),
      unregister: host.unregisterGuardrail?.bind(host),
      managed: options.managed.guardrails,
    },
    {
      label: 'maskers',
      target: target.readSideMaskers,
      current: () => [...(host.getReadSideMaskers?.() ?? [])],
      name: (item) => (item as ReadSideMasker).name,
      register: (item) => host.registerReadSideMasker?.(item as ReadSideMasker),
      unregister: host.unregisterReadSideMasker?.bind(host),
      managed: options.managed.maskers,
    },
  ];

  // 每面的增删改 + 回滚记录。
  const plan = faces.map((face) => {
    const targetByName = new Map(face.target.map((item) => [face.name(item), item]));
    const currentByName = new Map(face.current().map((item) => [face.name(item), item]));
    const added = [...targetByName.keys()].filter((name) => !currentByName.has(name));
    const removed = [...currentByName.keys()].filter(
      (name) => !targetByName.has(name) && face.managed.has(name),
    );
    const updated = [...targetByName.keys()].filter((name) => {
      const existing = currentByName.get(name);
      const next = targetByName.get(name);
      if (existing === undefined || next === undefined) return false;
      if (!face.managed.has(name)) return false;
      if (existing === next) return false;
      if (keyChanged) return true;
      return face.signature !== undefined && face.signature(existing) !== face.signature(next);
    });
    return { face, targetByName, currentByName, added, removed, updated };
  });

  const anyChange = plan.some((p) => p.added.length + p.removed.length + p.updated.length > 0);

  // 实例采纳 / dispose 计划（与注册面差量独立记账，注册成功后才执行）。
  const targetPluginNames = new Set(target.names);
  const adopted: string[] = [];
  const disposed: string[] = [];
  const instanceOps: Array<() => Promise<void>> = [];
  for (const assembled of target.plugins) {
    const old = options.liveInstances.get(assembled.name);
    const isNew = old === undefined;
    if (isNew || keyChanged) {
      // 新增 / 配置刷新：采纳 fresh 实例，dispose 旧实例。
      instanceOps.push(async () => {
        options.liveInstances.set(assembled.name, assembled.instance);
        if (old !== undefined && old !== assembled.instance) {
          await disposePlugin(old);
          disposed.push(assembled.name);
        }
        adopted.push(assembled.name);
      });
    } else {
      // 未变化：保留旧实例，dispose 旁路那份未采纳的新实例（清理其 install 副作用）。
      instanceOps.push(async () => {
        if (assembled.instance !== old) {
          await disposePlugin(assembled.instance);
          disposed.push(assembled.name);
        }
      });
    }
  }
  for (const [name, old] of options.liveInstances) {
    if (targetPluginNames.has(name)) continue;
    // 被移除的插件：dispose 旧实例（注册面已在差量里摘掉）。
    instanceOps.push(async () => {
      options.liveInstances.delete(name);
      await disposePlugin(old);
      disposed.push(name);
    });
  }

  if (!anyChange && instanceOps.length === 0) {
    return { summaries: [], adopted, disposed };
  }

  // 回滚记录：每面注销了什么（恢复）+ 注册了什么（撤销）。
  const unregistered: Array<{ face: RegistrationFace<unknown>; item: unknown }> = [];
  const registered: Array<{ face: RegistrationFace<unknown>; name: string }> = [];
  const rollback = (): void => {
    for (const { face, name } of registered.splice(0).reverse()) {
      try {
        face.unregister?.(name);
      } catch {
        // best-effort
      }
    }
    for (const { face, item } of unregistered.splice(0).reverse()) {
      try {
        face.register(item);
      } catch {
        // best-effort
      }
    }
  };

  const summaries: ApplierSummaryLine[] = [];
  try {
    for (const { face, targetByName, currentByName, added, removed, updated } of plan) {
      const toUnregister = [...new Set([...removed, ...updated])];
      const degraded = face.unregister === undefined;
      const toRegister = degraded ? added : [...added, ...updated];
      if (!degraded) {
        for (const name of toUnregister) {
          const existing = currentByName.get(name);
          const removable = face.unregister?.(name) ?? false;
          if (removable && existing !== undefined) unregistered.push({ face, item: existing });
        }
      }
      for (const name of toRegister) {
        const item = targetByName.get(name);
        if (item === undefined) continue;
        face.register(item);
        registered.push({ face, name });
      }
      // 管辖域并入本次目标名（后续 reload 才能把消失的名判成 removed）。
      for (const name of targetByName.keys()) face.managed.add(name);
      if (added.length + removed.length + updated.length > 0) {
        summaries.push(`tools: ${face.label} +${added.length} -${removed.length}`);
        if (removed.length > 0)
          summaries.push(`tools: ${face.label} removed ${removed.join(', ')}`);
        if (added.length > 0) summaries.push(`tools: ${face.label} added ${added.join(', ')}`);
        if (updated.length > 0)
          summaries.push(`tools: ${face.label} refreshed ${updated.join(', ')}`);
        if (degraded && toUnregister.length > 0) {
          summaries.push(
            `tools: ${face.label} kept ${toUnregister.join(', ')} (restart to remove)`,
          );
        }
      }
    }
  } catch (error) {
    rollback();
    throw new Error(
      `tools_hot_apply_failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 注册面全部成功 → 执行实例采纳 / dispose（回滚路径不会到这里）。
  for (const op of instanceOps) await op();

  return { summaries, adopted, disposed };
}

// ── mcp ──────────────────────────────────────────

/** MCP enable/disable 的最小控制面（现有插件未提供时由装配层补齐） */
export interface McpServerToggle {
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
}

/**
 * enable / disable 的最小实现（契约 §4：现有插件没有该能力时）。
 *
 * disable = 断开该 server 的连接 + 注销它注册的工具；enable = 重新连接（复用
 * `reconnect`，它会在连接成功后重新注册工具）。`tools` 取连接前的状态快照。
 */
export function createMcpServerToggle(options: {
  control: McpControl;
  plugin: {
    reconnect?(name: string): Promise<unknown>;
    getServer?(name: string): McpServerSummary | undefined;
    listServers?(): McpServerSummary[];
  };
  host: PluginHost;
  /** 关闭连接（插件扩展点；缺省只有 reconnect 时 disable 仅注销工具） */
  closeServer?: (name: string) => Promise<void>;
}): McpServerToggle {
  const toolNamesFor = (name: string): string[] => {
    const summary =
      options.plugin.getServer?.(name) ??
      options.plugin.listServers?.().find((server) => server.name === name);
    return summary?.tools ?? [];
  };

  return {
    async disable(name) {
      const tools = toolNamesFor(name);
      await options.closeServer?.(name);
      for (const tool of tools) options.host.unregisterTool?.(tool);
    },
    async enable(name) {
      // reconnect 成功后会重新注册工具；已连接时是幂等重连。
      await options.control.reconnect(name);
    },
  };
}

export interface McpApplierOptions {
  control: McpControl;
  /** enable / disable 实现；缺省时只支持 reconnect 语义（配置启用项重连） */
  toggle?: McpServerToggle;
  /** 重新读取配置里各 server 的 `enabled`（server 名 → enabled） */
  desiredEnabled: () => Promise<Record<string, boolean>>;
}

/** 从状态判断是否需要动作：connected 且应启用 → 重连刷新工具；disabled 且应启用 → enable */
export async function applyMcp(options: McpApplierOptions): Promise<ApplierSummaryLine[]> {
  const desired = await options.desiredEnabled();
  const servers = await options.control.list();
  const lines: ApplierSummaryLine[] = [];

  for (const server of servers) {
    const want = desired[server.name] !== false;
    if (want && server.status === 'disabled') {
      if (options.toggle === undefined) {
        lines.push(`mcp: ${server.name} enable unsupported`);
        continue;
      }
      await options.toggle.enable(server.name);
      lines.push(`mcp: ${server.name} enabled`);
      continue;
    }
    if (!want && server.status !== 'disabled') {
      if (options.toggle === undefined) {
        lines.push(`mcp: ${server.name} disable unsupported`);
        continue;
      }
      await options.toggle.disable(server.name);
      lines.push(`mcp: ${server.name} disabled`);
      continue;
    }
    if (want && server.status === 'failed') {
      // 失败项重连一次：配置里的 command / url 可能已经改好。
      await options.control.reconnect(server.name);
      lines.push(`mcp: ${server.name} reconnected`);
    }
  }

  // 配置新增但插件里还没建的 server 只能重启生效，明确报出来。
  const known = new Set(servers.map((server) => server.name));
  for (const name of Object.keys(desired)) {
    if (!known.has(name)) lines.push(`mcp: ${name} requires restart (not loaded)`);
  }
  return lines;
}

export function createMcpApplier(options: McpApplierOptions): () => Promise<ApplierSummaryLine[]> {
  return () => applyMcp(options);
}
