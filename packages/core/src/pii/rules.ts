/**
 * PII / 密钥规则：**纯函数，无 IO、无全局状态**（0.52）。
 *
 * 三条设计约束（来自 0.52 已核事实，别再退回旧做法）：
 * 1. **整串分类优先**：先按「整串」判定（整段数字 run、整条 header 值、整块私钥），
 *    不做无边界的子串匹配。`1794482135404`（13 位）不是手机号、随机 18 位不是
 *    身份证、裸 16 位过不了 Luhn 就不是卡号。
 * 2. **熵启发只作补充、默认关**，且必须与「密钥类关键字」同行共现才认。
 *    宁可漏掉可疑随机串，也不要把 hash / base64 / diff 全打码。
 * 3. 所有替换形状都以 `types.ts` 的 `«pii:…»` 为族；掩码结果**幂等**：
 *    把打过码的文本再过一遍规则，结果不变（探针 h）。
 *
 * 零依赖：只用 JS 内建（无 `node:crypto`），因此浏览器侧也能跑。
 */

import {
  PII_HANDLE_ERROR_CODES,
  PII_NEUTRALIZED,
  piiHandleOf,
  piiMaskOf,
  piiHandlePattern,
  PII_HANDLE_ID_LENGTH,
  type PiiCategory,
  type PiiDetectOptions,
  type PiiHandleFailureReason,
  type PiiHit,
} from './types.js';

// ---------------------------------------------------------------------------
// 校验位工具
// ---------------------------------------------------------------------------

/** Luhn（银行卡 / 信用卡校验位）。 */
export function passesLuhn(digits: string): boolean {
  const s = digits.replace(/\D/g, '');
  if (s.length < 12) return false;
  let sum = 0;
  let double = false;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    let d = s.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const CN_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CN_ID_CHECK = '10X98765432';

/**
 * 中国大陆居民身份证（GB 11643-1999）18 位校验。
 * 光看 18 位数字不算 —— 必须过校验位。
 */
export function isValidCnIdCard(value: string): boolean {
  const s = value.trim();
  if (!/^\d{17}[\dXx]$/.test(s)) return false;
  // 行政区划头两位不能是 00
  if (s.slice(0, 2) === '00') return false;
  // 出生日期粗校验（19000101 - 20991231 且月份/日合法）
  const year = Number(s.slice(6, 10));
  const month = Number(s.slice(10, 12));
  const day = Number(s.slice(12, 14));
  if (!(year >= 1900 && year <= 2099)) return false;
  if (!(month >= 1 && month <= 12)) return false;
  if (!(day >= 1 && day <= 31)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    sum += (s.charCodeAt(i) - 48) * CN_ID_WEIGHTS[i]!;
  }
  const expected = CN_ID_CHECK[sum % 11]!;
  return expected === s[17]!.toUpperCase();
}

/** Shannon 熵（bits/char），熵启发用。 */
export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

interface RuleSpec {
  category: PiiCategory;
  pattern: RegExp;
  /** 命中后再验一次（例如数字串的整串分类）；返回 false 则丢弃。 */
  validate?: (match: string) => boolean;
  /**
   * 命中后**只替换哪一段**（相对 match 的下标，左闭右开）。
   *
   * 用于「保留外壳、只打值」的规则：比如 `Authorization: xxx` 只打 `xxx`，
   * 头名与换行必须原样保留 —— 否则把前置换行吃掉会把上一行和这一行粘在一起，
   * 既破坏幂等也破坏 diff 可读性。
   */
  span?: (match: string) => { start: number; end: number };
}

/** 整串数字分类（手机号 / 身份证 / 银行卡），顺序即优先级。 */
function classifyDigits(run: string): PiiCategory | null {
  if (run.length === 18 && isValidCnIdCard(run)) return 'id_card';
  if (run.length === 11 && /^1[3-9]\d{9}$/.test(run)) return 'phone';
  if (run.length >= 15 && run.length <= 19 && passesLuhn(run)) return 'bank_card';
  return null;
}

const DIGIT_RUN = /(?<![\w.$])\d{11,19}(?![\w.$])/g;
const ID_CARD_X = /(?<![\w.$])\d{17}[Xx](?![\w.$])/g;
/** 带分隔符的卡号：4111 1111 1111 1111 / 4111-1111-1111-1111 */
const CARD_GROUPED = /(?<![\w.$])\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?![\w.$])/g;

