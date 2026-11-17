/**
 * `web_search` 的共用层（0.56 P0）。
 *
 * 一次调用的顺序（**拒绝要快、且不花钱**，设计 §5.5）：
 *   参数校验 → 缺 key → 缓存 → 熔断 → 每 run 配额 → 日上限 → 限流 → 发请求 → 归一 → 预算 → 定界渲染
 * 前五步任何一步拒绝都**不产生网络往返**；缓存命中不算计费调用，所以放在配额之前
 * （否则「今天到顶」会把已有的缓存也给挡掉，白白多花一次钱）。
 *
 * 「只数会被计费的调用」：search 只有**结果非空**才计费 ⇒ 空结果是
 * `ok: true` + `results: 0`（不是 error，模型不会为同一 query 重试三次）。
 *
 * ⚠️ 出口预算的唯一口径是 token（`estimateTokens`），不是条数：见 `planSearchBudget`。
 */

import { estimateTokens } from '../budget';
import { hashKey, type TtlLruCache } from '../cache';
import type { WebToolsConfig } from '../config';
import type { DeepSeekDeps } from '../deepseek-client';
import { type CostController, type CostSnapshot, type CostTicket, emitMetric } from '../limits';
import { createDeepSeekHttp } from '../provider-http';
import {
  renderSearchFailure,
  renderSearchResult,
  type SearchRenderHit,
  searchEnvelopeTokens,
  truncateWithLabel,
} from '../render';
import { missingKeyMessage, readKey } from '../secrets';
import { WebFetchError, type WebToolErrorCode } from '../types';
import {
  DEFAULT_SEARCH_PROVIDER_ID,
  getSearchProvider,
  type ProviderHttp,
  type SearchHit,
  type SearchProvider,
  type SearchQuery,
} from './provider';

/** 缺省返回条数（schema 默认值同此） */
export const DEFAULT_SEARCH_COUNT = 5;
/** 每条摘要的保底预算：低于它就减条数，而不是把摘要压成一行（设计 §4.2） */
export const MIN_SUMMARY_CHARS = 300;

export interface SearchDeps {
  deepseek?: DeepSeekDeps;
  /** 注入时钟（真机脚本用；缺省 Date.now） */
  now?: () => number;
}

/** 缓存里存的是**归一后的条目**，不是渲染后的字符串（否则 detail 一变就串味） */
export interface SearchCacheEntry {
  providerId: string;
  providerVersion: string;
  hits: SearchHit[];
  /** 上游真实返回条数（可能大于渲染条数） */
  upstreamCount: number;
  fetchedAt: string;
}

