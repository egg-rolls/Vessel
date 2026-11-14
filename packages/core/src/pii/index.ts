/** PII / 密钥脱敏模块（0.52）。
 *
 * 布局：
 * - `types.ts`  —— 类别、占位符形状、审计形状（纯常量与类型）
 * - `rules.ts`  —— 规则扫描 / 掩码 / 句柄读取与中和（纯函数，零 IO）
 * - `vault.ts`  —— 内存句柄 broker（单 session + TTL + 容量降级，不落盘真值）
 * - `notice.ts` —— 失效 / 容量两类 env 卡的文案（en / zh-CN，纯函数）
 * - `reveal.ts` —— `pii.reveal` 审批解锁工具（复用现有 ask / permission 链）
 *
 * 三处边界（同一个 broker，且受两条产品不变量约束）：
 * 1. **append 侧**（唯一打码点）：`ExecutionUnit.maskForAppend` —— 消息写入上下文那一刻
 *    就把真值换成占位符（同时中和外部伪造的 `«pii:…»`）。所以 store / 请求 / UI 是同一份
 *    字节（可见性对等），请求 messages 也天然只增不改（前缀缓存不废）。
 * 2. **工具参数求值前**：`runtime/tool-pipeline.ts` —— 占位符 → 真值，解不开就**报错**，
 *    绝不把占位符原样发给外部系统。
 * 3. **失效通知**：`ExecutionUnit.appendPiiDeadNotice` —— append-only 下只能**追加一张
 *    env 卡**（列 id + 类别、不含真值、按批去重），不回改历史。
 */

export {
  PII_CAPACITY_NOTICE,
  PII_DEAD_REFERENCE_LIST_LIMIT,
  PII_ENV_DETAIL_MARK,
  PII_INVALIDATION_NOTICE,
  type PiiDeadReference,
  type PiiNoticeLocale,
  renderDeadReferencesNotice,
} from './notice.js';
export {
  createPiiRevealTool,
  findApprovalId,
  PII_REVEAL_AUDIT_EVENT,
  PII_REVEAL_DENIED_CODE,
  PII_REVEAL_TOOL_NAME,
  PiiRevealNotApprovedError,
} from './reveal.js';
export {
  detect,
  findHandles,
  isHandleId,
  isValidCnIdCard,
  mask,
  neutralize,
  PII_ENTROPY_KEYWORD_WINDOW,
  PII_ENTROPY_MIN_BITS,
  PII_ENTROPY_MIN_LENGTH,
  PII_ERROR_ALLOWED_FIELDS,
  type PiiHandleFailure,
  type PiiHandleOccurrence,
  PiiHandleUnresolvedError,
  passesLuhn,
  shannonEntropy,
  substitute,
} from './rules.js';
export {
  PII_HANDLE_ALPHABET,
  PII_HANDLE_ERROR_CODES,
  PII_HANDLE_ID_LENGTH,
  PII_HANDLE_PATTERN_SOURCE,
  PII_NEUTRALIZED,
  type PiiCategory,
  type PiiDetectOptions,
  type PiiHandleFailureReason,
  type PiiHit,
  piiHandleOf,
  piiHandlePattern,
  piiMaskOf,
} from './types.js';
export {
  getPiiVault,
  PII_HANDLE_TTL_MS,
  PII_MAX_HANDLES_PER_SESSION,
  PII_MAX_NOTIFIED_BATCHES,
  PII_MAX_SESSIONS,
  PII_MAX_TOMBSTONES,
  PII_NOTICE_MIN_INTERVAL_MS,
  piiDeadBatchHash,
  type PiiAuditEntry,
  type PiiProtectBatchResult,
  type PiiProtectResult,
  type PiiResolveResult,
  PiiVault,
  type PiiVaultOptions,
  setPiiVault,
} from './vault.js';
