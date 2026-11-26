/**
 * RPC DTO（camelCase，两面重构 §3.3 / §8.1）。形状唯一真源 = 插件 src/index.ts；
 * 这里只做前端投影类型，不改后端形状。
 */

/** 凭证 DTO：yaml 元数据 ∪ 加密库元数据；值永不回显。 */
export interface CredentialDto {
  id: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  hasValue: boolean;
  createdAt?: string;
  updatedAt?: string;
  usedBy: string[];
}

/** 价格四元组（§10.1；单位 = 计价货币 / 百万 token）。 */
export interface EntryPricingDto {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

/** 缺省请求参数（§10.2）。 */
export interface EntryParamDto {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  promptCache?: boolean;
  extra?: Record<string, unknown>;
}

/** 元数据（§10.3；未知键读容忍）。 */
export interface EntryInfoDto {
  displayName?: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: { vision?: boolean; thinking?: boolean; tools?: boolean };
  [key: string]: unknown;
}

/** list.entries[] 投影（name = wire model id；legacy = provider.* 合成条目）。 */
export interface ModelEntryDto {
  id: string;
  name: string;
  alias?: string;
  provider: string;
  mode: string;
  credential?: string;
  baseUrl?: string;
  pricing?: EntryPricingDto;
  param?: EntryParamDto;
  info?: EntryInfoDto;
  inUse: boolean;
  legacy: boolean;
}

/** 迁移报告投影（§7.5；一次性，迁移完成后为空）。 */
export interface MigrationReportDto {
  migratedAt: string;
  credentialsSplit: Array<{ from: string; to: string }>;
  needsReRecord: string[];
  danglingCredentials: string[];
  droppedAliases: Array<{ alias: string; target: string; kept?: string }>;
  unmatchedPricing: string[];
  pinsRewritten: Array<{ file: string; member: string; from: string; to: string }>;
  pinsFailed: string[];
  errors: string[];
}

export interface ListResult {
  credentials: CredentialDto[];
  entries: ModelEntryDto[];
  default?: string;
  effective?: { entryId: string; wireModel: string };
  legacyPresent: boolean;
  migration?: MigrationReportDto;
}

/** test 结果：error 已经 redactor，不含 key / 完整请求头。 */
export interface TestResult {
  ok: boolean;
  latencyMs: number;
  models?: string[];
  error?: { code: string; message: string };
}

/** model_set entry（整条替换；未知键后端拒绝）。 */
export interface ModelSetEntry {
  name?: string;
  alias?: string;
  provider?: string;
  mode?: string;
  credential: string;
  pricing?: EntryPricingDto;
  param?: EntryParamDto;
  info?: EntryInfoDto;
}

/** legacy 合成条目凭证前缀（保留前缀；注册面拒绝）。 */
export const LEGACY_PREFIX = 'legacy:';

export function isLegacyCredential(id: string | undefined): boolean {
  return id?.startsWith(LEGACY_PREFIX) === true;
}

/** 规范协议集（UI 下拉口径，§5.1；品牌工厂名保留注册但退出下拉）。 */
export const CANONICAL_PROVIDERS = ['openai', 'openai-compatible', 'anthropic', 'gemini'] as const;

/** mode 缺省按 provider 推导（§6.2）。 */
export function defaultModeFor(provider: string): string {
  return provider === 'anthropic' ? 'messages' : 'chat';
}

/** provider 的合法 mode 集（responses 保留枚举，本期 UI 不呈现）。 */
export function modesFor(provider: string): string[] {
  return provider === 'anthropic' ? ['messages'] : ['chat'];
}
