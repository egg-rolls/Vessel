/**
 * @vessel-agent/core/tenant 模块（内部 barrel；不新增 subpath export）
 * @module @vessel-agent/core/tenant
 */

export { assertTenantId } from './resolve-tenant.js';
export {
  encodeSessionDirName,
  resolveSingleTenantPaths,
  sessionDirPath,
  sessionEventsFilePath,
  sessionIndexFilePath,
  type TenantPaths,
} from './tenant-paths.js';
