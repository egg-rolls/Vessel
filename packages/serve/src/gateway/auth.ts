/**
 * Gateway 鉴权 / 监听边界辅助 — 无状态纯函数与文件读取。
 *
 * @module @vessel-agent/serve/gateway/auth
 */

import { createHash, timingSafeEqual } from 'node:crypto';
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

/**
 * 请求来源 socket 是否回环：127.0.0.0/8、::1、IPv4-mapped `::ffff:127.x.x.x`。
 * 只用于本机便利端点（如 `/v1/local/token`）的来源判定，不替代 Host / Origin 校验。
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (typeof address !== 'string' || address === '') return false;
  const lower = address.toLowerCase();
  if (lower === '::1') return true;
  const mapped = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
  return isIP(mapped) === 4 && mapped.startsWith('127.');
}

/**
 * 0.55 P0：反代密钥头（opt-in；默认不配置 = 行为逐字不变）。
 *
 * 反代与 gateway 同机时客户端 peer 恒为 127.0.0.1，回环地址不再是可信信号。
 * 配好 `serve.proxy_secret_env` / `gateway.proxy_secret_env` 之后，反代必须为
 * 每个请求注入这个头；缺头 / 不匹配的请求不再被当作回环客户端。
 * 头名以 `x-vessel-` 开头，插件反代（`plugin-host/proxy.ts`）会剥离客户端自带的同名头。
 */
export const PROXY_SECRET_HEADER = 'x-vessel-proxy-secret';

/**
 * 反代密钥是否成立。
 *
 * - 未配置（undefined / 空串）→ `true`：旧部署与旧调用方一字不改；
 * - 已配置 → 请求必须带同值头，比较用定长哈希 + 常量时间（不按字节提前返回）。
 */
