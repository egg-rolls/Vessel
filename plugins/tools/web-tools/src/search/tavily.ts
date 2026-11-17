/**
 * Tavily 搜索后端（`POST https://api.tavily.com/search`）。
 *
 * 只做接口要求的三件事（renderQuery / call / parseEntries + normalize）：
 * 预算、缓存键（带 `provider_id` + `provider_version`）、三道闸、熔断、限流、
 * 指标行全在 `search/index.ts` 的共用层；重试/退避/错误映射在 `createJsonHttp`。
 *
 * 语义如实（不编造上游没给的东西）：
 * - `results[].content` 是**摘要**（Tavily 自己的口径），`raw_content` 才是正文
 *   ⇒ `need_content` 映射到 `include_raw_content`，`content` 只从 `raw_content` 取，
 *   绝不把摘要再复制一遍当正文；
 * - `site:` ⇒ Tavily 的 `include_domains`（它不认 `site:` 语法）；
 * - `lang` / `after` / `before`：Tavily 的 search 端点没有对应参数 ⇒ **不做过滤**，
 *   工具描述里如实写明（不假装过滤过）；
 * - `score` 是相关性分数，**不是** `authority` ⇒ 不映射，条目里就没有 authority 字段；
 * - 单次 `max_results` 上限 20 ⇒ `maxCount` 声明出去，超出由这里夹紧。
 */

import { createJsonHttp } from '../provider-http';
import {
  asRecord,
  firstString,
  type ProviderHttp,
  type ProviderHttpOptions,
  type ProviderHttpResponse,
  type RawSearchEntry,
  type SearchHit,
  type SearchProvider,
  type SearchQuery,
} from './provider';

export const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
/** 只存环境变量**名**（值是用户的，永不进配置/日志/缓存） */
export const TAVILY_DEFAULT_KEY_ENV = 'VESSEL_TAVILY_API_KEY';
/** 上游硬上限：`max_results` 只接受 0–20 */
export const TAVILY_MAX_RESULTS = 20;

/**
 * Tavily 不认 `site:` / `lang:` / `after:` / `before:` 这套语法，
 * 结构化条件走 body（`include_domains`），查询串原样传。
 */
export function renderTavilyQuery(query: SearchQuery): string {
  return query.query;
}

function entryArray(value: unknown): RawSearchEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => asRecord(item));
}

export const tavilySearchProvider: SearchProvider = {
  id: 'tavily',
  // 归一逻辑版本：一改就动它，旧缓存自动失效（键里带 provider_version）
  version: '1',
  billed: true,
  requiresKey: true,
  keyEnv: TAVILY_DEFAULT_KEY_ENV,
  maxCount: TAVILY_MAX_RESULTS,

  renderQuery: renderTavilyQuery,

  // 固定 host + Bearer（Tavily 官方支持 Authorization: Bearer）；重试/映射仍走共用那份
  createHttp(options: ProviderHttpOptions): ProviderHttp {
    return createJsonHttp({
      config: options.config,
      keyKind: 'search',
      keyEnvName: options.keyEnvName,
      endpoint: TAVILY_SEARCH_ENDPOINT,
      authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.deps !== undefined ? { deps: options.deps } : {}),
      backoff: options.backoff,
    });
  },

  async call(
    http: ProviderHttp,
    query: SearchQuery,
    renderedQuery: string,
  ): Promise<ProviderHttpResponse> {
    const body: Record<string, unknown> = {
      query: renderedQuery,
      // count 已由共用层按 maxCount（=20）夹紧；这里不再重复夹
      max_results: query.count,
      // 正文开关就是它；false 就明确不发，省的是我们的输出预算
      include_raw_content: query.needContent,
      search_depth: 'basic',
    };
    if (query.site !== undefined && query.site !== '') body.include_domains = [query.site];
    return http.postJson({
      path: '/search',
      body,
      hint: '检查 query 是否为空、max_results 是否 ≤20、include_domains 是否为主机名形态',
    });
  },

  parseEntries(payload: unknown): RawSearchEntry[] {
    const root = asRecord(payload);
    const data = asRecord(root.data);
    // 形状防御只在这一处：上层拿到的永远是同一个条目数组
    for (const candidate of [root.results, data.results, root.items, data.items]) {
      const entries = entryArray(candidate);
      if (entries !== undefined) return entries;
    }
    return [];
  },

  normalize(entry: RawSearchEntry): SearchHit | null {
    const rawUrl = firstString(entry, ['url', 'link']);
    if (rawUrl === undefined) return null;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    // content 是 Tavily 的「摘要」口径；raw_content 才是正文（need_content=false 时没有）
    const summary = firstString(entry, ['content', 'snippet', 'description']) ?? '';
    const content = firstString(entry, ['raw_content', 'text']);
    const date = firstString(entry, ['published_date', 'date', 'published_at']);
    const title = firstString(entry, ['title', 'name']) ?? '';

    return {
      title,
      url: parsed.href,
      summary,
      // authority 不出现：Tavily 没有权威度字段（score 是相关性，冒充它就是说谎）
      ...(content !== undefined ? { content } : {}),
      ...(date !== undefined ? { date } : {}),
    };
  },
};
