/**
 * 声明式「自定义搜索后端」：用**一段配置**描述一家同类 API，不再为每家写适配器。
 *
 * ## 能力边界（刻意很小，超出就退回专用适配器）
 *
 * 只支持「URL 固定 + 一种鉴权 + 请求体/查询串里的人字形占位符 + 点号路径取结果字段」。
 * **不做表达式语言**：出现 `if` / `map` / `filter` / 数组遍历 / 分页翻页 / 二次请求，
 * 就说明这家不适配声明式，写专用 `SearchProvider` 并说明原因。
 *
 * ## 五条硬约束
 *
 * 1. **占位符只能是字面替换**：`{{query}} {{count}} {{need_content}} {{freshness}}
 *    {{site}} {{lang}} {{after}} {{before}}`，没有函数、没有条件。
 * 2. **SSRF**：`url` 来自配置（人可信），但**必须 https**；`http` 只允许 loopback/私网
 *    （本地 SearxNG 是合法用途）。**工具入参永远不影响 host**（url 里出现 `{{` 直接拒）。
 * 3. **映射失败要响**：`results_path` 取不到 / 不是数组 / `field_map.url` 全空
 *    ⇒ `provider_schema_mismatch`，**绝不返回 0 条当成「没搜到」**。
 * 4. **闸只有一份**：这是普通 `SearchProvider`，走 `runWebSearch`
 *    ⇒ 预算 / 配额 / 缓存键（`custom:<id>` + 版本）/ 熔断 / 指标行 / `sk-` 擦除全部复用。
 * 5. **可见性同等**：注册进同一张表，`--tools` 的可用性预检一视同仁。
 *
 * ## 过滤条件的诚实处理
 *
 * 配置里有 `{{site}}` 才支持 `site`，有 `{{lang}}` 才支持 `lang`，有
 * `{{after}}`/`{{before}}`/`{{freshness}}` 才支持日期。**用户给了但映射不了 ⇒
 * `provider_bad_request` 说清楚**，不静默丢掉过滤（丢过滤比报错更坏：结果看着像过滤过）。
 */

import { hashKey } from '../cache';
import { createJsonHttp, type ProviderHttp } from '../provider-http';
import { isBlockedIpv4Tuple, parseIpv4 } from '../ssrf';
import { WebFetchError } from '../types';
import {
  asRecord,
  type ProviderHttpOptions,
  type ProviderHttpResponse,
  type RawSearchEntry,
  type SearchHit,
  type SearchProvider,
  type SearchQuery,
} from './provider';

/** 注册 id 前缀：`custom:bocha`、`custom:searx` */
export const CUSTOM_PRESET_PREFIX = 'custom:';

/** 占位符（**只有这些**；不做表达式语言） */
export const CUSTOM_PLACEHOLDERS = [
  'query',
  'count',
  'need_content',
  'freshness',
  'site',
  'lang',
  'after',
  'before',
] as const;

export type CustomPlaceholder = (typeof CUSTOM_PLACEHOLDERS)[number];

/** `field_map`：只映射 `SearchHit` **真有**的字段（没有 destination 的一律不收，免得成哑配置） */
export interface CustomFieldMap {
  title?: string;
  url: string;
  summary?: string;
  content?: string;
  date?: string;
}

export interface CustomSearchSpec {
  /** 短名 ⇒ 注册为 `custom:<id>` */
  id: string;
  request: {
    url: string;
    method: 'POST' | 'GET';
    /** query 放 body 还是放 URL 查询串 */
    queryIn: 'body' | 'query';
    body: Record<string, unknown>;
    headers: Record<string, string>;
  };
  auth: {
    style: 'bearer' | 'header' | 'query';
    /** `header`/`query` 用：头名或参数名 */
    headerName?: string;
    keyEnv: string;
  };
  response: {
    /** 点号路径，例如 `data.webPages.value` */
    resultsPath: string;
    fieldMap: CustomFieldMap;
  };
  limits: {
    /** 上游条数上限 */
    maxCount?: number;
    /** 声明「这套配置必须用到的占位符」；缺了就是配置错误（不是运行期才发现） */
    requires: CustomPlaceholder[];
  };
}

// ---------------------------------------------------------------- 配置解析

/** 递归把 camelCase 键转成 snake_case（配置层会把 `plugins[].config` 整棵树转成 camel） */
function deepSnakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => deepSnakeKeys(item));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    out[snake] = deepSnakeKeys(item);
  }
  return out;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`web-tools: ${where} 必须是非空字符串`);
  }
  return value.trim();
}

