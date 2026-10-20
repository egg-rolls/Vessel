/**
 * Gateway tenant 边界（0.5 E19 / A-3 §10.4、A-4 §11.4–§11.5）。
 *
 * web 只消费 asm 注入的 principal / tenant registry / quota；
 * 不读 env / YAML，也不直接持有 tenant 写锁。
 *
 * @module @vessel-agent/serve/tenant
 */

import type { RunEvent } from '@vessel-agent/core';
import { RpcError } from './rpc.js';

/** 角色（A-3 冻结） */
export type TenantRole = 'read' | 'write' | 'admin';

/** token → principal（与 asm `Principal` 结构一致） */
export interface TenantPrincipal {
  tenant_id: string;
  role: TenantRole;
}

/**
 * 鉴权面（与 asm `src/serve-auth.ts` 的 `GatewayAuth` 结构一致）。
 * web 不 import asm，只用结构类型。
 */
export interface GatewayAuthLike {
  configured: boolean;
  legacyToken?: string;
  authenticate(token: string | null): TenantPrincipal | null;
  anonymous?: TenantPrincipal;
}

/** tenant quota（A-3 §10.4；camelCase 来自 config，RPC 输出 snake_case） */
export interface TenantQuota {
  max_sessions?: number;
  max_runs_per_day?: number;
  max_concurrent_runs?: number;
  max_storage_bytes?: number;
}

/** tenant 元数据（RPC 输出形状） */
export interface TenantInfo {
  tenant_id: string;
  name?: string;
  status: 'active' | 'disabled';
  created_at: number;
  quota?: TenantQuota;
  usage?: Record<string, number>;
}

/** quota 检查的操作维度 */
export type QuotaOperation = 'runs.start' | 'sessions.create' | 'runs.concurrent' | 'storage';

/** asm 注入的 tenant 控制面；缺失时 tenants.* 返回 not_found / internal */
export interface TenantControlLike {
  list(): Promise<TenantInfo[]>;
  get(tenantId: string): Promise<TenantInfo | null>;
  create?(tenantId: string, options: { name?: string; quota?: TenantQuota }): Promise<TenantInfo>;
  update?(
    tenantId: string,
    patch: { name?: string; status?: 'active' | 'disabled'; quota?: TenantQuota },
  ): Promise<TenantInfo>;
  checkQuota?(tenantId: string, operation: QuotaOperation): Promise<void> | void;
}

/** 配置快照（与 packages/config ConfigSnapshot 结构一致；web 不 import 该包） */
export interface ConfigSnapshotLike {
  schema_version: 1;
  config: Record<string, unknown>;
  sources: Record<string, 'cli' | 'env' | 'project' | 'user' | 'default'>;
  paths?: { user: string; project: string };
  tenant_id?: string;
  tenant_overlay_keys?: string[];
}

/** asm 注入的配置视图（已脱敏） */
export interface ConfigGatewayOptionsLike {
  snapshot(tenantId: string): Promise<ConfigSnapshotLike> | ConfigSnapshotLike;
}

/** quota 超限；asm/core 可抛出同 code 错误 */
export class QuotaExceededError extends Error {
  readonly code = 'quota_exceeded' as const;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'QuotaExceededError';
    if (details !== undefined) this.details = details;
  }
}

/** tenant 写锁冲突；asm/core 可抛出同 code 错误 */
export class TenantLockedError extends Error {
  readonly code = 'tenant_locked' as const;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'TenantLockedError';
    if (details !== undefined) this.details = details;
  }
}

/** tenant id 规则（DECISION-010 §2.1） */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 缺省 tenant */
export const DEFAULT_TENANT_ID = 'default';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断 principal 是否为跨 tenant admin（`tenant_id:'*'`） */
export function isWildcardPrincipal(principal: TenantPrincipal): boolean {
  return principal.tenant_id === '*';
}

/**
 * 解析本次请求的目标 tenant（A-3 §10.4）。
 *
 * - 非 admin 指定其它 tenant → forbidden；
 * - admin（含 wildcard）可显式指定；
 * - wildcard 未指定时落到 default tenant；
 * - `all_tenants` 只有 admin 且显式为 true 才生效。
 */
export function resolveTenantScope(
  principal: TenantPrincipal,
  params: Record<string, unknown>,
  defaultTenantId: string = DEFAULT_TENANT_ID,
): { tenantId: string; allTenants: boolean } {
  const requestedRaw = params.tenant_id;
  if (requestedRaw !== undefined && typeof requestedRaw !== 'string') {
    throw new RpcError('invalid_params', 'tenant_id must be a string');
  }
  const requested = typeof requestedRaw === 'string' ? requestedRaw : undefined;
  if (requested !== undefined) {
    if (!TENANT_ID_PATTERN.test(requested)) {
      throw new RpcError('invalid_params', 'tenant_id has an invalid format');
    }
    if (principal.role !== 'admin' && requested !== principal.tenant_id) {
      throw new RpcError('forbidden', 'Cross-tenant access is not allowed');
    }
  }

  const isAdmin = principal.role === 'admin';
  const tenantId =
    requested ?? (isWildcardPrincipal(principal) ? defaultTenantId : principal.tenant_id);
  const allTenants = params.all_tenants === true && isAdmin;

  return { tenantId, allTenants };
}

