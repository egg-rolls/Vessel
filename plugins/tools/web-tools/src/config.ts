/**
 * 配置解析：插件 config（`plugins[].config`）+ 工具参数 都从这里收敛成一份强类型。
 * 所有上限都夹紧（clamp），配置写错不会把宿主拖死。
 */

export type WebFetchRenderer = 'none' | 'browser' | 'jina';
export type WebFetchApproval = 'open' | 'guarded' | 'locked';

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

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_CHARS = 8_000;

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

/** 注意：`max_bytes` 的默认值是 5 MiB（本单口径）；研究稿 §5.5 表里写的是 2 MiB，这里按本单执行。 */
export function parseWebFetchConfig(raw: unknown): WebFetchConfig {
  const cfg = asRecord(raw);
  return {
    maxBytes: readInt(cfg.max_bytes, DEFAULT_MAX_BYTES, 1024, 8 * 1024 * 1024),
    timeoutMs: readInt(cfg.timeout_ms, DEFAULT_TIMEOUT_MS, 500, 60_000),
    maxRedirects: readInt(cfg.max_redirects, 5, 0, 10),
    maxChars: readInt(cfg.max_chars, DEFAULT_MAX_CHARS, 200, 200_000),
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
    renderer: readRenderer(cfg.renderer),
  };
}

/** 工具参数里的 `max_chars` 覆盖配置，同样夹紧。 */
export function withMaxChars(config: WebFetchConfig, raw: unknown): WebFetchConfig {
  if (raw === undefined || raw === null) return config;
  return { ...config, maxChars: readInt(raw, config.maxChars, 200, 200_000) };
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
