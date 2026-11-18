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

/** 端口通配后缀：`http://127.0.0.1:*`（只有回环 host 允许）。 */
const PORT_WILDCARD_SUFFIX = ':*';

/**
 * 缺省回环通配集合：本机任意端口的 WebUI（Vite dev relay、临时端口）都能发 RPC。
 *
 * 为什么是三条：三个回环别名各自是**不同的** Origin（`localhost` 与 `127.0.0.1`
 * 在浏览器里不同源），只写一条会留下「换个别名访问就 403」的坑。
 */
export const LOOPBACK_WILDCARD_ORIGINS: readonly string[] = [
  'http://127.0.0.1:*',
  'http://localhost:*',
  'http://[::1]:*',
];

/** 解析后的来源形状（通配端口时 `host` 形如 `127.0.0.1:*`）。 */
export interface OriginPattern {
  /** 带冒号，与 `URL#protocol` 一致。 */
  protocol: 'http:' | 'https:';
  /** 小写 hostname（IPv6 带方括号，与 `URL#hostname` 一致）。 */
  hostname: string;
  /** 小写 `host[:port]`；通配端口时是 `host:*`。 */
  host: string;
  /** true = 端口是通配符，**只有回环 host 可能**为 true。 */
  wildcardPort: boolean;
}

/** `parseOriginUrl` 只放行 http(s)，这里把类型收窄成字面量联合。 */
function originProtocol(url: URL): 'http:' | 'https:' {
  return url.protocol === 'https:' ? 'https:' : 'http:';
}

/** 只接受 http(s)、无凭据、无 path/query/hash 的绝对 URL。 */
function parseOriginUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url;
}

/**
 * 解析单个来源条目；非法 ⇒ `null`。
 *
 * 两种合法形状：
 * - 完整 origin：`scheme://host[:port]`（无 path/query/hash/凭据）；
 * - **回环通配端口**：`scheme://<loopback>:*`（`127.0.0.0/8` / `localhost` / `[::1]`）。
 *   非回环 host 写 `:*` 一律拒绝 —— 公网域名不能因为一个 `*` 就整段放开。
 */
export function parseOriginPattern(raw: unknown): OriginPattern | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.endsWith(PORT_WILDCARD_SUFFIX)) {
    const base = trimmed.slice(0, -PORT_WILDCARD_SUFFIX.length);
    const url = parseOriginUrl(base);
    if (url === null) return null;
    // `http://127.0.0.1:8642:*` 这种写法不认（端口已经写死了，再加 `*` 是自相矛盾）。
    if (url.port !== '' || url.hostname === '') return null;
    const hostname = url.hostname.toLowerCase();
    if (!isLoopbackHostname(hostname)) return null;
    return {
      protocol: originProtocol(url),
      hostname,
      host: `${hostname}:*`,
      wildcardPort: true,
    };
  }
  const url = parseOriginUrl(trimmed);
  if (url === null) return null;
  return {
    protocol: originProtocol(url),
    hostname: url.hostname.toLowerCase(),
    host: url.host.toLowerCase(),
    wildcardPort: false,
  };
}

/** 归一化来源条目：合法 ⇒ 规范字符串（小写 host、去默认端口），非法 ⇒ `null`。 */
export function normalizeOriginPattern(raw: unknown): string | null {
  const parts = parseOriginPattern(raw);
  return parts === null ? null : `${parts.protocol}//${parts.host}`;
}

/**
 * Origin 是否命中 allowlist（逐条：完整 origin 精确比对，回环通配按 hostname + 协议）。
 *
 * 通配条目匹配该 hostname 的**任意端口，含默认端口**（`http://127.0.0.1` 也命中
 * `http://127.0.0.1:*`）—— 回环 host 上多一个端口不是新的信任边界。
 */
export function originMatchesAllowlist(origin: string, allowlist: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const hostname = url.hostname.toLowerCase();
  const host = url.host.toLowerCase();
  for (const entry of allowlist) {
    const pattern = parseOriginPattern(entry);
    if (pattern === null) continue;
    if (pattern.protocol !== url.protocol) continue;
    if (pattern.wildcardPort) {
      if (pattern.hostname === hostname) return true;
      continue;
    }
    if (pattern.host === host) return true;
  }
  return false;
}

