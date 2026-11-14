/**
 * PII / 密钥脱敏：类型与常量（0.52）。
 *
 * 设计前提（用户已拍板，别再讨论）：
 * - **纯内存句柄，不落盘真值**。agent 与进程同用户、又有 bash / 文件工具 ⇒
 *   「临时文件存原文」等于没脱敏；任何形式的明文映射都不许写盘。
 * - 真值只经**人工审批**（现有 permission/ask 链）解锁，见 `reveal.ts`。
 *
 * 本文件只放纯类型与「形状」常量，不含逻辑，便于任意边界（请求构造层、
 * 工具参数求值、入站正文）共用同一套形状。
 */

/** PII / 密钥类别。掩码与审计都按它归类（**不落值**）。 */
export type PiiCategory =
  | 'api_key'
  | 'jwt'
  | 'email'
  | 'phone'
  | 'id_card'
  | 'bank_card'
  | 'private_key'
  | 'conn_string'
  | 'auth_header'
  /** 熵启发（默认关，见 `rules.ts` 的 `entropy` 选项） */
  | 'high_entropy';

/** 一次命中：`start`/`end` 是原文下标（左闭右开），`text` 是命中的原文子串。 */
export interface PiiHit {
  category: PiiCategory;
  start: number;
  end: number;
  text: string;
  /** 规则命中 vs 熵启发命中（后者默认关） */
  source: 'rule' | 'entropy';
}

/** `detect()` 的选项。 */
export interface PiiDetectOptions {
  /**
   * 熵启发开关。**默认关**：阈值保守，宁可漏掉可疑随机串，
   * 也不要把 hash / base64 / diff 全打码（见 `rules.ts` 的说明）。
   */
  entropy?: boolean;
}

/**
 * 占位符（内存句柄）形状：`«pii:<8 位 base32>»`。
 *
 * 选 8 位 base32（`A-Z` + `2-7`，RFC 4648 字母表）= 40 bit，两个理由：
 * 1. 足够短，不会把 prompt 撑坏，也不会被模型当成分隔符吃掉；
 * 2. 形状严格（**只有**大写下划线与 2-7），因此：
 *    - 掩码 `«pii:mask:email»`、中和 `«pii:neutralized»` 这些小写关键字
 *      **不会**被误认成句柄；
 *    - 入站文本里伪造的同样形状可以被稳定识别出来并**中和**（见 `neutralize`）。
 *
 * 正则用 `PII_HANDLE_PATTERN`（全局、带 capture group 1 = 句柄 id）。
 */
export const PII_HANDLE_PATTERN_SOURCE = '«pii:([A-Z2-7]{8})»';

/** 句柄正则（`lastIndex` 有状态，消费方每次用 `new RegExp` 或重置）。 */
export function piiHandlePattern(): RegExp {
  return new RegExp(PII_HANDLE_PATTERN_SOURCE, 'g');
}

/** base32 字母表（RFC 4648，无 padding）。 */
export const PII_HANDLE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 句柄 id 长度（字符数）。 */
export const PII_HANDLE_ID_LENGTH = 8;

/** 由句柄 id 拼出占位符正文。 */
export function piiHandleOf(handleId: string): string {
  return `«pii:${handleId}»`;
}

/**
 * 直接掩码（不生成句柄）的形状：`«pii:mask:<category>»`。
 *
 * 用在两种场合：容量超限后的降级（见 `vault.ts`），以及纯函数 `mask()`。
 * 形状刻意与句柄**不重叠**，所以掩码结果可以反复过规则而保持幂等。
 */
export function piiMaskOf(category: PiiCategory): string {
  return `«pii:mask:${category}»`;
}

/**
 * 入站文本里伪造句柄被中和后的形状。
 * 小写关键字 ⇒ 同样不会被 `PII_HANDLE_PATTERN_SOURCE` 命中，不会被二次中和。
 */
export const PII_NEUTRALIZED = '«pii:neutralized»';

/**
 * 句柄解不开的三种原因（三档渲染，见 `vault.ts` 与 `runtime/error-envelope.ts`）。
 *
 * - `unknown_handle`：本 session 认识句柄机制、但这个 id 不是它发出去的
 *   （伪造 / 跨 session 混用 / 拼错）⇒ 重试没用，换数据。
 * - `expired_handle`：这个 id 以前有效，TTL 到了或 run 结束了 ⇒ 重新取数据。
 * - `invalidated_handle`：**broker 重启**，本进程没给这个 session 发过句柄，
 *   整批失效（面）而不是个别句柄 ⇒ 除报错外再发一张系统级提示卡（每 session 至多一次）。
 */
export type PiiHandleFailureReason = 'unknown_handle' | 'expired_handle' | 'invalidated_handle';

/** 三档对应的稳定错误码（与 `runtime/error-envelope.ts` 的 CODE_META key 一致）。 */
export const PII_HANDLE_ERROR_CODES: Record<PiiHandleFailureReason, string> = {
  unknown_handle: 'pii_unknown_handle',
  expired_handle: 'pii_expired_handle',
  invalidated_handle: 'pii_invalidated_handle',
};
