/**
 * `deepseek` 抓取后端：把 URL 交给服务端抓取，拿回 Markdown。
 *
 * 这一节最容易被做假的地方（设计 §2.4 / §9.1）：**不许用空值冒充能力**。
 *   - `status` 只能固定 200 且 `status_source: "api"`（它不代表目标站点状态）；
 *   - `redirects: []` 必须配 `redirects_known: false`；
 *   - `links: []` 必须配 `links_source: "none"`；
 *   - `bytes` 是正文的 UTF-8 字节 ⇒ `bytes_source: "extracted-text"`；
 *   - `robots` 只能是 `unknown`（服务端是否遵守 robots 不可知，绝不写 respected）。
 *
 * 安全含义（§6.3）：
 * - 我们只做**语法校验**（scheme / port / userinfo / 长度），不做 DNS/IP 判定
 *   （请求目标是 api.deepseek.com，「这域名解析到内网」没有意义）；
 * - 内网不可达是**特性**，文案不许写成「我们拦住了内网」；
 * - 新增风险 = **数据外发** ⇒ `deepseek_fetch_block_query_string` 缺省开。
 */

import type { WebToolsConfig } from './config';
import {
  callDeepSeekTool,
  DEEPSEEK_FETCH_PATH,
  type DeepSeekDeps,
  pickString,
} from './deepseek-client';
import type { FetchBackend, FetchRequest } from './fetch/provider';
import { checkUrl } from './ssrf';
import { WebFetchError, type WebFetchResult } from './types';

const MAX_URL_CHARS = 2_048;

function hostMatches(host: string, entries: readonly string[]): boolean {
  return entries.some((entry) => {
    const cleaned = entry.startsWith('.') ? entry.slice(1) : entry;
    return cleaned !== '' && (host === cleaned || host.endsWith(`.${cleaned}`));
  });
}

/**
 * 本地校验（**不发请求**）：
 * 1. 语法（scheme / 端口 / userinfo / 长度）——保证契约一致与快速失败；
 * 2. 私网/环回**字面量**直接拒（明确报错，而不是把垃圾交给服务端）；
 * 3. query string 策略（缺省拦，白名单显式放行）。
 */
export function validateDeepSeekFetchUrl(rawUrl: string, config: WebToolsConfig): URL {
  const input = rawUrl.trim();
  if (input === '') throw new WebFetchError('invalid_input', 'url 不能为空');
  if (input.length > MAX_URL_CHARS) {
    throw new WebFetchError('invalid_input', `url 过长（${input.length} > ${MAX_URL_CHARS} 字符）`);
  }

  let checked: ReturnType<typeof checkUrl>;
  try {
    checked = checkUrl(input, {
      allowPrivateNetworks: false,
      domainAllowlist: config.domainAllowlist,
      domainDenylist: config.domainDenylist,
    });
  } catch (error) {
    if (error instanceof WebFetchError && error.code === 'blocked_url') {
      throw new WebFetchError(
        'blocked_url',
        `${error.message}；另外注意：deepseek 后端在服务端抓取，内网/环回/本机地址对它不可达（这是后端特性，不是我们拦住了内网）；内网或离线调试请用 backend=local`,
        { url: input },
      );
    }
    throw error;
  }

  const url = checked.url;
  if (config.deepseekFetchBlockQueryString && url.search !== '') {
    if (!hostMatches(checked.host, config.deepseekFetchAllowQueryStringHosts)) {
      throw new WebFetchError(
        'blocked_by_policy',
        `这是 deepseek 后端的默认策略：带 query string 的 URL 不交给第三方抓取（里面常带一次性 token / 会话 id / 邮箱）。` +
          '两种放行方式：把主机加进 deepseek_fetch_allow_query_string_hosts，或改用 backend=local',
        { url: url.href },
      );
    }
  }
  return url;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** 上游响应里取 Markdown 正文（形状未核 ⇒ 多路径防御，取不到就是 `extract_empty`） */
function extractMarkdown(payload: unknown): string | undefined {
  return pickString(payload, [
    ['content'],
    ['markdown'],
    ['text'],
    ['body'],
    ['data', 'content'],
    ['data', 'markdown'],
    ['data', 'text'],
    ['result', 'content'],
    ['result', 'markdown'],
  ]);
}

export const deepseekFetchBackend: FetchBackend = {
  id: 'deepseek',
  billed: true,
  requiresKey: true,

  validate(request: FetchRequest): void {
    validateDeepSeekFetchUrl(request.url, request.config);
  },

  async fetch(request: FetchRequest): Promise<WebFetchResult> {
    const config = request.config;
    const url = validateDeepSeekFetchUrl(request.url, config);
    const apiDeps: DeepSeekDeps = {
      ...(request.deps.fetch !== undefined ? { fetch: request.deps.fetch } : {}),
      ...(request.deps.now !== undefined ? { now: request.deps.now } : {}),
      ...(request.api ?? {}),
    };

    const response = await callDeepSeekTool({
      config,
      keyKind: 'fetch',
      path: DEEPSEEK_FETCH_PATH,
      body: { url: url.href },
      backoff: request.backoff,
      deps: apiDeps,
      badRequestHint: '检查 URL 是否可公开访问（内网/环回地址服务端不可达）',
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });

    const markdown = extractMarkdown(response.json);
    if (markdown === undefined || markdown.trim() === '') {
      // 没拿到正文 ⇒ 不计费；不许返回 ok:true + 空正文冒充成功
      throw new WebFetchError(
        'extract_empty',
        '服务端没有返回正文（本次不计费，也不降级到 local 后端）',
        { url: url.href },
      );
    }

    const title =
      pickString(response.json, [['title'], ['data', 'title'], ['result', 'title']]) ?? '';
    const now = request.deps.now ?? (() => Date.now());

    return {
      ok: true,
      // 服务端跳链不可见 ⇒ `url` 只是我们请求的那个
      url: url.href,
      requested_url: request.url,
      status: 200,
      status_source: 'api',
      content_type: 'text/markdown; charset=utf-8',
      format: 'markdown',
      bytes: byteLength(markdown),
      bytes_source: 'extracted-text',
      fetched_at: new Date(now()).toISOString(),
      title,
      text: markdown,
      truncated: false,
      links: [],
      links_source: 'none',
      redirects: [],
      redirects_known: false,
      robots: 'unknown',
      backend: 'deepseek',
    };
  },
};
