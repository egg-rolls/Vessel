/**
 * Serper 搜索后端（`POST https://google.serper.dev/search`，Google 结果页结构）。
 *
 * 只做接口要求的三件事（renderQuery / call / parseEntries + normalize）：
 * 预算、缓存键（带 `provider_id` + `provider_version`）、三道闸、熔断、限流、
 * 指标行全在 `search/index.ts` 的共用层；重试/退避/错误映射在 `createJsonHttp`。
 *
 * 语义如实（这家与 DeepSeek 形状不同，**没有的字段就说没有**）：
 * - 鉴权只认 `X-API-KEY` 头（Bearer 不认）⇒ 自带 `createHttp`，但重试/错误映射仍是同一份；
 * - `organic[]` 的 `snippet` 就是它的摘要 ⇒ 映射 `summary`；它**没有** `summary` 字段；
 * - 它**没有** `authority` / 权威度字段 ⇒ 条目里不出现 `authority`（不拿域名冒充）；
 * - 它**没有**正文 ⇒ `need_content=true` 时也不返回 `content`（要全文用 web_fetch），
 *   工具描述里如实写明；
 * - `date` 是 Google 的相对时间（如 `2 days ago`）⇒ **原样透传**，不解析成日期（解析就会编）。
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

export const SERPER_SEARCH_ENDPOINT = 'https://google.serper.dev/search';
/** 只存环境变量**名** */
export const SERPER_DEFAULT_KEY_ENV = 'VESSEL_SERPER_API_KEY';
/** 上游 `num` 上限（Google 口径 100；工具层 count 本来就 ≤50） */
export const SERPER_MAX_RESULTS = 100;

/** 结构化过滤 → Google 认的查询串：只有 `site:` 走查询串，语言/日期走 body 参数 */
export function renderSerperQuery(query: SearchQuery): string {
  const parts = [query.query];
  if (query.site !== undefined && query.site !== '') parts.push(`site:${query.site}`);
  return parts.join(' ');
}

/** `YYYY-MM-DD` → Google `tbs` 的 `MM/DD/YYYY`（不合法就不拼接，不猜） */
function tbsDate(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  return `${match[2]}/${match[3]}/${match[1]}`;
}

/** after/before → `tbs=cdr:1,cd_min:…,cd_max:…`（只有一端时只写那一端） */
export function serperTbs(query: SearchQuery): string | undefined {
  const min = query.after !== undefined ? tbsDate(query.after) : undefined;
  const max = query.before !== undefined ? tbsDate(query.before) : undefined;
  if (min === undefined && max === undefined) return undefined;
  const parts = ['cdr:1'];
  if (min !== undefined) parts.push(`cd_min:${min}`);
  if (max !== undefined) parts.push(`cd_max:${max}`);
  return parts.join(',');
}

/** `zh` / `pt-BR` → `hl=zh` / `hl=pt` + `gl=br`（Serper 的 hl 只要语言，gl 要国家） */
function langParams(query: SearchQuery): { hl?: string; gl?: string } {
  if (query.lang === undefined || query.lang === '') return {};
  const [language, region] = query.lang.split('-');
  const hl = language !== undefined ? language.toLowerCase() : undefined;
  const gl = region !== undefined ? region.toLowerCase() : undefined;
  return {
    ...(hl !== undefined && hl !== '' ? { hl } : {}),
    ...(gl !== undefined && gl !== '' ? { gl } : {}),
  };
}

function entryArray(value: unknown): RawSearchEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => asRecord(item));
}

export const serperSearchProvider: SearchProvider = {
  id: 'serper',
  version: '1',
  billed: true,
  requiresKey: true,
  keyEnv: SERPER_DEFAULT_KEY_ENV,
  maxCount: SERPER_MAX_RESULTS,

  renderQuery: renderSerperQuery,

  createHttp(options: ProviderHttpOptions): ProviderHttp {
    return createJsonHttp({
      config: options.config,
      keyKind: 'search',
      keyEnvName: options.keyEnvName,
      endpoint: SERPER_SEARCH_ENDPOINT,
      // Serper 只认这个头；value 只出现在这里，不进 URL/日志
      authHeaders: (key) => ({ 'x-api-key': key }),
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
    const tbs = serperTbs(query);
    const body: Record<string, unknown> = {
      q: renderedQuery,
      // count 已由共用层按 maxCount（Serper num ≤100）夹紧
      num: query.count,
      ...langParams(query),
      ...(tbs !== undefined ? { tbs } : {}),
    };
    return http.postJson({
      path: '/search',
      body,
      hint: '检查 q 是否为空、num 是否 ≤100、tbs 日期格式是否为 MM/DD/YYYY',
    });
  },

  parseEntries(payload: unknown): RawSearchEntry[] {
    const root = asRecord(payload);
    // Google 结果页：只有 organic[] 是「带 URL 的候选」；answerBox/knowledgeGraph 没有 URL，不算条目
    for (const candidate of [root.organic, asRecord(root.data).organic, root.results]) {
      const entries = entryArray(candidate);
      if (entries !== undefined) return entries;
    }
    return [];
  },

  normalize(entry: RawSearchEntry): SearchHit | null {
    const rawUrl = firstString(entry, ['link', 'url']);
    if (rawUrl === undefined) return null;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    // snippet 就是这家的摘要口径；没有 summary 字段
    const summary = firstString(entry, ['snippet', 'summary', 'description']) ?? '';
    // 相对时间原样给（"2 days ago"）：解析成日期就是编
    const date = firstString(entry, ['date', 'published_date']);
    const title = firstString(entry, ['title', 'name']) ?? '';

    return {
      title,
      url: parsed.href,
      summary,
      // authority / content 都不出现：Serper 的 /search 不返回这两个东西
      ...(date !== undefined ? { date } : {}),
    };
  },
};