/** 事件的 tenant 归属；缺失视为 default（A-3 §10.3） */
export function eventTenantId(event: RunEvent): string {
  const raw = (event as { tenant_id?: unknown }).tenant_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_TENANT_ID;
}

/** 事件是否应发给该连接 */
export function eventVisible(event: RunEvent, tenantId: string, allTenants: boolean): boolean {
  if (allTenants) return true;
  return eventTenantId(event) === tenantId;
}

/** 从 token 解析 principal；未注入 auth 时按 0.4 单 token 语义 */
export function resolvePrincipal(
  auth: GatewayAuthLike | undefined,
  token: string | null,
  legacyToken: string,
): TenantPrincipal | null {
  if (auth) {
    const principal = auth.authenticate(token);
    if (principal !== null) {
      return { tenant_id: principal.tenant_id, role: principal.role };
    }
    // 0.4 兼容：gateway 自动生成/本地 token 仍按 default/admin 接受；
    // asm 未把生成值写回 auth 时不能回归。
    if (token !== null && token === legacyToken) {
      return { tenant_id: DEFAULT_TENANT_ID, role: 'admin' };
    }
    return null;
  }
  // 未注入 auth = 0.4 单 token 模式：仍要求匹配 gateway token（测试/旧调用方）。
  if (token === null || token === '') return null;
  return token === legacyToken ? { tenant_id: DEFAULT_TENANT_ID, role: 'admin' } : null;
}

/** 本地 dispatcher 的 principal（LocalRpcClient） */
export function resolveLocalPrincipal(
  auth: GatewayAuthLike | undefined,
  legacyToken: string,
): TenantPrincipal {
  const fromAuth = auth?.anonymous ?? auth?.authenticate(auth.legacyToken ?? legacyToken);
  if (fromAuth) return { tenant_id: fromAuth.tenant_id, role: fromAuth.role };
  return { tenant_id: DEFAULT_TENANT_ID, role: 'admin' };
}

/** 从 query / header / Bearer 取 token；空串视为未提供 */
export function extractToken(
  authorization: string | null,
  queryToken: string | null,
): string | null {
  if (authorization?.startsWith('Bearer ')) {
    const value = authorization.slice(7);
    if (value !== '') return value;
  }
  if (queryToken !== null && queryToken !== '') return queryToken;
  return null;
}

/** 把 asm/core 的 tenant/quota 错误映射为冻结 RPC 错误码 */
export function mapTenantError(error: unknown): never {
  const code = (error as { code?: unknown }).code;
  if (code === 'tenant_locked') {
    throw new RpcError(
      'tenant_locked',
      error instanceof Error ? error.message : 'Tenant is locked',
      (error as { details?: unknown }).details,
    );
  }
  if (code === 'quota_exceeded') {
    throw new RpcError(
      'quota_exceeded',
      error instanceof Error ? error.message : 'Tenant quota exceeded',
      (error as { details?: unknown }).details,
    );
  }
  if (code === 'conflict') {
    throw new RpcError(
      'conflict',
      error instanceof Error ? error.message : 'Conflict',
      (error as { details?: unknown }).details,
    );
  }
  if (code === 'forbidden' || code === 'not_found') {
    throw new RpcError(
      code,
      error instanceof Error ? error.message : String(error),
      (error as { details?: unknown }).details,
    );
  }
  throw error;
}

/** 参数里的 tenant_id（供 handler 透传给 asm 控制面） */
export function readTenantParam(params: Record<string, unknown>): string | undefined {
  const value = params.tenant_id;
  return typeof value === 'string' ? value : undefined;
}

/** 判断值是否是 tenant info 形状（防御性归一化） */
export function normalizeTenantInfo(input: unknown): TenantInfo | null {
  if (!isRecord(input)) return null;
  const tenantId = input.tenant_id;
  if (typeof tenantId !== 'string' || tenantId.length === 0) return null;
  const status = input.status === 'disabled' ? 'disabled' : 'active';
  const created = typeof input.created_at === 'number' ? input.created_at : 0;
  return {
    tenant_id: tenantId,
    ...(typeof input.name === 'string' ? { name: input.name } : {}),
    status,
    created_at: created,
    ...(isRecord(input.quota) ? { quota: input.quota as TenantQuota } : {}),
    ...(isRecord(input.usage) ? { usage: input.usage as Record<string, number> } : {}),
  };
}