function readStringMap(value: unknown, where: string): Record<string, string> {
  if (value === undefined) return {};
  const record = asRecord(deepSnakeKeys(value));
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string') throw new Error(`web-tools: ${where}.${key} 必须是字符串`);
    out[key] = item;
  }
  return out;
}

/** `https`；`http` 只允许 loopback/私网（本地 SearxNG 等），**url 里不许有占位符** */
export function assertCustomUrl(raw: string, where: string): string {
  if (raw.includes('{{')) {
    throw new Error(
      `web-tools: ${where}.url 不允许占位符 —— host 只能来自配置，工具入参永远不能影响 host`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`web-tools: ${where}.url 不是合法 URL`);
  }
  if (parsed.protocol === 'https:') return parsed.href;
  if (parsed.protocol !== 'http:') {
    throw new Error(`web-tools: ${where}.url 只支持 http(s)，收到 ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    // 不带点的裸主机名 = 内网机器（Docker/K8s service、searx 之类）
    !host.includes('.');
  const ipv4 = parseIpv4(host);
  const privateV4 = ipv4 !== null && isBlockedIpv4Tuple(ipv4);
  if (loopback || privateV4) return parsed.href;
  throw new Error(
    `web-tools: ${where}.url 用 http 只允许 loopback/私网（例：http://127.0.0.1:8080/search），收到 ${host}；公网请用 https`,
  );
}

const CUSTOM_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** 解析并校验一段自定义后端配置（**配置错就在这里抛**，不留到运行期） */
export function parseCustomSearchSpec(raw: unknown, where: string): CustomSearchSpec {
  const spec = asRecord(deepSnakeKeys(raw));

  const id = requireString(spec.id, `${where}.id`);
  if (!CUSTOM_ID.test(id)) {
    throw new Error(`web-tools: ${where}.id 只允许小写字母/数字/-/_（≤32 字符），收到 ${id}`);
  }
  if (
    id === 'deepseek' ||
    id === 'tavily' ||
    id === 'serper' ||
    id === 'custom' ||
    id === 'bocha'
  ) {
    throw new Error(
      `web-tools: ${where}.id=${id} 与内置后端重名（bocha 是内置预设，用 search_provider: bocha 选中它），换个名字`,
    );
  }

  const request = asRecord(spec.request);
  const url = assertCustomUrl(
    requireString(request.url, `${where}.request.url`),
    `${where}.request`,
  );
  const methodRaw = requireString(
    request.method ?? 'POST',
    `${where}.request.method`,
  ).toUpperCase();
  if (methodRaw !== 'POST' && methodRaw !== 'GET') {
    throw new Error(`web-tools: ${where}.request.method 只支持 POST | GET`);
  }
  const queryInRaw = requireString(request.query_in ?? 'body', `${where}.request.query_in`);
  if (queryInRaw !== 'body' && queryInRaw !== 'query') {
    throw new Error(`web-tools: ${where}.request.query_in 只支持 body | query`);
  }
  if (methodRaw === 'GET' && queryInRaw === 'body') {
    throw new Error(`web-tools: ${where}.request: GET 必须配 query_in: query（GET 没有 body）`);
  }

  const auth = asRecord(spec.auth);
  const styleRaw = requireString(auth.style ?? 'bearer', `${where}.auth.style`);
  if (styleRaw !== 'bearer' && styleRaw !== 'header' && styleRaw !== 'query') {
    throw new Error(`web-tools: ${where}.auth.style 只支持 bearer | header | query`);
  }
  const headerName =
    styleRaw === 'bearer'
      ? undefined
      : requireString(auth.header_name, `${where}.auth.header_name`);
  const keyEnv = requireString(auth.key_env, `${where}.auth.key_env`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) {
    throw new Error(`web-tools: ${where}.auth.key_env 必须是环境变量名（只存名字，不存值）`);
  }

  const response = asRecord(spec.response);
  const resultsPath = requireString(response.results_path, `${where}.response.results_path`);
  const rawFieldMap = asRecord(response.field_map);
  const allowedFields = ['title', 'url', 'summary', 'content', 'date'];
  for (const key of Object.keys(rawFieldMap)) {
    if (!allowedFields.includes(key)) {
      throw new Error(
        `web-tools: ${where}.response.field_map.${key} 无处安放：SearchHit 只有 ${allowedFields.join(' / ')}` +
          `（site/icon 之类要么没有 destination，要么会变成「拿域名冒充权威度」，不收）`,
      );
    }
  }
  const fieldMap: CustomFieldMap = {
    url: requireString(rawFieldMap.url, `${where}.response.field_map.url`),
    ...(typeof rawFieldMap.title === 'string' ? { title: rawFieldMap.title } : {}),
    ...(typeof rawFieldMap.summary === 'string' ? { summary: rawFieldMap.summary } : {}),
    ...(typeof rawFieldMap.content === 'string' ? { content: rawFieldMap.content } : {}),
    ...(typeof rawFieldMap.date === 'string' ? { date: rawFieldMap.date } : {}),
  };

  const limits = asRecord(spec.limits);
  const rawMax = limits.max_count;
  const maxCount =
    rawMax === undefined
      ? undefined
      : typeof rawMax === 'number' && rawMax > 0
        ? Math.floor(rawMax)
        : undefined;
  if (rawMax !== undefined && maxCount === undefined) {
    throw new Error(`web-tools: ${where}.limits.max_count 必须是正整数`);
  }
  const requiresRaw = limits.requires ?? [];
  if (!Array.isArray(requiresRaw))
    throw new Error(`web-tools: ${where}.limits.requires 必须是数组`);
  const requires: CustomPlaceholder[] = [];
  for (const item of requiresRaw) {
    if (typeof item !== 'string' || !CUSTOM_PLACEHOLDERS.includes(item as CustomPlaceholder)) {
      throw new Error(
        `web-tools: ${where}.limits.requires 只接受 ${CUSTOM_PLACEHOLDERS.join(' / ')}，收到 ${String(item)}`,
      );
    }
    requires.push(item as CustomPlaceholder);
  }

  const body = asRecord(deepSnakeKeys(request.body ?? {}));
  const headers = readStringMap(request.headers, `${where}.request.headers`);

  // requires 是「这套配置必须用到这些占位符」：声明了却没写 = 配置错，不留到运行期
  const used = collectPlaceholders({ body, headers });
  for (const name of requires) {
    if (!used.has(name)) {
      throw new Error(
        `web-tools: ${where}.limits.requires 声明了 ${name}，但 request.body/headers 里没有 {{${name}}} 占位符`,
      );
    }
  }

  return {
    id,
    request: { url, method: methodRaw, queryIn: queryInRaw, body, headers },
    auth: { style: styleRaw, ...(headerName !== undefined ? { headerName } : {}), keyEnv },
    response: { resultsPath, fieldMap },
    limits: { ...(maxCount !== undefined ? { maxCount } : {}), requires },
  };
}

// ---------------------------------------------------------------- 占位符

function collectPlaceholders(spec: {
  body: unknown;
  headers: Record<string, string>;
}): Set<CustomPlaceholder> {
  const used = new Set<CustomPlaceholder>();
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{([a-z_]+)\}\}/g)) {
        const name = match[1] ?? '';
        if (CUSTOM_PLACEHOLDERS.includes(name as CustomPlaceholder))
          used.add(name as CustomPlaceholder);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) scan(item);
    }
  };
  scan(spec.body);
  scan(spec.headers);
  return used;
}

