/**
 * 单一错误摘要（q-error-e1，设计 §3.2 / D2）。
 *
 * 收敛各包重复的 `errorText` 拍扁函数：沿原生 `Error.cause` 展开错误链，
 * 保 code + message + operation。拍扁文本只用于**展示**，不再作为跨层**数据**；
 * 跨层边界转换必须先读结构化字段（code/category/details/cause），读不到才允许
 * 文本兜底且必须标 `classified_by: 'message'`。
 *
 * 不发布事件、不写文件。E2（§3.3）起承担 error_id 兜底生产：已 stamped 的错误
 * 沿用同一 id；普通 Error 首次摘要时生成并以**不可枚举属性** stamp 回错误对象
 * （一事故一 id，不改 JSON 序列化面，裁定 G）。
 *
 * @module @vessel-agent/core/runtime
 */

import { randomBytes } from 'node:crypto';

/** cause 链深度上限（防环 + 防超长链撑爆日志/事件） */
const MAX_CAUSE_DEPTH = 8;
/** 每层 message 截断（errors-command cap 先例） */
const MAX_MESSAGE_LENGTH = 500;

/** 链上一环的摘要 */
export interface ErrorSummaryLink {
  code?: string;
  message: string;
  operation?: string;
}

/** errorSummary 输出：顶层 code/message + cause 链摘要（不含顶层） */
export interface ErrorSummary {
  code?: string;
  message: string;
  chain: ErrorSummaryLink[];
  /** 事故短 id（E2 §3.3）：stamped 沿用；普通 Error 兜底生成 */
  error_id: string;
  /** id 来源：'stamped'=出生点已盖；'summary'=本函数兜底生成（裁定⑤） */
  id_origin: 'stamped' | 'summary';
}

/** base32 字母表（RFC 4648 小写，无易混字符歧义需求，8 字符 = 40 bit 随机） */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * 出生点事故短 id（E2 §3.3）：8 字符 base32，crypto 随机。
 * 包装层沿用同一 id（读 errorId），只有出生点与兜底摘要生成新 id。
 *
 * RFC 4648 位打包：randomBytes(5) = 40 bit → 恰 8 个 5-bit 组，无 padding。
 * （canary 微修：原逐 byte % 32 只取每字节低 5 bit，恒 5 字符 25 bit，熵减半。）
 */
export function newErrorId(): string {
  const bytes = randomBytes(5);
  let id = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      id += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return id;
}

/**
 * 取 stack 首个 `at …` 帧（单行 file:line，E2 §3.3 的 at 字段）。
 * skip 用于跳过构造器/助手自身帧（出生点 = 调用方帧）；stack 全文不上 wire。
 */
export function firstStackFrame(stack: string | undefined, skip?: RegExp[]): string | undefined {
  if (typeof stack !== 'string') return undefined;
  for (const line of stack.split('\n')) {
    const frame = line.trim();
    if (!frame.startsWith('at ')) continue;
    if (skip !== undefined && skip.some((pattern) => pattern.test(frame))) continue;
    return frame;
  }
  return undefined;
}

/**
 * 以不可枚举属性 stamp errorId（裁定 G）：JSON.stringify / 展开均不见，
 * 跨层 `.errorId` 读取正常；已有 id 不覆盖（一事故一 id）。
 */
export function stampErrorId(error: unknown, id: string): void {
  if (typeof error !== 'object' || error === null) return;
  const existing = (error as { errorId?: unknown }).errorId;
  if (typeof existing === 'string' && existing.length > 0) return;
  Object.defineProperty(error, 'errorId', {
    value: id,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

function errorIdOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const id = (error as { errorId?: unknown }).errorId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function truncate(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) : message;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return truncate(error.message);
  if (typeof error === 'string') return truncate(error);
  return truncate(String(error));
}

/** 只接受 snake_case 稳定码（与 envelope 同纪律，避免泄漏平台大小写码如 ENOENT） */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]*$/.test(code) ? code : undefined;
}

function operationOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const operation = (error as Record<string, unknown>).operation;
  return typeof operation === 'string' && operation.length > 0 ? operation : undefined;
}

function causeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<string, unknown>).cause;
}

/**
 * 把任意错误归一成结构化摘要。
 *
 * - 顶层 code/message 读错误自身；chain 沿原生 cause 展开（深度上限 8，Set 防环）。
 * - 每层只取 code + message + operation（脱敏红线：不带 details/stack 全文）。
 * - error_id：已 stamped 沿用（id_origin:'stamped'）；普通 Error 兜底生成并
 *   不可枚举 stamp 回错误对象（id_origin:'summary'，一事故一 id）；非对象错误
 *   无法 stamp，每次生成新 id。
 */
export function errorSummary(error: unknown): ErrorSummary {
  const chain: ErrorSummaryLink[] = [];
  const seen = new Set<unknown>();
  let current = error;
  let depth = 0;
  while (depth < MAX_CAUSE_DEPTH) {
    if (typeof current === 'object' && current !== null) {
      if (seen.has(current)) break;
      seen.add(current);
    }
    const cause = causeOf(current);
    if (cause === undefined || cause === null) break;
    const link: ErrorSummaryLink = { message: messageOf(cause) };
    const code = codeOf(cause);
    if (code !== undefined) link.code = code;
    const operation = operationOf(cause);
    if (operation !== undefined) link.operation = operation;
    chain.push(link);
    current = cause;
    depth += 1;
  }
  const stamped = errorIdOf(error);
  const errorId = stamped ?? newErrorId();
  if (stamped === undefined) stampErrorId(error, errorId);
  const summary: ErrorSummary = {
    message: messageOf(error),
    chain,
    error_id: errorId,
    id_origin: stamped === undefined ? 'summary' : 'stamped',
  };
  const code = codeOf(error);
  if (code !== undefined) summary.code = code;
  return summary;
}
