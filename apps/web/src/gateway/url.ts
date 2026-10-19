/**
 * 运行时 gateway URL 解析与校验（纯函数，便于单测）。
 *
 * 优先级：localStorage > VITE_GATEWAY_URL > 空串（同源）。
 * 只接受 scheme://host[:port]；拒绝 path/query/hash/userinfo 与 wildcard。
 * 非回环必须 https；HTTPS 页面拒绝 http（mixed content）。
 */

export const GATEWAY_URL_KEY = 'vessel.gateway-url';

export interface GatewayUrlCheck {
  ok: boolean;
  /** 归一化后的 http(s) origin；空串 = 同源 */
  value: string;
  error?: string;
}

/** 回环判定：localhost / 127.0.0.0/8 / ::1（可带方括号） */
export function isLoopbackHostname(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '::1') return true;
  return lower.startsWith('127.');
}

/** 校验并归一化用户输入；空串表示同源。 */
export function checkGatewayUrl(raw: string, pageProtocol = 'http:'): GatewayUrlCheck {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: '' };
  if (trimmed === '*') {
    return { ok: false, value: '', error: '不支持通配符 gateway 地址' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, value: '', error: '请输入完整的 gateway 地址（如 https://host:8642）' };
  }

  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'ws:' && scheme !== 'wss:') {
    return { ok: false, value: '', error: 'gateway 地址只支持 http(s)/ws(s)' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, value: '', error: 'gateway 地址不能包含用户名或密码' };
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return { ok: false, value: '', error: '只填写 scheme://host[:port]，不要带路径或参数' };
  }

  const httpScheme = scheme === 'ws:' ? 'http:' : scheme === 'wss:' ? 'https:' : scheme;
  const value = `${httpScheme}//${url.host}`;

  if (httpScheme === 'http:' && !isLoopbackHostname(url.hostname)) {
    return {
      ok: false,
      value: '',
      error: '非回环 gateway 必须使用 HTTPS（wss）',
    };
  }
  if (pageProtocol === 'https:' && httpScheme === 'http:') {
    return {
      ok: false,
      value: '',
      error: 'HTTPS 页面不能连接 http:// gateway（mixed content）',
    };
  }

  return { ok: true, value };
}

/**
 * 首次加载的候选值：localStorage > 构建期 env > 同源。
 * 命中候选后不静默回退，非法值原样报错，方便用户修正。
 */
export function resolveInitialGatewayUrl(
  stored: string | null | undefined,
  env: string | null | undefined,
  pageProtocol = 'http:',
): GatewayUrlCheck {
  const fromStorage = stored?.trim() ?? '';
  if (fromStorage !== '') return checkGatewayUrl(fromStorage, pageProtocol);
  const fromEnv = env?.trim() ?? '';
  if (fromEnv !== '') return checkGatewayUrl(fromEnv, pageProtocol);
  return { ok: true, value: '' };
}

/** http(s) origin → WS base（空串保持空串，交给同源推导）。 */
export function toWebSocketBase(url: string): string {
  if (url === '') return '';
  if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`;
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`;
  return url;
}

/** 顶栏展示：空串显示当前页面同源。 */
export function displayGatewayUrl(url: string, pageOrigin: string): string {
  return url === '' ? pageOrigin : url;
}