/** `{{freshness}}` = `after..before`（两端都给）；都不给 = `noLimit`；只给一端 = 不可用 */
export function freshnessValue(query: SearchQuery): string | undefined {
  const iso = (value: string | undefined): string | undefined =>
    value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
  const after = iso(query.after);
  const before = iso(query.before);
  if (after !== undefined && before !== undefined) return `${after}..${before}`;
  if (query.after === undefined && query.before === undefined) return 'noLimit';
  return undefined;
}

type PlaceholderContext = Partial<Record<CustomPlaceholder, string | number | boolean>>;

function contextFor(query: SearchQuery): PlaceholderContext {
  const freshness = freshnessValue(query);
  return {
    query: query.query,
    count: query.count,
    need_content: query.needContent,
    ...(freshness !== undefined ? { freshness } : {}),
    ...(query.site !== undefined ? { site: query.site } : {}),
    ...(query.lang !== undefined ? { lang: query.lang } : {}),
    ...(query.after !== undefined ? { after: query.after } : {}),
    ...(query.before !== undefined ? { before: query.before } : {}),
  };
}

const WHOLE_PLACEHOLDER = /^\{\{([a-z_]+)\}\}$/;

/**
 * 替换占位符（**只做字面替换**）：
 * - 整个值就是一个占位符 ⇒ 保留原始类型（`"{{count}}"` → 数字，`"{{need_content}}"` → 布尔）；
 * - 占位符嵌在字符串里 ⇒ 拼字符串，缺值就整个键丢掉；
 * - 缺值的键**整条不出现**（不写 `null`，也不写空串——那会让上游以为我们传了东西）。
 */