export interface WebSearchRun {
  config: WebToolsConfig;
  cost: CostController;
  cache: TtlLruCache<SearchCacheEntry>;
  deps: SearchDeps;
  /** 每 run 配额的键（run_id 优先，退到 session_id） */
  runKey: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------- 参数校验

/** 行首/空白后的 `site:` / `-site:` / `lang:` / `after:` / `before:` 一律拒（设计 §2.1） */
const QUERY_SYNTAX_PATTERN = /(^|\s)-?(site|lang|after|before):/i;
const SITE_PATTERN = /^[a-z0-9.-]+$/;
const LANG_PATTERN = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const KNOWN_SEARCH_KEYS = new Set([
  'query',
  'count',
  'need_content',
  'detail',
  'site',
  'lang',
  'after',
  'before',
]);

function invalid(message: string): never {
  throw new WebFetchError('invalid_input', message);
}

/** trim + 内部连续空白折叠为 1 个空格；**不改大小写、不做全半角变换** */
function normalizeQueryText(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1970 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** 校验工具参数 → 归一后的 `SearchQuery`；非法一律 `invalid_input`（不「帮你修」） */
export function parseSearchArgs(args: unknown, config: WebToolsConfig): SearchQuery {
  const record =
    args !== null && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};

  for (const key of Object.keys(record)) {
    if (!KNOWN_SEARCH_KEYS.has(key)) invalid(`不认识的参数：${key}`);
  }

  const rawQuery = record.query;
  if (typeof rawQuery !== 'string') invalid('query 必须是字符串');
  const trimmed = rawQuery.trim();
  if (trimmed === '') invalid('query 不能为空');
  if (trimmed.length > 128) {
    // 不截断：截断会静默改语义
    invalid(`query 过长（${trimmed.length} > 128 字符）；请缩短后重试，本工具不截断 query`);
  }
  if (QUERY_SYNTAX_PATTERN.test(trimmed)) {
    invalid(
      'query 里不要写搜索语法：请用 site/lang/after/before 参数（query 里只留关键词与原样短语）',
    );
  }
  const query = normalizeQueryText(trimmed);

  let count = DEFAULT_SEARCH_COUNT;
  if (record.count !== undefined && record.count !== null) {
    if (typeof record.count !== 'number' || !Number.isInteger(record.count)) {
      invalid('count 必须是整数');
    }
    count = Math.min(Math.max(record.count, 1), Math.min(50, config.searchCountMax));
  }

  let needContent = false;
  if (record.need_content !== undefined && record.need_content !== null) {
    if (typeof record.need_content !== 'boolean') invalid('need_content 必须是布尔值');
    needContent = record.need_content;
  }

  let detail = config.searchDetailDefault;
  if (record.detail !== undefined && record.detail !== null) {
    const value = typeof record.detail === 'string' ? record.detail.trim().toLowerCase() : '';
    if (value !== 'brief' && value !== 'full') invalid('detail 只支持 brief | full');
    detail = value;
  }

  const optionalString = (key: string): string | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') invalid(`${key} 必须是字符串`);
    const text = value.trim();
    return text === '' ? undefined : text;
  };

  const site = optionalString('site');
  if (site !== undefined) {
    if (site.length > 255) invalid('site 过长（>255 字符）');
    if (!SITE_PATTERN.test(site)) {
      invalid('site 必须是主机名形态（小写字母/数字/点/连字符，无 scheme、无路径、无空格）');
    }
  }

  const lang = optionalString('lang');
  if (lang !== undefined) {
    if (lang.length > 16) invalid('lang 过长（>16 字符）');
    if (!LANG_PATTERN.test(lang)) invalid('lang 形态是 xx 或 xx-YY（例如 zh / en / pt-BR）');
  }

  const after = optionalString('after');
  if (after !== undefined && !isRealDate(after)) invalid('after 必须是真实日期 YYYY-MM-DD');
  const before = optionalString('before');
  if (before !== undefined && !isRealDate(before)) invalid('before 必须是真实日期 YYYY-MM-DD');
  if (after !== undefined && before !== undefined && after > before) {
    invalid('after 晚于 before（时间窗为空）');
  }

