/**
 * 单一错误摘要（q-error-e1，设计 §3.2 / D2）。
 *
 * 收敛各包重复的 `errorText` 拍扁函数：沿原生 `Error.cause` 展开错误链，
 * 保 code + message + operation。拍扁文本只用于**展示**，不再作为跨层**数据**；
 * 跨层边界转换必须先读结构化字段（code/category/details/cause），读不到才允许
 * 文本兜底且必须标 `classified_by: 'message'`。
 *
 * 纯函数：不发布事件、不写文件、不生成 id（error_id 出生点 stamped 属 E2）。
 *
 * @module @vessel-agent/core/runtime
 */

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
  const summary: ErrorSummary = { message: messageOf(error), chain };
  const code = codeOf(error);
  if (code !== undefined) summary.code = code;
  return summary;
}
