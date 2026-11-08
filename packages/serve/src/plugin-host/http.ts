/**
 * 插件 HTTP 路由表（CONTRACT-0.48 §2 / §3.1）。
 *
 * 纯函数：不读 manifest、不碰进程、不做 IO。manager 把已解析的声明注入这里，
 * 得到可匹配的路由表；冲突 / 非法声明一律 fail-closed。
 *
 * 匹配规则（v1）：
 * - method 精确；path 按段精确匹配；
 * - `:name` 匹配单个路径段；静态段优先于参数段；
 * - 同一路径形状出现多个不同参数名（`/hub/:id` vs `/hub/:name`）视为冲突；
 * - 不支持可选 / 正则 / 跨段通配。
 *
 * @module @vessel-agent/serve/plugin-host
 */

import {
  DEFAULT_PLUGIN_HTTP_LIMITS,
  type PluginExposeConfig,
  type PluginHttpLimitsConfig,
} from '@vessel-agent/config';
import { isLoopbackHostname } from '../gateway/auth.js';
import { pluginError } from './errors.js';
import { isHttpRouteExposed } from './expose.js';

/** v1 允许的 HTTP 方法（OPTIONS 由 gateway 的 CORS 预检先处理）。 */
export const PLUGIN_HTTP_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

export type PluginHttpMethod = (typeof PLUGIN_HTTP_METHODS)[number];

export type PluginHttpAuth = 'required' | 'none' | 'plugin';
export type PluginHttpScope = 'read' | 'write' | 'admin';
export type PluginHttpResponseMode = 'buffered' | 'stream';
/** 0.48 M3：v1 只支持 WebSocket 升级。 */
export type PluginHttpUpgrade = 'websocket';

/** 归一化后的限额；`null` = 不限制。 */
export type PluginHttpLimits = { [K in keyof Required<PluginHttpLimitsConfig>]: number | null };

/** manifest `contributes.http[]` 的宿主结构。 */
export interface PluginHttpDeclaration {
  /** 授权 / 冲突 / 审计用；同一插件内唯一。 */
  id: string;
  method: string;
  /** 绝对路径；支持 `:name` 单段参数。 */
  path: string;
  /** 缺省 required。 */
  auth?: PluginHttpAuth;
  /** 缺省 read。 */
  scope?: PluginHttpScope;
  /** 缺省 buffered。 */
  responseMode?: PluginHttpResponseMode;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  idleTimeoutMs?: number;
  maxConnections?: number;
  /** 0.48 M3：声明为 WS 升级路由（method 必须是 GET）。 */
  upgrade?: PluginHttpUpgrade;
  /** 0.48 M3：WS 单帧上限；只能收紧宿主默认。 */
  maxFrameBytes?: number;
}

export type PluginHttpSegment = { kind: 'static'; value: string } | { kind: 'param'; name: string };

/** 编译后的单条路由。 */
export interface PluginHttpRoute {
  pluginId: string;
  id: string;
  method: PluginHttpMethod;
  /** manifest 声明的原始 path（授权 / 诊断用）。 */
  path: string;
  segments: readonly PluginHttpSegment[];
  auth: PluginHttpAuth;
  scope: PluginHttpScope;
  responseMode: PluginHttpResponseMode;
  /** 0.48 M3：WS 升级路由；普通请求 → 400 upgrade_required。 */
  upgrade: boolean;
  /** 宿主默认与 manifest 声明的交集（只能收紧）。 */
  limits: PluginHttpLimits;
  /** 内置插件（随 release 发布，可信）。 */
  builtin: boolean;
}

export type PluginHttpConflictReason =
  | 'invalid'
  | 'duplicate_route_id'
  | 'duplicate_route'
  | 'shape_conflict'
  | 'reserved_path'
  | 'untrusted_auth'
  | 'limit_relaxed';

/**
 * 0.48 M4：冲突两级（CONTRACT-0.48 §6.2）。
 * - `plugin`：该插件的声明 / 同插件形状冲突 → 只排除该插件；
 * - `surface`：effective 路由跨插件冲突 → 整个 HTTP 面 fail-closed。
 */
export type PluginHttpConflictScope = 'plugin' | 'surface';

