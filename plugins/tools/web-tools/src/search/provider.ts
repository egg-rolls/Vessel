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
  body: unknown;
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

export interface SearchProvider {
  /** 稳定 id（进日志与缓存键） */
  readonly id: string;
  /** 语义版本（进缓存键：归一逻辑一改，旧缓存自动失效） */
  readonly version: string;
  /** 这台后端是否计费（决定是否走三道成本闸） */
  readonly billed: boolean;
  /** 是否需要 key（true ⇒ 缺 key 时本地拒，不发请求） */
  readonly requiresKey: boolean;
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
  /** 原始条目 → `SearchHit`；返回 null 表示这条不可用（例如没有 url） */
  normalize(entry: RawSearchEntry): SearchHit | null;
}

const providers = new Map<string, SearchProvider>();

/** 注册（或覆盖）一个搜索后端。幂等：同名后注册者胜。 */
export function registerSearchProvider(provider: SearchProvider): void {
  providers.set(provider.id, provider);
}

export function getSearchProvider(id: string): SearchProvider | undefined {
  return providers.get(id);
}

export function listSearchProviders(): string[] {
  return [...providers.keys()].sort();
}

/** 唯一在册的后端；新增后端时这里不动（配置里写它的 id 即可） */
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
