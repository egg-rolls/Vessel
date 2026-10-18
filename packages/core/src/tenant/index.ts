/**
 * @vessel/core/tenant 模块（内部 barrel；不新增 subpath export）
 * @module @vessel/core/tenant
 */

export {
  assertTenantId,
  type ResolveTenantIdInput,
  type ResolveTenantInput,
  resolveTenant,
  resolveTenantId,
  tenantRootPath,
} from './resolve-tenant.js';
export { resolveTenantPaths, type TenantPaths } from './tenant-paths.js';
