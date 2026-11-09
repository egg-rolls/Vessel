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
import {
  buildContentSecurityPolicy,
  corsHeaders,
  hostAllowed,
  normalizeAllowedOrigins,
  originAllowed,
} from '../gateway/auth.js';
import { serveStatic } from '../gateway/static.js';
import { resolvePlatformAuth } from './auth.js';
import { createPlatformRegistry } from './registry.js';
import { handlePlatformRpc } from './rpc.js';
import type { PlatformGateway, PlatformGatewayOptions } from './types.js';

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

/**
 * 启动平台监听。`staticDir/index.html` 缺失时 fail-fast（P10），错误信息带解析后路径。
 */
export function startPlatformGateway(opts: PlatformGatewayOptions): PlatformGateway {
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

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const extra = corsHeaders(req, allowedOrigins);

      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: { Allow: 'GET, POST, OPTIONS', ...extra },
        });
      }

      // 平台侧错误码只用 CONTRACT §7 表内项：Host/Origin 拒绝统一为 `forbidden`。
      if (!hostAllowed(req, opts.hostname)) {
        return errorJson('forbidden', 'Host header is not allowed', 403, extra);
      }
      if (!originAllowed(req, allowedOrigins)) {
        return errorJson('forbidden', 'Origin is not allowed', 403, extra);
      }

      const address = srv.requestIP(req)?.address;
      const auth = resolvePlatformAuth({ req, address, platformToken });

      // 非回环且未通过平台认证：一律 401（即使未配置平台 token）。
      if (!auth.loopback && !auth.ok) {
        return errorJson('platform_unauthorized', 'Missing or invalid platform token', 401, extra);
      }

      if (path === '/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return errorJson('not_found', `Not found: ${path}`, 404, extra);
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
        if (!auth.ok) {
          return errorJson(
            'platform_unauthorized',
            'Missing or invalid platform token',
            401,
            extra,
          );
        }
        return handlePlatformRpc(
          req,
          { auth, registry, resolveNodeCredential: opts.resolveNodeCredential, version },
          extra,
        );
      }

      if (isNodeOnlyPath(path)) {
        return errorJson('not_found', `Not found: ${path}`, 404, extra);
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const staticResponse = await serveStatic(path, staticDir);
        if (staticResponse !== null) {
          const contentType = staticResponse.headers.get('content-type') ?? '';
          if (contentType.includes('text/html')) {
            staticResponse.headers.set(
              'Content-Security-Policy',
              buildContentSecurityPolicy(req, allowedOrigins, {
                frameSrc: nodeOrigins,
                connectSrc: [...nodeOrigins, ...hubOrigins],
              }),
            );
          }
          for (const [key, value] of Object.entries(extra)) {
            staticResponse.headers.set(key, value);
          }
          return staticResponse;
        }
      }

      return errorJson('not_found', `Not found: ${path}`, 404, extra);
    },
  });

  return {
    // Bun 对 unix socket 返回 undefined；平台只走 TCP，回退到请求端口。
    port: server.port ?? opts.port,
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}