/** `normalizeAllowedOrigins` 的逐条错误文案（尽量说清「错哪个字」）。 */
function allowedOriginError(trimmed: string): string {
  const wildcard = trimmed.endsWith(PORT_WILDCARD_SUFFIX);
  const base = wildcard ? trimmed.slice(0, -PORT_WILDCARD_SUFFIX.length) : trimmed;
  let url: URL | null = null;
  try {
    url = new URL(base);
  } catch {
    return 'expected an absolute URL like https://egg-rolls.top';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'only http(s) origins are allowed';
  }
  if (url.username !== '' || url.password !== '') return 'credentials are not allowed';
  if (wildcard && url.port === '' && !isLoopbackHostname(url.hostname.toLowerCase())) {
    return (
      'a port wildcard ("host:*") is only allowed on loopback hosts ' +
      '(127.0.0.1 / localhost / [::1])'
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return 'use scheme://host[:port] only';
  }
  if (wildcard) return 'a port wildcard ("host:*") must carry no other port';
  return 'expected an absolute URL like https://egg-rolls.top';
}

/**
 * 归一化 CORS/WS Origin allowlist：只接受显式 http(s) origin。
 * 拒绝 `*`、path/query/hash/userinfo；保存 `URL.origin`（小写 host、去默认端口）。
 *
 * 0.61：额外接受**回环端口通配**（`http://127.0.0.1:*` 等），归一后原样保留；
 * 非回环 host 的 `:*` 仍然报错（与 config validator 同口径）。
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
        'allowedOrigins must contain explicit origins; wildcard ("*") is not allowed ' +
          '(only a loopback port wildcard such as "http://127.0.0.1:*" is accepted).',
      );
    }
    const origin = normalizeOriginPattern(trimmed);
    if (origin === null) {
      throw new Error(`Invalid allowed origin "${trimmed}": ${allowedOriginError(trimmed)}.`);
    }
    normalized.add(origin);
  }
  return [...normalized];
}

/**
 * 0.61：`http.allowed_origins` 的生效值（**访问控制**：浏览器能不能发 RPC）。
 *
 * 与 `auth.public_origins`（`redirect_uri` 的来源选择）是两件事，别再合并语义：
 * 前者回答「谁能调这个 API」，后者回答「登录回跳到哪个 origin」。
 *
 * - 未配置（`undefined`）⇒ 回落到 `auth.public_origins`，再补上
 *   {@link LOOPBACK_WILDCARD_ORIGINS}（本机任意端口的 WebUI 因此可用，而线上
 *   部署的既有配置一字不改）；
 * - 显式配置 ⇒ 就是它（**不再**自动补回环通配：显式即全权，`[]` = 只允许同源）。
 *
 * 非法条目静默丢弃（validator 已在前一步报错；运行时不为一个错字拒绝启动）。
 */
export function resolveHttpAllowedOrigins(input: {
  /** `http.allowed_origins`；`undefined` = 未配置。 */
  allowedOrigins?: readonly unknown[] | undefined;
  /** `auth.public_origins`（已合并归一）；未配置时为回落基线。 */
  publicOrigins?: readonly unknown[] | undefined;
}): string[] {
  const out: string[] = [];
  const push = (raw: unknown): void => {
    const origin = normalizeOriginPattern(raw);
    if (origin === null || out.includes(origin)) return;
    out.push(origin);
  };
  if (input.allowedOrigins !== undefined) {
    for (const entry of input.allowedOrigins) push(entry);
    return out;
  }
  for (const entry of input.publicOrigins ?? []) push(entry);
  for (const entry of LOOPBACK_WILDCARD_ORIGINS) push(entry);
  return out;
}

/**
 * Origin 闸的「谁在担保这个请求」事实。
 *
 * 依据是**担保者**，不是配置里开着什么模式：
 * - {@link credentialVerified}：`Authorization: Bearer` 已与真实 token 比对通过
 *   （是一次校验结果，不是「配了 token」这个开关）；
 * - {@link viaProxy}：请求来自受信反代（`resolveRequestEdge().viaProxy`），
 *   origin 校验已在该层做完。
 *
 * 两条都**不放宽 cookie 会话**：浏览器不会自动附加 `Authorization`（跨站请求连
 * CORS 预检都带不了凭据），所以显式凭据不是 CSRF 面；cookie 路径必须照旧过白名单。
 */
export interface OriginGateFacts {
  /** 显式凭据（Bearer token）已校验通过。 */
  credentialVerified?: boolean;
  /**
   * 请求来自受信反代（`resolveRequestEdge().viaProxy`）。
   *
   * TODO(0.61)：**故意未接线**。平台的 `viaProxy` 把「回环 socket」默认当归受信代理
   * （`resolveRequestEdge` 的 trusted-proxy 判定），所以本机直连请求天然是 `viaProxy: true`；
   * 若拿它当 bypass，本机流量会整段绕过 Origin 闸。要真正启用这一条，条件不是「回环」，
   * 而是 **反代密钥成立**：node 侧需要先有 `auth.trustedProxies` + proxy secret 的边缘解析
   * （目前 node 路径没有 `resolveRequestEdge`），再把 `edge.viaProxy` 传进来。未接线前
   * 这个字段保持 `undefined`，行为与 0.60 一致。
   */
  viaProxy?: boolean;
}

/**
 * 「浏览器 Origin 是否等于生效边缘 host」的判定 —— 受信边缘声明的**形参入口**（未接线）。
 *
 * 现网 `AuthService.originMatchesEdge` 只比 `Origin` 的 host 与 `ctx.edge.host`；在
 * 「页面 origin 是 8644、Host 是平台端口」的 dev relay 场景下会不匹配（→ `csrf_failed`）。
 * 正确解法**不是**把 relay 端口加进受信同源名单（那样本机任何进程开的页面都能伪造），
 * 而是让受信 relay 带**自己的密钥** + 声明「页面真实 origin 是 X」，平台在密钥成立时
 * 才采信这个声明参与比较（与 `X-Forwarded-*` + 反代密钥同一套模式）。
 *
 * 这里只把入口形参化：调用方拿不到密钥证据时**必须**传 `undefined`，行为与旧逻辑逐字一致。
 *
 * @param input.origin 浏览器发来的 `Origin` 头原值
 * @param input.edgeHost 受信边缘解析出的 `host`（`null` ⇒ 判不过）
 * @param input.trustedOriginClaim 受信 relay 声明的页面真实 origin；**仅密钥成立时**可传
 */
export function originMatchesEdgeHost(input: {
  origin: string;
  edgeHost: string | null;
  trustedOriginClaim?: string | null;
}): boolean {
  if (input.edgeHost === null) return false;
  const candidate =
    input.trustedOriginClaim === undefined || input.trustedOriginClaim === null
      ? input.origin
      : input.trustedOriginClaim;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  return parsed.host.toLowerCase() === input.edgeHost.toLowerCase();
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
 * `publicHosts`（来自 `auth.public_origins` / `auth.public_origin`，每个来源的 host）
 * + `additionalHosts`（额外同意的域名）。
 */
export interface HostPolicy {
  /** 平台/node 监听地址（旧语义：与它完全相同的 host 放行）。 */
  listenHost: string;
  /** 公网来源派生的 host（含端口，小写）；如 `egg-rolls.top`、`127.0.0.1:8642`。 */
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

/**
 * Origin 校验：无 Origin（curl / peer）放行；浏览器必须同源或在允许列表。
 *
 * 0.61：`facts` 给出「谁在担保这个请求」（见 {@link OriginGateFacts}）时可跳过白名单；
 * 不传 `facts` 时行为与 0.60 逐字一致（cookie 路径必须走这条）。
 */
export function originAllowed(
  req: Request,
  allowedOrigins: string[],
  facts: OriginGateFacts = {},
): boolean {
  // 显式凭据 / 受信反代：来源已由担保者负责，白名单不再是这一跳的门。
  if (facts.credentialVerified === true || facts.viaProxy === true) return true;
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
  if (originMatchesAllowlist(parsed.origin, allowedOrigins)) return true;
  const host = req.headers.get('host');
  if (!host) return false;
  return parsed.host.toLowerCase() === host.toLowerCase();
}

/**
 * 允许列表命中时返回 CORS 头（同源不需要）。
 * allowlist 非空时所有响应都带 Vary: Origin，避免共享缓存把 A 的 ACAO 复用给 B。
 * 不使用 Access-Control-Allow-Credentials：鉴权走 Authorization，不依赖 cookie。
 */
/** CORS 预检允许的头：浏览器跨源发 RPC 会带 `Authorization`（显式凭据）或 CSRF 同步令牌。 */
const CORS_ALLOW_HEADERS = 'Content-Type, Authorization, X-Vessel-Protocol, X-Vessel-CSRF';

/** `corsHeaders` 的可选事实；不传时与 0.60 行为一致（只是不再回 `*`，本来也没回过）。 */
export interface CorsOptions {
  /**
   * 该服务是否用 **cookie 会话**（平台 `true` / node `false`）。
   *
   * 只有 cookie 会话才需要 `Access-Control-Allow-Credentials: true`：
   * - 带凭据的跨源响应必须逐个 origin 授权（不能 `*`），这里回显的是**命中白名单的
   *   那个请求 Origin**；
   * - 纯 bearer 的 node 侧不需要它 —— 给它只会扩大「站点能读到响应」的面，
   *   而 bearer 请求本身就要求调用方已经持有 token。
   *
   * 命中白名单是前提：不命中连 `Access-Control-Allow-Origin` 都不给，凭据头更不给。
   */
  credentials?: boolean;
}

/**
 * CORS 头：**只回显命中的请求 Origin**（绝不 `*`），并带 `Vary: Origin`。
 *
 * 0.61：命中判定改用 `originMatchesAllowlist`，因此 `http://127.0.0.1:*` 这类
 * 回环端口通配也生效 —— 否则「Origin 闸放行了、浏览器却读不到响应」，第 2 层是半成品。
 */
export function corsHeaders(
  req: Request,
  allowedOrigins: string[],
  options: CorsOptions = {},
): Record<string, string> {
  if (allowedOrigins.length === 0) return {};
  const headers: Record<string, string> = { Vary: 'Origin' };
  const origin = req.headers.get('origin');
  if (!origin) return headers;
  let normalized: string;
  try {
    const parsed = new URL(origin);
    // 只对浏览器 http(s) origin 回 CORS 头；`file://` / opaque origin 一律不给。
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return headers;
    normalized = parsed.origin;
  } catch {
    return headers;
  }
  if (!originMatchesAllowlist(normalized, allowedOrigins)) return headers;
  return {
    ...headers,
    'Access-Control-Allow-Origin': normalized,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Max-Age': '600',
    ...(options.credentials === true ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
  };
}
