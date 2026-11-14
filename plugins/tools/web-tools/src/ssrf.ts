/**
 * SSRF 护栏（M1 的核心）。
 *
 * 三条铁律：
 * 1. 只允许 http/https，且端口只能是 80/443（用户信息段一律拒，防止 `http://good.com@evil` 之类的分割歧义）。
 * 2. 主机名/IP 双重判定：字面 IP 直接判黑；域名在 DNS 解析后逐个 IP 判黑（防 rebinding 的第一道）。
 * 3. 每一跳都重新走这套判定——重定向后必须再校验，因为 302 的 Location 完全由远端控制。
 *
 * 关于 rebinding 的**残留窗口**（必须写清楚，不能假装解决了）：
 * 本模块在连接前把域名解析出的**所有** A/AAAA 记录都校验一遍，之后才交给 `fetch` 去连；
 * 而 `fetch` 会自己做第二次解析。两次解析之间攻击者可以把 TTL 极短的记录换成 127.0.0.1。
 * 真正堵死需要把已校验的 IP 钉进 socket（自定义 dispatcher/`lookup` 回调），M1 没做：
 * 这里是「降低概率」而不是「证明安全」。审计时请按此口径评估。
 */

import { WebFetchError } from './types';

/** 允许的端口：空串表示协议的默认端口（WHATWG URL 会把 `:80`/`:443` 规范化为空串）。 */
const ALLOWED_PORTS = ['', '80', '443'];

/** 这些主机名不经 DNS 就拒绝：它们是「本机/云元数据」的常用别名。 */
const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'kubernetes.default',
  'kubernetes.default.svc',
];

export interface UrlPolicy {
  /** 逃生阀，默认 false */
  allowPrivateNetworks?: boolean;
  /** 非空时只有命中白名单的域名可以访问 */
  domainAllowlist?: string[];
  /** 命中即拒 */
  domainDenylist?: string[];
  /** 相对 URL 的基准（重定向时传当前 URL） */
  base?: string;
}

export interface CheckedUrl {
  url: URL;
  /** 小写、去掉方括号与结尾点 */
  host: string;
  /** true 表示 host 本身就是 IP 字面量（无需 DNS，也无需防 rebinding） */
  isIpLiteral: boolean;
}

function blocked(message: string, url: string | undefined): WebFetchError {
  return new WebFetchError('blocked_url', message, { url });
}

/** 严格点分十进制解析；`010` 这种按十进制读（WHATWG 解析出的 hostname 已规范化，不会走到这里）。 */
export function parseIpv4(raw: string): number[] | null {
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return out;
}