/**
 * 生成器类规则：**整串**匹配，不做无边界子串匹配。
 * 每个模式都带 `\b` / 边界断言，避免把 hash、diff、变量名切碎误判。
 */
const RULES: RuleSpec[] = [
  {
    // PEM 私钥块：从 BEGIN 到 END（没有 END 就吃到结尾，宁可多打码）
    category: 'private_key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    category: 'private_key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g,
  },
  {
    // 带密码的连接串（redis://user:pass@host、postgres://…）——整条打码
    category: 'conn_string',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@]+@[^\s/]+/gi,
  },
  { category: 'email', pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  {
    // Authorization / Cookie / X-Api-Key 头值：**只打值**，保留头名（便于模型理解）
    // 与前置换行（不动行结构）。
    category: 'auth_header',
    pattern: /(?:^|\n)[ \t]*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)[ \t]*:[ \t]*[^\n]+/gi,
    validate: (match) => /:[ \t]*\S/.test(match),
    span: (match) => {
      const colon = match.indexOf(':');
      let start = colon + 1;
      while (start < match.length && (match[start] === ' ' || match[start] === '\t')) start += 1;
      return { start, end: match.length };
    },
  },
  // --- API key / token 家族 ---
  { category: 'api_key', pattern: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g },
  { category: 'api_key', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { category: 'api_key', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { category: 'api_key', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { category: 'api_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { category: 'api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { category: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
];

/**
 * 熵启发：默认关。
 *
 * 阈值（保守，见字段注释）：
 * - 长度 ≥ 40（短随机串基本都是 hash 前缀 / 变量名）；
 * - 字符集 [A-Za-z0-9+/_-]（**不含 `=`**：否则 `api_token=…` 这种赋值形状会被整段
 *   吃进 token，关键字上下文就被吞掉了），且必须**同时**含大写、小写、数字；
 * - Shannon 熵 ≥ 4.5 bits/char；
 * - **必须同行有密钥类关键字**（key / token / secret / password / bearer…），
 *   且关键字在 token 前 40 字符内。
 *
 * 最后一条是关键：没有它，base64 的 sha256、diff 里的长串、lockfile 内容全会
 * 被打码，误伤远大于收益。所以熵启发只是「补充」，不是主力。
 */
const ENTROPY_TOKEN = /[A-Za-z0-9+/_-]{40,}/g;
const ENTROPY_KEYWORD = /(?:key|token|secret|passw(?:or)?d|pwd|credential|bearer|apikey)/i;

/** 熵启发阈值常量（对探针与文档可见，便于 Review 时争论具体数字）。 */
export const PII_ENTROPY_MIN_LENGTH = 40;
export const PII_ENTROPY_MIN_BITS = 4.5;
export const PII_ENTROPY_KEYWORD_WINDOW = 40;

function entropyHits(text: string): PiiHit[] {
  const hits: PiiHit[] = [];
  for (const m of text.matchAll(ENTROPY_TOKEN)) {
    const token = m[0];
    if (token.length < PII_ENTROPY_MIN_LENGTH) continue;
    if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[0-9]/.test(token)) continue;
    if (shannonEntropy(token) < PII_ENTROPY_MIN_BITS) continue;
    const start = m.index ?? 0;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const context = text.slice(Math.max(lineStart, start - PII_ENTROPY_KEYWORD_WINDOW), start);
    if (!ENTROPY_KEYWORD.test(context)) continue;
    hits.push({ category: 'high_entropy', start, end: start + token.length, text: token, source: 'entropy' });
  }
  return hits;
}

/** 命中排序 + 去重叠：靠前的、更长的优先（例：连接串压住里面的邮箱）。 */
function resolveOverlaps(hits: PiiHit[]): PiiHit[] {
  const sorted = [...hits].sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const out: PiiHit[] = [];
  let cursor = -1;
  for (const hit of sorted) {
    if (hit.start < cursor) continue;
    out.push(hit);
    cursor = hit.end;
  }
  return out;
}

/**
 * 扫描文本里的 PII / 密钥。**纯函数**：同样输入恒得同样输出。
 *
 * @param text 待扫描正文
 * @param options `entropy: true` 才启用熵启发（默认关）
 */
export function detect(text: string, options: PiiDetectOptions = {}): PiiHit[] {
  if (!text) return [];
  const hits: PiiHit[] = [];
  const push = (category: PiiCategory, start: number, match: string, source: 'rule' | 'entropy' = 'rule'): void => {
    hits.push({ category, start, end: start + match.length, text: match, source });
  };

  // 1) 整串数字：身份证（含 X 尾）/ 手机号 / 银行卡（Luhn）
  for (const m of text.matchAll(ID_CARD_X)) {
    const start = m.index ?? 0;
    if (isValidCnIdCard(m[0])) push('id_card', start, m[0]);
  }
  for (const m of text.matchAll(DIGIT_RUN)) {
    const category = classifyDigits(m[0]);
    if (category) push(category, m.index ?? 0, m[0]);
  }
  for (const m of text.matchAll(CARD_GROUPED)) {
    if (passesLuhn(m[0])) push('bank_card', m.index ?? 0, m[0]);
  }

  // 2) 形态规则（私钥 / 连接串 / 头值 / 邮箱 / key 家族）
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      if (rule.validate && !rule.validate(m[0])) continue;
      const start = m.index ?? 0;
      if (rule.span === undefined) {
        push(rule.category, start, m[0]);
        continue;
      }
      const span = rule.span(m[0]);
      const value = m[0].slice(span.start, span.end);
      if (value.length === 0) continue;
      push(rule.category, start + span.start, value);
    }
  }

  // 3) 熵启发（默认关）
  if (options.entropy) hits.push(...entropyHits(text));

  return resolveOverlaps(hits);
}

/**
 * 直接掩码：命中全部换成 `«pii:mask:<category>»`（**不**生成句柄）。
 *
 * 幂等：掩码形状不含任何规则会命中的子串，所以 `mask(mask(x)).text === mask(x).text`。
 */
export function mask(text: string, options: PiiDetectOptions = {}): { text: string; hits: PiiHit[] } {
  const hits = detect(text, options);
  if (hits.length === 0) return { text, hits };
  let out = '';
  let cursor = 0;
  for (const hit of hits) {
    out += text.slice(cursor, hit.start) + piiMaskOf(hit.category);
    cursor = hit.end;
  }
  out += text.slice(cursor);
  return { text: out, hits };
}

// ---------------------------------------------------------------------------
// 句柄形状的读写
// ---------------------------------------------------------------------------

/** 文本里出现的一个句柄（位置 + id + 完整占位符）。 */
export interface PiiHandleOccurrence {
  handle: string;
  id: string;
  start: number;
  end: number;
}

/** 找出文本里所有 `«pii:<8 base32>»` 形状（**不判断真伪**，真伪交给 vault）。 */
export function findHandles(text: string): PiiHandleOccurrence[] {
  if (!text || !text.includes('«pii:')) return [];
  const out: PiiHandleOccurrence[] = [];
  for (const m of text.matchAll(piiHandlePattern())) {
    const id = m[1]!;
    const start = m.index ?? 0;
    out.push({ id, handle: m[0], start, end: start + m[0].length });
  }
  return out;
}

/**
 * 把入站文本里**伪造的**占位符中和掉。
 *
 * 为什么要中和：占位符形状必须能被正则稳定识别（替换边界要靠它），但网页正文 /
 * 文件内容 / 工具输出是外部可控的 —— 外部可以写一段 `«pii:ABCD2345»` 来冒充句柄，
 * 诱导后面的工具参数替换把别的会话 / 别的值的真值塞进去，或者仅仅是把占位符
 * 原样喷到外部去。所以入站文本里凡是**本 session 不认识**的同形 token 一律中和
 * （换成 `«pii:neutralized»`，小写关键字，不会被当成句柄，也不会被二次中和）。
 *
 * @param text 入站正文
 * @param isKnown 本 session 认得的句柄 id（`undefined` ⇒ 一律中和，纯净化模式）
 */
export function neutralize(text: string, isKnown?: (id: string) => boolean): string {
  const occurrences = findHandles(text);
  if (occurrences.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const occurrence of occurrences) {
    if (isKnown && isKnown(occurrence.id)) continue;
    out += text.slice(cursor, occurrence.start) + PII_NEUTRALIZED;
    cursor = occurrence.end;
  }
  if (cursor === 0) return text;
  return out + text.slice(cursor);
}

/** 句柄解析失败的分类（0.52 起是三档，见 `types.ts` 的 `PiiHandleFailureReason`）。 */
export type PiiHandleFailure = PiiHandleFailureReason;

/**
 * 三档共用的「下一步」文案。**只讲状态，不含任何真值**。
 *
 * 宗旨（用户 0.52 裁定）：一句「句柄失效」会让人以为能修，静默外发则是事故 ——
 * 所以逐档给出**可执行的**下一步，并明确 `retryable = false`：同一句柄重试必然再失败。
 */
const PII_FAILURE_NEXT_STEP: Record<PiiHandleFailureReason, string> = {
  unknown_handle:
    'This handle was never issued for the current session, so the call was rejected before it ran. ' +
    'Do not retry with the same placeholder and do not forward it to external systems. ' +
    'Next: call the tool with the real value you already have, or re-read the source to obtain a fresh handle.',
  expired_handle:
    'This handle expired (PII handles live 10 minutes per session and are dropped when the run ends). ' +
    'The call was rejected before it ran, nothing was forwarded. ' +
    'Next: re-run the tool that produced the data to get a fresh handle, or ask the user to provide the value again.',
  invalidated_handle:
    'PII handles were invalidated in bulk because the in-memory broker restarted; old placeholders from the ' +
    'previous process can never be resolved again. The call was rejected before it ran, nothing was forwarded. ' +
    'Next: re-fetch the source data to obtain new handles; if a raw value must be surfaced, request pii.reveal ' +
    'again after the re-fetch (it needs human approval).',
};

/** 句柄解不开时抛的错（工具参数边界必须**报错**，不许原样外发）。 */
export class PiiHandleUnresolvedError extends Error {
  /** 涉及到的占位符（不含真值） */
  readonly handles: string[];
  readonly reason: PiiHandleFailureReason;
  /** 稳定错误码：`pii_unknown_handle` / `pii_expired_handle` / `pii_invalidated_handle` */
  readonly code: string;
  /** 结构化细节（`toErrorEnvelope` 会带到 `details` 里），**不含真值** */
  readonly details: Record<string, unknown>;

  constructor(handles: string[], reason: PiiHandleFailureReason, sessionId?: string) {
    super(
      `PII handle cannot be resolved (${reason}): ${handles.join(', ')}. ` +
        PII_FAILURE_NEXT_STEP[reason],
    );
    this.name = 'PiiHandleUnresolvedError';
    this.handles = handles;
    this.reason = reason;
    this.code = PII_HANDLE_ERROR_CODES[reason];
    this.details = {
      reason,
      handle_count: handles.length,
      handles,
      ...(sessionId !== undefined ? { session: sessionId } : {}),
    };
  }
}

/**
 * 占位符替换：把文本里的句柄换成真值。
 *
 * `resolve(id)` 返回真值；返回 `undefined` ⇒ 视为不可解析并**抛错**
 * （工具参数边界就要这个行为：宁可失败，也不能把 `«pii:…»` 原样发给外部）。
 * 不知道具体是哪档时用 `reason` 指定默认档（默认 `unknown_handle`）。
 *
 * 纯函数：不查任何全局表，解析逻辑全部来自入参。
 */
export function substitute(
  text: string,
  resolve: (id: string) => string | undefined,
  reason: PiiHandleFailureReason = 'unknown_handle',
): string {
  const occurrences = findHandles(text);
  if (occurrences.length === 0) return text;
  const resolved: Array<{ occurrence: PiiHandleOccurrence; value: string }> = [];
  const missing: string[] = [];
  for (const occurrence of occurrences) {
    const value = resolve(occurrence.id);
    if (typeof value === 'string') resolved.push({ occurrence, value });
    else missing.push(occurrence.handle);
  }
  if (missing.length > 0) throw new PiiHandleUnresolvedError(missing, reason);
  let out = '';
  let cursor = 0;
  for (const { occurrence, value } of resolved) {
    out += text.slice(cursor, occurrence.start) + value;
    cursor = occurrence.end;
  }
  return out + text.slice(cursor);
}

/** 句柄 id 是否是合法形状（8 位 base32）。 */
export function isHandleId(value: string): boolean {
  return value.length === PII_HANDLE_ID_LENGTH && /^[A-Z2-7]+$/.test(value);
}

/** 由 id 拼占位符（re-export，省得调用方到处 import types）。 */
export { piiHandleOf, piiHandlePattern, piiMaskOf, PII_NEUTRALIZED };
export type { PiiCategory, PiiDetectOptions, PiiHandleFailureReason, PiiHit };
