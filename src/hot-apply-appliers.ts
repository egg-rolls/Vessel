/**
 * `gateway.reload` 的 permission / tools / mcp applier（CONTRACT-hot-apply §4）。
 *
 * 每个 applier 是 `() => Promise<string[]>`：返回**要广播的差异摘要行**，
 * 由 `src/cli.ts` 注入到 `createGatewayReloadRunner({ appliers })`。
 * applier 之间互不依赖，可脱离 CLI 单独测试（见 `src/__tests__/hot-apply-appliers.test.ts`）。
 *
 * ## 语义边界
 *
 * - `permission`：对**所有存活 runtime** 调 `applyPermissionRules`（owner + 成员 Body）；
 *   下一轮工具调用即按新规则判定。已记住的 "always" 不受影响（core 语义）。
 * - `tools`：先在**旁路**注册到临时 host 求出目标工具集，再一次性替换真实宿主；
 *   注册失败只回滚已发生的差异，绝不留下半更新状态。
 * - `mcp`：复用现有 `mcp.reconnect`，并补 enable / disable（断开连接 + 注销该 server 的
 *   工具）。没有 MCP 控制面时不注册该 applier（请求即 `unknown reload scope`）。
 *
 * @module vessel/hot-apply-appliers
 */

import type {
  PluginHost,
  RuntimePermissionConfig,
  ToolDefinition,
} from '../packages/core/src/index';
import type { McpControl, McpServerSummary } from './mcp-wiring';

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

/** 一次 `tools` applier 的结果（摘要 + 明细，便于测试断言） */
export interface ToolsApplyResult {
  summaries: ApplierSummaryLine[];
  added: string[];
  removed: string[];
  updated: string[];
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
 * `unregisterTool` 是可选的（自定义宿主可能没有）：缺少时无法移除旧工具，
 * 此时明确报“不可热移除”，不假装已删除。
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
  if (toUnregister.length > 0 && unregister === undefined) {
    throw new Error(
      `tools_hot_apply_unsupported: host cannot unregister ${toUnregister.join(', ')}`,
    );
  }

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
    for (const name of toUnregister) {
      const existing = currentByName.get(name);
      const removable = unregister?.(name) ?? false;
      // 每个真正移除的定义都记下来：回滚时要按原样放回去（含纯 removed）。
      if (removable && existing !== undefined) unregistered.push(existing);
    }
    for (const name of [...added, ...updated]) {
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
