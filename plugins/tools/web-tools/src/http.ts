/**
 * 一级抓取：纯 HTTP + 受控重定向。
 *
 * 关键点（都是安全边界，改动前先想清楚）：
 * - `redirect: 'manual'`：绝不让 fetch 自己跟跳，否则 SSRF 校验只在第一跳生效；
 * - 每一跳都重新 `checkUrl` + 重新解析 DNS 并校验 IP；
 * - 整体一个 deadline（`timeout_ms`），不是「每跳一个」——否则 6 跳能拖 60s；
 * - 先看 `content-length` 再流式读，边读边计数，超限立刻 cancel。
 */

import { lookup } from 'node:dns/promises';

import { isAllowedContentType, type WebFetchConfig } from './config';
import { extractDocument } from './extract';
import {
  allowAllRules,
  disallowAllRules,
  parseRobotsTxt,
  RobotsCache,
  type RobotsRules,
} from './robots';
import { assertAddressAllowed, type CheckedUrl, checkUrl, type UrlPolicy } from './ssrf';
import { WebFetchError, type WebFetchResult } from './types';

export interface WebFetchDeps {
  /** 注入点：探针用替身，生产用全局 fetch */
  fetch?: typeof fetch;
  /** 注入点：DNS 解析（返回全部 A/AAAA） */
  resolveHost?: (host: string) => Promise<string[]>;
  /** 注入点：时钟 */
  now?: () => number;
  /** 注入点：robots 缓存（探针用来断言同源只拉一次） */
  robotsCache?: RobotsCache;
}

