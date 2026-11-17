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
  listSearchProviderEntries,
  listSearchProviders,
  type ProviderHttp,
  type ProviderHttpOptions,
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

// ---------------------------------------------------------------- 选后端

type EnvLike = Record<string, string | undefined>;

/**
 * 这次调用读哪个环境变量名：**配置 `search_key_env` > provider 的 `keyEnv` > `key_env`**。
 *
 * 为什么不直接用 `provider.keyEnv`：用户的 key 可能挂在别的变量名下（CI、多账户），
 * 显式配置必须能盖过 provider 的缺省值——这是「配置优先」在 key 上的同一条规则。
 */
function keyEnvNameFor(config: WebToolsConfig, provider: SearchProvider): string {
  if (config.searchKeyEnv !== '') return config.searchKeyEnv;
  if (provider.keyEnv !== undefined && provider.keyEnv !== '') return provider.keyEnv;
  return config.keyEnv;
}

function providerHasKey(config: WebToolsConfig, provider: SearchProvider, env: EnvLike): boolean {
  if (!provider.requiresKey) return true;
  return readKey(config, 'search', env, keyEnvNameFor(config, provider)).present;
}

/**
 * 选后端（**纯本地**，不发请求）：
 * ① 配置 `search_provider` 显式指定 ⇒ 只用它（未注册 ⇒ `provider_unavailable`）；
 * ② `auto`（缺省）⇒ 按**注册顺序**取第一个 key 在位的；
 * ③ 一个 key 都没有 ⇒ `provider_auth_failed`，并把每家要哪个环境变量列出来
 *    （不猜、不降级、不发请求）。
 */
function selectSearchProvider(config: WebToolsConfig, env: EnvLike): SearchProvider {
  if (config.searchProvider !== 'auto') {
    const explicit = getSearchProvider(config.searchProvider);
    if (explicit === undefined) {
      throw new WebFetchError(
        'provider_unavailable',
        `配置 search_provider=${config.searchProvider} 没有对应的搜索后端；已注册：${listSearchProviders().join(' | ')}`,
      );
    }
    return explicit;
  }

  const candidates = listSearchProviderEntries();
  if (candidates.length === 0) {
    throw new WebFetchError(
      'provider_unavailable',
      `没有注册任何搜索后端（连 ${DEFAULT_SEARCH_PROVIDER_ID} 都没有）`,
    );
  }
  for (const candidate of candidates) {
    if (providerHasKey(config, candidate, env)) return candidate;
  }

  const order = candidates.map((provider) => provider.id).join(' → ');
  const needs = candidates
    .map((provider) => `${provider.id} → ${keyEnvNameFor(config, provider)}`)
    .join('、');
  throw new WebFetchError(
    'provider_auth_failed',
    `没有可用的搜索后端：按注册顺序（${order}）都没有可用的 key。设置其一即可：${needs}；` +
      '或用配置 search_provider 指定某一家（本次没有发出任何请求）',
  );
}

/** 每个后端「要哪把 key、现在在不在」——**只有变量名，没有值**，供诊断与工具装配判定 */
export interface SearchKeyRequirement {
  providerId: string;
  keyEnv: string;
  present: boolean;
}

export interface SearchAvailability {
  /** 现在这个配置下，至少有一个搜索后端能解析到 key */
  available: boolean;
  /** 将会选中的后端（`auto` 时是第一个 key 在位的；不可用时为 undefined） */
  providerId?: string;
  /** 不可用的原因（**不含 key 值**，只含变量名）——写进 debug 行，别让它静默 */
  reason?: string;
  /** 全部在册后端的 key 需求（顺序 = 注册顺序），诊断用 */
  requirements: SearchKeyRequirement[];
}

/**
 * 可用性预检（**纯本地**，不发请求、不读 key 值）：
 * 工具装配时用它决定「要不要注册 `web_search`」。
 *
 * 与 `selectSearchProvider` 的区别：那个在调用时抛错（`provider_auth_failed`），
 * 这个在装配时回答「有没有任何一个能用」——同一个判定函数，两种用途，
 * 避免出现「--tools 说有、调用说没有」的两套口径。
 */
