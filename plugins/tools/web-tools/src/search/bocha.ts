/**
 * Bocha（博查）搜索后端：`POST https://api.bocha.cn/v1/web-search`。
 *
 * 只做接口要求的三件事（renderQuery / call / parseEntries + normalize）：预算、缓存键
 * （带 `provider_id` + `provider_version`）、三道闸、熔断、限流、指标行全在 `search/index.ts`
 * 的共用层；重试/退避/错误映射在 `createJsonHttp`（与 Tavily / Serper / DeepSeek 同一份）。
 *
 * ## 响应形状 → 我们的字段（**没有的就不出现，不编**）
 *
 * Bocha 返回是 Bing 系形状：`data.webPages.value[]`，条目字段与我们的对应关系：
 *
 * | Bocha | 我们 | 说明 |
 * | --- | --- | --- |
 * | `name` | `title` | 标题 |
 * | `url` | `url` | 只接受 http/https |
 * | `snippet` | `summary` | 短摘要（Bocha 自己的 snippet 口径） |
 * | `summary` | `content` | 长摘要，**只有 `summary: true` 才返回** ⇒ 映射自 `need_content` |
 * | `datePublished` | `date` | ISO 时间串，原样透传 |
 * | `siteName` / `siteIcon` / `image` | **不映射** | 我们的 `SearchHit` 没有对应字段（网站名不是权威度） |
 * | （无） | `authority` | Bocha 不给权威度 ⇒ 条目里**不出现**这个字段 |
 *
 * ## 参数映射
 *
 * - `count` ← 我们的 `count`（上游上限 50 ⇒ `maxCount`）；
 * - `summary` ← `need_content`（Bocha 的长摘要开关，**不是**「是否返回结果」）；
 * - `freshness` ← `after`/`before`：**两端都给了**才发 `YYYY-MM-DD..YYYY-MM-DD`（Bocha 的日期区间语法）；
 *   只给一端时**不传**（它的枚举只有 noLimit/oneDay/oneWeek/oneMonth/oneYear，
 *   映射过去就会把「某天之后」悄悄放宽成「某周之内」——宁可不传，并在工具描述里写明）；
 * - `site` → **不传**：Bocha 没有域名过滤参数，`site:` 也不是它的文档语法 ⇒ 如实不传（工具描述写明）。
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

export const BOCHA_SEARCH_ENDPOINT = 'https://api.bocha.cn/v1/web-search';
/** 只存环境变量**名**（值是用户的，永不进配置/日志/缓存） */
export const BOCHA_DEFAULT_KEY_ENV = 'BOCHAAI_SEARCH_API_KEY';
/** 上游 `count` 上限 */
export const BOCHA_MAX_RESULTS = 50;

/**
 * Bocha 不认 `site:` / `lang:` / `after:` / `before:` 这套语法：
 * 日期走 body 的 `freshness`，语言与站点**没有**对应参数 ⇒ 查询串原样传。
 */
export function renderBochaQuery(query: SearchQuery): string {
  return query.query;
}

/** `YYYY-MM-DD` 校验（不合法就当没给，不猜日期） */
function isoDay(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

/**
 * `after`/`before` → Bocha `freshness`。
 *
 * 只有**两端都是合法 YYYY-MM-DD** 才映射成区间；只有一端时返回 undefined
 * （映射成枚举会悄悄放宽范围——那比不过滤更坏，因为结果看着像是过滤过的）。
 */
export function bochaFreshness(query: SearchQuery): string {
  const after = isoDay(query.after);
  const before = isoDay(query.before);
  if (after !== undefined && before !== undefined) return `${after}..${before}`;
  return 'noLimit';
}

function entryArray(value: unknown): RawSearchEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => asRecord(item));
}

export const bochaSearchProvider: SearchProvider = {
  id: 'bocha',
  version: '1',
  billed: true,
  requiresKey: true,
  keyEnv: BOCHA_DEFAULT_KEY_ENV,
  maxCount: BOCHA_MAX_RESULTS,

  renderQuery: renderBochaQuery,

  createHttp(options: ProviderHttpOptions): ProviderHttp {
    return createJsonHttp({
      config: options.config,
      keyKind: 'search',
      keyEnvName: options.keyEnvName,
      endpoint: BOCHA_SEARCH_ENDPOINT,
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
      // Bocha 的 summary 开关就是「要不要长摘要」；我们的 need_content 正好是同一个意思
      summary: query.needContent,
      freshness: bochaFreshness(query),
      // count 已由共用层按 maxCount（=50）夹紧
      count: query.count,
    };
    return http.postJson({
      path: '/v1/web-search',
      body,
      hint: '检查 query 是否为空、count 是否 ≤50、freshness 是否为 noLimit 或 YYYY-MM-DD..YYYY-MM-DD',
    });
  },

  parseEntries(payload: unknown): RawSearchEntry[] {
    const root = asRecord(payload);
    const data = asRecord(root.data);
    const webPages = asRecord(data.webPages);
    // 形状防御只在这一处：Bocha 把条目埋在 data.webPages.value
    for (const candidate of [webPages.value, data.value, root.value, data.results]) {
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

    // snippet = 短摘要；summary = 长摘要（只有 summary:true 才有）⇒ content
    const summary = firstString(entry, ['snippet', 'summary', 'description']) ?? '';
    const content = firstString(entry, ['summary', 'content']);
    const date = firstString(entry, ['datePublished', 'dateLastCrawled', 'date']);
    const title = firstString(entry, ['name', 'title']) ?? '';

    return {
      title,
      url: parsed.href,
      summary,
      // authority 不出现：Bocha 给的是 siteName（网站名），不是权威度，不冒充
      ...(content !== undefined && content !== summary ? { content } : {}),
      ...(date !== undefined ? { date } : {}),
    };
  },
};
