import { extractTokenFromHash } from '../app/router';
import { t } from '../i18n';
import { DEV_PROXY_TOKEN, resolveConnectionSeed } from './dev-auth';
import { GATEWAY_URL_KEY, resolveInitialGatewayUrl } from './url';

/**
 * 平台 token 槽：只写 sessionStorage；`#token=` 是它的种子。
 * 平台 token 只用于 `/platform/rpc`，不会发送给 node。
 */
export const PLATFORM_TOKEN_KEY = 'vessel.platform-token';

/**
 * legacy `--serve`（node 宿主 UI）的 node token 槽，保留旧 key。
 * 平台模式下不使用；legacy 回退时由引导层选择。
 */
export const LEGACY_TOKEN_KEY = 'vessel.token';

/**
 * 首次平台 token：先处理 `#token=`，再读 sessionStorage。
 * 该函数必须在路由初始化前调用（会从 URL 移除 token）。
 */
export function consumeInitialPlatformToken(): string {
  const { token, restHash } = extractTokenFromHash(window.location.hash);
  if (token) {
    sessionStorage.setItem(PLATFORM_TOKEN_KEY, token);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${restHash}`,
    );
    return token;
  }
  return sessionStorage.getItem(PLATFORM_TOKEN_KEY) ?? '';
}

/** legacy 回退时使用的 node token（旧 `vessel.token` 槽）。 */
export function readLegacyNodeToken(): string {
  return sessionStorage.getItem(LEGACY_TOKEN_KEY) ?? '';
}

function initialPlatformUrl(): { url: string; error: string | null } {
  // 0.49：`vessel.gateway-url` 语义 = 平台 origin；空串 = 页面同源。
  const resolved = resolveInitialGatewayUrl(
    localStorage.getItem(GATEWAY_URL_KEY),
    undefined,
    window.location.protocol,
  );
  return resolved.ok
    ? { url: resolved.value, error: null }
    : { url: '', error: resolved.error ?? t('gateway.connection.invalidUrl') };
}

export interface InitialConnection {
  /** 平台 origin；空串 = 页面同源。 */
  platformUrl: string;
  platformUrlError: string | null;
  platformToken: string;
  /** legacy 回退候选 token（只来自旧 `vessel.token` 槽）。 */
  legacyNodeToken: string;
  /** 开发代理注入占位 token；只对 legacy node 连接生效。 */
  devProxyAuth: boolean;
}

/** 模块加载期初始化：顺序必须是 token → seed → platform URL。 */
export function computeInitialConnection(): InitialConnection {
  const platformToken = consumeInitialPlatformToken();
  const legacyNodeToken = readLegacyNodeToken();
  const seed = resolveConnectionSeed({
    dev: import.meta.env.DEV === true,
    proxyFlag: import.meta.env.VITE_DEV_PROXY_AUTH as string | undefined,
    // 旧 `vessel.token` 也算显式凭据：与 0.48 的 dev 代理行为保持一致。
    explicitToken: platformToken !== '' ? platformToken : legacyNodeToken,
    storedUrl: localStorage.getItem(GATEWAY_URL_KEY),
    // 0.49：平台 URL 只来自 localStorage 或同源；构建期 env 不再参与。
    envUrl: undefined,
  });
  // 代理模式强制同源：不读 VITE_GATEWAY_URL，也不走 localStorage。
  const initialPlatform = seed.devProxyAuth ? { url: '', error: null } : initialPlatformUrl();
  return {
    platformUrl: initialPlatform.url,
    platformUrlError: initialPlatform.error,
    platformToken,
    legacyNodeToken: seed.devProxyAuth ? DEV_PROXY_TOKEN : legacyNodeToken,
    devProxyAuth: seed.devProxyAuth,
  };
}