export function proxySecretAllowed(req: Request, secret: string | undefined): boolean {
  if (typeof secret !== 'string' || secret === '') return true;
  const provided = req.headers.get(PROXY_SECRET_HEADER);
  if (typeof provided !== 'string' || provided === '') return false;
  const expected = createHash('sha256').update(secret).digest();
  const actual = createHash('sha256').update(provided).digest();
  return timingSafeEqual(expected, actual);
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
 * CSP 扩展源：0.49 平台入口用它允许嵌入 node 插件 iframe / 跨源连接。
 * 不传扩展源时输出与旧版逐字一致。
 */
export interface CspExtensionSources {
  /** 额外允许被嵌入的 frame 源（如 node origin）。 */
  frameSrc?: string[];
  /** 额外允许连接的源；自动补 ws/wss 变体。 */
  connectSrc?: string[];
}

/**
 * CSP source-list 不接受 IPv6 字面量（Chromium 会整条忽略并报
 * `invalid source`）。回环绑定会同时给出 `[::1]` 变体，这里统一跳过；
 * 页面仍可通过 `127.0.0.1` / `localhost` 访问。
 */
function cspSafeUrl(origin: string): URL | null {
  try {
    const url = new URL(origin);
    if (url.hostname.startsWith('[')) return null;
    return url;
  } catch {
    return null;
  }
}

/** 受信边缘输入：反代与 gateway 同机时，「谁给了 Host / 协议真值」的唯一依据。 */
export interface EdgeTrustInput {
  /** `srv.requestIP(req)?.address`；null / undefined 视为不受信。 */
  address?: string | null;
  /** `gateway.proxy_secret_env` 解析结果；未配置 / 空串 = undefined（旧行为）。 */
  proxySecret?: string | undefined;
  /**
   * `auth.trustedProxies`：受信代理地址（精确地址，或以 `.` 结尾的网段前缀）。
   * 缺省 = 只信回环 socket。显式配置后**替换**缺省，不再自动包含回环。
   */
  trustedProxies?: string[] | undefined;
}

/** 一次请求的边缘事实：Host 与协议的生效值 + 可信度。 */
export interface RequestEdge {
  /** 请求是否来自受信代理（此时才读 `X-Forwarded-*`）。 */
  viaProxy: boolean;
  /** 反代密钥头是否成立（未配置密钥时恒为 true）。 */
  proxySecretOk: boolean;
  /** 生效 Host（小写、含端口）；缺失 / 非法 = null。 */
  host: string | null;
  /** 生效协议（受信时代理说了算）。 */
  protocol: 'http' | 'https';
  /**
   * 本机直连：回环 socket ∧ 未经受信代理 ∧ Host 指向回环。
   * 反代同机时客户端 peer 也是回环，所以只靠地址无法区分；Host 是最后一个信号。
   */
  localDirect: boolean;
}

/** CSP 只需要这两个事实；单独成型便于在静态响应里复用同一次解析。 */
export interface CspRequestFacts {
  host: string | null;
  protocol: 'http' | 'https';
}

/** 常规 host[:port] 字符白名单（同时用于 CSP 指令注入防护）。 */
function safeHostValue(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const value = raw.trim().toLowerCase();
  if (!/^[a-z0-9.\-:[\]]+$/.test(value)) return null;
  return value;
}

/** 取的第一个非空值；`x-forwarded-host` 允许逗号链，取最左（原始客户端）。 */
function firstForwardedValue(raw: string | null): string | null {
  if (raw === null) return null;
  const first = raw.split(',')[0];
  return first === undefined ? null : safeHostValue(first);
}

/** 回环地址是否在受信代理列表内（支持精确地址与 `10.0.` 这种前缀）。 */
function addressInTrustedProxies(address: string, trustedProxies: string[]): boolean {
  const lower = address.toLowerCase();
  for (const raw of trustedProxies) {
    const entry = raw.trim().toLowerCase();
    if (entry === '') continue;
    if (entry.endsWith('.') || entry.endsWith(':')) {
      if (lower.startsWith(entry)) return true;
      continue;
    }
    if (lower === entry) return true;
  }
  return false;
}

/**
 * 解析本次请求的「边缘事实」（0.56）。
 *
 * 规则（fail-closed）：`X-Forwarded-Host` / `X-Forwarded-Proto` **只在**请求来自
 * 受信代理时被采信 —— 受信 = socket 在受信代理列表内（缺省回环）∧ 反代密钥成立。
 * 其它情况一律用请求自身（`Host` / `req.url`），因此伪造 Host 不会拿到公网身份。
 */
export function resolveRequestEdge(req: Request, trust: EdgeTrustInput = {}): RequestEdge {
  const proxySecretOk = proxySecretAllowed(req, trust.proxySecret);
  const address = typeof trust.address === 'string' ? trust.address : '';
  const addressTrusted =
    address !== '' &&
    (trust.trustedProxies !== undefined && trust.trustedProxies.length > 0
      ? addressInTrustedProxies(address, trust.trustedProxies)
      : isLoopbackAddress(address));
  const viaProxy = addressTrusted && proxySecretOk;

  const rawHost = safeHostValue(req.headers.get('host'));
  const forwardedHost = viaProxy ? firstForwardedValue(req.headers.get('x-forwarded-host')) : null;
  const host = forwardedHost ?? rawHost;

  const forwardedProto = viaProxy
    ? req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
    : undefined;
  const protocol: 'http' | 'https' =
    forwardedProto === 'https'
      ? 'https'
      : forwardedProto === 'http'
        ? 'http'
        : isHttpsRequest(req)
          ? 'https'
          : 'http';

  let hostname = '';
  if (host !== null) {
    try {
      hostname = new URL(`http://${host}`).hostname.toLowerCase();
    } catch {
      hostname = '';
    }
  }
  return {
    viaProxy,
    proxySecretOk,
    host,
    protocol,
    // 直连 = 回环 socket ∧ 未经受信代理 ∧ Host 指回环。反代与浏览器同机时
    // 两者都是回环 socket，只有 Host 能区分；不满足任一条就不算直连。
    localDirect:
      isLoopbackAddress(address) && !viaProxy && hostname !== '' && isLoopbackHostname(hostname),
  };
}

/** 请求自身是否 https（Bun 下 TLS 监听会给出 https: url）。 */
function isHttpsRequest(req: Request): boolean {
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * HTML CSP：connect-src 只放同源 Host 与显式 allowlist，不再使用裸 `ws:` / `wss:`。
 * 其余指令保持 0.5 的基线；`extend` 缺省时输出逐字不变。
 *
 * 0.56：`facts` 由受信边缘解析（`resolveRequestEdge`）给出。反代后面板
 * `req.url` 恒为 `http:`，只看它会给 https 页面下发 `ws://` 并被浏览器拦掉；
 * 传 `facts` 时以「有效 host / 有效协议」为准，不传时逐字保持旧行为。
 */
export function buildContentSecurityPolicy(
  req: Request,
  allowedOrigins: string[],
  extend?: CspExtensionSources,
  facts?: CspRequestFacts,
): string {
  const sources = new Set<string>(["'self'"]);
  const rawHost = facts !== undefined ? facts.host : req.headers.get('host');
  // Host 会进入 CSP 指令；只接受常规 host[:port] 字符，防止指令注入。
  const host = rawHost && /^[A-Za-z0-9.\-:[\]]+$/.test(rawHost) ? rawHost : null;
  // IPv6 字面量不是合法 CSP source；这类页面靠 `'self'` 覆盖同源连接。
  if (host && !host.startsWith('[')) {
    const secure = facts !== undefined ? facts.protocol === 'https' : isHttpsRequest(req);
    sources.add(`${secure ? 'wss' : 'ws'}://${host}`);
  }
  for (const origin of allowedOrigins) {
    const url = cspSafeUrl(origin);
    if (url === null) continue;
    sources.add(url.origin);
    sources.add(`${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`);
  }
  for (const origin of extend?.connectSrc ?? []) {
    const url = cspSafeUrl(origin);
    if (url === null) continue;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    sources.add(url.origin);
    sources.add(`${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`);
  }
  const frameSources = new Set<string>();
  for (const origin of extend?.frameSrc ?? []) {
    const url = cspSafeUrl(origin);
    if (url === null) continue;
    if (url.protocol === 'http:' || url.protocol === 'https:') frameSources.add(url.origin);
  }
  const frameDirective = frameSources.size > 0 ? `frame-src ${[...frameSources].join(' ')}; ` : '';
  return (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    `img-src 'self' data:; font-src 'self'; connect-src ${[...sources].join(' ')}; ` +
    `object-src 'none'; base-uri 'self'; ${frameDirective}frame-ancestors 'none'`
  );
}

/**
 * Host 放行策略（0.56）。
 *
 * 公网部署（反代保留原始 Host）时，监听地址仍是 `127.0.0.1`，`Host: egg-rolls.top`
 * 与它不相等 —— 旧实现直接 403，登录页都打不开。这里改为**显式允许列表**：
 * `publicHosts`（来自 `auth.publicOrigin`）+ `additionalHosts`（额外同意的域名）。
 */
export interface HostPolicy {
  /** 平台/node 监听地址（旧语义：与它完全相同的 host 放行）。 */
  listenHost: string;
  /** 公网 origin 派生的 host（含端口，小写）；如 `egg-rolls.top`。 */
  publicHosts?: string[];
  /** 额外允许的 host（含端口或裸域名）。 */
  additionalHosts?: string[];
  /** 受信边缘事实；缺省 = 不采信任何转发头（旧行为）。 */
  edge?: RequestEdge;
}

/** host 比对：允许「带端口」与「裸域名」两种写法互相命中。 */
function hostMatches(host: string, allowed: string): boolean {
  const target = allowed.trim().toLowerCase();
  if (target === '') return false;
  if (host === target) return true;
  const hostname = host.split(':')[0] ?? '';
  return hostname !== '' && hostname === target;
}

/**
 * 判断 Host 是否可信。
 *
 * 旧签名 `hostAllowed(req, listenHost)` 逐字保留（hub / 已知调用方不动）；
 * 平台入口传 {@link HostPolicy}：先看受信边缘给出的**生效 Host**，再比对显式列表。
 *
 * 0.56 关键一条：`publicHosts` / `additionalHosts` 是**反代域名**，只在请求确实
 * 来自受信代理（`edge.viaProxy`）时才放行 —— 否则「伪造 `Host: egg-rolls.top`
 * 但没带反代凭据」就会拿到公网身份。本机直连永远走回环分支。
 */
export function hostAllowed(req: Request, policy: string | HostPolicy): boolean {
  const resolved: HostPolicy = typeof policy === 'string' ? { listenHost: policy } : policy;
  const rawHost = resolved.edge !== undefined ? resolved.edge.host : req.headers.get('host');
  if (!rawHost) return true;
  const host = rawHost.toLowerCase();
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (isLoopbackHostname(hostname)) return true;
  // 通配绑定无法与 Host 精确比较；远程模式仍要求 token，浏览器 Origin 仍须同源。
  if (isWildcardHostname(resolved.listenHost)) return true;
  if (hostname === resolved.listenHost.toLowerCase()) return true;
  // 反代域名：没有「受信代理」这个前提，显式列表不生效。
  if (resolved.edge !== undefined && !resolved.edge.viaProxy) return false;
  for (const allowed of resolved.publicHosts ?? []) {
    if (hostMatches(host, allowed)) return true;
  }
  for (const allowed of resolved.additionalHosts ?? []) {
    if (hostMatches(host, allowed)) return true;
  }
  return false;
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