/** 16 位组形式（长度 8）的 IPv6 解析，支持 `::` 压缩、内嵌 IPv4、`%zone`。 */
export function parseIpv6(raw: string): number[] | null {
  let text = raw.trim().toLowerCase();
  const zoneAt = text.indexOf('%');
  if (zoneAt !== -1) text = text.slice(0, zoneAt);
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (!text.includes(':')) return null;

  const lastColon = text.lastIndexOf(':');
  const tailText = text.slice(lastColon + 1);
  if (tailText.includes('.')) {
    const v4 = parseIpv4(tailText);
    if (!v4) return null;
    // 解析器保证长度 4；显式取值避免  下的 possibly-undefined。
    const high = ((v4[0]! << 8) | v4[1]!).toString(16);
    const low = ((v4[2]! << 8) | v4[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (chunk: string): number[] | null => {
    if (chunk === '') return [];
    const groups: number[] = [];
    for (const piece of chunk.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0] ?? '');
  if (!head) return null;
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : null;
  if (halves.length === 2 && !tail) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const tailGroups = tail ?? [];
  const used = head.length + tailGroups.length;
  if (used > 7) return null;
  const zeros = new Array<number>(8 - used).fill(0);
  return [...head, ...zeros, ...tailGroups];
}

function embeddedIpv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** 私网/环回/链路本地/云元数据/CGNAT/组播/保留段，一律视为不可访问。 */
export function isBlockedIpv4Tuple(address: number[]): boolean {
  const [a, b, c] = address as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 环回
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地（含 169.254.169.254 元数据）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 文档
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 文档
  if (a >= 224) return true; // 组播 224/4 + 保留 240/4 + 广播
  return false;
}

export function isBlockedIpv6Groups(groups: number[]): boolean {
  const g0 = groups[0] as number;
  const g1 = groups[1] as number;
  const restIsZero = (from: number) => groups.slice(from).every((g) => g === 0);

  if (restIsZero(0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1

  // ::ffff:0:0/96 IPv4-mapped
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isBlockedIpv4Tuple(embeddedIpv4(groups[6] as number, groups[7] as number));
  }
  // ::/96 IPv4-compatible（已弃用，除 ::/::1 外整段拒）
  if (groups.slice(0, 6).every((g) => g === 0)) return true;
  // 64:ff9b::/96 NAT64
  if (g0 === 0x64 && g1 === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return isBlockedIpv4Tuple(embeddedIpv4(groups[6] as number, groups[7] as number));
  }
  // 100::/64 discard-only
  if (g0 === 0x100 && groups.slice(1, 4).every((g) => g === 0)) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 站点本地（弃用）
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 文档
  if (g0 === 0x2002) return true; // 2002::/16 6to4（内嵌 IPv4，直接拒省得再剥一层）
  return false;
}

/** 给 DNS 结果用：传入单个 IP 字面量，命中黑名单就抛 `blocked_url`。 */
export function assertAddressAllowed(
  address: string,
  host: string,
  allowPrivateNetworks = false,
): void {
  const trimmed = address.trim();
  const v4 = parseIpv4(trimmed);
  if (v4) {
    if (allowPrivateNetworks) {
      if (v4[0] === 169 && v4[1] === 254) {
        throw blocked(
          `目标域名 ${host} 解析到链路本地/云元数据地址 ${trimmed}，即使 allow_private_networks 也不能访问`,
          undefined,
        );
      }
      return;
    }
    if (isBlockedIpv4Tuple(v4))
      throw blocked(`目标域名 ${host} 解析到受限地址 ${trimmed}`, undefined);
    return;
  }
  const v6 = parseIpv6(trimmed);
  if (v6) {
    if (allowPrivateNetworks) {
      if (((v6[0] as number) & 0xffc0) === 0xfe80) {
        throw blocked(
          `目标域名 ${host} 解析到链路本地地址 ${trimmed}，即使 allow_private_networks 也不能访问`,
          undefined,
        );
      }
      return;
    }
    if (isBlockedIpv6Groups(v6))
      throw blocked(`目标域名 ${host} 解析到受限地址 ${trimmed}`, undefined);
    return;
  }
  // 解析器给出的不是合法 IP：宁可信其有，拒绝。
  throw blocked(`目标域名 ${host} 解析结果不是合法 IP（${trimmed}），拒绝连接`, undefined);
}

function matchesDomain(host: string, entry: string): boolean {
  const cleaned = entry.startsWith('.') ? entry.slice(1) : entry;
  if (cleaned === '') return false;
  return host === cleaned || host.endsWith(`.${cleaned}`);
}

/**
 * 同步校验（不发 DNS）。重定向每一跳、工具参数预检、checkPermission 都走这里。
 */
export function checkUrl(raw: string, policy: UrlPolicy = {}): CheckedUrl {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (input === '') throw new WebFetchError('invalid_input', 'url 不能为空');

  let url: URL;
  try {
    url = policy.base ? new URL(input, policy.base) : new URL(input);
  } catch {
    throw new WebFetchError('invalid_input', `无法解析的 URL：${input.slice(0, 200)}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw blocked(`只允许 http/https，收到 ${url.protocol.replace(':', '')}`, url.href);
  }
  if (url.username !== '' || url.password !== '') {
    throw blocked('URL 不允许携带用户名/密码段', url.href);
  }
  if (!ALLOWED_PORTS.includes(url.port)) {
    throw blocked(`只允许 80/443 端口，收到 ${url.port}`, url.href);
  }

  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1); // 去掉 FQDN 结尾点，避免 `localhost.` 绕过
  if (host === '') throw new WebFetchError('invalid_input', 'URL 缺少主机名');

  const deny = policy.domainDenylist ?? [];
  for (const entry of deny) {
    if (matchesDomain(host, entry)) throw blocked(`域名 ${host} 在 domain_denylist 中`, url.href);
  }

  const allow = policy.domainAllowlist ?? [];
  if (allow.length > 0 && !allow.some((entry) => matchesDomain(host, entry))) {
    throw new WebFetchError('blocked_by_policy', `域名 ${host} 不在 domain_allowlist 中`, {
      url: url.href,
    });
  }

  for (const entry of BLOCKED_HOSTNAMES) {
    if (matchesDomain(host, entry))
      throw blocked(`主机名 ${host} 属于本机/元数据别名，禁止访问`, url.href);
  }

  const v4 = parseIpv4(host);
  const v6 = v4 ? null : parseIpv6(host);
  const isIpLiteral = v4 !== null || v6 !== null;
  if (!isIpLiteral) {
    // 纯数字/十六进制等古怪主机名交给 DNS 也危险，统一拒掉最外层是数字的情况
    if (/^[0-9]+$/.test(host)) throw blocked(`无法识别的 IP 形式：${host}`, url.href);
  } else if (!policy.allowPrivateNetworks) {
    if (v4 && isBlockedIpv4Tuple(v4)) throw blocked(`目标地址 ${host} 属于私网/保留段`, url.href);
    if (v6 && isBlockedIpv6Groups(v6))
      throw blocked(`目标地址 [${host}] 属于私网/保留段`, url.href);
  } else {
    // 逃生阀打开时仍然拦住云元数据（169.254.169.254 及同段的 IMDS 变体）
    if (v4 && v4[0] === 169 && v4[1] === 254) {
      throw blocked(
        `目标地址 ${host} 属于链路本地/云元数据段，负责 allow_private_networks 也不能访问`,
        url.href,
      );
    }
    if (v6 && ((v6[0] as number) & 0xffc0) === 0xfe80) {
      throw blocked(
        `目标地址 [${host}] 属于链路本地段，即使 allow_private_networks 也不能访问`,
        url.href,
      );
    }
  }

  return { url, host, isIpLiteral };
}
