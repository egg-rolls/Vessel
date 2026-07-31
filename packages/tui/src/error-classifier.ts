/**
 * 错误分类器
 *
 * 将 run() 抛出的错误分类（网络 / API / 限额 / 鉴权 / 其他）。
 * 纯函数，可单测。
 * 从 repl.ts 中提取，保持向后兼容。
 */

export type ErrorCategory = 'network' | 'auth' | 'quota' | 'api' | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  hint?: string;
}

/**
 * 把 run() 抛出的错误分类（网络 / API / 限额 / 鉴权 / 其他）。
 * 纯函数，可单测。
 */
export function classifyError(error: unknown): ClassifiedError {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (/usage limits exceeded|termination policy|max iterations|max_runtime/.test(lower)) {
    return {
      category: 'quota',
      message: msg,
      hint: '用量/限额触发，调大 limits 或 /session new 开新会话。',
    };
  }
  if (/429|rate limit|rate_limit|quota/.test(lower)) {
    return { category: 'quota', message: msg, hint: '请求过频或额度不足，稍后重试。' };
  }
  if (/401|unauthorized|invalid api key|invalid_api_key|authentication/.test(lower)) {
    return { category: 'auth', message: msg, hint: 'API Key 无效，运行 /setup 重新配置。' };
  }
  if (
    /fetch failed|econnrefused|enotfound|etimedout|connect_timeout|network|socket hang up|aborted/.test(
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
