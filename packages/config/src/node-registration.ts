/**
 * node 自动加入：注册字段 schema 校验 + origin 分类 + 派生白名单（0.61）。
 *
 * 三件事放在同一个文件里，因为它们共用同一个「什么算本机来源」的定义：
 *
 * 1. {@link validateNodeRegistration}：`POST /v1/hub/join` 的请求体校验。**node 声明的
 *    `kind` 只是声明**，hub 必须用 {@link classifyOrigin} 重新分类并比对（`B5 声明不可信`）。
 * 2. {@link classifyOrigin}：`loopback` / `private` / `public` 三分类。只认字面量，
 *    域名一律 `public`（`foo.local` 也不猜）。
 * 3. {@link deriveTrustedOrigins}：从 node 注册表派生「放行的浏览器来源」集合 D。
 *
 * 派生的唯一放宽条件（**这是本模块的安全核心，改动前先读设计稿 §4.2**）：
 *
 * - `loopback`：无条件进 D（只有本机代码能提供回环来源）。
 * - `private`：仅当该地址出现在**本机网卡列表**里才进 D —— 注册表里的是 node 自己
 *   声明的字符串，不加这一层「任何 node 都能把某段私网拉进白名单」。
 * - `public`：**永不进 D**，想要生效只能写显式配置。
 *
 * 纯函数、零 I/O：网卡列表由调用方注入，测试可完全控制。
 *
 * @module @vessel-agent/config/node-registration
 */

/** origin 的来源分类。 */
export type OriginClass = 'loopback' | 'private' | 'public';

/** 注册条目声明的入口类型（只是声明，hub 会重算）。 */
export const NODE_REGISTRATION_ENTRY_KINDS = ['loopback', 'private', 'public'] as const;
export type NodeRegistrationEntryKind = (typeof NODE_REGISTRATION_ENTRY_KINDS)[number];

/**
 * node 能力枚举（白名单，不是自由文本）。
 *
 * 只用于展示与将来的能力协商；未列入的值一律拒绝，避免 registry 变成任意字符串容器。
 */
export const NODE_REGISTRATION_CAPABILITIES = [
  'gateway.rpc',
  'web.ui',
  'hub.control',
  'federation.in',
] as const;
export type NodeRegistrationCapability = (typeof NODE_REGISTRATION_CAPABILITIES)[number];

/** 入口条数上限：loopback / private / public 各一。 */
export const MAX_REGISTRATION_ENTRIES = 3;
/** 能力条数上限。 */
export const MAX_REGISTRATION_CAPABILITIES = 8;
/** 派生集合上限；超出部分丢弃（防一条坏记录把白名单撑爆）。 */
export const MAX_DERIVED_ORIGINS = 32;

/** 归一化后的注册入口。 */
export interface NodeRegistrationEntry {
  /** node 的声明；与 `classifyOrigin(url)` 不一致即整条注册失败。 */
  kind: NodeRegistrationEntryKind;
  /** 归一化 origin：`scheme://host[:port]`，无 path / 无尾斜杠 / 默认端口已省略。 */
  url: string;
}

/** 校验通过的注册载荷（未知字段已被丢弃）。 */
export interface NodeRegistration {
  node_id: string;
  alias?: string;
  version?: string;
  capabilities: NodeRegistrationCapability[];
  entries: NodeRegistrationEntry[];
  incarnation?: string;
  /**
   * 旧字段：浏览器可达的节点 origin。**含义是「浏览器能到」，不是「公网」**
   * ——局域网 http 地址完全可以（NAT 场景由隧道/反代提供），只有真正的公网
   * 域名才强制 https。保留原语义，不与 `entries` 的 `kind` 混为一谈。
   */
  public_url?: string;
}

export type NodeRegistrationErrorCode =
  | 'invalid_request'
  | 'invalid_node_id'
  | 'invalid_alias'
  | 'invalid_version'
  | 'invalid_capabilities'
  | 'invalid_entries'
  | 'entry_kind_mismatch';

export type ValidateNodeRegistrationResult =
  | { ok: true; value: NodeRegistration }
  | { ok: false; code: NodeRegistrationErrorCode; message: string };

