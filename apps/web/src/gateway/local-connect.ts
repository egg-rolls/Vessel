/**
 * 本机 gateway 自动连接（0.35）。
 *
 * 打开本机 WebUI 时，页面若由 gateway 托管（或 dev server 代理了 `/v1`），
 * 同源 `GET /v1/local/token` 会返回已配置的 gateway token；拿到后只写
 * `sessionStorage` 并走现有连接流程，省掉每次新标签页手填 token。
 *
 * 约束：
 * - 只对回环页面尝试；非回环页面一律不动，继续用手动表单。
 * - 用户已有 token / 已保存的地址指向别处时不自动接管，避免覆盖用户配置。
 * - 只尝试一次；任何失败（404 / 403 / CORS / 网络 / 超时）都安静返回 null。
 *
 * 独立成纯函数（注入 `fetch`），便于在无浏览器环境下验证决策与调用次数。
 */

import { isLoopbackHostname } from './url';

/** 本机默认 gateway（与 serve 默认端口一致）。 */
export const LOCAL_GATEWAY_URL = 'http://127.0.0.1:8642';
export const LOCAL_TOKEN_PATH = '/v1/local/token';

const DEFAULT_TIMEOUT_MS = 1500;

export interface LocalConnectContext {
  /** `window.location.hostname` */
  hostname: string;
  /** `window.location.origin` */
  origin: string;
  /** 已消费的显式 token（`#token=` 或 sessionStorage）。 */
  token: string;
  /** `localStorage['vessel.gateway-url']`（'' = 未保存）。 */
  storedUrl: string;
  /** dev proxy auth 模式（占位 token 由 relay 注入），不参与自动连接。 */
  devProxyAuth: boolean;
}

export interface LocalTokenDiscovery {
  token: string;
  /** 连接目标；'' = 页面同源。 */
  gatewayUrl: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LocalConnectDeps {
  context: LocalConnectContext;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * 是否值得尝试自动连接。回环页面 + 无 token + 未指向其它已保存目标。
 * 已保存地址非法时也不尝试：交给现有表单原样报错。
 */
export function shouldAttemptLocalConnect(context: LocalConnectContext): boolean {
  if (context.devProxyAuth) return false;
  if (context.token.trim() !== '') return false;
  if (!isLoopbackHostname(context.hostname)) return false;
  const stored = context.storedUrl.trim();
  if (stored === '') return true;
  try {
    return new URL(stored).origin === context.origin;
  } catch {
    return false;
  }
}

function abortableTimeout(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

/** GET → JSON；非 2xx / 非 JSON / 网络错误 / 超时一律 null（不抛错、不重试）。 */
async function getJson(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<unknown | null> {
  const { signal, cancel } = abortableTimeout(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    cancel();
  }
}

function readToken(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const token = (payload as { token?: unknown }).token;
  return typeof token === 'string' && token.trim() !== '' ? token : null;
}

/**
 * 发现本机 gateway token。
 *
 * 1. 先试页面同源 `/v1/local/token`：gateway 托管的页面，或 dev server 代理了 `/v1`。
 * 2. 同源失败且用户没有保存地址时，探测默认本机 gateway（`/health` 可达才继续）。
 *    跨源被 CORS / 403 拒绝的 dev server 场景安静返回 null。
 */
export async function discoverLocalGatewayToken(
  deps: LocalConnectDeps,
): Promise<LocalTokenDiscovery | null> {
  const { context } = deps;
  if (!shouldAttemptLocalConnect(context)) return null;
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const sameOriginToken = readToken(
    await getJson(fetchImpl, `${context.origin}${LOCAL_TOKEN_PATH}`, timeoutMs),
  );
  if (sameOriginToken !== null) return { token: sameOriginToken, gatewayUrl: '' };

  // 用户保存了同源地址但同源端点不可用 = 该地址并不是 gateway（例如 dev server）；
  // 不擅自把目标切到 127.0.0.1:8642。
  if (context.storedUrl.trim() !== '') return null;

  const health = await getJson(fetchImpl, `${LOCAL_GATEWAY_URL}/health`, timeoutMs);
  if (health === null) return null;
  const token = readToken(
    await getJson(fetchImpl, `${LOCAL_GATEWAY_URL}${LOCAL_TOKEN_PATH}`, timeoutMs),
  );
  return token === null ? null : { token, gatewayUrl: LOCAL_GATEWAY_URL };
}