export interface PluginHttpRouteConflict {
  scope: PluginHttpConflictScope;
  pluginId: string;
  routeId?: string;
  path?: string;
  method?: string;
  reason: PluginHttpConflictReason;
  message: string;
}

export interface PluginHttpRouteInput {
  pluginId: string;
  builtin: boolean;
  declarations: readonly PluginHttpDeclaration[] | undefined;
  /** 0.48 M4：config `plugins[].expose`；builtin 忽略。 */
  expose?: PluginExposeConfig;
}

export interface PluginHttpRouteTable {
  routes: readonly PluginHttpRoute[];
  conflicts: readonly PluginHttpRouteConflict[];
}

export type PluginHttpMatch =
  | { kind: 'match'; route: PluginHttpRoute; params: Record<string, string> }
  | { kind: 'none' }
  | { kind: 'invalid' };

/** 插件自己上报的 loopback endpoint。 */
export interface PluginHttpTarget {
  /** `http://127.0.0.1:<port>`（无 path/query）。 */
  url: string;
  /** 每次 spawn 轮换的内部 token。 */
  token: string;
}

export type PluginHttpResolution =
  | { kind: 'ready'; target: PluginHttpTarget }
  | { kind: 'disabled' }
  | { kind: 'unavailable' };

/** 0.48 M3：宿主 WS 连接句柄（gateway 用它关闭两侧）。 */
export interface PluginWebSocketHandle {
  close(code: number, reason: string): void;
}

/** `plugin.http.request` 审计（CONTRACT-0.48 §4.8；不含 header/body/token/query）。 */
export interface PluginHttpRequestAudit {
  plugin: string;
  route: string;
  method: string;
  kind: 'http' | 'ws';
  /** 稳定分类：accepted / ok / unauthorized / forbidden / busy / disabled / unavailable / invalid / error。 */
  outcome: string;
  /** HTTP 状态；WS 成功升级为 101。 */
  status: number;
  durationMs: number;
}

/** `plugin.http.disconnect` 审计（reason 只记分类，不记原文）。 */
export interface PluginHttpDisconnectAudit {
  plugin: string;
  route: string;
  code: number;
  reasonClass: string;
  bytesIn: number;
  bytesOut: number;
  framesIn: number;
  framesOut: number;
}

export type PluginHttpAuditEvent =
  | { event: 'plugin.http.request'; data: PluginHttpRequestAudit }
  | { event: 'plugin.http.disconnect'; data: PluginHttpDisconnectAudit };

/**
 * WS 连接登记 / 计数器（只进日志聚合，不新增 RPC / 事件总线）。
 * 连接 open 时登记；manager 在 deactivate/disable/reload/stopAll 时通过句柄
 * 先关连接再 terminate。
 */
export interface PluginWebSocketAccounting {
  /** 登记打开的 WS；返回幂等注销函数。 */
  register(pluginId: string, handle: PluginWebSocketHandle): () => void;
  frame(pluginId: string, direction: 'in' | 'out', bytes: number): void;
  /** 连接结束；`code` 是实际发给客户端（映射后）的 close code。 */
  closed(pluginId: string, code: number): void;
  /** upgrade 前拒绝（maxConnections / 无效握手）。 */
  rejected(pluginId: string): void;
  audit(event: PluginHttpAuditEvent): void;
}

/**
 * gateway 只依赖这个窄接口；`PluginHostManager` 实现它。
 * 冲突非空时 `match` 必须返回 none（HTTP 面 fail-closed）。
 */
export interface PluginHttpHostLike {
  match(method: string, pathname: string): PluginHttpMatch;
  resolve(pluginId: string): Promise<PluginHttpResolution>;
  conflicts(): readonly PluginHttpRouteConflict[];
  /** 0.48 M3：WS 登记 / 计数器 / 审计；缺省 = 不记账。 */
  readonly webSockets?: PluginWebSocketAccounting;
}

/**
 * 宿主保留路由。由宿主维护；manifest 校验 / 路由表构建都以它为准。
 * 派生自 gateway 的实际 HTTP 入口，不只写 RPC 前缀。
 */
export const PLUGIN_HTTP_RESERVED_PATHS: readonly string[] = [
  '/',
  '/health',
  '/v1',
  '/plugins',
  '/events',
  '/ws',
  '/sessions',
  '/run',
  '/api',
];

