/**
 * 配置解析：插件 config（`plugins[].config`）+ 工具参数 都从这里收敛成一份强类型。
 *
 * 口径（设计 §12 ①）：**所有键都留在 `plugins[].config`，不动 `packages/config/**`**；
 * validator 也在插件侧——坏值在 `install()` 时抛配置错，不静默取默认。
 *
 * 两类键分开对待：
 * - 数值/布尔：一律夹紧（clamp），配置写错不会把宿主拖死；
 * - 枚举/环境变量名/base_url：写错就抛（静默回落会让用户以为切了后端其实没切，R10）。
 */

import { type CustomSearchSpec, parseCustomSearchSpec } from './search/custom';
import type { FetchBackendId } from './types';

export type WebFetchRenderer = 'none' | 'browser' | 'jina';
export type WebFetchApproval = 'open' | 'guarded' | 'locked';
/** 搜索输出的预算档（纯本地旋钮，不传给上游） */
export type SearchDetail = 'brief' | 'full';

export interface WebFetchConfig {
  /** 响应体字节上限（默认 5 MiB） */
  maxBytes: number;
  /** 整体超时（默认 10s，含所有跳） */
  timeoutMs: number;
  /** 重定向跟随上限（默认 5 跳） */
  maxRedirects: number;
  /** 返回文本的字符预算（默认 8000） */
  maxChars: number;
  /** 同域链接上限 */
  linksLimit: number;
  /** content-type 白名单 */
  allowedContentTypes: string[];
  respectRobots: boolean;
  /** robots.txt 缓存 TTL（默认 12h） */
  robotsTtlMs: number;
  userAgent: string;
  /** 逃生阀：默认 false。放开后私网/环回仍被拦，只有链路本地与云元数据会被额外放行——见 ssrf.ts 注释。 */
  allowPrivateNetworks: boolean;
  /** 允许 https -> http 降级重定向，默认 false */
  allowHttpsToHttp: boolean;
  domainAllowlist: string[];
  domainDenylist: string[];
  approval: WebFetchApproval;
  /** M1 只实现 'none'；其它值直接 `renderer_unavailable` */
  renderer: WebFetchRenderer;
}

/** 0.56 新增的配置（全部有缺省值；现有键一个不动） */
export interface WebToolsConfig extends WebFetchConfig {
  /** 抓取后端，缺省 `local`（R11：新后端不许悄悄变成默认，否则开始花钱 + 内容出网） */
  backend: FetchBackendId;
  /**
   * 搜索后端 id；缺省 `auto` = **按注册顺序**取第一个 key 在位的后端。
   *
   * 显式写 id（例如 `tavily`）就忽略顺序，只用它——这是「配置优先」的唯一含义。
   * 这里只做形态校验；「这个 id 有没有注册」在调用时判（注册表在插件内，
   * 让 config.ts 依赖注册表会形成环）。
   */
  searchProvider: string;
  /**
   * 逃生阀：**没有**任何搜索后端能解析到 key 时，仍然注册 `web_search`。
   *
   * 缺省 `false` ⇒ 无 key 时工具从列表里消失（用户明确要求：不可用的工具不要占位）。
   * 设 `true` 时工具照旧出现，调用会返回 `provider_auth_failed` 并点名要设的环境变量——
   * 给「想先看到工具、再配 key」的人留一条路。
   *
   * 为什么不叫 `web.tools.always_register`（顶层键）：这条语义只对 web-tools 有效，
   * 放进 `packages/config` 会让「配置包」知道某个插件的行为细节。
   */
  alwaysRegister: boolean;
  /**
   * 声明式自定义搜索后端（数组）。每项注册成 `custom:<id>`，
   * 用 `search_provider: custom:<id>` 选中；不写就是空数组。
   */
  customSearch: CustomSearchSpec[];
  /** DeepSeek tools API 的 base_url（不含末尾斜杠） */
  baseUrl: string;
  /** **只存环境变量名**，绝不存值（设计 §6.1） */
  keyEnv: string;
  /** 分开账户时才用；空则回落 `keyEnv` */
  searchKeyEnv: string;
  fetchKeyEnv: string;
  /** 允许模型用 `backend` 参数改后端（花钱 + 外发，默认不许） */
  allowModelBackendOverride: boolean;
  /** 单次上游调用总 deadline（毫秒，**含**重试与 body 读取） */
  apiTimeoutMs: number;
  searchDetailDefault: SearchDetail;
  /** brief / full 两档输出 token 预算，都不得 ≥16,000（闸的口径） */
  searchBudgetBriefTokens: number;
  searchBudgetFullTokens: number;
  searchSummaryMaxChars: number;
  searchContentMaxChars: number;
  searchCountMax: number;
  searchCacheTtlMs: number;
  searchCacheMaxEntries: number;
  /** 抓取缓存 TTL：0 = 关闭（local 缺省关闭；deepseek 缺省 1800s） */
  fetchCacheTtlMs: number;
  retryMax: number;
  retryBaseMs: number;
  searchQps: number;
  fetchQps: number;
  fetchHostMinIntervalMs: number;
  maxUsesSearchPerRun: number;
  maxUsesFetchPerRun: number;
  /** **每进程每日计费调用上限**（跨 run 累积；单 run 配额挡不住 20 个 run × 15 次） */
  maxBilledCallsPerDay: number;
  breakerFailures: number;
  breakerOpenMs: number;
  /** deepseek 抓取：带 query string 的 URL 缺省**拦**（一次性 token / 会话 id / 邮箱 = 外发） */
  deepseekFetchBlockQueryString: boolean;
  /** 上一条的显式白名单（主机名） */
  deepseekFetchAllowQueryStringHosts: string[];
}

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_CHARS = 8_000;
/**
 * `max_chars` 的硬上界（0.56 从 200,000 收到 32,000）。
 *
 * 32,000 全 CJK = 16,000 token，正好撞单条工具结果的闸（设计 §4.3）；
 * 200,000 时一个参数就能塞 ≈50,000 token，而本插件不在 16k 闸内（§0 第 2 条）。
 */
