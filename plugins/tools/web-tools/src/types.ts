/**
 * web 工具的数据契约（0.56：`web_fetch` 双后端 + `web_search`）。
 *
 * 错误码命名对齐研究结论 `docs/dev/research/web-search-fetch.md` §5.5 的表与
 * 设计 `docs/dev/design/0.56-web-tools.md` §2.5：
 * - 既有 14 个码**不删不改名**（上层分支不用改）；
 * - 0.56 只**新增** provider_* 系列 + `max_uses_exceeded` / `circuit_open`，
 *   搜索与 deepseek 抓取共用同一套词汇表（避免两套错误语义）；
 * - 特意**没有** `no_results`：空结果是 `ok: true` + `results: 0`，
 *   做成 error 会让模型对同一 query 重试三次（设计 §2.2 第 6 条）。
 */

/** M1 起的 14 个既有错误码（顺序即历史顺序，勿动） */
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

/** 0.56 新增的 8 个码（只增不改；search 与 deepseek 后端共用） */
export type WebToolExtraErrorCode =
  | 'provider_auth_failed'
  | 'provider_quota_exhausted'
  | 'provider_bad_request'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'endpoint_not_found'
  | 'max_uses_exceeded'
  | 'circuit_open';

export type WebToolErrorCode = WebFetchErrorCode | WebToolExtraErrorCode;

/** 抓取后端 id（后端实现在 `fetch/provider.ts` 注册；加后端不改工具层） */
export type FetchBackendId = 'local' | 'deepseek';

/**
 * robots 声明（设计 §6.4）。
 *
 * 这是**输出字段**而不是注释：模型会据此决定「这个站的其它页能不能抓」，
 * 所以 deepseek 后端只能写 `unknown`，绝不许写 respected 冒充。
 */
export type RobotsDeclaration = 'respected' | 'ignored (config)' | 'unknown';

export interface WebFetchErrorExtra {
  /** 触发失败的那一跳的 URL（重定向链上是对应的下一跳） */
  url?: string;
  /** `http_error` 时带上真实状态码 */
  status?: number;
}

/**
 * 工具内部一律用异常表达失败，由工具层统一转成 `ok: false` 结构。
 * 用 `code` 而不是 message 字符串做分支，避免上层去匹配人类可读文本。
 */
export class WebFetchError extends Error {
  readonly code: WebToolErrorCode;
  readonly url: string | undefined;
  readonly status: number | undefined;

  constructor(code: WebToolErrorCode, message: string, extra: WebFetchErrorExtra = {}) {
    super(message);
    this.name = 'WebFetchError';
    this.code = code;
    this.url = extra.url;
    this.status = extra.status;
  }
}

/**
 * 成功结果：字段名即契约。
 *
 * 0.56 起新增的 `backend` / `*_source` / `redirects_known` / `robots` 是**如实标注**：
 * 两个后端拿不到同一个东西时，用「缺就说缺」的字段，而不是 `0` / `[]` / `200` 填空。
 * 设计 §2.4 与 §9.1：「字段多两个不丢人，字段说谎才丢人」。
 */
export interface WebFetchResult {
  ok: true;
  /** 最终 URL：local 是跟随重定向后的；deepseek 只能是我们请求的那个（服务端跳链不可见） */
  url: string;
  /** 用户最初请求的 URL，便于模型对照 */
  requested_url: string;
  /** local = 目标站点状态码；deepseek = 固定 200（我们只拿到成功/失败），见 `status_source` */
  status: number;
  content_type: string;
  /** 字节数，语义见 `bytes_source` */
  bytes: number;
  /** ISO8601（UTC） */
  fetched_at: string;
  title: string;
  /** 正文，已按 `max_chars` 与 token 预算截断（两个后端用同一个截断函数） */
  text: string;
  truncated: boolean;
  /** 与最终 URL 同源的链接；语义见 `links_source` */
  links: string[];
  /** 跟过的重定向 URL 链；语义见 `redirects_known` */
  redirects: string[];
  /** 0.56：这次有没有花钱 / 内容有没有出网，让模型与用户都能看见 */
  backend: FetchBackendId;
  /** 0.56：`target` = 目标站点真实状态码；`api` = 只是上游 API 的成功状态 */
  status_source: 'target' | 'api';
  /** 0.56：`text` = 本地抽取纯文本；`markdown` = 服务端返回的 Markdown */
  format: 'text' | 'markdown';
  /** 0.56：`http-body` = 实际读到的响应体字节；`extracted-text` = 正文的 UTF-8 字节 */
  bytes_source: 'http-body' | 'extracted-text';
  /** 0.56：`backend` = 后端真的给了链接；`none` = 后端不返回链接（不许读成「这页没有链接」） */
  links_source: 'backend' | 'none';
  /** 0.56：false = 后端看不到跳链（deepseek），此时 `redirects: []` 不代表没跳 */
  redirects_known: boolean;
  /** 0.56：robots 的真实状态（见 `RobotsDeclaration`） */
  robots: RobotsDeclaration;
}

export interface WebFetchFailure {
  ok: false;
  code: WebToolErrorCode;
  message: string;
  url: string;
  requested_url: string;
  status?: number;
  /** 0.56：配额类失败带上日计数，便于人判断「是不是今天到顶了」 */
  daily_used?: number;
  daily_limit?: number;
}

export type WebFetchOutcome = WebFetchResult | WebFetchFailure;