export const PLUGIN_HTTP_RESERVED_PREFIXES: readonly string[] = ['/v1/', '/plugins/', '/api/'];

/** 宿主保留路径（静态根 + API / WS / 插件静态面）。 */
export function isHostReservedPath(pathname: string): boolean {
  if (PLUGIN_HTTP_RESERVED_PATHS.includes(pathname)) return true;
  return PLUGIN_HTTP_RESERVED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * 0.48 M4：外部插件 per-id carve-out（CONTRACT-0.48 §6.1）。
 *
 * 内置插件沿用 M1 规则（完全依赖宿主保留表）。外部插件只有自己的
 * `/plugins/<own-id>/<segment...>` 命名空间可用：该前缀豁免保留校验，其余路径
 * （`/plugins/<other-id>/...`、`/plugins/<own-id>`、`/plugins/<own-id>/`、任意
 * 非保留绝对路径）一律视为不可声明，serve 侧 fail-closed。
 */
export function isPluginHttpPathReserved(
  pluginId: string,
  builtin: boolean,
  pathname: string,
  isReserved: (pathname: string) => boolean = isHostReservedPath,
): boolean {
  if (builtin) return isReserved(pathname);
  const ownPrefix = `/plugins/${pluginId}/`;
  if (pathname.startsWith(ownPrefix) && pathname.length > ownPrefix.length) return false;
  return true;
}

const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STATIC_SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * `serve.pluginHttp` → 完整限额。缺省字段用宿主默认；`null` 保留为不限制。
 */
export function resolvePluginHttpLimits(input?: PluginHttpLimitsConfig): PluginHttpLimits {
  return {
    maxBodyBytes:
      input?.maxBodyBytes === undefined
        ? DEFAULT_PLUGIN_HTTP_LIMITS.maxBodyBytes
        : input.maxBodyBytes,
    maxResponseBytes:
      input?.maxResponseBytes === undefined
        ? DEFAULT_PLUGIN_HTTP_LIMITS.maxResponseBytes
        : input.maxResponseBytes,
    timeoutMs:
      input?.timeoutMs === undefined ? DEFAULT_PLUGIN_HTTP_LIMITS.timeoutMs : input.timeoutMs,
    idleTimeoutMs:
      input?.idleTimeoutMs === undefined
        ? DEFAULT_PLUGIN_HTTP_LIMITS.idleTimeoutMs
        : input.idleTimeoutMs,
    maxConnections:
      input?.maxConnections === undefined
        ? DEFAULT_PLUGIN_HTTP_LIMITS.maxConnections
        : input.maxConnections,
    maxFrameBytes:
      input?.maxFrameBytes === undefined
        ? DEFAULT_PLUGIN_HTTP_LIMITS.maxFrameBytes
        : input.maxFrameBytes,
  };
}

/** manifest path → 段列表；非法返回 null（调用方 fail-closed）。 */
function parseDeclarationPath(path: string): PluginHttpSegment[] | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/') return null;
  if (path.includes('?') || path.includes('#') || path.endsWith('/')) return null;
  const rawSegments = path.slice(1).split('/');
  if (rawSegments.length === 0) return null;
  const seenParams = new Set<string>();
  const segments: PluginHttpSegment[] = [];
  for (const raw of rawSegments) {
    if (raw.length === 0) return null;
    if (raw.startsWith(':')) {
      const name = raw.slice(1);
      if (!PARAM_NAME_PATTERN.test(name) || seenParams.has(name)) return null;
      seenParams.add(name);
      segments.push({ kind: 'param', name });
      continue;
    }
    if (raw === '.' || raw === '..') return null;
    if (!STATIC_SEGMENT_PATTERN.test(raw)) return null;
    segments.push({ kind: 'static', value: raw });
  }
  return segments;
}