export function searchAvailability(
  config: WebToolsConfig,
  env: EnvLike = process.env,
): SearchAvailability {
  const entries = listSearchProviderEntries();
  const requirements: SearchKeyRequirement[] = entries.map((provider) => ({
    providerId: provider.id,
    keyEnv: keyEnvNameFor(config, provider),
    present: provider.requiresKey ? providerHasKey(config, provider, env) : true,
  }));

  if (config.searchProvider !== 'auto') {
    const explicit = getSearchProvider(config.searchProvider);
    if (explicit === undefined) {
      return {
        available: false,
        reason: `search_provider=${config.searchProvider} 没有对应的后端；在册：${listSearchProviders().join(' | ')}`,
        requirements,
      };
    }
    const requirement = requirements.find((item) => item.providerId === explicit.id);
    if (explicit.requiresKey && requirement !== undefined && !requirement.present) {
      return {
        available: false,
        reason: `search_provider=${explicit.id} 的 key 未设置（${requirement.keyEnv}）`,
        requirements,
      };
    }
    return { available: true, providerId: explicit.id, requirements };
  }

  for (const provider of entries) {
    const requirement = requirements.find((item) => item.providerId === provider.id);
    if (!provider.requiresKey || requirement?.present === true) {
      return { available: true, providerId: provider.id, requirements };
    }
  }

  return {
    available: false,
    reason: `按注册顺序（${entries.map((provider) => provider.id).join(' → ')}）都没有可用的 key：${requirements
      .map((item) => `${item.providerId} → ${item.keyEnv}`)
      .join('、')}`,
    requirements,
  };
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
  //
  // 否则如实报**上游条数**：只有 `rendered < 上游` 才是预算收缩。写成
  // `max(count, upstream)` 会把「这家上游只给了 2 条」谎报成「我们压掉了预算」
  // ——Tavily/Serper 对小众 query 经常少给，deepseek 也可能。
  const requestedCount = entry.upstreamCount;
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
  let provider: SearchProvider | undefined;
  let attempts: number | undefined;
  let upstreamMs: number | undefined;

  try {
    // ① 参数
    query = parseSearchArgs(args, config);
    // ② 选后端 + 缺 key：都在本地判，不发请求，不静默降级
    //    （选中谁进指标行 `provider_id`，也进结果信封 `backend:`——用户能看见用了哪家）
    const env = run.deps.deepseek?.env ?? process.env;
    const selected: SearchProvider = selectSearchProvider(config, env);
    provider = selected;
    const keyEnvName = keyEnvNameFor(config, selected);
    if (selected.requiresKey) {
      const key = readKey(config, 'search', env, keyEnvName);
      if (!key.present) {
        throw new WebFetchError('provider_auth_failed', missingKeyMessage(key.envName));
      }
    }

    // 这家表达不了的过滤条件 ⇒ **发请求前就失败**，而且**在查缓存之前**：
    // 缓存命中会让「这条过滤根本没生效」看起来像生效了。
    selected.checkFilters?.(query);

    // 缓存键字段清单（顺序固定；漏一个 = 静默给错内容 + 继续计费）：
    // provider_id + provider_version + normalized_query + count + need_content
    // + detail + site + lang + after + before
    const cacheKey = hashKey([
      selected.id,
      selected.version,
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
        provider: selected,
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
    if (selected.billed) ticket = await run.cost.acquire('search', run.runKey);
    if (selected.billed) {
      try {
        await run.cost.throttle('search');
      } catch (error) {
        // 本地排队超时不是上游失败：不算进熔断（settle 幂等，外层再 settle 会被忽略）
        ticket?.skipped();
        throw error;
      }
    }

    // ⑥ 发请求（重试 / 退避 / 错误映射在 ProviderHttp 里）
    //    传输层：provider 自带 `createHttp`（鉴权风格不同，例如 Serper 的 X-API-KEY）就用它；
    //    没带 ⇒ 回落 deepseek 的 Bearer 实现（第一个实现，不代表其他家也长这样）。
    const backoff = (attempt: number, retryAfterMs?: number): number =>
      run.cost.backoffMs(attempt, retryAfterMs);
    const httpOptions: ProviderHttpOptions = {
      config,
      keyEnvName,
      ...(run.signal !== undefined ? { signal: run.signal } : {}),
      ...(run.deps.deepseek !== undefined ? { deps: run.deps.deepseek } : {}),
      backoff,
    };
    const http: ProviderHttp =
      selected.createHttp !== undefined
        ? selected.createHttp(httpOptions)
        : createDeepSeekHttp({
            config,
            keyKind: 'search',
            ...(run.signal !== undefined ? { signal: run.signal } : {}),
            ...(run.deps.deepseek !== undefined ? { deps: run.deps.deepseek } : {}),
            backoff,
          });
    const renderedQuery = selected.renderQuery(query);
    // 上游条数上限（Tavily 只认 ≤20）：夹在 `call` 之前，body 与上游口径一致；
    // 缓存键/预算仍按模型请求的 count，信封报上游真实条数。
    const upstreamQuery: SearchQuery =
      selected.maxCount !== undefined && query.count > selected.maxCount
        ? { ...query, count: selected.maxCount }
        : query;
    const callStart = Date.now();
    const response = await selected.call(http, upstreamQuery, renderedQuery);
    upstreamMs = Date.now() - callStart;
    attempts = response.attempts;

    // ⑦ 归一（缓存存条目，渲染每次现做）
    const entries = selected.parseEntries(response.json);
    const hits = entries
      .map((entry) => selected.normalize(entry))
      .filter((hit): hit is SearchHit => hit !== null);
    const entry: SearchCacheEntry = {
      providerId: selected.id,
      providerVersion: selected.version,
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
        provider: selected,
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
      provider: selected,
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
    // 失败也要写清试的是哪家：选了后端但没到发请求就失败时，用配置口径兜底
    const backendId = provider?.id ?? config.searchProvider;
    emitMetric({
      tool: 'web_search',
      backend: backendId,
      ...(query !== undefined
        ? {
            provider_id: backendId,
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
