/**
 * @vessel-agent/core/tenant 模块（内部 barrel；不新增 subpath export）
 * @module @vessel-agent/core/tenant
 */

export {
  assertTenantId,
  type ResolveTenantIdInput,
  type ResolveTenantInput,
  resolveTenant,
  resolveTenantId,
  tenantRootPath,
} from './resolve-tenant.js';
export {
  encodeSessionDirName,
  resolveTenantPaths,
  sessionDirPath,
  sessionEventsFilePath,
  sessionIndexFilePath,
  type TenantPaths,
} from './tenant-paths.js';