export const MAX_MAX_CHARS = 32_000;

/** 0.56：上游 API 的默认地址与端点（端点路径见 `deepseek-client.ts`） */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_KEY_ENV = 'DEEPSEEK_API_KEY';
export const DEFAULT_API_TIMEOUT_MS = 15_000;
/** 单条工具结果的硬闸：插件内自收口的上界（对齐 `boundToolResult` 的 16k 口径） */
export const MAX_RESULT_TOKENS = 16_000;

/**
 * 三道成本闸的硬常量（设计 §5.5，已定稿；配置只能在此基础上调，缺省即这三个数）。
 *
 * - `MAX_SEARCH_PER_RUN = 15`：一个 run 正常 3–5 次搜索够用，研究型任务 10 次算多；
 *   15 给自我纠错留余量，但封顶 0.075 元/run。
 * - `MAX_DEEPSEEK_FETCH_PER_RUN = 20`：一次深挖通常 5–10 篇，20 条 ≈0.1 元/run 是
 *   「够用且心疼」的量级；`local` 抓取不计也不拦。
 * - `MAX_BILLED_CALLS_PER_DAY = 500`：**单 run 配额挡不住跨 run 累积**——
 *   一小时 20 个 run × 15 次搜索 = 1.5 元，没人会看。500 次/天 = 2.5 元/天上界。
 */
export const MAX_SEARCH_PER_RUN = 15;
export const MAX_DEEPSEEK_FETCH_PER_RUN = 20;
export const MAX_BILLED_CALLS_PER_DAY = 500;

export const DEFAULT_ALLOWED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml',
];

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; VesselWebFetch/0.1; +https://github.com/vessel-agent/vessel)';

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * 插件配置从 `packages/config` 送来时**已经被 snake→camel 转过**
 * （`plugins[].config.search_provider` → `searchProvider`）。本文件的读法统一按
 * snake_case 写（`search_provider`），所以这里补一层归一：两种拼写都认，
 * **snake 优先**（显式按插件文档写的那个赢）。
 *
 * 为什么不在每个 read 里传两个名字：本文件有 40+ 个键，逐个写两遍必然漏。
 * 一行归一把「漏一个键就静默失效」这类事故从根上关掉。
 */
function normalizeKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    out[snake] = value;
  }
  // 原样拼写也放进去（snake 优先：先写的不会被覆盖）
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

function readInt(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function readBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const lowered = raw.trim().toLowerCase();
    if (lowered === 'true' || lowered === '1' || lowered === 'yes') return true;
    if (lowered === 'false' || lowered === '0' || lowered === 'no') return false;
  }
  return fallback;
}

function readString(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback;
}

function readStringArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().toLowerCase();
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
  }
  return out.length > 0 ? out : fallback;
}

/** 白名单允许显式空数组（「一个都不放行」是有意义的意图，不能回落成缺省） */
function readHostList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().toLowerCase();
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function readRenderer(raw: unknown): WebFetchRenderer {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'browser' || value === 'jina' || value === 'none') return value;
  return 'none';
}