/** 声明限额；缺省沿用宿主，超过宿主上限视为放宽（fail-closed）。 */
function resolveRouteLimits(
  pluginId: string,
  routeId: string,
  host: PluginHttpLimits,
  raw: Record<string, unknown>,
  upgrade: boolean,
): PluginHttpLimits {
  const take = (
    key: keyof PluginHttpLimits,
    validate: (value: unknown) => value is number,
  ): number | null => {
    const value = raw[key];
    if (value === undefined || value === null) return host[key];
    if (!validate(value)) {
      throw pluginError(
        'plugin_manifest_invalid',
        `contributes.http[${routeId}].${key} is invalid.`,
        {
          plugin: pluginId,
          route: routeId,
          limit: key,
        },
      );
    }
    const hostLimit = host[key];
    if (hostLimit !== null && value > hostLimit) {
      throw pluginError(
        'plugin_manifest_invalid',
        `contributes.http[${routeId}].${key} exceeds the host limit.`,
        { plugin: pluginId, route: routeId, limit: key },
      );
    }
    return value;
  };
  if (upgrade) {
    // WS 不适用 body / response 上限（声明了也忽略，CONTRACT-0.48 §3.1）。
    return {
      maxBodyBytes: host.maxBodyBytes,
      maxResponseBytes: host.maxResponseBytes,
      timeoutMs: take('timeoutMs', positiveInt),
      idleTimeoutMs: take('idleTimeoutMs', positiveInt),
      maxConnections: take('maxConnections', positiveInt),
      maxFrameBytes: take('maxFrameBytes', positiveInt),
    };
  }
  return {
    maxBodyBytes: take('maxBodyBytes', nonNegativeInt),
    maxResponseBytes: take('maxResponseBytes', nonNegativeInt),
    timeoutMs: take('timeoutMs', positiveInt),
    idleTimeoutMs: take('idleTimeoutMs', positiveInt),
    maxConnections: take('maxConnections', positiveInt),
    // maxFrameBytes 只对 WS 生效；普通 HTTP 路由显式忽略。
    maxFrameBytes: host.maxFrameBytes,
  };
}

