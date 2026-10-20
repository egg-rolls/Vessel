/**
 * 多租户类型定义（0.5 F4 / DECISION-010 §2.5、Addendum A-3/A-4）
 *
 * core 不读 env / argv / YAML；resolveTenant 只做纯函数。
 *
 * @module @vessel/core/types
 */

/** 缺省 tenant id */
export const DEFAULT_TENANT_ID = 'default';

/** tenant id 规则（DECISION-010 §2.1 冻结） */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** tenant 解析来源 */
export type TenantSource = 'explicit' | 'cli' | 'env' | 'config' | 'default';

/**
 * tenant 上下文（DECISION-010 §2.5 冻结）。
 *
 * `Config` 泛型：core 不能 import `@vessel/config`（依赖方向），
 * asm 实例化为 `TenantContext<VesselConfig>`（Addendum A-4 §11.3）。
 */
export interface TenantContext<Config = unknown> {
  tenant_id: string;
  /** 冻结语义：`<base_data_dir>/tenants/<tenant_id>` */
  data_dir: string;
  config: Config;
}

/** 非法 tenant id / 非法派生路径 */
export class TenantIdError extends Error {
  readonly code = 'invalid_tenant_id' as const;
  readonly tenantId: string;

  constructor(tenantId: string, detail?: string) {
    super(`invalid_tenant_id: ${detail ?? `"${tenantId}" does not match ${TENANT_ID_PATTERN}`}`);
    this.name = 'TenantIdError';
    this.tenantId = tenantId;
  }
}