function readApproval(raw: unknown): WebFetchApproval {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'open' || value === 'guarded' || value === 'locked') return value;
  return 'open';
}

function readDetail(raw: unknown, fallback: SearchDetail): SearchDetail {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'brief' || value === 'full') return value;
  return fallback;
}

/** 环境变量**名**的形态校验：把「把 key 明文写进配置」这种错误在 install 时就打回 */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readEnvName(raw: unknown, fallback: string, key: string): string {
  if (raw === undefined || raw === null) return fallback;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return fallback;
  if (!ENV_NAME_PATTERN.test(value)) {
    throw new Error(
      `web-tools: ${key} 必须是环境变量名（如 DEEPSEEK_API_KEY），不接受 key 本身；实际长度 ${value.length}`,
    );
  }
  return value;
}

function readBackend(raw: unknown): FetchBackendId {
  if (raw === undefined || raw === null) return 'local';
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === '') return 'local';
  if (value === 'local' || value === 'deepseek') return value;
  throw new Error(`web-tools: backend 只支持 local | deepseek，收到 ${String(raw)}`);
}

/**
 * 搜索后端 id 的形态：内置后端（`tavily`）或声明式后端（`custom:<id>`）。
 * 存在性在调用时判（注册表在插件内，让 config.ts 依赖注册表会形成环）。
 */
const SEARCH_PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,31}(:[a-z0-9][a-z0-9_-]{0,31})?$/;

function readSearchProvider(raw: unknown): string {
  if (raw === undefined || raw === null) return 'auto';
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === '') return 'auto';
  if (!SEARCH_PROVIDER_PATTERN.test(value)) {
    throw new Error(
      `web-tools: search_provider 必须是 auto 或后端 id（小写字母/数字/-/_，例 tavily），收到 ${JSON.stringify(String(raw).slice(0, 40))}`,
    );
  }
  return value;
}

