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

import { DEFAULT_PLUGIN_HTTP_LIMITS, type PluginHttpLimitsConfig } from '@vessel-agent/config';
import { isLoopbackHostname } from '../gateway/auth.js';
import { pluginError } from './errors.js';

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

export interface PluginHttpRouteConflict {
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

/**
 * gateway 只依赖这个窄接口；`PluginHostManager` 实现它。
 * 冲突非空时 `match` 必须返回 none（HTTP 面 fail-closed）。
 */
export interface PluginHttpHostLike {
  match(method: string, pathname: string): PluginHttpMatch;
  resolve(pluginId: string, tenantId: string): Promise<PluginHttpResolution>;
  conflicts(): readonly PluginHttpRouteConflict[];
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
  return {
    maxBodyBytes: take('maxBodyBytes', nonNegativeInt),
    maxResponseBytes: take('maxResponseBytes', nonNegativeInt),
    timeoutMs: take('timeoutMs', positiveInt),
    idleTimeoutMs: take('idleTimeoutMs', positiveInt),
    maxConnections: take('maxConnections', positiveInt),
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
  const responseMode = raw.responseMode ?? 'buffered';
  if (responseMode !== 'buffered' && responseMode !== 'stream') {
    throw pluginError(
      'plugin_manifest_invalid',
      `contributes.http[${id}].responseMode is invalid.`,
      { plugin: pluginId, route: id, responseMode },
    );
  }
  // 提前校验限额；编译时再取交集。
  resolveRouteLimits(pluginId, id, hostLimits, raw);
  return {
    id,
    method,
    path: path as string,
    auth,
    scope,
    responseMode,
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
  const limits = resolveRouteLimits(pluginId, declaration.id, hostLimits, {
    ...declaration,
  });
  return {
    pluginId,
    id: declaration.id,
    method: declaration.method.toUpperCase() as PluginHttpMethod,
    path: declaration.path,
    segments,
    auth: declaration.auth ?? 'required',
    scope: declaration.scope ?? 'read',
    responseMode: declaration.responseMode ?? 'buffered',
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
 * 构建路由表。
 *
 * - 冲突（重复形状 / 保留路径 / 非法声明 / 未受信 auth / 放宽限额）任一出现时，
 *   返回空路由表（HTTP 面整体 fail-closed），并把冲突逐条返回给调用方诊断。
 * - 静态段优先由排序保证；形状相同但参数名不同的路由不会同时存在。
 */
export function buildPluginHttpRouteTable(
  inputs: readonly PluginHttpRouteInput[],
  hostLimits: PluginHttpLimits,
  isReservedPath: (pathname: string) => boolean = isHostReservedPath,
): PluginHttpRouteTable {
  const routes: PluginHttpRoute[] = [];
  const conflicts: PluginHttpRouteConflict[] = [];
  const byShape = new Map<string, PluginHttpRoute>();

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
        pluginId: input.pluginId,
        reason: 'invalid',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const declaration of normalized) {
      let route: PluginHttpRoute;
      try {
        route = compileRoute(input.pluginId, input.builtin, declaration, hostLimits);
      } catch (error) {
        conflicts.push({
          pluginId: input.pluginId,
          routeId: declaration.id,
          path: declaration.path,
          method: declaration.method,
          reason: 'invalid',
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (isReservedPath(route.path)) {
        conflicts.push({
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
        const exact = existing.method === route.method && existing.path === route.path;
        conflicts.push({
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
      routes.push(route);
    }
  }

  if (conflicts.length > 0) {
    return { routes: [], conflicts };
  }
  routes.sort(specificityCompare);
  return { routes, conflicts };
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
