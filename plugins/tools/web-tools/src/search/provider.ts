/**
 * 搜索后端的**接口 + 注册点**（宪法第十三条：可复用能力做成插件包内的扩展点）。
 *
 * 分工（设计 §3.2）——provider 只做三件事：`renderQuery` / `requestSpec` / `normalize`；
 * **共用层独占**：预算、缓存键与 TTL、限流、熔断、重试、untrusted 包装、`cached` 标记、指标。
 *
 * ⇒ 以后加 Bing / Tavily / SearxNG（P2）**不改工具层、不改契约、不改预算与缓存语义**：
 * 在插件包里 `registerSearchProvider(...)` 一个新实现即可（搜索键里带
 * `provider_id` + `provider_version`，两个后端的结果不会串味）。
 */

import type { WebToolsConfig } from '../config';

/** 搜索输出的预算档（纯本地旋钮） */
export type SearchDetail = 'brief' | 'full';

/** 校验归一后的查询（不含 `site:` 等语法——那些由 provider 按自己的语法渲染） */
export interface SearchQuery {
  query: string;
  count: number;
  needContent: boolean;
  detail: SearchDetail;
  site?: string;
  lang?: string;
  after?: string;
  before?: string;
}

/** 归一后的一条结果（缓存存的就是它，**不是**渲染后的字符串） */
export interface SearchHit {
  title: string;
  url: string;
  summary: string;
  content?: string;
  date?: string;
  authority?: string;
}

/** 上游原始条目（形状随 provider 变；`asRecord` 之后取值一律防御） */
export type RawSearchEntry = Record<string, unknown>;

export interface ProviderHttpRequest {
  path: string;
  /** 请求体（GET 或缺省时可省） */
  body?: unknown;
  /** 请求方法（缺省 POST）；自定义后端可能是 GET */
  method?: 'POST' | 'GET';
  /** 追加到 URL 的查询参数（`query_in: query` 的后端与 query 风格的 key 用它） */
  query?: Record<string, string>;
  /** 额外的请求头（声明式后端的 `request.headers`） */
  headers?: Record<string, string>;
  /** 400 时给模型看的补充提示（各家错法不同） */
  hint?: string;
}

export interface ProviderHttpResponse {
  json: unknown;
  status: number;
  attempts: number;
  upstreamMs: number;
}

/**
 * provider 拿到的唯一网络端口：**带鉴权、重试、错误映射、整体 deadline** 的 POST JSON。
 *
 * provider 只描述线格式（路径 + body + 怎么归一），重试/退避/错误码/限流全在共用层。
 * 加一个 auth 风格不同的后端时，在插件包里再提供一个 `ProviderHttp` 实现即可。
 */
export interface ProviderHttp {
  postJson(request: ProviderHttpRequest): Promise<ProviderHttpResponse>;
}

/** 传输层注入点（替身 fetch / 时钟 / 睡眠 / env）——与 `DeepSeekDeps` 同形 */
export interface ProviderTransportDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
}

/** `createHttp()` 拿到的参数：**已解析好的** key 环境变量名与共用的退避函数 */
export interface ProviderHttpOptions {
  config: WebToolsConfig;
  /** 这次调用读哪个环境变量（已按 配置 > `provider.keyEnv` > `key_env` 解析） */
  keyEnvName: string;
  signal?: AbortSignal;
  deps?: ProviderTransportDeps;
  /** 退避毫秒（带抖动）；由 `CostController` 提供，重试策略本身仍在共用层 */
  backoff: (attempt: number, retryAfterMs?: number) => number;
}