function readBaseUrl(raw: unknown): string {
  const value = readString(raw, DEFAULT_BASE_URL).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`web-tools: base_url 无法解析：${value.slice(0, 200)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`web-tools: base_url 只允许 http/https，收到 ${parsed.protocol}`);
  }
  return value;
}

/**
 * 声明式自定义后端：整段配置交给 `parseCustomSearchSpec` 校验。
 *
 * **配置错在这里抛**（非法 url / 非法占位符 / `field_map` 写了无处安放的字段 /
 * `limits.requires` 声明了却没写占位符）——不留到运行期才炸。
 */
function readCustomSearch(raw: unknown): CustomSearchSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('web-tools: custom_search 必须是数组');
  return raw.map((item, index) => parseCustomSearchSpec(item, `custom_search[${index}]`));
}

/** 注意：`max_bytes` 的默认值是 5 MiB（本单口径）；研究稿 §5.5 表里写的是 2 MiB，这里按本单执行。 */
export function parseWebToolsConfig(raw: unknown): WebToolsConfig {
  const cfg = normalizeKeys(asRecord(raw));
  const backend = readBackend(cfg.backend);
  const renderer = readRenderer(cfg.renderer);
  if (backend === 'deepseek' && renderer !== 'none') {
    // 设计 §10 第 6 条：provider 已经返回 Markdown，再谈二级渲染没有意义。
    // 冲突配置直接报错，**不静默取其一**。
    throw new Error(
      `web-tools: backend=deepseek 与 renderer=${renderer} 是冲突配置（上游已返回 Markdown）；请把 renderer 设为 none`,
    );
  }

  const fetchCacheTtlDefaultS = backend === 'deepseek' ? 1800 : 0;

  return {
    maxBytes: readInt(cfg.max_bytes, DEFAULT_MAX_BYTES, 1024, 8 * 1024 * 1024),
    timeoutMs: readInt(cfg.timeout_ms, DEFAULT_TIMEOUT_MS, 500, 60_000),
    maxRedirects: readInt(cfg.max_redirects, 5, 0, 10),
    maxChars: readInt(cfg.max_chars, DEFAULT_MAX_CHARS, 200, MAX_MAX_CHARS),
    linksLimit: readInt(cfg.links_limit, 20, 0, 100),
    allowedContentTypes: readStringArray(cfg.allowed_content_types, DEFAULT_ALLOWED_CONTENT_TYPES),
    respectRobots: readBool(cfg.respect_robots, true),
    robotsTtlMs: readInt(cfg.robots_ttl_ms, 12 * 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000),
    userAgent: readString(cfg.user_agent, DEFAULT_USER_AGENT),
    allowPrivateNetworks: readBool(cfg.allow_private_networks, false),
    allowHttpsToHttp: readBool(cfg.allow_https_to_http, false),
    domainAllowlist: readStringArray(cfg.domain_allowlist, []),
    domainDenylist: readStringArray(cfg.domain_denylist, []),
    approval: readApproval(cfg.approval),
    renderer,

    backend,
    searchProvider: readSearchProvider(cfg.search_provider),
    alwaysRegister: readBool(cfg.always_register, false),
    customSearch: readCustomSearch(cfg.custom_search),
    baseUrl: readBaseUrl(cfg.base_url),
    keyEnv: readEnvName(cfg.key_env, DEFAULT_KEY_ENV, 'key_env'),
    searchKeyEnv: readEnvName(cfg.search_key_env, '', 'search_key_env'),
    fetchKeyEnv: readEnvName(cfg.fetch_key_env, '', 'fetch_key_env'),
    allowModelBackendOverride: readBool(cfg.allow_model_backend_override, false),
    apiTimeoutMs: readInt(cfg.api_timeout_ms, DEFAULT_API_TIMEOUT_MS, 1_000, 60_000),
    searchDetailDefault: readDetail(cfg.search_detail_default, 'brief'),
    // 都不得 ≥16,000：那是闸的口径，配置不能把它顶穿
    searchBudgetBriefTokens: readInt(cfg.search_budget_brief_tokens, 4_000, 1_000, 12_000),
    searchBudgetFullTokens: readInt(cfg.search_budget_full_tokens, 8_000, 1_000, 12_000),
    searchSummaryMaxChars: readInt(cfg.search_summary_max_chars, 800, 200, 2_000),
    searchContentMaxChars: readInt(cfg.search_content_max_chars, 600, 200, 2_000),
    searchCountMax: readInt(cfg.search_count_max, 50, 1, 50),
    searchCacheTtlMs: readInt(cfg.search_cache_ttl_s, 600, 0, 86_400) * 1000,
    searchCacheMaxEntries: readInt(cfg.search_cache_max_entries, 128, 0, 1_024),
    fetchCacheTtlMs: readInt(cfg.fetch_cache_ttl_s, fetchCacheTtlDefaultS, 0, 86_400) * 1000,
    retryMax: readInt(cfg.retry_max, 2, 0, 3),
    retryBaseMs: readInt(cfg.retry_base_ms, 400, 100, 2_000),
    searchQps: readInt(cfg.search_qps, 5, 1, 100),
    fetchQps: readInt(cfg.fetch_qps, 3, 1, 100),
    fetchHostMinIntervalMs: readInt(cfg.fetch_host_min_interval_ms, 500, 0, 10_000),
    maxUsesSearchPerRun: readInt(cfg.max_uses_search_per_run, MAX_SEARCH_PER_RUN, 1, 200),
    maxUsesFetchPerRun: readInt(cfg.max_uses_fetch_per_run, MAX_DEEPSEEK_FETCH_PER_RUN, 1, 200),
    maxBilledCallsPerDay: readInt(
      cfg.max_billed_calls_per_day,
      MAX_BILLED_CALLS_PER_DAY,
      1,
      10_000,
    ),
    breakerFailures: readInt(cfg.breaker_failures, 5, 1, 100),
    breakerOpenMs: readInt(cfg.breaker_open_ms, 60_000, 1_000, 3_600_000),
    deepseekFetchBlockQueryString: readBool(cfg.deepseek_fetch_block_query_string, true),
    deepseekFetchAllowQueryStringHosts: readHostList(cfg.deepseek_fetch_allow_query_string_hosts),
  };
}

/** 旧名字（M1 起的导出点）；返回的是 0.56 的超集 */
export function parseWebFetchConfig(raw: unknown): WebToolsConfig {
  return parseWebToolsConfig(raw);
}

/** 工具参数里的 `max_chars` 覆盖配置，同样夹紧（上界 = MAX_MAX_CHARS = 32,000）。 */
export function withMaxChars(config: WebFetchConfig, raw: unknown): WebFetchConfig {
  if (raw === undefined || raw === null) return config;
  return { ...config, maxChars: readInt(raw, config.maxChars, 200, MAX_MAX_CHARS) };
}

/** content-type 白名单判定：精确匹配，或 `+xml`/`+json` 后缀归到对应基础类型。 */
export function isAllowedContentType(mime: string, allowed: string[]): boolean {
  const normalized = mime.trim().toLowerCase();
  if (normalized === '') return false;
  if (allowed.includes(normalized)) return true;
  if (normalized.endsWith('+xml') && allowed.includes('application/xml')) return true;
  if (normalized.endsWith('+json') && allowed.includes('application/json')) return true;
  return false;
}
