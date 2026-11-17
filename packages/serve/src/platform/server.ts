/**
 * 0.49 G1：Platform Gateway 独立监听。
 *
 * 单一 `Bun.serve`：静态宿主 + `/health` + `POST /platform/rpc`。
 * 路由表与 node 完全分离：`/v1/*`、`/plugins/*`、`/ws`、`/sse` 一律 404，不反代。
 *
 * @module @vessel-agent/serve/platform/server
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type AuthRequestContext, AuthService } from '../auth/index.js';
import {
  buildContentSecurityPolicy,
  corsHeaders,
  hostAllowed,
  normalizeAllowedOrigins,
  originAllowed,
  resolveRequestEdge,
} from '../gateway/auth.js';
import { serveStatic } from '../gateway/static.js';
import { platformUnauthorizedMessage, resolvePlatformAuth } from './auth.js';
import { platformListenGuard } from './listen-guard.js';
import { createPlatformRegistry } from './registry.js';
import { handlePlatformRpc } from './rpc.js';
import type { PlatformAuthOptions, PlatformGateway, PlatformGatewayOptions } from './types.js';

const PLATFORM_RPC_PATH = '/platform/rpc';

/** node 独占路径：平台入口一律 404（不代理、不转发）。 */
function isNodeOnlyPath(path: string): boolean {
  return (
    path === '/v1' ||
    path.startsWith('/v1/') ||
    path === '/plugins' ||
    path.startsWith('/plugins/') ||
    path === '/ws' ||
    path.startsWith('/ws/') ||
    path === '/sse' ||
    path.startsWith('/sse/')
  );
}

/**
 * 0.55 P0：401 文案必须能直接照做 —— 分清「缺反代密钥」与「缺平台 token」。
 * 仍然只用 CONTRACT §7 的 `platform_unauthorized` 错误码（Web 端据此弹「需要 token」）。
 * 0.55 拍板项 2：文案与 `rpc.ts` 的凭据端点共用（见 `auth.ts`），避免两处口径漂移。
 */
function json(data: unknown, status: number, extra: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

function errorJson(
  code: string,
  message: string,
  status: number,
  extra: Record<string, string>,
): Response {
  return json({ error: { code, message } }, status, extra);
}

/** 0.56：没有任何 auth 配置时的等价物 —— 空后端 = 行为退回 0.55。 */
const DISABLED_AUTH: PlatformAuthOptions = {
  publicOrigin: null,
  allowedHosts: [],
  backends: [],
  session: { idleMinutes: 30, absoluteHours: 12 },
};

/** 配置了登录后端、但请求来自公网（或经反代）且没有会话。 */
function sessionRequiredMessage(): string {
  return (
    'session_required: 这个部署启用了 WebUI 登录（auth.backends），经公网/反代的请求必须' +
    '先登录。请打开站点根路径，用「用 GitHub 登录」获取会话 cookie 后再调用；' +
    '本机直连（127.0.0.1）仍可用 Bearer token 或回环匿名。'
  );
}

/** 会话 cookie 在，但缺少或错误的 CSRF 同步令牌。 */
function csrfRejectedMessage(reason: 'csrf_missing' | 'csrf_failed'): string {
  return (
    (reason === 'csrf_missing' ? 'csrf_missing' : 'csrf_failed') +
    ': 变更类请求必须带 X-Vessel-CSRF 头（值取自 GET /auth/status 的 csrfToken）。' +
    '缺它或值不匹配都会被拒 —— 这是防 CSRF 的同步令牌，不是登录凭据。'
  );
}

/**
 * 校验 `auth.publicOrigin`：只接受 `scheme://host[:port]`，不接受路径/查询/凭据。
 *
 * 它是 `redirect_uri` 的**唯一**来源（不许从请求头推导），配错就是登录后 404，
 * 所以在启动时 fail-fast，而不是等用户点登录才发现。
 */
function normalizePublicOrigin(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `auth.publicOrigin "${trimmed}" is not an absolute URL (expected https://host).`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`auth.publicOrigin "${trimmed}" must be http(s).`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`auth.publicOrigin "${trimmed}" must not carry credentials.`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`auth.publicOrigin "${trimmed}" must be scheme://host[:port] only.`);
  }
  return url.origin;
}

