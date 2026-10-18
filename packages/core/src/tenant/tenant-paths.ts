/**
 * tenant 目录布局（0.5 F1 / DECISION-010 §2.1 冻结）
 *
 * <data_dir>/tenants/<tenant_id>/
 *   .lock
 *   sessions/<session_id>.json
 *   runs/<run_id>.json
 *   events/<run_id>.jsonl
 *   tenant.json
 *
 * 锁文件的读写归 asm（E15）；core 只提供路径。
 *
 * @module @vessel/core/tenant
 */

import { join } from 'node:path';
import { DEFAULT_TENANT_ID } from '../types/index.js';
import { tenantRootPath } from './resolve-tenant.js';

/** tenant 路径集合（E2 冻结形状） */
export interface TenantPaths {
  tenant_id: string;
  /** `<data_dir>/tenants/<tenant_id>` */
  root: string;
  sessions_dir: string;
  runs_dir: string;
  events_dir: string;
  tenant_file: string;
  lock_file: string;
}

/** 按 tenant 派生冻结目录布局 */
export function resolveTenantPaths(
  baseDataDir: string,
  tenantId: string = DEFAULT_TENANT_ID,
): TenantPaths {
  const root = tenantRootPath(baseDataDir, tenantId);
  return {
    tenant_id: tenantId,
    root,
    sessions_dir: join(root, 'sessions'),
    runs_dir: join(root, 'runs'),
    events_dir: join(root, 'events'),
    tenant_file: join(root, 'tenant.json'),
    lock_file: join(root, '.lock'),
  };
}
