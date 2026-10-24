/**
 * RPC 信封、方法表与 capability manifest（0.5 E10/E11 / A-3 §10.1–§10.3）。
 *
 * HTTP `POST /v1/rpc` 与 WS `kind:'req'` 共用同一分发表；旧 REST 端点是适配器。
 * 方法级错误一律封装在 `ok:false` 中（HTTP 200）；传输/信封错误才用 4xx。
 *
 * @module @vessel-agent/serve/rpc
 */

import type { PrincipalScope } from '@vessel-agent/config';
import type { RunEvent } from '@vessel-agent/core';
import { PROTOCOL_VERSION } from './protocol.js';

/**
 * @deprecated 版本常量唯一来源是 `PROTOCOL_VERSION`；此导出仅为兼容旧导入。
 */
export const RPC_VERSION = PROTOCOL_VERSION;

/** 冻结错误码（A-3 §10.2） */
export type RpcErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_params'
  | 'tenant_locked'
  | 'quota_exceeded'
  | 'conflict'
  | 'internal'
  // 0.12：注入的可选能力未提供（DECISION-023 §2.3，如未注入的 gateway.reload）。
  | 'not_supported'
  // 0.13：交互请求已过期/已随 run 取消（DECISION-024 §2.2）。
  | 'expired'
  // 0.13 Addendum A：run 已结束 / 重启后找不到 run，权限请求失效。
  | 'run_ended';

/** 方法权限（manifest 同名字段） */
export type MethodPermission = 'read' | 'write' | 'admin';

/** 请求信封 */
export interface RpcRequest {
  v: 1;
  id: string;
  method: string;
  params?: unknown;
}

/** 失败载荷 */
export interface RpcErrorBody {
  code: RpcErrorCode;
  message: string;
  details?: unknown;
}

/** 成功响应 */
export interface RpcSuccessResponse {
  v: 1;
  id: string;
  ok: true;
  result: unknown;
}

/** 失败响应 */
export interface RpcFailureResponse {
  v: 1;
  id: string;
  ok: false;
  error: RpcErrorBody;
}

/** 响应信封 */
export type RpcResponse = RpcSuccessResponse | RpcFailureResponse;

/** 方法级错误 */
export class RpcError extends Error {
  readonly code: RpcErrorCode;
  readonly details?: unknown;

