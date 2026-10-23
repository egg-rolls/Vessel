/**
 * 开发代理鉴权（dev proxy auth）的纯函数判定。
 *
 * 只在 Vite 开发服务器下、显式开启 `VITE_DEV_PROXY_AUTH=1`、且**没有任何显式凭据**时，
 * 前端才用同源地址 + 非密钥占位 token 连接由 dev server 转发到 gateway 的代理端点。
 * 显式凭据（`#token=` / sessionStorage token / localStorage gateway URL）一律走原路径，
 * 生产构建（`dev: false`）永远不会返回 `devProxyAuth: true`。
 *
 * 独立成纯函数是为了让单测不依赖 `import.meta.env`。
 */

/** 占位 token：gateway 侧由 dev 代理注入真实凭据，前端从不持久化该值。 */
export const DEV_PROXY_TOKEN = 'vessel-dev-proxy';

export interface ConnectionSeed {
  /** 空串 = 同源。 */
  gatewayUrl: string;
  token: string;
  devProxyAuth: boolean;
}

export interface ConnectionSeedInput {
  /** `import.meta.env.DEV`。 */
  dev: boolean;
  /** `import.meta.env.VITE_DEV_PROXY_AUTH`（只有 `'1'` 才算开启）。 */
  proxyFlag: string | undefined;
  /** 已消费的显式 token（`#token=` 或 sessionStorage）。 */
  explicitToken: string;
  /** localStorage 里的 gateway URL。 */
  storedUrl: string | null | undefined;
  /** 构建期 `VITE_GATEWAY_URL`。 */
  envUrl: string | null | undefined;
}

/** 是否已有显式凭据；任一项存在都不得隐式启用 dev 代理。 */
export function hasExplicitCredentials(
  input: Pick<ConnectionSeedInput, 'explicitToken' | 'storedUrl'>,
): boolean {
  return input.explicitToken.trim() !== '' || (input.storedUrl?.trim() ?? '') !== '';
}

export function resolveConnectionSeed(input: ConnectionSeedInput): ConnectionSeed {
  const explicitToken = input.explicitToken.trim();
  const storedUrl = input.storedUrl?.trim() ?? '';
  const envUrl = input.envUrl?.trim() ?? '';

  // 显式凭据优先：保留原有地址解析与校验路径，不启用代理模式。
  if (explicitToken !== '' || storedUrl !== '') {
    return {
      gatewayUrl: storedUrl !== '' ? storedUrl : envUrl,
      token: input.explicitToken,
      devProxyAuth: false,
    };
  }

  // 只有开发构建 + 显式开关，才使用同源代理与非密钥占位 token。
  if (input.dev && input.proxyFlag === '1') {
    return { gatewayUrl: '', token: DEV_PROXY_TOKEN, devProxyAuth: true };
  }

  return { gatewayUrl: '', token: input.explicitToken, devProxyAuth: false };
}
