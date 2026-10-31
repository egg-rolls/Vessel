import { extractTokenFromHash } from '../app/router';
import { t } from '../i18n';
import { type ConnectionSeed, resolveConnectionSeed } from './dev-auth';
import { GATEWAY_URL_KEY, resolveInitialGatewayUrl } from './url';

export const TOKEN_KEY = 'vessel.token';

/** 首次 token：先处理 `#token=`，再读 sessionStorage。该函数必须在路由初始化前调用。 */
export function consumeInitialToken(): string {
  const { token, restHash } = extractTokenFromHash(window.location.hash);
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${restHash}`,
    );
    return token;
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

export function initialGatewayUrl(): { url: string; error: string | null } {
  const resolved = resolveInitialGatewayUrl(
    localStorage.getItem(GATEWAY_URL_KEY),
    import.meta.env.VITE_GATEWAY_URL as string | undefined,
    window.location.protocol,
  );
  return resolved.ok
    ? { url: resolved.value, error: null }
    : { url: '', error: resolved.error ?? t('gateway.connection.invalidUrl') };
}

export interface InitialConnection {
  seed: ConnectionSeed;
  gateway: { url: string; error: string | null };
}

/** 模块加载期初始化：顺序必须是 token → seed → gateway。 */
export function computeInitialConnection(): InitialConnection {
  const initialTokenValue = consumeInitialToken();
  const initialSeed = resolveConnectionSeed({
    dev: import.meta.env.DEV === true,
    proxyFlag: import.meta.env.VITE_DEV_PROXY_AUTH as string | undefined,
    explicitToken: initialTokenValue,
    storedUrl: localStorage.getItem(GATEWAY_URL_KEY),
    envUrl: import.meta.env.VITE_GATEWAY_URL as string | undefined,
  });
  // 代理模式强制同源：不读 VITE_GATEWAY_URL，也不走 localStorage。
  const initialGateway = initialSeed.devProxyAuth ? { url: '', error: null } : initialGatewayUrl();
  return { seed: initialSeed, gateway: initialGateway };
}
