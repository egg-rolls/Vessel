/**
 * Plugin extension surfaces —— declared vs effective（CONTRACT-0.48 §5 / §8）。
 *
 * 纯函数：manifest 是声明的唯一来源，config `expose` 只做 allow/deny。
 * 不做 IO、不读盘、不加载 config；未知 id 自然忽略（warning 由接线层负责）。
 *
 * - builtin（`source === 'repo'`）忽略 `expose`：enabled 即全部声明面；
 * - external 缺省为空：只认显式 route / command id；
 * - 有效面 = manifest 声明 ∩ enabled ∩ expose。
 *
 * @module @vessel-agent/serve/plugin-host/expose
 */

import type { PluginExposeConfig } from '@vessel-agent/config';

/** `packages/config.PluginConfig.expose` 的单一形状；serve 只消费，不重复定义。 */
export type { PluginExposeConfig } from '@vessel-agent/config';

/** catalog `declaredSurface` / `effectiveSurface` 的 HTTP 摘要（不含 handler）。 */
export interface PluginSurfaceHttpEntry {
  id: string;
  method: string;
  path: string;
}

/** catalog 的 CLI 摘要（不含 handler / args schema）。 */
export interface PluginSurfaceCliEntry {
  path: string[];
  description?: string;
}

export interface PluginSurfaceSummary {
  http: PluginSurfaceHttpEntry[];
  cli: PluginSurfaceCliEntry[];
}

export interface ResolveEffectiveSurfaceInput {
  declared: PluginSurfaceSummary;
  /** builtin（随宿主发布，可信）→ 忽略 expose。 */
  builtin: boolean;
  enabled: boolean;
  /** config `plugins[].expose`；external 缺省即全关。 */
  expose?: PluginExposeConfig;
  /** manager 判定 effective HTTP 面跨插件冲突 fail-closed。 */
  httpSurfaceDisabled?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readHttpSurface(contributes: Record<string, unknown>): PluginSurfaceHttpEntry[] {
  const raw = contributes.http;
  if (!Array.isArray(raw)) return [];

  const routes: PluginSurfaceHttpEntry[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    if (entry === undefined) continue;
    const { id, method, path } = entry;
    if (!nonEmptyString(id) || !nonEmptyString(method) || !nonEmptyString(path)) continue;
    routes.push({ id, method, path });
  }
  return routes;
}

function readCliSurface(contributes: Record<string, unknown>): PluginSurfaceCliEntry[] {
  const raw = contributes.cli;
  if (!Array.isArray(raw)) return [];

  const commands: PluginSurfaceCliEntry[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    if (entry === undefined) continue;
    if (!Array.isArray(entry.path) || entry.path.length === 0) continue;
    const path = entry.path.filter(nonEmptyString);
    if (path.length !== entry.path.length) continue;
    const description = nonEmptyString(entry.description) ? entry.description : undefined;
    commands.push({ path, ...(description !== undefined ? { description } : {}) });
  }
  return commands;
}

/**
 * 从 manifest 提取声明面摘要；两者都空 / 无 manifest → `undefined`
 * （catalog 用字段缺省表达“没有声明面”，而不是空数组）。
 */
export function surfaceSummaryFromManifest(manifest: unknown): PluginSurfaceSummary | undefined {
  const contributes = asRecord(asRecord(manifest)?.contributes);
  if (contributes === undefined) return undefined;

  const http = readHttpSurface(contributes);
  const cli = readCliSurface(contributes);
  if (http.length === 0 && cli.length === 0) return undefined;
  return { http, cli };
}

/** builtin → 恒 true；external → 只在 config 显式列出该 id 时 true。 */
export function isHttpRouteExposed(
  expose: PluginExposeConfig | undefined,
  routeId: string,
  builtin: boolean,
): boolean {
  if (builtin) return true;
  return expose?.http?.includes(routeId) === true;
}

/** builtin → 恒 true；external → 只在 config 显式列出该 id 时 true。 */
export function isCliCommandExposed(
  expose: PluginExposeConfig | undefined,
  commandId: string,
  builtin: boolean,
): boolean {
  if (builtin) return true;
  return expose?.cli?.includes(commandId) === true;
}

/**
 * 有效面 = declared ∩ enabled ∩ expose。
 *
 * 未启用 → 两个面都空；HTTP 面被 manager 标为冲突 → `http: []`（CLI 不受影响）；
 * 未知 expose id 因为只从 declared 过滤而自然忽略。
 */
export function resolveEffectiveSurface(input: ResolveEffectiveSurfaceInput): PluginSurfaceSummary {
  const { declared, builtin, enabled, expose, httpSurfaceDisabled } = input;
  if (!enabled) return { http: [], cli: [] };
  return {
    http:
      httpSurfaceDisabled === true
        ? []
        : declared.http.filter((route) => isHttpRouteExposed(expose, route.id, builtin)),
    cli: declared.cli.filter((command) =>
      isCliCommandExposed(expose, command.path.join('.'), builtin),
    ),
  };
}
