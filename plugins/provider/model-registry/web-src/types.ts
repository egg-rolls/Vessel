/**
 * RPC DTO（camelCase）。形状唯一真源 = P1 插件 src/index.ts（只读参考）；
 * 这里只做前端投影类型，不改后端形状。
 */

/** 每模型唯一可选字段 promptCache 三态：缺省 = auto。 */
export interface ModelEntryDto {
  promptCache?: boolean;
}

/** list.vendors[] 投影（apiKeyEnv = 环境变量名，非密钥值；A+B 用户批准只读回显）。 */
export interface VendorDto {
  id: string;
  protocol: string;
  baseUrl?: string;
  credentialRef?: string;
  apiKeyEnv?: string;
  models: Record<string, ModelEntryDto>;
  inUse: boolean;
}

export interface ListResult {
  vendors: VendorDto[];
  aliases: Record<string, string>;
  default?: string;
  effective?: { vendorId: string; wireModel: string };
  legacy: { present: boolean; ref?: string };
}

/** credentials_list：只有元数据，无值、无片段、无指纹。 */
export interface CredentialMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  usedBy: string[];
}

/** test 结果（§3.4）：error 已经 redactor，不含 key / 完整请求头。 */
export interface TestResult {
  ok: boolean;
  latencyMs: number;
  models?: string[];
  error?: { code: string; message: string };
}

/** vendor_set entry（整条替换；未知键后端拒绝）。 */
export interface VendorSetEntry {
  protocol: string;
  baseUrl?: string;
  credential?: string;
  apiKeyEnv?: string;
  models: Record<string, ModelEntryDto>;
}

/** legacy 合成条目 id 前缀（§2.1 保留前缀；validator 拒绝该前缀的 vendor_set）。 */
export const LEGACY_PREFIX = 'legacy:';

export function isLegacyVendor(id: string): boolean {
  return id.startsWith(LEGACY_PREFIX);
}
