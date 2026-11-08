/**
 * tenant id 校验（0.5 F4 / DECISION-010 §2.5）
 *
 * 0.49 T5：旧布局解析（explicit > cli > env > config > default）与
 * `<data_dir>/tenants/<id>` 根目录推导随迁移层删除；单 id 由 asm 的
 * `readPersistedTenantId` / `resolveEffectiveTenantId` 解析，core 只保留校验。
 *
 * @module @vessel-agent/core/tenant
 */

import { TENANT_ID_PATTERN, TenantIdError } from '../types/index.js';

/** 校验 tenant id；非法值抛 TenantIdError（不静默回退） */
export function assertTenantId(value: string): string {
  if (typeof value !== 'string' || !TENANT_ID_PATTERN.test(value)) {
    throw new TenantIdError(typeof value === 'string' ? value : String(value));
  }
  return value;
}
