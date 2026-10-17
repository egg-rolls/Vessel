/**
 * 错误分类器
 *
 * 将 run() 抛出的错误分类（取消 / 权限 / 超时 / 网络 / API / 限额 / 鉴权 / 其他）。
 * 纯函数，可单测。
 */

export type ErrorCategory =
  | 'cancelled'
  | 'permission'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'quota'
  | 'api'
  | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  hint?: string;
}

/**
 * 把 run() 抛出的错误分类。纯函数，可单测。
 *
 * 顺序很重要：
 * - 先判 timeout——`The operation was aborted due to timeout` 同时含 abort，不能被当成取消；
 * - 再判权限拒绝、取消；
 * - 其余沿用原有网络 / 限额 / 鉴权 / API 规则。
 */
export function classifyError(error: unknown): ClassifiedError {
  const msg = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const lower = msg.toLowerCase();

  // 超时（含 AbortSignal.timeout 的 TimeoutError）
  if (
    name === 'TimeoutError' ||
    /timed out|timeout|etimedout|connect_timeout|deadline exceeded/.test(lower)
  ) {
    return { category: 'timeout', message: msg, hint: '请求超时；检查网络或稍后重试。' };
  }

  // 权限拒绝（用户或策略）
  if (/denied by (user|permission policy)|execution denied|permission denied/.test(lower)) {
    return {
      category: 'permission',
      message: msg,
      hint: '权限确认被拒绝；模型会收到拒绝结果并继续。',
    };
  }

  // 取消（Esc / Ctrl+C / AbortError）
  if (name === 'AbortError' || /abort|cancel/.test(lower)) {
    return { category: 'cancelled', message: msg };
  }

  if (/usage limits exceeded|termination policy|max iterations|max_runtime/.test(lower)) {
    return {
      category: 'quota',
      message: msg,
      hint: '用量/限额触发，调大 limits 或 /new 开新会话。',
    };
  }
  if (/429|rate limit|rate_limit|quota/.test(lower)) {
    return { category: 'quota', message: msg, hint: '请求过频或额度不足，稍后重试。' };
  }
  if (/401|unauthorized|invalid api key|invalid_api_key|authentication/.test(lower)) {
    return { category: 'auth', message: msg, hint: 'API Key 无效，运行 /setup 重新配置。' };
  }
  if (
    /fetch failed|econnrefused|econnreset|enotfound|etimedout|connect_timeout|network|socket hang up|dns/.test(
      lower,
    )
  ) {
    return { category: 'network', message: msg, hint: '网络不可达，检查 BaseURL/网络后重试。' };
  }
  if (/api error|http \d{3}|bad request|400|403|404|500|502|503/.test(lower)) {
    return { category: 'api', message: msg, hint: 'Provider 返回错误，检查模型名/参数。' };
  }
  return { category: 'unknown', message: msg };
}

/**
 * 格式化为单条可读文本（TTY / simple mode 共用）。
 * 取消不是错误，显示为一条状态；其余带分类标签与 hint。
 */
export function formatClassifiedError(classified: ClassifiedError): string {
  if (classified.category === 'cancelled') return '⏹ Cancelled.';
  const head = `✗ [${classified.category}] ${classified.message}`;
  return classified.hint ? `${head}\n  ${classified.hint}` : head;
}