export interface FetchPageOptions {
  config: WebFetchConfig;
  deps?: WebFetchDeps;
  signal?: AbortSignal;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function policyOf(config: WebFetchConfig): UrlPolicy {
  return {
    allowPrivateNetworks: config.allowPrivateNetworks,
    domainAllowlist: config.domainAllowlist,
    domainDenylist: config.domainDenylist,
  };
}

function requestHeaders(config: WebFetchConfig): Record<string, string> {
  return {
    'user-agent': config.userAgent,
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.1',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'cache-control': 'no-cache',
  };
}

/** DNS 解析 + 逐 IP 校验（rebinding 防护的「解析后校验」这一半，残留窗口见 ssrf.ts 注释）。 */
async function assertHostPublic(
  checked: CheckedUrl,
  resolveHost: (host: string) => Promise<string[]>,
  config: WebFetchConfig,
): Promise<void> {
  if (checked.isIpLiteral) return;
  let addresses: string[];
  try {
    addresses = await resolveHost(checked.host);
  } catch {
    throw new WebFetchError('dns_failed', `DNS 解析失败：${checked.host}`, {
      url: checked.url.href,
    });
  }
  if (addresses.length === 0) {
    throw new WebFetchError('dns_failed', `DNS 未返回任何地址：${checked.host}`, {
      url: checked.url.href,
    });
  }
  for (const address of addresses) {
    try {
      assertAddressAllowed(address, checked.host, config.allowPrivateNetworks);
    } catch (error) {
      if (error instanceof WebFetchError) {
        throw new WebFetchError(error.code, error.message, { url: checked.url.href });
      }
      throw error;
    }
  }
}

/**
 * 取 robots.txt 也走同一套逐跳校验：`redirect: 'manual'` + 最多 3 跳 + 每跳 checkUrl，
 * 免得 robots.txt 的 302 把请求带去 169.254.169.254。
 */
async function loadRobots(
  origin: string,
  config: WebFetchConfig,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<RobotsRules> {
  const policy = policyOf(config);
  let target = new URL('/robots.txt', origin);
  for (let hop = 0; hop < 3; hop += 1) {
    let checked: CheckedUrl;
    try {
      checked = checkUrl(target.href, policy);
    } catch {
      return disallowAllRules();
    }
    let response: Response;
    try {
      response = await doFetch(checked.url.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': config.userAgent, accept: 'text/plain,*/*' },
        signal,
      });
    } catch {
      // 网络层拿不到 robots.txt：保守视为全部禁止
      return disallowAllRules();
    }
    const location = response.headers.get('location');
    if (REDIRECT_STATUS.has(response.status) && location) {
      try {
        target = new URL(location, checked.url);
      } catch {
        return disallowAllRules();
      }
      continue;
    }
    if (response.status >= 500) return disallowAllRules();
    if (response.status < 200 || response.status >= 300) return allowAllRules();
    let raw: string;
    try {
      raw = await response.text();
    } catch {
      return disallowAllRules();
    }
    return parseRobotsTxt(raw.slice(0, 512 * 1024), config.userAgent);
  }
  return disallowAllRules();
}

async function assertRobotsAllowed(
  checked: CheckedUrl,
  config: WebFetchConfig,
  cache: RobotsCache,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<void> {
  const rules = await cache.get(checked.url.origin, () =>
    loadRobots(checked.url.origin, config, doFetch, signal),
  );
  const path = `${checked.url.pathname}${checked.url.search}`;
  if (!rules.isAllowed(path)) {
    throw new WebFetchError('blocked_by_robots', `robots.txt 不允许抓取 ${path}`, {
      url: checked.url.href,
    });
  }
}

async function readBodyLimited(
  response: Response,
  maxBytes: number,
  url: string,
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    const value = step.value;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new WebFetchError('too_large', `响应体超过 ${maxBytes} 字节上限`, { url });
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function filterSameOriginLinks(links: string[], base: URL, limit: number): string[] {
  if (limit <= 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const link of links) {
    if (out.length >= limit) break;
    let parsed: URL;
    try {
      parsed = new URL(link);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    if (parsed.origin !== base.origin) continue;
    parsed.hash = '';
    const href = parsed.href;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

interface RedirectOutcome {
  response: Response;
  checked: CheckedUrl;
  redirects: string[];
}

/** 把「失败就抛」的调用收成一个表达式，避免 `let x!: T` 这类靠 CFA 的写法。 */
async function attempt<T>(run: () => Promise<T>, onError: (error: unknown) => never): Promise<T> {
  try {
    return await run();
  } catch (error) {
    return onError(error);
  }
}

export async function fetchPage(
  rawUrl: string,
  options: FetchPageOptions,
): Promise<WebFetchResult> {
  const config = options.config;
  const deps = options.deps ?? {};
  const doFetch = deps.fetch ?? fetch;
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const now = deps.now ?? (() => Date.now());
  const robots = deps.robotsCache ?? new RobotsCache(config.robotsTtlMs);
  const policy = policyOf(config);

  const requested = rawUrl.trim();
  // 第一跳在开 timer 之前先做静态校验：连 URL 都不合法就不用建 controller 了
  checkUrl(requested, policy);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  /** 网络层错误 → 统一错误码。放这里是为了能读到 timedOut / 调用方取消。 */
  const toWebFetchError = (error: unknown, url: string): never => {
    if (error instanceof WebFetchError) throw error;
    if (options.signal?.aborted && !timedOut) {
      throw new WebFetchError('connect_failed', '抓取被调用方取消', { url });
    }
    if (timedOut || (error as { name?: string } | null)?.name === 'AbortError') {
      throw new WebFetchError('timeout', `抓取超时（>${config.timeoutMs}ms）`, { url });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/certificate|tls|ssl|self-signed/i.test(message)) {
      throw new WebFetchError('tls_error', `TLS 握手失败：${message}`, { url });
    }
    throw new WebFetchError('connect_failed', `连接失败：${message}`, { url });
  };

  /** 跟随重定向（每跳重查），返回最后一跳的响应。 */
  const followRedirects = async (): Promise<RedirectOutcome> => {
    const redirects: string[] = [];
    let checked = checkUrl(requested, policy);
    for (let hop = 0; ; hop += 1) {
      await assertHostPublic(checked, resolveHost, config);
      if (config.respectRobots) {
        await assertRobotsAllowed(checked, config, robots, doFetch, controller.signal);
      }

      const response = await attempt(
        () =>
          doFetch(checked.url.href, {
            method: 'GET',
            redirect: 'manual',
            headers: requestHeaders(config),
            signal: controller.signal,
          }),
        (error) => toWebFetchError(error, checked.url.href),
      );

      const location = response.headers.get('location');
      if (REDIRECT_STATUS.has(response.status) && location !== null && location !== '') {
        if (hop >= config.maxRedirects) {
          throw new WebFetchError('too_many_redirects', `重定向超过 ${config.maxRedirects} 跳`, {
            url: checked.url.href,
          });
        }
        // 每跳重查：Location 由远端控制，必须当成不可信输入再走一遍全套判定
        const next = checkUrl(location, { ...policy, base: checked.url.href });
        if (
          checked.url.protocol === 'https:' &&
          next.url.protocol === 'http:' &&
          !config.allowHttpsToHttp
        ) {
          throw new WebFetchError('blocked_url', '禁止从 https 降级重定向到 http', {
            url: next.url.href,
          });
        }
        redirects.push(next.url.href);
        checked = next;
        continue;
      }
      return { response, checked, redirects };
    }
  };

  try {
    const { response, checked, redirects } = await followRedirects();
    const finalUrl = checked.url.href;
    const status = response.status;

    if (status >= 400) {
      throw new WebFetchError('http_error', `HTTP ${status}`, { url: finalUrl, status });
    }

    const contentTypeHeader = response.headers.get('content-type') ?? '';
    const mime = (contentTypeHeader.split(';')[0] ?? '').trim().toLowerCase();
    if (!isAllowedContentType(mime, config.allowedContentTypes)) {
      throw new WebFetchError(
        'unsupported_content_type',
        `content-type 不在白名单：${mime === '' ? '(缺失)' : mime}`,
        { url: finalUrl, status },
      );
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > config.maxBytes) {
      throw new WebFetchError(
        'too_large',
        `声明长度 ${declaredLength} 超过 ${config.maxBytes} 字节上限`,
        {
          url: finalUrl,
          status,
        },
      );
    }

    const bytes = await attempt(
      () => readBodyLimited(response, config.maxBytes, finalUrl),
      (error) => toWebFetchError(error, finalUrl),
    );

    // 只按 UTF-8 解：GBK/Shift-JIS 之类会乱码，M1 明确不做编码嗅探
    const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

    const isHtml = mime === 'text/html' || mime === 'application/xhtml+xml';
    const extracted = isHtml
      ? await extractDocument(bodyText, checked.url, {
          maxLinks: Math.max(config.linksLimit * 4, 40),
        })
      : { text: bodyText, title: '', links: [] };

    const truncated = extracted.text.length > config.maxChars;
    const text = truncated ? extracted.text.slice(0, config.maxChars) : extracted.text;
    if (text.trim() === '') {
      throw new WebFetchError(
        'extract_empty',
        '正文为空（可能是纯 JS 渲染页面，M1 不做无头渲染）',
        {
          url: finalUrl,
          status,
        },
      );
    }

    return {
      ok: true,
      url: finalUrl,
      requested_url: requested,
      status,
      content_type: contentTypeHeader.trim() === '' ? mime : contentTypeHeader.trim(),
      bytes: bytes.byteLength,
      fetched_at: new Date(now()).toISOString(),
      title: extracted.title,
      text,
      truncated,
      links: filterSameOriginLinks(extracted.links, checked.url, config.linksLimit),
      redirects,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}
