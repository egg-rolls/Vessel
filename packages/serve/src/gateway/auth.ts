/**
 * Gateway 鉴权 / 监听边界辅助 — 无状态纯函数与文件读取。
 *
 * @module @vessel-agent/serve/gateway/auth
 */

import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

/** 回环判定：localhost / 127.0.0.0/8 / ::1（可带方括号） */
export function isLoopbackHostname(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '::1') return true;
  return isIP(lower) === 4 && lower.startsWith('127.');
}

/** 通配绑定：0.0.0.0 / ::（可带方括号） */
export function isWildcardHostname(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return host === '0.0.0.0' || host === '::';
}

/** 读取 TLS 证书/私钥；空文件与不可读都给出明确错误 */
export function loadTlsMaterial(tls: { certFile: string; keyFile: string }): {
  cert: string;
  key: string;
} {
  if (!tls.certFile || !tls.keyFile) {
    throw new Error('serve.tls requires both cert_file and key_file.');
  }
  const read = (path: string, label: 'cert_file' | 'key_file'): string => {
    try {
      const content = readFileSync(path, 'utf8');
      if (content.trim().length === 0) throw new Error('file is empty');
      return content;
    } catch (error) {
      const detail =
        (error as NodeJS.ErrnoException).code ??
        (error instanceof Error ? error.message : String(error));
      throw new Error(`Failed to read TLS ${label} "${path}": ${detail}`);
    }
  };
  return { cert: read(tls.certFile, 'cert_file'), key: read(tls.keyFile, 'key_file') };
}

/**
 * 归一化 CORS/WS Origin allowlist：只接受显式 http(s) origin。
 * 拒绝 `*`、path/query/hash/userinfo；保存 `URL.origin`（小写 host、去默认端口）。
 */
export function normalizeAllowedOrigins(raw: string[] | undefined): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error('allowedOrigins must be an array of explicit http(s) origins.');
  }
  const normalized = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') {
      throw new Error('allowedOrigins must contain strings.');
    }
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === '*') {
      throw new Error(
        'allowedOrigins must contain explicit origins; wildcard ("*") is not allowed.',
      );
    }
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(`Invalid allowed origin "${trimmed}": expected an absolute URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Invalid allowed origin "${trimmed}": only http(s) origins are allowed.`);
    }
    if (url.username !== '' || url.password !== '') {
      throw new Error(`Invalid allowed origin "${trimmed}": credentials are not allowed.`);
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      throw new Error(`Invalid allowed origin "${trimmed}": use scheme://host[:port] only.`);
    }
    normalized.add(url.origin);
  }
  return [...normalized];
}

/**
 * HTML CSP：connect-src 只放同源 Host 与显式 allowlist，不再使用裸 `ws:` / `wss:`。
 * 其余指令保持 0.5 的基线。
 */
export function buildContentSecurityPolicy(req: Request, allowedOrigins: string[]): string {
  const sources = new Set<string>(["'self'"]);
  const rawHost = req.headers.get('host');
  // Host 会进入 CSP 指令；只接受常规 host[:port] 字符，防止指令注入。
  const host = rawHost && /^[A-Za-z0-9.\-:[\]]+$/.test(rawHost) ? rawHost : null;
  if (host) {
    const secure = new URL(req.url).protocol === 'https:';
    sources.add(`${secure ? 'wss' : 'ws'}://${host}`);
  }
  for (const origin of allowedOrigins) {
    sources.add(origin);
    try {
      const url = new URL(origin);
      sources.add(`${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`);
    } catch {
      // normalizeAllowedOrigins 已校验；防御性跳过非法值。
    }
  }
  return (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    `img-src 'self' data:; font-src 'self'; connect-src ${[...sources].join(' ')}; ` +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
}

/** 判断 Host 是否指向回环地址（防 DNS rebinding） */
export function hostAllowed(req: Request, listenHost: string): boolean {
  const host = req.headers.get('host');
  if (!host) return true;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (isLoopbackHostname(hostname)) return true;
  // 通配绑定无法与 Host 精确比较；远程模式仍要求 token，浏览器 Origin 仍须同源。
  if (isWildcardHostname(listenHost)) return true;
  return hostname === listenHost.toLowerCase();
}

/** Origin 校验：无 Origin（curl / peer）放行；浏览器必须同源或在允许列表 */
export function originAllowed(req: Request, allowedOrigins: string[]): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // 只接受浏览器 http(s) origin；file:// / opaque origin 一律拒绝。
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (allowedOrigins.includes(parsed.origin)) return true;
  const host = req.headers.get('host');
  if (!host) return false;
  return parsed.host.toLowerCase() === host.toLowerCase();
}

/**
 * 允许列表命中时返回 CORS 头（同源不需要）。
 * allowlist 非空时所有响应都带 Vary: Origin，避免共享缓存把 A 的 ACAO 复用给 B。
 * 不使用 Access-Control-Allow-Credentials：鉴权走 Authorization，不依赖 cookie。
 */
export function corsHeaders(req: Request, allowedOrigins: string[]): Record<string, string> {
  if (allowedOrigins.length === 0) return {};
  const headers: Record<string, string> = { Vary: 'Origin' };
  const origin = req.headers.get('origin');
  if (!origin) return headers;
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return headers;
  }
  if (!allowedOrigins.includes(normalized)) return headers;
  return {
    ...headers,
    'Access-Control-Allow-Origin': normalized,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Vessel-Protocol',
    'Access-Control-Max-Age': '600',
  };
}