export interface SearchProvider {
  /** 稳定 id（进日志与缓存键） */
  readonly id: string;
  /** 语义版本（进缓存键：归一逻辑一改，旧缓存自动失效） */
  readonly version: string;
  /** 这台后端是否计费（决定是否走三道成本闸） */
  readonly billed: boolean;
  /** 是否需要 key（true ⇒ 缺 key 时本地拒，不发请求） */
  readonly requiresKey: boolean;
  /**
   * 缺 key 时**缺省**读哪个环境变量名（只存名字）。
   *
   * 优先级：配置 `search_key_env` > 这里的 `keyEnv` > 配置 `key_env`。
   * 不写 ⇒ 用配置口径（历史上只有 deepseek 一个后端时的行为）。
   */
  readonly keyEnv?: string;
  /**
   * 上游单次条数上限（Tavily=20、Serper num≤100）。
   *
   * 由**共用层**在发请求前把模型请求的 `count` 夹到它（见 `search/index.ts` ⑥），
   * 缓存键与预算口径仍按模型请求的 `count`；信封里的 `results: N` 报的是
   * **上游真实条数**，所以「你要 50、这家只肯给 20」是看得见的。
   */
  readonly maxCount?: number;
  /**
   * 传输层：**鉴权风格与本家不同**的后端在这里自带 `ProviderHttp` 实现。
   *
   * 不提供 ⇒ 复用 `deepseek-client.ts` 的 Bearer + `config.base_url` 实现
   * （为什么默认是它：deepseek 是第一个后端，不是「大家都用 Bearer」）。
   */
  createHttp?(options: ProviderHttpOptions): ProviderHttp;
  /** 结构化过滤条件 → 该后端认的查询串（例如 deepseek 用 `site:` / `lang:`） */
  renderQuery(query: SearchQuery): string;
  /** 真正发请求：provider 只管线格式，重试/错误映射由 `http` 负责 */
  call(
    http: ProviderHttp,
    query: SearchQuery,
    renderedQuery: string,
  ): Promise<ProviderHttpResponse>;
  /** 从响应 JSON 里取条目数组（形状变化只影响这一处） */
  parseEntries(payload: unknown): RawSearchEntry[];

  /**
   * 这个后端**表达不了**的过滤条件（`site` / `lang` / `after` / `before`）。
   *
   * 只回答「用户给了、但我们没法应用」的那些；不实现 = 全都支持。
   * 共用层把它渲染成信封里的 `filters_ignored: site` —— 纯省略是静默变宽，
   * 硬报错又太脆（模型要多一轮往返才知道），所以「照常返回 + 显式披露」。
   */
  unsupportedFilters?(query: SearchQuery): string[];

  /** 原始条目 → `SearchHit`；返回 null 表示这条不可用（例如没有 url） */
  normalize(entry: RawSearchEntry): SearchHit | null;
}

const providers = new Map<string, SearchProvider>();

/** 注册（或覆盖）一个搜索后端。幂等：同名后注册者胜（Map 的插入顺序即注册顺序）。 */
export function registerSearchProvider(provider: SearchProvider): void {
  providers.set(provider.id, provider);
}

export function getSearchProvider(id: string): SearchProvider | undefined {
  return providers.get(id);
}

/**
 * 注销（**只给配置驱动的自定义后端用**：改了 `custom_search` 之后旧的那家要退场，
 * 否则「上一份配置注册的后端」会在 `auto` 里继续参与选择）。
 */
export function unregisterSearchProvider(id: string): void {
  providers.delete(id);
}

/** 在册 id（**字典序**，只用于报错/展示；选择优先序见 `listSearchProviderEntries`） */
export function listSearchProviders(): string[] {
  return [...providers.keys()].sort();
}

/** 在册后端本体，**保持注册顺序**（`search_provider=auto` 的优先序就是它） */
export function listSearchProviderEntries(): SearchProvider[] {
  return [...providers.values()];
}

/**
 * 历史缺省后端；**选择已经不再只看它**：`search/index.ts` 按
 * 配置 `search_provider` → `auto` 注册顺序选，这里只作为「一个都没注册」时的
 * 报错锚点与既有导出点（真机脚本/上层装配仍在用）。
 */
export const DEFAULT_SEARCH_PROVIDER_ID = 'deepseek';

/** 防御式取对象（上游 JSON 的形状不在我们控制内） */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 取第一个非空字符串字段（用于 title/summary/url 这类必填性不明的字段） */
export function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}
