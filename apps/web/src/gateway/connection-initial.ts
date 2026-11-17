import { extractTokenFromHash } from '../app/router';
import { t } from '../i18n';
import { DEV_PROXY_TOKEN, resolveConnectionSeed } from './dev-auth';
import { GATEWAY_URL_KEY, resolveInitialGatewayUrl } from './url';

/**
 * 平台 token 槽：只写 sessionStorage（**手动输入**那条路，见连接设置）。
 *
 * 0.56 P2：`#token=` **不再**写这里 —— URL 里的值只当一次性引导码用一次，
 * 之后一律走登录（口令 + TOTP / GitHub）。
 */
export const PLATFORM_TOKEN_KEY = 'vessel.platform-token';

/**
 * legacy `--serve`（node 宿主 UI）的 node token 槽，保留旧 key。
 * 平台模式下不使用；legacy 回退时由引导层选择。
 */
export const LEGACY_TOKEN_KEY = 'vessel.token';

/**
 * 一次性引导码（`#token=` / `#bootstrap=`）。
 *
 * 只在内存里活到「登录层用掉它」为止：既不进 sessionStorage（刷新即失效是对的，
 * 它是**一次性的**），也不进 history（hash 已被 replaceState 抹掉）。
 */
let pendingBootstrap = '';

/** 待消费的引导码；没有则空串。 */
export function pendingBootstrapCode(): string {
  return pendingBootstrap;
}

/** 用过（或确认无效）后清掉，避免重试循环。 */
export function clearPendingBootstrapCode(): void {
  pendingBootstrap = '';
}

/**
 * 首次连接初始化：先处理 `#token=` / `#bootstrap=`（**只**取引导码），再读 sessionStorage。
 * 该函数必须在路由初始化前调用（会从 URL 移除引导码）。
 */
export function consumeInitialBootstrapCode(): string {
  const { token, restHash } = extractTokenFromHash(window.location.hash);
  if (token) {
    pendingBootstrap = token;
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${restHash}`,
    );
    return token;
  }
  return '';
}

/** 已存的平台 token（手动在连接设置里填过才有；不再是 `#token=` 的种子）。 */
export function readStoredPlatformToken(): string {
  try {
    return sessionStorage.getItem(PLATFORM_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
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
  /** 平台 token（只来自手动输入 / sessionStorage；`#token=` 不再是它的来源）。 */
  platformToken: string;
  /** 待消费的一次性引导码（`#token=` / `#bootstrap=`）；没有则空串。 */
  bootstrapCode: string;
  /** legacy 回退候选 token（只来自旧 `vessel.token` 槽）。 */
  legacyNodeToken: string;
  /** 开发代理注入占位 token；只对 legacy node 连接生效。 */
  devProxyAuth: boolean;
}

/** 模块加载期初始化：顺序必须是引导码 → token → seed → platform URL。 */
export function computeInitialConnection(): InitialConnection {
  const bootstrapCode = consumeInitialBootstrapCode();
  const platformToken = readStoredPlatformToken();
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
    bootstrapCode,
    legacyNodeToken: seed.devProxyAuth ? DEV_PROXY_TOKEN : legacyNodeToken,
    devProxyAuth: seed.devProxyAuth,
  };
}