function normalizeDeclaration(
  pluginId: string,
  builtin: boolean,
  raw: unknown,
  hostLimits: PluginHttpLimits,
): PluginHttpDeclaration & { segments: PluginHttpSegment[] } {
  if (!isRecord(raw)) {
    throw pluginError('plugin_manifest_invalid', 'contributes.http entries must be objects.', {
      plugin: pluginId,
    });
  }
  const id = raw.id;
  if (typeof id !== 'string' || !ROUTE_ID_PATTERN.test(id)) {
    throw pluginError('plugin_manifest_invalid', 'contributes.http[].id is invalid.', {
      plugin: pluginId,
      id,
    });
  }
  const methodRaw = raw.method;
  const method = typeof methodRaw === 'string' ? methodRaw.toUpperCase() : '';
  if (!(PLUGIN_HTTP_METHODS as readonly string[]).includes(method)) {
    throw pluginError('plugin_manifest_invalid', `contributes.http[${id}].method is invalid.`, {
      plugin: pluginId,
      route: id,
      method: methodRaw,
    });
  }
  const path = raw.path;
  const segments = typeof path === 'string' ? parseDeclarationPath(path) : null;
  if (segments === null) {
    throw pluginError('plugin_manifest_invalid', `contributes.http[${id}].path is invalid.`, {
      plugin: pluginId,
      route: id,
      path,
    });
  }
  const auth = raw.auth ?? 'required';
  if (auth !== 'required' && auth !== 'none' && auth !== 'plugin') {
    throw pluginError('plugin_manifest_invalid', `contributes.http[${id}].auth is invalid.`, {
      plugin: pluginId,
      route: id,
      auth,
    });
  }
  if (auth !== 'required' && !builtin) {
    throw pluginError(
      'plugin_manifest_invalid',
      `contributes.http[${id}].auth "${auth}" is only allowed for built-in plugins.`,
      { plugin: pluginId, route: id, auth },
    );
  }
  const scope = raw.scope ?? 'read';
  if (scope !== 'read' && scope !== 'write' && scope !== 'admin') {
    throw pluginError('plugin_manifest_invalid', `contributes.http[${id}].scope is invalid.`, {
      plugin: pluginId,
      route: id,
      scope,
    });
  }
  const upgradeRaw = raw.upgrade;
  if (upgradeRaw !== undefined && upgradeRaw !== 'websocket') {
    throw pluginError('plugin_manifest_invalid', `contributes.http[${id}].upgrade is invalid.`, {
      plugin: pluginId,
      route: id,
      upgrade: upgradeRaw,
    });
  }
  const upgrade = upgradeRaw === 'websocket';
  if (upgrade && method !== 'GET') {
    throw pluginError(
      'plugin_manifest_invalid',
      `contributes.http[${id}].upgrade requires method "GET".`,
      { plugin: pluginId, route: id },
    );
  }
  const responseModeRaw = raw.responseMode;
  if (
    responseModeRaw !== undefined &&
    responseModeRaw !== 'buffered' &&
    responseModeRaw !== 'stream'
  ) {
    throw pluginError(
      'plugin_manifest_invalid',
      `contributes.http[${id}].responseMode is invalid.`,
      { plugin: pluginId, route: id, responseMode: responseModeRaw },
    );
  }
  // 显式 buffered 与升级冲突；缺省按 stream 归一化（CONTRACT-0.48 §3.1）。
  if (upgrade && responseModeRaw === 'buffered') {
    throw pluginError(
      'plugin_manifest_invalid',
      `contributes.http[${id}].responseMode must not be "buffered" for upgrades.`,
      { plugin: pluginId, route: id },
    );
  }
  const responseMode: PluginHttpResponseMode =
    upgrade && responseModeRaw === undefined ? 'stream' : (responseModeRaw ?? 'buffered');
  // 提前校验限额；编译时再取交集。
  resolveRouteLimits(pluginId, id, hostLimits, raw, upgrade);
  return {
    id,
    method,
    path: path as string,
    auth,
    scope,
    responseMode,
    ...(upgrade ? { upgrade: 'websocket' as const } : {}),
    ...(raw.timeoutMs !== undefined && raw.timeoutMs !== null
      ? { timeoutMs: raw.timeoutMs as number }
      : {}),
    ...(raw.maxBodyBytes !== undefined && raw.maxBodyBytes !== null
      ? { maxBodyBytes: raw.maxBodyBytes as number }
      : {}),
    ...(raw.maxResponseBytes !== undefined && raw.maxResponseBytes !== null
      ? { maxResponseBytes: raw.maxResponseBytes as number }
      : {}),
    ...(raw.idleTimeoutMs !== undefined && raw.idleTimeoutMs !== null
      ? { idleTimeoutMs: raw.idleTimeoutMs as number }
      : {}),
    ...(raw.maxConnections !== undefined && raw.maxConnections !== null
      ? { maxConnections: raw.maxConnections as number }
      : {}),
    ...(raw.maxFrameBytes !== undefined && raw.maxFrameBytes !== null
      ? { maxFrameBytes: raw.maxFrameBytes as number }
      : {}),
    segments,
  };
}

/**
 * 校验并归一化单个插件的 `contributes.http`（缺省 `[]`）。
 * 任何非法声明都抛 `plugin_manifest_invalid`，由 manager 把插件标为 invalid。
 */
export function normalizePluginHttpDeclarations(
  pluginId: string,
  raw: unknown,
  builtin: boolean,
  hostLimits: PluginHttpLimits,
): PluginHttpDeclaration[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw pluginError('plugin_manifest_invalid', 'contributes.http must be an array.', {
      plugin: pluginId,
    });
  }
  const ids = new Set<string>();
  const output: PluginHttpDeclaration[] = [];
  for (const entry of raw) {
    const normalized = normalizeDeclaration(pluginId, builtin, entry, hostLimits);
    if (ids.has(normalized.id)) {
      throw pluginError(
        'plugin_manifest_invalid',
        `Duplicate contributes.http id: ${normalized.id}`,
        {
          plugin: pluginId,
          route: normalized.id,
        },
      );
    }
    ids.add(normalized.id);
    const { segments: _segments, ...declaration } = normalized;
    output.push(declaration);
  }
  return output;
}