function fail(
  code: NodeRegistrationErrorCode,
  message: string,
): { ok: false; code: NodeRegistrationErrorCode; message: string } {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** 控制字符检查（不用正则：`noControlCharactersInRegex` 是 lint 硬规则）。 */
function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// ── origin 解析与地址分类 ────────────────────────────────────────────────

/**
 * 手写 origin 解析（不用 `new URL`）。
 *
 * 理由：`URL` 拒绝 IPv6 zone id（`[fe80::1%en0]`），而 node 在真实网卡上很可能
 * 报出带 zone 的链路本地地址。这里先按文法切开，再由 {@link classifyHost} 归一。
 */
export interface ParsedOrigin {
  scheme: 'http' | 'https';
  /** 小写、去方括号、去 zone id 的 host（可能是 IPv4 / IPv6 / 域名）。 */
  host: string;
  port?: number;
  /** 归一化后的 origin 字符串。 */
  origin: string;
}

const ORIGIN_RE = /^(https?):\/\/(\[[^\]\s]+\]|[^\s/:?#[\]@]+)(?::(\d{1,5}))?\/?$/i;

/** IPv6 的 zone id（`%25en0` / `%en0`）：分类前必须剥掉，否则前缀判断全错。 */
function stripZoneId(host: string): string {
  const percent = host.indexOf('%');
  return percent < 0 ? host : host.slice(0, percent);
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** 解析 origin；非法（带 path / 凭据 / 非法端口 / 结构坏）返回 `null`。 */
export function parseOrigin(raw: unknown): ParsedOrigin | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.includes('\0')) return null;
  const match = ORIGIN_RE.exec(trimmed);
  if (match === null) return null;

  const rawScheme = match[1];
  const rawHost = match[2];
  const rawPort = match[3];
  if (rawScheme === undefined || rawHost === undefined) return null;
  const scheme = rawScheme.toLowerCase() === 'https' ? 'https' : 'http';

  const bracketed = rawHost.startsWith('[');
  const bareHost = stripZoneId(stripBrackets(rawHost)).toLowerCase();
  if (bareHost === '') return null;
  // 括号只服务 IPv6；`[example.com]` 是坏输入。
  if (bracketed && !bareHost.includes(':')) return null;

  let port: number | undefined;
  if (rawPort !== undefined) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
    const defaultPort = scheme === 'https' ? 443 : 80;
    if (parsed !== defaultPort) port = parsed;
  }

  const hostOut = bareHost.includes(':') ? `[${bareHost}]` : bareHost;
  const origin = port !== undefined ? `${scheme}://${hostOut}:${port}` : `${scheme}://${hostOut}`;
  return { scheme, host: bareHost, ...(port !== undefined ? { port } : {}), origin };
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Octets(host: string): [number, number, number, number] | null {
  const match = IPV4_RE.exec(host);
  if (match === null) return null;
  const octets: number[] = [];
  for (const part of match.slice(1)) {
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

/**
 * IPv6 → 规范化文本（`::ffff:127.0.0.1` 这类映射地址还原成 IPv4 文本）。
 *
 * 用 `URL` 做规范化：WHATWG 会把 `::ffff:127.0.0.1` 序列化成 `::ffff:7f00:1`，
 * 所以这里必须把最后两段拼回点分十进制，不能直接看原文前缀。
 */
function canonicalIpv6(host: string): string | null {
  try {
    const url = new URL(`http://[${host}]/`);
    const canonical = stripBrackets(url.hostname).toLowerCase();
    return canonical.includes(':') ? canonical : null;
  } catch {
    return null;
  }
}

function ipv4FromMapped(rest: string): string | null {
  const hextets = rest.split(':');
  if (hextets.length !== 2) return null;
  const high = Number.parseInt(hextets[0] ?? '', 16);
  const low = Number.parseInt(hextets[1] ?? '', 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
  if (hextets.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function classifyIpv4(host: string): OriginClass | null {
  const octets = ipv4Octets(host);
  if (octets === null) return null;
  const [a, b] = octets;
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'private';
  // CGNAT（100.64/10）：运营商共享地址，不当作本机。
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  return 'public';
}

function classifyIpv6(host: string): OriginClass | null {
  const canonical = canonicalIpv6(host);
  if (canonical === null) return null;
  if (canonical === '::1') return 'loopback';
  // IPv4 映射 / 兼容：`::ffff:7f00:1` / `::7f00:1`。
  if (canonical.startsWith('::ffff:')) {
    const mapped = ipv4FromMapped(canonical.slice('::ffff:'.length));
    return mapped === null ? 'public' : classifyIpv4(mapped);
  }
  if (canonical.startsWith('::') && /^::[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(canonical)) {
    const mapped = ipv4FromMapped(canonical.slice(2));
    if (mapped !== null) return classifyIpv4(mapped);
  }
  const first = canonical.split(':')[0];
  if (first === undefined || first === '') return 'public';
  const hextet = Number.parseInt(first, 16);
  if (!Number.isInteger(hextet)) return 'public';
  if ((hextet & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 ULA
  if ((hextet & 0xffc0) === 0xfe80) return 'private'; // fe80::/10 链路本地
  return 'public';
}

/** 主机名分类；非法字面量返回 `null`（调用方丢弃该条）。 */
export function classifyHost(rawHost: string): OriginClass | null {
  const host = stripZoneId(stripBrackets(rawHost)).toLowerCase().replace(/\.$/, '');
  if (host === '') return null;
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (ipv4Octets(host) !== null) return classifyIpv4(host);
  if (host.includes(':')) return classifyIpv6(host);
  // 域名一律 public：`foo.local` / `.lan` 之类不做猜测。
  return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(host) ? 'public' : null;
}

/** origin 分类；非法 origin 返回 `null`。 */
export function classifyOrigin(raw: unknown): OriginClass | null {
  const parsed = parseOrigin(raw);
  if (parsed === null) return null;
  return classifyHost(parsed.host);
}

/**
 * 地址归一化键（用于「这条私网地址是不是本机网卡」的比较）。
 *
 * 统一：IPv4 映射的 IPv6 → 点分 IPv4；IPv6 → WHATWG 规范文本；剥 zone id、去尾点。
 */
export function addressKey(raw: string): string | null {
  const host = stripZoneId(stripBrackets(raw.trim())).toLowerCase().replace(/\.$/, '');
  if (host === '') return null;
  const octets = ipv4Octets(host);
  if (octets !== null) return octets.join('.');
  if (!host.includes(':')) return host;
  const canonical = canonicalIpv6(host);
  if (canonical === null) return null;
  if (canonical.startsWith('::ffff:')) {
    const mapped = ipv4FromMapped(canonical.slice('::ffff:'.length));
    if (mapped !== null) return mapped;
  }
  return canonical;
}

/** `scheme://host[:port]` 归一；非法返回 `null`。 */
export function normalizeEntryOrigin(raw: unknown): string | null {
  return parseOrigin(raw)?.origin ?? null;
}

// ── 注册载荷校验 ────────────────────────────────────────────────────────

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?$/;

/** 校验入口 url 与声明的 `kind` 是否一致（声明不可信，必须重算比对）。 */
function entryKindMatches(kind: NodeRegistrationEntryKind, origin: string): boolean {
  return classifyOrigin(origin) === kind;
}

/**
 * 校验 `POST /v1/hub/join` 的注册载荷。
 *
 * - 只认白名单键；未知键**丢弃**（便于协议演进，不因旧客户端多带字段而失败）。
 * - `public_url`（旧字段）保持原语义：浏览器可达即可（LAN http 允许），公网必须 https。
 * - 入口结构错误与「声明与事实不符」用不同错误码，便于排查。
 */
export function validateNodeRegistration(raw: unknown): ValidateNodeRegistrationResult {
  if (!isRecord(raw)) return fail('invalid_request', 'body must be a JSON object');

  const nodeId = raw.node_id;
  if (!isNonEmptyString(nodeId) || nodeId.length > 200 || hasControlChars(nodeId)) {
    return fail('invalid_node_id', 'node_id must be a non-empty string without control chars');
  }

  const alias = raw.alias;
  if (alias !== undefined) {
    if (typeof alias !== 'string' || alias.trim() === '' || alias.length > 120) {
      return fail('invalid_alias', 'alias must be a non-empty string of at most 120 chars');
    }
  }

  const version = raw.version;
  if (version !== undefined && (typeof version !== 'string' || !VERSION_RE.test(version.trim()))) {
    return fail('invalid_version', 'version must look like 1.2.3');
  }

  const incarnation = raw.incarnation;
  if (
    incarnation !== undefined &&
    (typeof incarnation !== 'string' || incarnation === '' || incarnation.length > 200)
  ) {
    return fail('invalid_request', 'incarnation must be a non-empty string');
  }

  // capabilities：枚举白名单 + 去重 + 上限；未知能力静默丢弃（能力只用于展示）。
  const capabilities: NodeRegistrationCapability[] = [];
  const rawCapabilities = raw.capabilities;
  if (rawCapabilities !== undefined) {
    if (!Array.isArray(rawCapabilities)) {
      return fail('invalid_capabilities', 'capabilities must be an array');
    }
    for (const item of rawCapabilities) {
      if (typeof item !== 'string') {
        return fail('invalid_capabilities', 'capabilities must contain strings only');
      }
      if (!(NODE_REGISTRATION_CAPABILITIES as readonly string[]).includes(item)) continue;
      const capability = item as NodeRegistrationCapability;
      if (!capabilities.includes(capability)) capabilities.push(capability);
      if (capabilities.length > MAX_REGISTRATION_CAPABILITIES) {
        return fail(
          'invalid_capabilities',
          `capabilities must not contain more than ${MAX_REGISTRATION_CAPABILITIES} entries`,
        );
      }
    }
  }

  const rawEntries = raw.entries;
  const entries: NodeRegistrationEntry[] = [];
  if (rawEntries !== undefined) {
    if (!Array.isArray(rawEntries)) {
      return fail('invalid_entries', 'entries must be an array');
    }
    if (rawEntries.length > MAX_REGISTRATION_ENTRIES) {
      return fail(
        'invalid_entries',
        `entries must not contain more than ${MAX_REGISTRATION_ENTRIES} items`,
      );
    }
    for (const item of rawEntries) {
      if (!isRecord(item)) return fail('invalid_entries', 'entries items must be objects');
      const kind = item.kind;
      if (
        typeof kind !== 'string' ||
        !(NODE_REGISTRATION_ENTRY_KINDS as readonly string[]).includes(kind)
      ) {
        return fail(
          'invalid_entries',
          `entry kind must be one of ${NODE_REGISTRATION_ENTRY_KINDS.join(', ')}`,
        );
      }
      const origin = normalizeEntryOrigin(item.url);
      if (origin === null) {
        return fail('invalid_entries', 'entry url must be a bare http(s) origin');
      }
      if (kind === 'public' && !origin.startsWith('https://')) {
        return fail('invalid_entries', 'public entries must use https');
      }
      if (!entryKindMatches(kind as NodeRegistrationEntryKind, origin)) {
        return fail(
          'entry_kind_mismatch',
          `entry kind "${kind}" does not match the actual address class of ${origin}`,
        );
      }
      if (entries.some((entry) => entry.url === origin)) continue;
      entries.push({ kind: kind as NodeRegistrationEntryKind, url: origin });
    }
  }

  // 旧字段 public_url：语义是「浏览器可达的 origin」，不是「公网 origin」。
  // 只做形状与「公网必须 https」的校验，保持不变，避免破坏已有的 LAN 直连部署。
  const rawPublicUrl = raw.public_url;
  let publicUrl: string | undefined;
  if (rawPublicUrl !== undefined) {
    if (typeof rawPublicUrl !== 'string' || rawPublicUrl.trim() === '') {
      return fail('invalid_request', 'public_url must be a non-empty string');
    }
    const origin = normalizeEntryOrigin(rawPublicUrl);
    if (origin === null) return fail('invalid_request', 'public_url must be a bare http(s) origin');
    if (classifyOrigin(origin) === 'public' && !origin.startsWith('https://')) {
      return fail('invalid_entries', 'public_url must use https when it points at a public origin');
    }
    publicUrl = origin;
  }

  const value: NodeRegistration = {
    node_id: nodeId,
    capabilities,
    entries,
  };
  if (alias !== undefined) value.alias = alias;
  if (version !== undefined) value.version = version.trim();
  if (incarnation !== undefined) value.incarnation = incarnation;
  if (publicUrl !== undefined) value.public_url = publicUrl;
  return { ok: true, value };
}

// ── 派生白名单 ──────────────────────────────────────────────────────────

/** 派生输入里的单个 node 视图（registry 记录的子集，便于用字面量写测试）。 */
export interface DerivedOriginsNodeView {
  node_id?: string;
  entries?: readonly { kind?: string; url?: string }[];
  url?: string;
  public_url?: string;
}

export interface DeriveTrustedOriginsInput {
  nodes: readonly DerivedOriginsNodeView[];
  /** 本机网卡地址（`os.networkInterfaces()` 展开）；缺省 = 空 ⇒ 不做 private 自动。 */
  localAddresses?: readonly string[];
  /** 私网自动的开关；缺省 `true`。`false` ⇒ 只有 loopback 能自动进集。 */
  allowPrivate?: boolean;
  /** 集合上限；缺省 {@link MAX_DERIVED_ORIGINS}。 */
  maxOrigins?: number;
}

export interface DerivedOriginsResult {
  /** 派生白名单（顺序稳定：先按 node_id，再按 origin）。 */
  origins: string[];
  /** 进了集合的回环条数。 */
  loopback: number;
  /** 进了集合的（本机网卡验证过的）私网条数。 */
  private: number;
  /** 因是公网被丢弃的条数。 */
  skipped_public: number;
  /** 因私网但无法证明属于本机而被丢弃的条数。 */
  skipped_private: number;
  /** 非法 origin 的条数。 */
  invalid: number;
  /** 被丢弃的 host（capped，便于一行日志排查；不含 query / token）。 */
  skipped_hosts: string[];
}

const MAX_SKIPPED_HOSTS = 8;

/**
 * 从注册表派生来源集 D。
 *
 * 关键不变量（设计稿 §4.2 / §8）：
 * - `loopback` 无条件进；`private` 必须被 `localAddresses` 证明；`public` 永不进。
 * - 输入异常不抛错：非法条目计数丢弃，结果集为空也能安全返回（fail-closed）。
 *
 * **被接受的风险（拍板结论，别在这里放宽）**：node 可以声明任意回环 origin
 * （`http://127.0.0.1:1` 也挡不住，任何 node 都能这么写）。这条可接受的前提是
 * **cookie 写操作仍必须带 CSRF 同步令牌**——派生集只影响 CORS/CSP 与 node 的
 * `allowed_origins`，永不放宽会话判定（`auth.public_origins` 不含派生值）。
 */
export function deriveTrustedOrigins(input: DeriveTrustedOriginsInput): DerivedOriginsResult {
  const allowPrivate = input.allowPrivate !== false;
  const maxOrigins =
    typeof input.maxOrigins === 'number' &&
    Number.isFinite(input.maxOrigins) &&
    input.maxOrigins > 0
      ? Math.floor(input.maxOrigins)
      : MAX_DERIVED_ORIGINS;
  const localKeys = new Set<string>();
  for (const address of input.localAddresses ?? []) {
    const key = addressKey(address);
    if (key !== null) localKeys.add(key);
  }

  const chosen = new Map<string, { origin: string; nodeId: string; originClass: OriginClass }>();
  let loopback = 0;
  let privateCount = 0;
  let skippedPublic = 0;
  let skippedPrivate = 0;
  let invalid = 0;
  const skippedHosts: string[] = [];

  const consider = (raw: unknown, nodeId: string): void => {
    const parsed = parseOrigin(raw);
    if (parsed === null) {
      invalid += 1;
      return;
    }
    const originClass = classifyHost(parsed.host);
    if (originClass === null) {
      invalid += 1;
      return;
    }
    if (originClass === 'public') {
      skippedPublic += 1;
      if (skippedHosts.length < MAX_SKIPPED_HOSTS) skippedHosts.push(parsed.host);
      return;
    }
    if (originClass === 'private') {
      const key = addressKey(parsed.host);
      if (!allowPrivate || key === null || !localKeys.has(key)) {
        skippedPrivate += 1;
        if (skippedHosts.length < MAX_SKIPPED_HOSTS) skippedHosts.push(parsed.host);
        return;
      }
    }
    if (chosen.has(parsed.origin)) return;
    chosen.set(parsed.origin, { origin: parsed.origin, nodeId, originClass });
  };

  for (const node of input.nodes) {
    const nodeId = typeof node.node_id === 'string' ? node.node_id : '';
    const seen = new Set<string>();
    const push = (raw: unknown): void => {
      if (typeof raw !== 'string' || seen.has(raw)) return;
      seen.add(raw);
      consider(raw, nodeId);
    };
    for (const entry of node.entries ?? []) push(entry.url);
    push(node.url);
    push(node.public_url);
  }

  const ordered = [...chosen.values()].sort((left, right) => {
    if (left.nodeId !== right.nodeId) return left.nodeId < right.nodeId ? -1 : 1;
    return left.origin < right.origin ? -1 : left.origin > right.origin ? 1 : 0;
  });
  const origins: string[] = [];
  for (const item of ordered) {
    if (origins.length >= maxOrigins) break;
    origins.push(item.origin);
    if (item.originClass === 'loopback') loopback += 1;
    else privateCount += 1;
  }

  return {
    origins,
    loopback,
    private: privateCount,
    skipped_public: skippedPublic,
    skipped_private: skippedPrivate,
    invalid,
    skipped_hosts: skippedHosts,
  };
}
