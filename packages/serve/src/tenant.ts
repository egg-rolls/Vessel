/**
 * Gateway 鉴权 / 配置注入边界（0.49 T4：单执行面，wire 不再带 tenant）。
 *
 * web 只消费 asm 注入的 principal / 配置视图；
 * 不读 env / YAML，也不直接持有写锁。
 *
 * @module @vessel-agent/serve/tenant
 */

import type { PrincipalScope } from '@vessel-agent/config';
import { RpcError } from './rpc.js';

/** 角色（A-3 冻结） */
export type TenantRole = 'read' | 'write' | 'admin';

/** token → principal（与 asm `Principal` 结构一致；S5 additive scope） */
export interface TenantPrincipal {
  role: TenantRole;
  scope?: PrincipalScope;
  team_id?: string;
  token_id?: string;
  hub_id?: string;
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

/** 配置快照（与 packages/config ConfigSnapshot 结构一致；web 不 import 该包） */
export interface ConfigSnapshotLike {
  schema_version: 1;
  config: Record<string, unknown>;
  sources: Record<string, 'cli' | 'env' | 'project' | 'user' | 'default'>;
  paths?: { user: string; project: string };
}

/** asm 注入的配置视图（已脱敏） */
/** 0.15：`config.set` 的写入请求；只允许白名单键（方法层校验）。 */
export interface ConfigSetRequest {
  tenantId: string;
  key: string;
  value: string | boolean;
}

export interface ConfigGatewayOptionsLike {
  snapshot(tenantId: string): Promise<ConfigSnapshotLike> | ConfigSnapshotLike;
  /** 可写用户配置；未注入时 `config.set` 返回 not_found。 */
  set?(request: ConfigSetRequest): Promise<void> | void;
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

/** 写锁冲突；asm/core 可抛出同 code 错误（T4 保留 `tenant_locked` 错误码，R7=B） */
export class TenantLockedError extends Error {
  readonly code = 'tenant_locked' as const;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'TenantLockedError';
    if (details !== undefined) this.details = details;
  }
}

/** 缺省单 id 兜底（调用方应显式传 `defaultTenantId`；仅内部路径使用） */
export const DEFAULT_TENANT_ID = 'default';

/**
 * 从 token 解析 principal；未注入 auth 时按 0.4 单 token 语义。
 * 0.49 T4：principal 不再携带 tenant 维度。
 */
export function resolvePrincipal(
  auth: GatewayAuthLike | undefined,
  token: string | null,
  legacyToken: string,
): TenantPrincipal | null {
  let principal: TenantPrincipal | null = null;
  if (auth) {
    const authenticated = auth.authenticate(token);
    if (authenticated !== null) {
      // S5：保留 additive scope / team_id / token_id / hub_id，不在这里丢掉。
      principal = { ...authenticated };
    } else if (token !== null && token === legacyToken) {
      // 0.4 兼容：gateway 自动生成/本地 token 仍按 admin 接受；
      // asm 未把生成值写回 auth 时不能回归。
      principal = { role: 'admin' };
    }
  } else if (token !== null && token !== '' && token === legacyToken) {
    // 未注入 auth = 0.4 单 token 模式：仍要求匹配 gateway token（测试/旧调用方）。
    principal = { role: 'admin' };
  }
  return principal;
}

/** 本地 dispatcher 的 principal（LocalRpcClient） */
export function resolveLocalPrincipal(
  auth: GatewayAuthLike | undefined,
  legacyToken: string,
): TenantPrincipal {
  const fromAuth = auth?.anonymous ?? auth?.authenticate(auth.legacyToken ?? legacyToken);
  if (fromAuth) return { ...fromAuth };
  return { role: 'admin' };
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

/** 把 asm/core 的锁 / quota 错误映射为冻结 RPC 错误码 */
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