function compileRoute(
  pluginId: string,
  builtin: boolean,
  declaration: PluginHttpDeclaration,
  hostLimits: PluginHttpLimits,
): PluginHttpRoute {
  const segments = parseDeclarationPath(declaration.path);
  if (segments === null) {
    throw pluginError(
      'plugin_manifest_invalid',
      `contributes.http[${declaration.id}].path is invalid.`,
    );
  }
  const limits = resolveRouteLimits(
    pluginId,
    declaration.id,
    hostLimits,
    { ...declaration },
    declaration.upgrade === 'websocket',
  );
  return {
    pluginId,
    id: declaration.id,
    method: declaration.method.toUpperCase() as PluginHttpMethod,
    path: declaration.path,
    segments,
    auth: declaration.auth ?? 'required',
    scope: declaration.scope ?? 'read',
    responseMode: declaration.responseMode ?? 'buffered',
    upgrade: declaration.upgrade === 'websocket',
    limits,
    builtin,
  };
}

/** 路由形状：静态值 + 参数占位（忽略参数名）。 */
function shapeKey(route: PluginHttpRoute): string {
  const shape = route.segments
    .map((segment) => (segment.kind === 'static' ? `s:${segment.value}` : 'p'))
    .join('/');
  return `${route.method} ${shape}`;
}

function specificityCompare(a: PluginHttpRoute, b: PluginHttpRoute): number {
  const shared = Math.min(a.segments.length, b.segments.length);
  for (let index = 0; index < shared; index += 1) {
    const aStatic = a.segments[index]?.kind === 'static';
    const bStatic = b.segments[index]?.kind === 'static';
    if (aStatic !== bStatic) return aStatic ? -1 : 1;
  }
  if (a.segments.length !== b.segments.length) return b.segments.length - a.segments.length;
  return 0;
}

/**
 * 构建路由表（0.48 M4：两级冲突，CONTRACT-0.48 §6.2）。
 *
 * 1. **每插件声明校验**：对每个插件**全部**声明做归一化 / 编译 / 保留路径 /
 *    同插件重复校验；任一失败 → 该插件全部路由排除（`scope: "plugin"`），
 *    其它插件不受影响。
 * 2. **effective 过滤**：`builtin` 忽略 `expose`，外部插件只保留
 *    `expose.http` 列出的 route id；未授权声明不进入跨插件判定。
 * 3. **跨插件冲突**：只在 effective 路由之间判定；任一冲突 → 整个 HTTP 面
 *    fail-closed（空路由表，`scope: "surface"`）。
 *
 * 静态段优先由排序保证；形状相同但参数名不同的路由不会同时存在。
 */