/**
 * 启动平台监听。`staticDir/index.html` 缺失时 fail-fast（P10），错误信息带解析后路径。
 */
export function startPlatformGateway(opts: PlatformGatewayOptions): PlatformGateway {
  // 0.55 P0：fail-closed。非回环监听 + 没有 platform token ⇒ 拒绝启动（不是警告）。
  const listenGuard = platformListenGuard({
    hostname: opts.hostname,
    port: opts.port,
    platformToken: opts.platformToken,
  });
  if (listenGuard !== null) throw new Error(listenGuard);

  const staticDir = resolve(opts.staticDir);
  const indexFile = resolve(staticDir, 'index.html');
  if (!existsSync(indexFile)) {
    throw new Error(
      `Platform gateway requires a built web UI: missing ${indexFile}. ` +
        'Build apps/web (npm run build) before starting the gateway.',
    );
  }

  const allowedOrigins = normalizeAllowedOrigins(opts.allowedOrigins);
  const nodeOrigins = normalizeAllowedOrigins(opts.nodeOrigins);
  const hubOrigins = normalizeAllowedOrigins(opts.hubOrigins);
  const registry = createPlatformRegistry(opts.nodes);
  const version = opts.version ?? 'unknown';
  const platformToken = opts.platformToken;
  const proxySecret = opts.proxySecret;

  // 0.56 登录基座。未配置 auth.backends 时后端列表为空 ⇒ AuthService 报
  // `enabled === false`，不拦任何人，行为与 0.55 逐字一致（不锁死回环）。
  const authOptions: PlatformAuthOptions = { ...DISABLED_AUTH, ...opts.auth };
  const publicOrigin = normalizePublicOrigin(authOptions.publicOrigin);
  const publicHosts = publicOrigin === null ? [] : [new URL(publicOrigin).host];
  // 公网 origin 同时是合法 CORS Origin：反代后面板仍是同源页面，但 Origin 头会
  // 是公网域名；把它并入 allowlist 才能过 Origin 闸且拿到正确的 CORS 头。
  const httpAllowedOrigins =
    publicOrigin === null
      ? allowedOrigins
      : normalizeAllowedOrigins([...allowedOrigins, publicOrigin]);
  const authService = new AuthService({
    ...authOptions,
    publicOrigin,
    env: authOptions.env ?? (process.env as Record<string, string | undefined>),
    log: (message: string) => {
      // 只打非敏感事实：会话 id / csrf / token / secret 都不进这行。
      console.warn(`[platform-auth] ${message}`);
    },
  });
  const authCleanupTimer = setInterval(() => authService.cleanup(), 60_000);
  authCleanupTimer.unref?.();

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const address = srv.requestIP(req)?.address ?? null;

      // 0.56：先解析「受信边缘」。反代头（Host / X-Forwarded-Proto）只有在本请求
      // 来自受信代理时才被采信；否则一律用请求自身，伪造 Host 拿不到公网身份。
      const edge = resolveRequestEdge(req, {
        address,
        proxySecret,
        ...(authOptions.trustedProxies !== undefined
          ? { trustedProxies: authOptions.trustedProxies }
          : {}),
      });
      const extra = corsHeaders(req, httpAllowedOrigins);

      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: { Allow: 'GET, POST, OPTIONS', ...extra },
        });
      }

      // 平台侧错误码只用 CONTRACT §7 表内项：Host/Origin 拒绝统一为 `forbidden`。
      if (
        !hostAllowed(req, {
          listenHost: opts.hostname,
          publicHosts,
          additionalHosts: authOptions.allowedHosts,
          edge,
        })
      ) {
        return errorJson('forbidden', 'Host header is not allowed', 403, extra);
      }
      if (!originAllowed(req, httpAllowedOrigins)) {
        return errorJson('forbidden', 'Origin is not allowed', 403, extra);
      }

      const authCtx: AuthRequestContext = { edge, address };

      // 0.56：登录端点（/auth/*）**在**鉴权闸之前。配了 token 的部署里，
      // 浏览器必须能先打开登录页、走 OAuth 回来，才谈得上带 cookie 调 RPC。
      const authRoute = await authService.handle(req, url, authCtx);
      if (authRoute !== null) return authRoute;

      const auth = resolvePlatformAuth({
        req,
        address,
        platformToken,
        // 0.56：派生值不算「配置」——回环匿名必须保持（迁移安全）。
        explicitPlatformToken: opts.platformTokenConfigured ?? true,
        ...(proxySecret !== undefined ? { proxySecret } : {}),
      });

      if (isNodeOnlyPath(path)) {
        return errorJson('not_found', `Not found: ${path}`, 404, extra);
      }

      // 静态宿主同样在闸之前：`index.html` 与 `/login` 是登录页本身，匿名也要拿得到
      // （否则「配了 token」⇒ 浏览器永远停在白屏）。数据面仍然要靠 RPC 鉴权。
      if (req.method === 'GET' || req.method === 'HEAD') {
        const staticResponse = await serveStatic(path, staticDir);
        if (staticResponse !== null) {
          const contentType = staticResponse.headers.get('content-type') ?? '';
          if (contentType.includes('text/html')) {
            staticResponse.headers.set(
              'Content-Security-Policy',
              buildContentSecurityPolicy(
                req,
                httpAllowedOrigins,
                {
                  frameSrc: nodeOrigins,
                  connectSrc: [...nodeOrigins, ...hubOrigins],
                },
                { host: edge.host, protocol: edge.protocol },
              ),
            );
          }
          for (const [key, value] of Object.entries(extra)) {
            staticResponse.headers.set(key, value);
          }
          return staticResponse;
        }
      }

      if (path === '/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return errorJson('not_found', `Not found: ${path}`, 404, extra);
        }
        // 0.55 口径不变：health 不放公网（回环或已认证才可读）。
        if (!auth.loopback && !auth.ok) {
          return errorJson('platform_unauthorized', platformUnauthorizedMessage(auth), 401, extra);
        }
        // 平台健康：不含 node runtime 数据；`role` 供 CLI 确定性区分平台/node health。
        return json({ status: 'ok', role: 'platform', version }, 200, extra);
      }

      if (path === PLATFORM_RPC_PATH) {
        if (req.method !== 'POST') {
          return errorJson('method_not_allowed', 'Only POST is allowed', 405, {
            ...extra,
            Allow: 'POST',
          });
        }
        // 鉴权矩阵（0.56 只加「会话」这一项，其余逐字保持 0.55）：
        //  1. Bearer token 成立 → 放行（旧行为，令牌优先，不需要 CSRF）；
        //  2. 会话 cookie 成立 → 放行，但变更类请求必须带 CSRF；
        //  3. 会话 cookie 在但 CSRF 缺失/不匹配 → 403；
        //  4. 配了登录后端且请求不是本机直连（公网/经反代）→ 401 session_required；
        //  5. 非回环且未认证 → 401 platform_unauthorized（旧行为）；
        //  6. 本机直连（127.0.0.1 直连、未配 token）→ 匿名放行（旧行为，防锁死）。
        if (!auth.ok) {
          const gate = authService.authorize(req, authCtx, { mutating: true });
          if (!gate.ok && (gate.reason === 'csrf_missing' || gate.reason === 'csrf_failed')) {
            return errorJson('csrf_failed', csrfRejectedMessage(gate.reason), 403, extra);
          }
          if (!gate.ok && authService.enabled && !edge.localDirect) {
            return errorJson('session_required', sessionRequiredMessage(), 401, extra);
          }
          if (!gate.ok && !auth.loopback) {
            return errorJson(
              'platform_unauthorized',
              platformUnauthorizedMessage(auth),
              401,
              extra,
            );
          }
        }
        return handlePlatformRpc(
          req,
          { auth, registry, resolveNodeCredential: opts.resolveNodeCredential, version },
          extra,
        );
      }

      return errorJson('not_found', `Not found: ${path}`, 404, extra);
    },
  });

  return {
    // Bun 对 unix socket 返回 undefined；平台只走 TCP，回退到请求端口。
    port: server.port ?? opts.port,
    async stop(): Promise<void> {
      clearInterval(authCleanupTimer);
      await authService.flush();
      await server.stop(true);
    },
  };
}