  return {
    query,
    count,
    needContent,
    detail,
    ...(site !== undefined ? { site } : {}),
    ...(lang !== undefined ? { lang } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
  };
}

// ---------------------------------------------------------------- 预算分配

export interface SearchBudget {
  budgetTokens: number;
  /** 信封成本（头 + 定界 + hint）实测 token */
  envelopeTokens: number;
  /** 每条摘要字符上限 */
  perItemChars: number;
  /** 实际渲染条数（可能被预算收缩） */
  renderedCount: number;
  /** 每条正文上限（`need_content=false` 时 0） */
  contentChars: number;
}

/**
 * token 预算 → 条级字符预算（设计 §4.2 的算法）。
 *
 * 算术自证（全 CJK + 摘要满额的最坏情况，`E ≈ 300`）：
 * - `count=5, brief`：`per_item = min(800, floor(3700/5)) = 740` ⇒ 5×740×0.5 + 300 = **2,150 tok**
 * - `count=10, brief`：`per_item = 370` ⇒ 10×370×0.5 + 300 = **2,150 tok**（死按 800 字 = 4,300 ❌）
 * - `count=12, brief`：`per_item` 触 300 下限 ⇒ 12×300×0.5 + 300 = **2,100 tok**（边界）
 * - `count=50, brief`：装不下 ⇒ `rendered = floor(3700 / 150) = 24` ⇒ 24×150 + 300 = **3,900 tok**
 *   （死按 50 条 = 7,500 ❌），头条写明「只渲染 24 条」
 */
export function planSearchBudget(
  query: SearchQuery,
  config: WebToolsConfig,
  envelopeTokens: number,
): SearchBudget {
  const budgetTokens =
    query.detail === 'full' ? config.searchBudgetFullTokens : config.searchBudgetBriefTokens;
  const available = Math.max(0, budgetTokens - envelopeTokens);
  const count = Math.max(1, query.count);
  const rawPerItem = Math.floor(available / count);
  const perItemChars = Math.min(
    Math.max(rawPerItem, MIN_SUMMARY_CHARS),
    config.searchSummaryMaxChars,
  );
  const contentChars = query.needContent ? Math.min(config.searchContentMaxChars, perItemChars) : 0;
  // 最坏情况：全 CJK（0.5 token/字符）+ 摘要满额（+ 正文满额）
  const itemTokens = (perItemChars + contentChars) * 0.5;
  let renderedCount = count;
  if (rawPerItem < MIN_SUMMARY_CHARS || itemTokens * count > available) {
    renderedCount = Math.max(1, Math.min(count, Math.floor(available / Math.max(1, itemTokens))));
  }
  return { budgetTokens, envelopeTokens, perItemChars, renderedCount, contentChars };
}

/** 把归一后的条目按预算渲染（摘要/正文各自截断，带业务标记） */
export function renderHits(hits: readonly SearchHit[], budget: SearchBudget): SearchRenderHit[] {
  const out: SearchRenderHit[] = [];
  for (const hit of hits.slice(0, budget.renderedCount)) {
    const summary = truncateWithLabel(hit.summary, budget.perItemChars, '摘要');
    const rendered: SearchRenderHit = {
      title: hit.title,
      url: hit.url,
      summary: summary.text,
      ...(hit.date !== undefined ? { date: hit.date } : {}),
      ...(hit.authority !== undefined ? { authority: hit.authority } : {}),
    };
    if (budget.contentChars > 0 && hit.content !== undefined) {
      rendered.content = truncateWithLabel(
        hit.content,
        budget.contentChars,
        '正文',
        '，用 web_fetch 取全文',
      ).text;
    }
    out.push(rendered);
  }
  return out;
}

// ---------------------------------------------------------------- 主流程

/** 本地拒绝（未发请求）：只释放半开探针，不计也不罚 */
function isLocalRejection(code: WebToolErrorCode): boolean {
  return code === 'max_uses_exceeded' || code === 'circuit_open' || code === 'invalid_input';
}

/** 4xx 客户端错：不动熔断（是我们的请求不合法，不是服务挂了） */
function isClientError(code: WebToolErrorCode): boolean {
  return (
    code === 'provider_auth_failed' ||
    code === 'provider_bad_request' ||
    code === 'provider_quota_exhausted' ||
    code === 'endpoint_not_found' ||
    code === 'too_large'
  );
}

function toWebFetchError(error: unknown): WebFetchError {
  if (error instanceof WebFetchError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new WebFetchError('connect_failed', `搜索失败：${message}`);
}

function sha8(text: string): string {
  return hashKey([text]).slice(0, 8);
}

interface RenderOutcome {
  text: string;
  tokens: number;
  results: number;
}

function renderEntry(
  entry: SearchCacheEntry,
  query: SearchQuery,
  config: WebToolsConfig,
  options: { cached: boolean; cachedAgeMs?: number },
): RenderOutcome {
  // 上游一条都没有 ⇒ 0（这样头条是 `results: 0`，而不是「只渲染 0 条，预算限制」）
  const requestedCount = entry.upstreamCount > 0 ? Math.max(query.count, entry.upstreamCount) : 0;
  const baseOptions = {
    providerId: entry.providerId,
    query: query.query,
    requestedCount,
    detail: query.detail,
    budgetTokens:
      query.detail === 'full' ? config.searchBudgetFullTokens : config.searchBudgetBriefTokens,
    perItemChars: 0,
    cached: options.cached,
    ...(options.cachedAgeMs !== undefined ? { cachedAgeMs: options.cachedAgeMs } : {}),
    fetchedAt: entry.fetchedAt,
  };
  // 信封成本实测（头 + 定界 + hint），再分配条级预算
  const envelopeTokens = searchEnvelopeTokens({ ...baseOptions, hits: [] });
  const budget = planSearchBudget(query, config, envelopeTokens);

  const build = (hits: SearchRenderHit[]): string =>
    renderSearchResult({
      ...baseOptions,
      hits,
      requestedCount,
      perItemChars: budget.perItemChars,
    });

  let rendered = renderHits(entry.hits, budget);
  let text = build(rendered);
  let tokens = estimateTokens(text);
  // 兜底（不依赖上面算术一定对）：超预算就从尾部丢条，直到进入预算
  while (tokens > budget.budgetTokens && rendered.length > 0) {
    rendered = rendered.slice(0, -1);
    text = build(rendered);
    tokens = estimateTokens(text);
  }
  return { text, tokens, results: rendered.length };
}

interface SearchMetricInput {
  provider: SearchProvider;
  query: SearchQuery;
  cached: boolean;
  cachedAgeMs?: number;
  results: number;
  outTokens: number;
  latencyMs: number;
  upstreamMs?: number;
  attempts?: number;
  snapshot: CostSnapshot;
}

function emitSearchMetric(input: SearchMetricInput): void {
  emitMetric({
    tool: 'web_search',
    backend: input.provider.id,
    provider_id: input.provider.id,
    query_chars: input.query.query.length,
    query_sha8: sha8(input.query.query),
    count: input.query.count,
    detail: input.query.detail,
    need_content: input.query.needContent,
    cached: input.cached,
    ...(input.cachedAgeMs !== undefined
      ? { cached_age_s: Math.round(input.cachedAgeMs / 1000) }
      : {}),
    results: input.results,
    out_tokens_est: input.outTokens,
    latency_ms: input.latencyMs,
    ...(input.upstreamMs !== undefined ? { upstream_ms: input.upstreamMs } : {}),
    ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
    breaker_state: input.snapshot.breaker,
    quota_used: input.snapshot.dailyUsed,
  });
}

/** 一次 `web_search` 调用：返回给模型看的文本（成功与失败都不抛） */
export async function runWebSearch(args: unknown, run: WebSearchRun): Promise<string> {
  const startedAt = Date.now();
  const config = run.config;
  const clock = run.deps.now ?? (() => Date.now());
  let ticket: CostTicket | undefined;
  let query: SearchQuery | undefined;
  let attempts: number | undefined;
  let upstreamMs: number | undefined;

  try {
    // ① 参数
    query = parseSearchArgs(args, config);
    const provider = getSearchProvider(DEFAULT_SEARCH_PROVIDER_ID);
    if (provider === undefined) {
      throw new WebFetchError(
        'provider_unavailable',
        `没有注册搜索后端（${DEFAULT_SEARCH_PROVIDER_ID}）`,
      );
    }

    // ② 缺 key：本地判，不发请求，不静默降级
    if (provider.requiresKey) {
      const key = readKey(config, 'search', run.deps.deepseek?.env ?? process.env);
      if (!key.present) {
        throw new WebFetchError('provider_auth_failed', missingKeyMessage(key.envName));
      }
    }

    // 缓存键字段清单（顺序固定；漏一个 = 静默给错内容 + 继续计费）：
    // provider_id + provider_version + normalized_query + count + need_content
    // + detail + site + lang + after + before
    const cacheKey = hashKey([
      provider.id,
      provider.version,
      query.query,
      query.count,
      query.needContent,
      query.detail,
      query.site ?? '',
      query.lang ?? '',
      query.after ?? '',
      query.before ?? '',
    ]);
    const cached = run.cache.get(cacheKey);
    if (cached !== undefined) {
      const rendered = renderEntry(cached.value, query, config, {
        cached: true,
        cachedAgeMs: cached.ageMs,
      });
      emitSearchMetric({
        provider,
        query,
        cached: true,
        cachedAgeMs: cached.ageMs,
        results: rendered.results,
        outTokens: rendered.tokens,
        latencyMs: Date.now() - startedAt,
        snapshot: run.cost.snapshot('search', run.runKey),
      });
      return rendered.text;
    }

    // ③④⑤ 熔断 / 每 run 配额 / 日上限（前五步拒绝都不产生网络往返）
    if (provider.billed) ticket = await run.cost.acquire('search', run.runKey);
    if (provider.billed) {
      try {
        await run.cost.throttle('search');
      } catch (error) {
        // 本地排队超时不是上游失败：不算进熔断（settle 幂等，外层再 settle 会被忽略）
        ticket?.skipped();
        throw error;
      }
    }

    // ⑥ 发请求（重试 / 退避 / 错误映射在 ProviderHttp 里）
    const http: ProviderHttp = createDeepSeekHttp({
      config,
      keyKind: 'search',
      ...(run.signal !== undefined ? { signal: run.signal } : {}),
      ...(run.deps.deepseek !== undefined ? { deps: run.deps.deepseek } : {}),
      backoff: (attempt, retryAfterMs) => run.cost.backoffMs(attempt, retryAfterMs),
    });
    const renderedQuery = provider.renderQuery(query);
    const callStart = Date.now();
    const response = await provider.call(http, query, renderedQuery);
    upstreamMs = Date.now() - callStart;
    attempts = response.attempts;

    // ⑦ 归一（缓存存条目，渲染每次现做）
    const entries = provider.parseEntries(response.json);
    const hits = entries
      .map((entry) => provider.normalize(entry))
      .filter((hit): hit is SearchHit => hit !== null);
    const entry: SearchCacheEntry = {
      providerId: provider.id,
      providerVersion: provider.version,
      hits,
      upstreamCount: entries.length,
      fetchedAt: new Date(clock()).toISOString(),
    };
    run.cache.set(cacheKey, entry);

    if (hits.length === 0) {
      // 空结果**不计费**、也不是 error
      ticket?.empty();
      const rendered = renderEntry(entry, query, config, { cached: false });
      emitSearchMetric({
        provider,
        query,
        cached: false,
        results: 0,
        outTokens: rendered.tokens,
        latencyMs: Date.now() - startedAt,
        ...(upstreamMs !== undefined ? { upstreamMs } : {}),
        ...(attempts !== undefined ? { attempts } : {}),
        snapshot: run.cost.snapshot('search', run.runKey),
      });
      return rendered.text;
    }

    // ⑧ 计费（结果非空）⑨ 预算 + 定界渲染
    ticket?.billed();
    const rendered = renderEntry(entry, query, config, { cached: false });
    emitSearchMetric({
      provider,
      query,
      cached: false,
      results: rendered.results,
      outTokens: rendered.tokens,
      latencyMs: Date.now() - startedAt,
      ...(upstreamMs !== undefined ? { upstreamMs } : {}),
      ...(attempts !== undefined ? { attempts } : {}),
      snapshot: run.cost.snapshot('search', run.runKey),
    });
    return rendered.text;
  } catch (error) {
    const failure = toWebFetchError(error);
    if (isLocalRejection(failure.code)) ticket?.skipped();
    else if (isClientError(failure.code)) ticket?.clientError();
    else ticket?.failure();

    const snapshot = run.cost.snapshot('search', run.runKey);
    emitMetric({
      tool: 'web_search',
      backend: DEFAULT_SEARCH_PROVIDER_ID,
      ...(query !== undefined
        ? {
            provider_id: DEFAULT_SEARCH_PROVIDER_ID,
            query_chars: query.query.length,
            query_sha8: sha8(query.query),
            count: query.count,
            detail: query.detail,
            need_content: query.needContent,
          }
        : {}),
      latency_ms: Date.now() - startedAt,
      ...(upstreamMs !== undefined ? { upstream_ms: upstreamMs } : {}),
      ...(attempts !== undefined ? { attempts } : {}),
      code: failure.code,
      breaker_state: snapshot.breaker,
      quota_used: snapshot.dailyUsed,
    });
    const daily =
      failure.code === 'max_uses_exceeded' || failure.code === 'circuit_open'
        ? { dailyUsed: snapshot.dailyUsed, dailyLimit: snapshot.dailyLimit }
        : {};
    return renderSearchFailure({ code: failure.code, message: failure.message, ...daily });
  }
}
