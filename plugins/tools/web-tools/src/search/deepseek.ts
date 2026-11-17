/**
 * DeepSeek 搜索后端（P0 唯一实现）。
 *
 * 它只做三件事（设计 §3.2）：把结构化过滤条件渲染成它认的查询串、描述请求线格式、
 * 把返回条目归一。预算/缓存/限流/熔断/重试/定界渲染全在 `search/index.ts` 的共用层。
 *
 * ⚠️ owner 口径（未在仓里二次核对，实现以真实响应为准）：
 * - 端点 `POST /v1/tools/search`；
 * - 请求字段 `query` / `count` / `need_content`；
 * - 结果字段 `title` / `url` / `snippet` / `summary` / `content` / `date` / `authority`。
 */

import { DEEPSEEK_SEARCH_PATH } from '../deepseek-client';
import {
  asRecord,
  firstString,
  type ProviderHttp,
  type ProviderHttpResponse,
  type RawSearchEntry,
  type SearchHit,
  type SearchProvider,
  type SearchQuery,
} from './provider';

/**
 * 过滤条件渲染成上游认的语法。
 *
 * 允许模型写的是**结构化参数**，不是搜索语法本身：`site:` / `lang:` / `after:` / `before:`
 * 都由这里渲染，且 `query` 里出现这些 token 会被共用层拒绝（否则模型能绕过参数校验）。
 * `-词` 与 `"短语"` 是合法且有价值的否定/精确匹配，原样保留。
 */
export function renderDeepSeekQuery(query: SearchQuery): string {
  const parts = [query.query];
  if (query.site !== undefined && query.site !== '') parts.push(`site:${query.site}`);
  if (query.lang !== undefined && query.lang !== '') parts.push(`lang:${query.lang}`);
  if (query.after !== undefined && query.after !== '') parts.push(`after:${query.after}`);
  if (query.before !== undefined && query.before !== '') parts.push(`before:${query.before}`);
  return parts.join(' ');
}

function entryArray(value: unknown): RawSearchEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => asRecord(item));
}

export const deepseekSearchProvider: SearchProvider = {
  id: 'deepseek',
  // 归一逻辑的版本：一改就动版本，旧缓存自动失效（键里带它）
  version: '1',
  billed: true,
  requiresKey: true,

  renderQuery: renderDeepSeekQuery,

  async call(
    http: ProviderHttp,
    query: SearchQuery,
    renderedQuery: string,
  ): Promise<ProviderHttpResponse> {
    return http.postJson({
      path: DEEPSEEK_SEARCH_PATH,
      body: {
        query: renderedQuery,
        count: query.count,
        // false 就是 false：不发也不渲染正文（省的不是钱，是预算）
        need_content: query.needContent,
      },
      hint: '检查 query 里的特殊字符与 site/lang/after 格式',
    });
  },

  parseEntries(payload: unknown): RawSearchEntry[] {
    const root = asRecord(payload);
    const data = asRecord(root.data);
    // 形状防御：只在这一处容忍差异，上层拿到的永远是同一个条目数组
    for (const candidate of [root.results, data.results, root.items, data.items, data.entries]) {
      const entries = entryArray(candidate);
      if (entries !== undefined) return entries;
    }
    if (Array.isArray(root.data)) return root.data.map((item) => asRecord(item));
    return [];
  },

  normalize(entry: RawSearchEntry): SearchHit | null {
    const rawUrl = firstString(entry, ['url', 'link', 'href']);
    if (rawUrl === undefined) return null;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return null;
    }
    // 搜索结果是模型接下来的抓取目标：只留绝对 http(s)，别的一律当不可用
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    const summary = firstString(entry, ['summary', 'snippet', 'description']) ?? '';
    const content = firstString(entry, ['content', 'raw_content', 'text']);
    const date = firstString(entry, ['date', 'published_at', 'published', 'time']);
    const authority = firstString(entry, ['authority', 'author', 'site', 'domain']);
    const title = firstString(entry, ['title', 'name']) ?? '';

    return {
      title,
      url: parsed.href,
      summary,
      ...(content !== undefined ? { content } : {}),
      ...(date !== undefined ? { date } : {}),
      ...(authority !== undefined ? { authority } : {}),
    };
  },
};
