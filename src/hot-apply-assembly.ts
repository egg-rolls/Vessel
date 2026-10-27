/**
 * 热应用的装配（CONTRACT-hot-apply §1/§4）。
 *
 * 把「合法的配置 → 目标工具集 / 目标权限规则」这类**只读重算**集中在这里，
 * 让 `src/cli.ts` 只负责注入依赖（runtime / pluginHost / AgentService / MCP 控制面）。
 *
 * 为什么单独一层：
 * - tools applier 必须能在**旁路 host** 上算出目标集合（不能一边算一边改真实宿主），
 *   这条路径与 `--tools` 口径一致（同一套插件选择 / 配置合并 / tenant 工具策略）；
 * - permission applier 的规则解析与 bootstrap 的启动语义必须一致
 *   （交互 `ask`、headless `allow`，加上 `ask_user` 与 `agent.close` 的既有约定）。
 *
 * @module vessel/hot-apply-assembly
 */

import type { VesselConfig } from '../packages/config/src/index';
import { resolveTenantToolPolicy } from '../packages/config/src/index';
import type {
  PluginHost,
  RuntimePermissionConfig,
  ToolDefinition,
} from '../packages/core/src/index';
import { MemoryPluginHost } from '../packages/core/src/index';
import { resolveAgentCwd } from './path-resolution';
import { buildPluginConfigMap, declarativePluginEntries, installWithConfig } from './plugin-config';
import { PluginLoader } from './plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from './plugin-selection';
import type { RuntimeNoticeBus } from './runtime-notice';
import { createRuntimeNoticeHook, RUNTIME_NOTICE_HOOK } from './runtime-notice-hook';
import { resolveRuntimePermission, TenantToolHost } from './tenant-runtime-factory';

/**
 * 权限规则解析：直接复用 bootstrap 的 `resolveRuntimePermission`，不另写一份，
 * 保证「启动时的规则」与「热应用的规则」永远同源（交互 `ask` / headless `allow`，
 * 加上 `ask_user` 与 `agent.close` 的既有约定）。
 */
export function permissionConfigFor(
  config: VesselConfig,
  headless: boolean,
): RuntimePermissionConfig {
  return resolveRuntimePermission(config, headless);
}

/** 只保留 `applyPermissionRules` 的最小 runtime 形状（不做 `as AgentRuntime` 断言）。 */
export interface PermissionApplyTarget {
  id: string;
  applyPermissionRules?: (rules: RuntimePermissionConfig) => void;
}

function hasApplyPermissionRules(value: unknown): value is PermissionApplyTarget & {
  applyPermissionRules: (rules: RuntimePermissionConfig) => void;
} {
  if (value === null || typeof value !== 'object') return false;
  return (
    typeof (value as { applyPermissionRules?: unknown }).applyPermissionRules === 'function' &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

/**
 * 从一个 runtime 候选（`AgentRuntime` / 包装过的 `RunnableAgent`）里找到真正能
 * 应用权限规则的对象。
 *
 * 包装过的 runtime 把真正的 runtime 藏在 `handle` / `inner` 等字段后面；
 * 这里按结构逐层下探，找不到就返回 undefined（不抛错，调用方跳过）。
 */
export function resolveAgentRuntime(value: unknown, depth = 0): PermissionApplyTarget | undefined {
  if (value === null || typeof value !== 'object' || depth > 3) return undefined;
  if (hasApplyPermissionRules(value)) return value;

  const record = value as Record<string, unknown>;
  // 包装层：withSessionWriteLock 的 inner / 其它持有者字段等。
  for (const key of ['handle', 'inner', 'runtime', 'agentRuntime']) {
    const resolved = resolveAgentRuntime(record[key], depth + 1);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** 从 bootstrap 结果里收集所有「存活且可热应用权限」的 runtime（按 id 去重）。 */
export function collectPermissionTargets(input: {
  runtime?: unknown;
  bundleRuntime?: unknown;
  tenantRuntimes?: () => unknown[];
}): PermissionApplyTarget[] {
  const byId = new Map<string, PermissionApplyTarget>();
  const add = (candidate: unknown): void => {
    const resolved = resolveAgentRuntime(candidate);
    if (resolved === undefined) return;
    if (!byId.has(resolved.id)) byId.set(resolved.id, resolved);
  };
  add(input.runtime);
  add(input.bundleRuntime);
  for (const candidate of input.tenantRuntimes?.() ?? []) add(candidate);
  return [...byId.values()];
}

/**
 * 在旁路 host 上装配插件工具，返回目标工具定义（不碰真实宿主）。
 *
 * 口径与 `--tools` / bootstrap 一致：插件选择 → 配置合并 → tenant 工具策略过滤。
 * `installWithConfig` 里的插件若有副作用（MCP 建连等），调用方负责排除——
 * 本函数只给「普通插件工具」用（MCP / agent 由各自 applier 管理）。
 */
export async function assemblePluginTools(options: {
  config: VesselConfig;
  tenantId: string;
  loader?: PluginLoader;
  /** 显式排除的插件名（工厂式 / 由其它 applier 管理的插件） */
  excludePlugins?: ReadonlySet<string>;
}): Promise<{ tools: ToolDefinition[]; names: string[] }> {
  const loader = options.loader ?? new PluginLoader();
  const declarative = declarativePluginEntries(options.config);
  const selection = resolvePluginSelection(
    loader,
    options.config.plugins,
    Boolean(process.env.VESSEL_DEBUG),
    declarative,
  );
  // 告警只打一次（进程级 once），不会因热应用刷屏。
  warnExternalPluginsOnce(selection.external);
  const pluginConfigs = buildPluginConfigMap(
    options.config.plugins,
    declarative,
    resolveAgentCwd(options.config),
  );
  const exclude = options.excludePlugins ?? new Set<string>();
  const host: PluginHost = new TenantToolHost(
    new MemoryPluginHost(),
    resolveTenantToolPolicy(options.config, options.tenantId),
  );
  const names: string[] = [];
  for (const name of selection.names) {
    if (exclude.has(name)) continue;
    const plugin = await loader.load(name);
    if (!plugin) continue;
    await installWithConfig(plugin, host, pluginConfigs[plugin.name]);
    names.push(name);
  }
  return { tools: host.listTools(), names };
}

/**
 * 在真实 host 上注册 `runtime.notice` 的 BeforeLlm hook（幂等）。
 *
 * 成员 runtime 会在 spawn 时复制父 `PluginHost.getHooks()`，因此在这里注册一次，
 * owner 与所有成员 turn 都能看到通知；成员各自用自己的 `session_id` 取游标。
 */
export function registerRuntimeNoticeHook(host: PluginHost, bus: RuntimeNoticeBus): void {
  const existing = host.getHooks().some((hook) => hook.name === RUNTIME_NOTICE_HOOK);
  if (existing) return;
  host.registerHook(createRuntimeNoticeHook({ bus }));
}