  constructor(code: RpcErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** 单次分发的上下文 */
export interface RpcMethodContext {
  /** 由 token 解析出的 principal；tenant_id 可为 '*'（admin token） */
  principal: {
    tenant_id: string;
    role: MethodPermission;
    /** S5：动态 token 的 scope；静态 token 缺省 */
    scope?: PrincipalScope;
    /** S5：control token 的 team 限制 */
    team_id?: string;
    /** S5：吊销 / 关闭 WS 用 */
    token_id?: string;
    /** S5：token 绑定的 hub */
    hub_id?: string;
    /**
     * 合成传输（loopback owner）携带的 agent 身份。
     *
     * 缺省（gateway / team token）表示人类调用者，handler 以 `human` 作为
     * from / viewer；owner 传输填 root owner id，恢复 private 可见性与回复路径。
     */
    agent_id?: string;
  };
  /** 本次请求实际作用的目标 tenant（admin 可显式指定） */
  tenantId: string;
  isAdmin: boolean;
  /** admin 显式 all_tenants（仅 events.subscribe 使用） */
  allTenants: boolean;
  connection: 'http' | 'ws' | 'local';
}

/** 方法处理函数 */
export type RpcHandler = (
  params: Record<string, unknown>,
  ctx: RpcMethodContext,
) => unknown | Promise<unknown>;

/** 方法描述（manifest 与分发表同源） */
export interface RpcMethodDefinition {
  name: string;
  permission: MethodPermission;
  params_schema?: Record<string, unknown>;
  result_schema?: Record<string, unknown>;
  handler: RpcHandler;
}

/** 方法表 */
export interface RpcMethodTable {
  methods: RpcMethodDefinition[];
  byName: Map<string, RpcMethodDefinition>;
}

/** 定义并冻结方法表；重名直接抛错（启动期失败） */
export function defineMethods(methods: RpcMethodDefinition[]): RpcMethodTable {
  const byName = new Map<string, RpcMethodDefinition>();
  for (const method of methods) {
    if (byName.has(method.name)) {
      throw new Error(`Duplicate RPC method: ${method.name}`);
    }
    byName.set(method.name, method);
  }
  return { methods, byName };
}

/** capability manifest（DECISION-010 §2.3 冻结形状） */
export interface CapabilityManifest {
  version: string;
  config_schema_version: number;
  methods: Array<{
    name: string;
    params_schema?: unknown;
    result_schema?: unknown;
    permission: MethodPermission;
  }>;
  tools: Array<{ name: string; description?: string }>;
  plugins: Array<{ name: string; enabled: boolean }>;
}

/** 从方法表生成 manifest；不允许手抄第二份方法清单 */
export function buildCapabilityManifest(input: {
  version: string;
  table: RpcMethodTable;
  tools?: Array<{ name: string; description?: string }>;
  plugins?: Array<{ name: string; enabled: boolean }>;
}): CapabilityManifest {
  return {
    version: input.version,
    config_schema_version: 1,
    methods: input.table.methods.map((method) => ({
      name: method.name,
      ...(method.params_schema !== undefined ? { params_schema: method.params_schema } : {}),
      ...(method.result_schema !== undefined ? { result_schema: method.result_schema } : {}),
      permission: method.permission,
    })),
    tools: input.tools ?? [],
    plugins: input.plugins ?? [],
  };
}

/** 外部 RPC 客户端形状（与 asm `RpcDispatcher` 结构一致） */
export type RpcDispatcher = (request: RpcRequest) => Promise<RpcResponse>;

/** 分发器选项 */
export interface CreateRpcDispatcherOptions {
  table: RpcMethodTable;
  /** LocalRpcClient 使用的 principal（进程内嵌） */
  localPrincipal: RpcMethodContext['principal'];
  /** 由 gateway 提供：解析目标 tenant / all_tenants */
  makeContext: (
    method: RpcMethodDefinition,
    params: Record<string, unknown>,
    principal: RpcMethodContext['principal'],
    connection: RpcMethodContext['connection'],
  ) => RpcMethodContext;
  /** manifest 生成所需的动态部分 */
  describe?: () => { tools?: CapabilityManifest['tools']; plugins?: CapabilityManifest['plugins'] };
  version?: string;
  /**
   * 结果校验失败时回调（gateway 用它发布 `rpc.result_invalid`）。
   * 回调异常不得影响错误响应。
   */
  onResultInvalid?: (violation: { method: string; path: string }) => void;
}

/** 分发器 */
export interface RpcDispatcherHandle {
  /** 供 asm LocalRpcClient 注入 ctx.rpc（本地 principal） */
  dispatch: RpcDispatcher;
  /** HTTP / WS 用：principal 已由 token 解析 */
  dispatchFor: (
    request: RpcRequest,
    principal: RpcMethodContext['principal'],
    connection: RpcMethodContext['connection'],
  ) => Promise<RpcResponse>;
  manifest: () => CapabilityManifest;
}

/** 角色等级；REST 控制面与 RPC 方法表共用，避免第二套权限判断。 */
export const ROLE_RANK: Record<MethodPermission, number> = { read: 1, write: 2, admin: 3 };

/**
 * S5：动态 token scope 的方法白名单。
 *
 * 规则在 rank 检查**之前**应用；`admin` 与缺省 scope（静态 token）保持原
 * rank 语义不变。不新增 role 字符串，也不改 `ROLE_RANK`。
 */
const VIEW_SCOPE_METHODS: ReadonlySet<string> = new Set(['health.get', 'capabilities.list']);
const EXCHANGE_SCOPE_METHODS: ReadonlySet<string> = new Set(['auth.exchange']);
const CONTROL_SCOPE_METHODS: ReadonlySet<string> = new Set([
  'health.get',
  'capabilities.list',
  'teams.list',
  'teams.get',
  'teams.post',
  // S10.3：team-scoped token 只能更新 / 归档自己的 team；create 不在白名单。
  'teams.update',
  'teams.archive',
  // 0.26：team-scoped token 只能对同 team 成员 send / dispatch / rotate
  // （handler 逐条校验 team_id；create 仍不在白名单）。
  'agents.send',
  'agents.dispatch',
  'agents.rotate',
  'events.subscribe',
  'interactions.list',
  'permission.respond',
  'ask.respond',
]);

/** scope 的方法白名单；返回 null 表示沿用 rank 检查（admin / 缺省）。 */
function scopeAllowlist(scope: PrincipalScope | undefined): ReadonlySet<string> | null {
  switch (scope) {
    case 'view':
      return VIEW_SCOPE_METHODS;
    case 'exchange':
      return EXCHANGE_SCOPE_METHODS;
    case 'control':
      return CONTROL_SCOPE_METHODS;
    default:
      return null;
  }
}

/**
 * S5：principal 是否为按 team 收窄的 control token。
 * 只有 `scope === 'control'` 且带非空 `team_id` 时成立；调用方据此做
 * team 过滤，映射不可用时 fail-closed。
 */
export function isTeamScopedPrincipal(
  principal: Pick<RpcMethodContext['principal'], 'scope' | 'team_id'>,
): boolean {
  return (
    principal.scope === 'control' &&
    typeof principal.team_id === 'string' &&
    principal.team_id.length > 0
  );
}

/** principal 是否达到所需权限（未知角色按 read 处理）。 */
export function hasPermission(
  role: MethodPermission | string | undefined,
  required: MethodPermission,
): boolean {
  const rank = ROLE_RANK[role as MethodPermission] ?? ROLE_RANK.read;
  return rank >= ROLE_RANK[required];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验失败的位置与人类可读信息 */
export interface SchemaViolation {
  /** 失败字段的 JSON 路径（例如 `result.value`） */
  path: string;
  message: string;
}

/** 最小 JSON Schema 校验（只支持本仓库 manifest 用到的子集） */
export function validateParams(
  schema: Record<string, unknown> | undefined,
  value: unknown,
): string | null {
  if (schema === undefined) {
    return value === undefined || isRecord(value) ? null : 'params must be an object';
  }
  return validateValue(schema, value, 'params')?.message ?? null;
}

/** 结果校验：返回失败路径；schema 缺失时视为通过（覆盖率由测试保证）。 */
export function validateResult(
  schema: Record<string, unknown> | undefined,
  value: unknown,
): SchemaViolation | null {
  if (schema === undefined) return null;
  return validateValue(schema, value, 'result');
}

function validateValue(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
): SchemaViolation | null {
  const type = schema.type;
  if (type === 'object') {
    if (!isRecord(value)) return { path, message: `${path} must be an object` };
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) {
        return { path: `${path}.${key}`, message: `${path}.${key} is required` };
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(properties)) {
      if (!(key in value)) continue;
      if (!isRecord(child)) continue;
      const failure = validateValue(child, value[key], `${path}.${key}`);
      if (failure !== null) return failure;
    }
    return null;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return { path, message: `${path} must be an array` };
    const items = isRecord(schema.items) ? schema.items : undefined;
    if (items) {
      for (let index = 0; index < value.length; index += 1) {
        const failure = validateValue(items, value[index], `${path}[${index}]`);
        if (failure !== null) return failure;
      }
    }
    return null;
  }
  if (type === 'string') {
    if (typeof value !== 'string') return { path, message: `${path} must be a string` };
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return { path, message: `${path} is too short` };
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return { path, message: `${path} is too long` };
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          return { path, message: `${path} has an invalid format` };
        }
      } catch {
        return null;
      }
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return { path, message: `${path} must be one of ${schema.enum.join(', ')}` };
    }
    return null;
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { path, message: `${path} must be a number` };
    }
    if (type === 'integer' && !Number.isInteger(value)) {
      return { path, message: `${path} must be an integer` };
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return { path, message: `${path} must be >= ${schema.minimum}` };
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return { path, message: `${path} must be <= ${schema.maximum}` };
    }
    return null;
  }
  if (type === 'boolean') {
    return typeof value === 'boolean' ? null : { path, message: `${path} must be a boolean` };
  }
  return null;
}

function normalizeParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new RpcError('invalid_params', 'params must be an object');
  return value;
}

function failure(id: string, error: RpcErrorBody): RpcFailureResponse {
  return { v: PROTOCOL_VERSION, id, ok: false, error };
}

function toErrorBody(error: unknown): RpcErrorBody {
  if (error instanceof RpcError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  const code = (error as { code?: unknown }).code;
  const mapped = mapExternalErrorCode(code);
  if (mapped !== null) {
    return {
      code: mapped,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
  };
}

function mapExternalErrorCode(code: unknown): RpcErrorCode | null {
  switch (code) {
    case 'unauthorized':
    case 'forbidden':
    case 'not_found':
    case 'invalid_params':
    case 'tenant_locked':
    case 'quota_exceeded':
    case 'conflict':
    case 'internal':
    case 'not_supported':
    case 'expired':
    case 'run_ended':
      return code;
    default:
      return null;
  }
}

/** 创建分发器；方法表在启动期冻结 */
export function createRpcDispatcher(options: CreateRpcDispatcherOptions): RpcDispatcherHandle {
  const { table, makeContext } = options;

  async function dispatchFor(
    request: RpcRequest,
    principal: RpcMethodContext['principal'],
    connection: RpcMethodContext['connection'],
  ): Promise<RpcResponse> {
    const id = typeof request.id === 'string' ? request.id : '';
    const method = table.byName.get(request.method);
    if (!method) {
      return failure(id, {
        code: 'not_found',
        message: `Unknown method: ${request.method}`,
        details: { method: request.method },
      });
    }

    let params: Record<string, unknown>;
    try {
      params = normalizeParams(request.params);
      const invalid = validateParams(method.params_schema, params);
      if (invalid !== null) throw new RpcError('invalid_params', invalid);
    } catch (error) {
      return failure(id, toErrorBody(error));
    }

    let ctx: RpcMethodContext;
    try {
      ctx = makeContext(method, params, principal, connection);
    } catch (error) {
      return failure(id, toErrorBody(error));
    }

    // S5：动态 token scope 白名单先于 rank 检查；admin / 缺省 scope 不受影响。
    const allowlist = scopeAllowlist(principal.scope);
    if (allowlist !== null && !allowlist.has(method.name)) {
      return failure(id, {
        code: 'forbidden',
        message: `Method ${method.name} is not allowed for scope ${principal.scope}`,
        details: { method: method.name, scope: principal.scope },
      });
    }

    const rank = ROLE_RANK[principal.role] ?? 1;
    if (rank < ROLE_RANK[method.permission]) {
      return failure(id, {
        code: 'forbidden',
        message: `Method ${method.name} requires ${method.permission} permission`,
        details: { method: method.name, required: method.permission },
      });
    }

    try {
      const result = (await method.handler(params, ctx)) ?? null;
      // 生产默认关闭；测试与 qa 探针用 VESSEL_VALIDATE_RESULTS=1 打开。
      if (process.env.VESSEL_VALIDATE_RESULTS === '1' && method.result_schema !== undefined) {
        const violation = validateResult(method.result_schema, result);
        if (violation !== null) {
          try {
            options.onResultInvalid?.({ method: method.name, path: violation.path });
          } catch {
            // 事件发布失败不影响错误返回
          }
          return failure(id, {
            code: 'internal',
            message: 'RPC result failed schema validation',
            // 只暴露 method/path，绝不回传 payload。
            details: { method: method.name, path: violation.path },
          });
        }
      }
      return { v: PROTOCOL_VERSION, id, ok: true, result };
    } catch (error) {
      return failure(id, toErrorBody(error));
    }
  }

  const dispatch: RpcDispatcher = (request) =>
    dispatchFor(request, options.localPrincipal, 'local');

  return {
    dispatch,
    dispatchFor,
    manifest: () =>
      buildCapabilityManifest({
        version: options.version ?? '0.0.0',
        table,
        ...(options.describe?.().tools !== undefined ? { tools: options.describe?.().tools } : {}),
        ...(options.describe?.().plugins !== undefined
          ? { plugins: options.describe?.().plugins }
          : {}),
      }),
  };
}

/** 事件通知（RPC subscribe 回调，A-3 §10.3） */
export interface RpcEventNotification {
  method: 'events.event';
  params: RunEvent;
}

/** 订阅帧编码：供 WS/SSE 客户端复用 */
export function toEventNotification(event: RunEvent): RpcEventNotification {
  return { method: 'events.event', params: event };
}