export function buildPluginHttpRouteTable(
  inputs: readonly PluginHttpRouteInput[],
  hostLimits: PluginHttpLimits,
  isReservedPath: (pathname: string) => boolean = isHostReservedPath,
): PluginHttpRouteTable {
  const conflicts: PluginHttpRouteConflict[] = [];
  const effective: PluginHttpRoute[] = [];

  for (const input of inputs) {
    let normalized: PluginHttpDeclaration[];
    try {
      normalized = normalizePluginHttpDeclarations(
        input.pluginId,
        input.declarations,
        input.builtin,
        hostLimits,
      );
    } catch (error) {
      conflicts.push({
        scope: 'plugin',
        pluginId: input.pluginId,
        reason: 'invalid',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const pluginRoutes: PluginHttpRoute[] = [];
    const byShape = new Map<string, PluginHttpRoute>();
    let pluginInvalid = false;
    for (const declaration of normalized) {
      let route: PluginHttpRoute;
      try {
        route = compileRoute(input.pluginId, input.builtin, declaration, hostLimits);
      } catch (error) {
        pluginInvalid = true;
        conflicts.push({
          scope: 'plugin',
          pluginId: input.pluginId,
          routeId: declaration.id,
          path: declaration.path,
          method: declaration.method,
          reason: 'invalid',
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (isPluginHttpPathReserved(route.pluginId, input.builtin, route.path, isReservedPath)) {
        pluginInvalid = true;
        conflicts.push({
          scope: 'plugin',
          pluginId: route.pluginId,
          routeId: route.id,
          path: route.path,
          method: route.method,
          reason: 'reserved_path',
          message: `contributes.http[${route.id}] conflicts with a host-reserved path: ${route.path}`,
        });
        continue;
      }
      const key = shapeKey(route);
      const existing = byShape.get(key);
      if (existing !== undefined) {
        pluginInvalid = true;
        const exact = existing.method === route.method && existing.path === route.path;
        conflicts.push({
          scope: 'plugin',
          pluginId: route.pluginId,
          routeId: route.id,
          path: route.path,
          method: route.method,
          reason: exact ? 'duplicate_route' : 'shape_conflict',
          message:
            `${route.method} ${route.path} conflicts with ` +
            `${existing.method} ${existing.path} (${existing.pluginId})`,
        });
        continue;
      }
      byShape.set(key, route);
      pluginRoutes.push(route);
    }
    // 声明层失败 → 该插件 HTTP 面整体排除；不影响其它插件。
    if (pluginInvalid) continue;

    for (const route of pluginRoutes) {
      // 授权谓词只有 expose.ts 一份：route table / catalog / CLI 不允许漂移。
      if (isHttpRouteExposed(input.expose, route.id, input.builtin)) {
        effective.push(route);
      }
    }
  }

  // 跨插件冲突只看 effective（已授权）路由；未授权声明不参与。
  const byEffectiveShape = new Map<string, PluginHttpRoute>();
  const surfaceConflicts: PluginHttpRouteConflict[] = [];
  for (const route of effective) {
    const key = shapeKey(route);
    const existing = byEffectiveShape.get(key);
    if (existing !== undefined) {
      const exact = existing.method === route.method && existing.path === route.path;
      surfaceConflicts.push({
        scope: 'surface',
        pluginId: route.pluginId,
        routeId: route.id,
        path: route.path,
        method: route.method,
        reason: exact ? 'duplicate_route' : 'shape_conflict',
        message:
          `${route.method} ${route.path} conflicts with ` +
          `${existing.method} ${existing.path} (${existing.pluginId})`,
      });
      continue;
    }
    byEffectiveShape.set(key, route);
  }

  if (surfaceConflicts.length > 0) {
    return { routes: [], conflicts: [...conflicts, ...surfaceConflicts] };
  }
  effective.sort(specificityCompare);
  return { routes: effective, conflicts };
}

/** 请求路径 → 已解码段；`invalid` 表示穿越 / 非法编码。 */
function parseRequestPath(
  pathname: string,
): { kind: 'ok'; segments: string[] } | { kind: 'invalid' } {
  if (pathname === '/') return { kind: 'ok', segments: [] };
  if (!pathname.startsWith('/')) return { kind: 'invalid' };
  const rawSegments = pathname.slice(1).split('/');
  const segments: string[] = [];
  for (const raw of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return { kind: 'invalid' };
    }
    if (decoded === '.' || decoded === '..') return { kind: 'invalid' };
    // v1 不支持跨段通配；请求里的 `*` 视为非法路径（CONTRACT-0.48 §5）。
    if (decoded.includes('*')) return { kind: 'invalid' };
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
      return { kind: 'invalid' };
    }
    segments.push(decoded);
  }
  return { kind: 'ok', segments };
}

/**
 * 匹配请求。`none` = 没有插件路由；`invalid` = 路径穿越 / 非法编码（400）。
 * 空段（`//` / 尾斜杠）不匹配任何声明路由，归为 `none`，不影响宿主静态页。
 */
export function matchPluginHttpRoute(
  routes: readonly PluginHttpRoute[],
  method: string,
  pathname: string,
): PluginHttpMatch {
  const parsed = parseRequestPath(pathname);
  if (parsed.kind === 'invalid') return { kind: 'invalid' };
  const { segments } = parsed;
  if (segments.some((segment) => segment.length === 0)) return { kind: 'none' };
  const wanted = method.toUpperCase();
  for (const route of routes) {
    if (route.method !== wanted) continue;
    if (route.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < route.segments.length; index += 1) {
      const segment = route.segments[index];
      const value = segments[index] as string;
      if (segment === undefined) {
        matched = false;
        break;
      }
      if (segment.kind === 'static') {
        if (segment.value !== value) {
          matched = false;
          break;
        }
      } else {
        params[segment.name] = value;
      }
    }
    if (matched) return { kind: 'match', route, params };
  }
  return { kind: 'none' };
}

/**
 * 插件自报 endpoint 归一化：只接受 `http://<loopback>:<port>`，无 path/query。
 * 返回 `url.origin`；非法返回 null（manager 会把插件标为 invalid）。
 */
export function normalizePluginHttpEndpoint(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  if (!isLoopbackHostname(url.hostname)) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return url.origin;
}