function substitute(value: unknown, context: PlaceholderContext): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE_PLACEHOLDER.exec(value);
    if (whole !== null) return context[whole[1] as CustomPlaceholder];
    let missing = false;
    const replaced = value.replace(/\{\{([a-z_]+)\}\}/g, (_match, name: string) => {
      const resolved = context[name as CustomPlaceholder];
      if (resolved === undefined) {
        missing = true;
        return '';
      }
      return String(resolved);
    });
    return missing ? undefined : replaced;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((item) => substitute(item, context))
      .filter((item) => item !== undefined);
    return items;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const resolved = substitute(item, context);
      if (resolved !== undefined) out[key] = resolved;
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- 结果解析

/** 点号路径取值（`data.webPages.value`；支持数组下标 `items.0.title`） */
export function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (segment === '') continue;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    const record = asRecord(current);
    if (!(segment in record)) return undefined;
    current = record[segment];
  }
  return current;
}

// ---------------------------------------------------------------- provider 工厂

/** 这套配置的版本（进缓存键）：改任何一个字段 ⇒ 旧缓存自动失效 */
function specVersion(spec: CustomSearchSpec): string {
  return `1.${hashKey([spec]).slice(0, 8)}`;
}

/** 把一段声明式配置变成普通 `SearchProvider`（闸/缓存/指标全部复用共用层） */
export function createCustomProvider(
  spec: CustomSearchSpec,
  options: { id?: string } = {},
): SearchProvider {
  const providerId = options.id ?? `${CUSTOM_PRESET_PREFIX}${spec.id}`;
  const used = collectPlaceholders({ body: spec.request.body, headers: spec.request.headers });
  const supportsDates = used.has('after') || used.has('before') || used.has('freshness');
  return {
    // 内置预设用短名（`bocha`，用户不必记新名字）；用户自定义一律 `custom:<id>`
    id: providerId,
    version: specVersion(spec),
    billed: true,
    requiresKey: true,
    keyEnv: spec.auth.keyEnv,
    ...(spec.limits.maxCount !== undefined ? { maxCount: spec.limits.maxCount } : {}),

    // 声明式后端不替上游「翻译语法」：查询串原样，过滤条件走 body/headers
    renderQuery: (query: SearchQuery): string => query.query,

    /**
     * 这套配置**表达不了**的过滤条件 ⇒ 在发请求前就报错（0 请求），文案带下一步。
     *
     * 为什么不「省略 + 在结果里提示」：丢过滤 = 用户要的约束被静默放宽，
     * 而正文会被当成事实继续推理——正确性不该依赖「调用方一定读并一定在意那一行」。
     * 判据始终是：**宁可难看（可操作的报错），不许看着对（悄悄变宽的结果）**。
     */
    checkFilters(query: SearchQuery): void {
      const refuse = (what: string, next: string): never => {
        throw new WebFetchError(
          'provider_bad_request',
          `后端 ${providerId} 的声明式映射表达不了 ${what}。下一步：${next}（本次没有发出任何请求）`,
        );
      };
      if (query.site !== undefined && !used.has('site')) {
        refuse(
          'site（request.body 里没有 {{site}} 占位符）',
          '去掉 site，或改用支持站点过滤的后端（deepseek / serper），或在 custom_search 的 request.body 里加 "{{site}}"',
        );
      }
      if (query.lang !== undefined && !used.has('lang')) {
        refuse(
          'lang（request.body 里没有 {{lang}} 占位符）',
          '去掉 lang，或改用支持它的后端，或在 request.body 里加 "{{lang}}"',
        );
      }
      if ((query.after !== undefined || query.before !== undefined) && !supportsDates) {
        refuse(
          '按日期过滤（没有任何日期占位符）',
          '去掉 after/before，或改用支持日期过滤的后端（deepseek / serper）',
        );
      }
      if (
        (query.after !== undefined || query.before !== undefined) &&
        contextFor(query).freshness === undefined
      ) {
        refuse(
          '单边日期（{{freshness}} 只接受完整的 after..before 区间）',
          '同时给 after 和 before，或两个都不给',
        );
      }
    },

    createHttp(options: ProviderHttpOptions): ProviderHttp {
      const headers =
        spec.auth.style === 'bearer'
          ? (key: string) => ({ authorization: `Bearer ${key}` })
          : spec.auth.style === 'header'
            ? (key: string) => ({ [spec.auth.headerName ?? 'x-api-key']: key })
            : undefined;
      return createJsonHttp({
        config: options.config,
        keyKind: 'search',
        keyEnvName: options.keyEnvName,
        endpoint: spec.request.url,
        ...(headers !== undefined ? { authHeaders: headers } : {}),
        ...(spec.auth.style === 'query'
          ? { authQuery: (key: string) => ({ [spec.auth.headerName ?? 'key']: key }) }
          : {}),
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
      // 过滤条件已在 `checkFilters` 里判过（表达不了就在发请求前拒了）。
      // 这里只做映射：占位符解析为空 ⇒ 整条键省略（映射规则，不需要表达式语言）。
      const context = contextFor({ ...query, query: renderedQuery });

      const resolvedBody = substitute(spec.request.body, context);
      const resolvedHeaders = substitute(spec.request.headers, context);
      const asQuery = spec.request.queryIn === 'query';

      return http.postJson({
        path: '',
        method: spec.request.method,
        body: asQuery ? undefined : resolvedBody,
        ...(asQuery ? { query: stringifyParams(resolvedBody) } : {}),
        hint: '检查 query 是否为空、占位符的值是否合法；声明式后端的报错来自上游',
        ...(Object.keys(resolvedHeaders as Record<string, string>).length > 0
          ? { headers: resolvedHeaders as Record<string, string> }
          : {}),
      });
    },

    parseEntries(payload: unknown): RawSearchEntry[] {
      const entries = resolvePath(payload, spec.response.resultsPath);
      if (!Array.isArray(entries)) {
        // 这里**绝不能**返回 []：0 条 = 「上游说没有」，形状不对 = 「配置和上游不一致」
        throw new WebFetchError(
          'provider_schema_mismatch',
          `自定义后端 ${CUSTOM_PRESET_PREFIX}${spec.id} 的 results_path=${spec.response.resultsPath} 取不到数组` +
            `（实际类型：${entries === undefined ? 'undefined（路径不存在）' : typeof entries}）；` +
            '检查 response.results_path 或上游是否改了响应形状',
        );
      }
      return entries.map((item) => asRecord(item));
    },

    normalize(entry: RawSearchEntry): SearchHit | null {
      const map = spec.response.fieldMap;
      const rawUrl = pickString(entry, map.url);
      if (rawUrl === undefined) return null;
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return null;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      const summary = map.summary !== undefined ? pickString(entry, map.summary) : undefined;
      const content = map.content !== undefined ? pickString(entry, map.content) : undefined;
      const date = map.date !== undefined ? pickString(entry, map.date) : undefined;
      const title = map.title !== undefined ? pickString(entry, map.title) : undefined;
      return {
        title: title ?? '',
        url: parsed.href,
        summary: summary ?? '',
        ...(content !== undefined && content !== summary ? { content } : {}),
        ...(date !== undefined ? { date } : {}),
      };
    },
  };
}

/** GET/查询串模式：值一律转字符串（`URLSearchParams` 只认字符串） */
function stringifyParams(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (item === undefined || item === null) continue;
    out[key] = typeof item === 'string' ? item : JSON.stringify(item);
  }
  return out;
}

// ---------------------------------------------------------------- 内置预设

/**
 * Bocha 的内置预设（`search_provider: custom:bocha` 即可用，零配置）。
 *
 * 字段对应：`name`→title、`url`→url、`snippet`→summary、`summary`（`summary: true` 才回）
 * →content、`datePublished`→date；`siteName`/`siteIcon`/`image` **无处安放就不映射**
 * （`field_map` 里干脆没有它们——写进来会变成哑配置）。
 */
export const BOCHA_PRESET: CustomSearchSpec = {
  id: 'bocha',
  request: {
    url: 'https://api.bocha.cn/v1/web-search',
    method: 'POST',
    queryIn: 'body',
    body: {
      query: '{{query}}',
      summary: '{{need_content}}',
      freshness: '{{freshness}}',
      count: '{{count}}',
    },
    headers: {},
  },
  auth: { style: 'bearer', keyEnv: 'BOCHAAI_SEARCH_API_KEY' },
  response: {
    resultsPath: 'data.webPages.value',
    fieldMap: {
      title: 'name',
      url: 'url',
      summary: 'snippet',
      content: 'summary',
      date: 'datePublished',
    },
  },
  limits: { maxCount: 50, requires: ['freshness'] },
};

/** `field_map` 的取值：点号路径 + 只认非空字符串（数字/布尔不硬转，免得编数据） */
function pickString(entry: RawSearchEntry, path: string): string | undefined {
  const value = resolvePath(entry, path);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}

/** 注册一组自定义后端（同 id 后注册者胜：用户配置覆盖内置预设） */
export function registerCustomSearchProviders(
  specs: readonly CustomSearchSpec[],
  register: (provider: SearchProvider) => void,
): void {
  for (const spec of specs) register(createCustomProvider(spec));
}
