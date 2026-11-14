/**
 * `web_fetch` 的数据契约（M1：一级 = 纯 HTTP + 本地抽取）。
 *
 * 错误码命名对齐研究结论 `docs/dev/research/web-search-fetch.md` §5.5 的表，
 * 便于后续接二级渲染时沿用同一枚举。
 */

export type WebFetchErrorCode =
  | 'invalid_input'
  | 'blocked_url'
  | 'blocked_by_policy'
  | 'blocked_by_robots'
  | 'dns_failed'
  | 'connect_failed'
  | 'tls_error'
  | 'timeout'
  | 'too_many_redirects'
  | 'too_large'
  | 'unsupported_content_type'
  | 'http_error'
  | 'extract_empty'
  | 'renderer_unavailable';

export interface WebFetchErrorExtra {
  /** 触发失败的那一跳的 URL（重定向链上是对应的下一跳） */
  url?: string;
  /** `http_error` 时带上真实状态码 */
  status?: number;
}

/**
 * 工具内部一律用异常表达失败，由 `webFetch()` 统一转成 `ok: false` 结构。
 * 用 `code` 而不是 message 字符串做分支，避免上层去匹配人类可读文本。
 */
export class WebFetchError extends Error {
  readonly code: WebFetchErrorCode;
  readonly url: string | undefined;
  readonly status: number | undefined;

  constructor(code: WebFetchErrorCode, message: string, extra: WebFetchErrorExtra = {}) {
    super(message);
    this.name = 'WebFetchError';
    this.code = code;
    this.url = extra.url;
    this.status = extra.status;
  }
}

/** 成功结果：字段名即契约（`url`/`fetched_at`/`content_type`/`bytes`/`text`/`truncated`/`links`/`status`）。 */
export interface WebFetchResult {
  ok: true;
  /** 最终 URL（跟随重定向之后），不是用户给的原始 URL */
  url: string;
  /** 用户最初请求的 URL，便于模型对照 */
  requested_url: string;
  status: number;
  content_type: string;
  /** 实际读到的响应体字节数（截断前） */
  bytes: number;
  /** ISO8601（UTC） */
  fetched_at: string;
  title: string;
  /** 抽取后的纯文本，已按 `max_chars` 截断 */
  text: string;
  truncated: boolean;
  /** 与最终 URL 同源的前 N 条链接（去重、已规范化） */
  links: string[];
  /** 跟过的重定向 URL 链（按发生顺序） */
  redirects: string[];
}

export interface WebFetchFailure {
  ok: false;
  code: WebFetchErrorCode;
  message: string;
  url: string;
  requested_url: string;
  status?: number;
}

export type WebFetchOutcome = WebFetchResult | WebFetchFailure;
