/**
 * Hub 控制面 HTTP / WS（S5 / `vessel.hub/1`）。
 *
 * 只做三件事：维护节点目录、与节点保持 control 连接、向目录客户端推
 * 指针 / 快照。**不**启动 runtime / AgentService / TenantEventHub，也**没有**
 * 消息 / 事件 / 权限 / 工具端点。
 *
 * - 默认监听 `127.0.0.1:8643`；
 * - 非回环必须 `allowRemote=true` + TLS cert/key + 非空 `tokenEnv`
 *   （fail-closed，无 `--insecure`）；
 * - 复用 `@vessel-agent/serve` 的 Host / Origin / CORS 语义；
 * - 写端点（配对 / 移除）只接受回环 peer；
 * - 目录 / 事件响应永不包含 token。
 *
 * @module vessel/hub/server
 */

import type { HubConfig } from '@vessel-agent/config';
import type { Logger } from '@vessel-agent/core';
import {
  corsHeaders,
  HUB_NODE_CONTROL_PATH,
  HUB_PROTOCOL,
  type HubPingFrame,
  type HubPointerFrame,
  type HubPointerReason,
  hostAllowed,
  isHubProtocol,
  isLoopbackHostname,
  loadTlsMaterial,
  normalizeAllowedOrigins,
  originAllowed,
} from '@vessel-agent/serve';
import type { HubClientHelloFrame, HubDirectoryFrame } from './client-protocol.js';
import {
  createHubNodeInbound,
  type HubNodeInbound,
  type HubNodeInboundConnection,
} from './inbound-control.js';
import { normalizeNodeUrl } from './node-url.js';
import type { HubRegistry } from './registry.js';
import { type HubNodeInboundDeps, type IssuedHubNodeToken, pairingIdFor } from './types.js';

/** 请求体上限 */
export const HUB_MAX_BODY_BYTES = 1024 * 1024;

/** 默认监听 */
export const HUB_DEFAULT_HOSTNAME = '127.0.0.1';
export const HUB_DEFAULT_PORT = 8643;

/** WS 心跳：15s ping，30s（两轮）无 pong 关闭。 */
const WS_PING_INTERVAL_MS = 15_000;
/** WS 首帧 auth 超时。 */
const WS_AUTH_TIMEOUT_MS = 5_000;
/** 目录变化广播 debounce（与 registry 写合并节奏一致）。 */
const DIRECTORY_BROADCAST_DEBOUNCE_MS = 250;
/** join 失败限流：每个 IP 每分钟允许的失败次数。 */
const JOIN_RATE_LIMIT_WINDOW_MS = 60_000;
const JOIN_RATE_LIMIT_MAX_FAILURES = 5;

export interface HubServerPointerInput {
  node_id: string;
  team_id: string;
  reason: HubPointerReason;
  request_id?: string;
  ts?: number;
}

export interface CreateHubServerOptions {
  config: HubConfig;
  hubId: string;
  registry: HubRegistry;
  /** 提供时启用 `POST /v1/hub/join` 与 `GET /v1/hub/node-control`；缺省 404。 */
  nodeControl?: HubNodeInboundDeps;
  logger?: Logger;
  now?: () => number;
}

export interface HubServer {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
  /** 向已鉴权的事件客户端广播指针。 */
  publishPointer(pointer: HubServerPointerInput): void;
  /** 立即向已鉴权的事件客户端广播完整目录。 */
  publishDirectory(): void;
  /** 兼容旧名：等价 `publishDirectory()`。 */
  publishSnapshot(pairingId: string): void;
  /** 幂等停止。 */
  stop(): Promise<void>;
}

/** `/v1/hub/events` 目录客户端。 */
interface DirectoryWsData {
  kind: 'directory';
  authed: boolean;
  alive: boolean;
  /** upgrade 时由 requestIP 判定；回环客户端可匿名。 */
  local: boolean;
  authTimer?: ReturnType<typeof setTimeout>;
}

/** `/v1/hub/node-control` 的 node 入站连接；状态机由 inbound-control 持有。 */
interface NodeWsData {
  kind: 'node';
  inbound?: HubNodeInboundConnection;
}

type HubWsData = DirectoryWsData | NodeWsData;

type Ws = import('bun').ServerWebSocket<HubWsData>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function configError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function jsonResponse(status: number, body: unknown, extra: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  extra: Record<string, string>,
): Response {
  return jsonResponse(status, { ok: false, error: { code, message } }, extra);
}

/** join store 错误码 → HTTP 状态；未知一律 500。 */
function joinStatus(code: unknown): number {
  switch (code) {
    case 'pairing_not_found':
      return 404;
    case 'pairing_invalid':
      return 401;
    case 'pairing_expired':
    case 'pairing_used':
      return 410;
    case 'tenant_mismatch':
      return 400;
    default:
      return 500;
  }
}

/** 只放行稳定错误码；其余折叠成 `internal`，不泄漏实现细节。 */
function joinErrorCode(code: unknown): string {
  switch (code) {
    case 'pairing_not_found':
    case 'pairing_invalid':
    case 'pairing_expired':
    case 'pairing_used':
    case 'tenant_mismatch':
    case 'hub_join_corrupt':
      return code;
    default:
      return 'internal';
  }
}

/** 对外文案；不包含文件路径或 code 明文。 */
function joinMessage(code: string): string {
  switch (code) {
    case 'pairing_not_found':
      return 'Join code not found';
    case 'pairing_invalid':
      return 'Invalid join code';
    case 'pairing_expired':
      return 'Join code expired';
    case 'pairing_used':
      return 'Join code already used';
    case 'tenant_mismatch':
      return 'tenant_id does not match the join code';
    case 'hub_join_corrupt':
      return 'Hub join state is unavailable';
    default:
      return 'Join failed';
  }
}

type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

async function readJsonBody(request: Request, extra: Record<string, string>): Promise<BodyResult> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > HUB_MAX_BODY_BYTES) {
    return {
      ok: false,
      response: errorResponse(
        'payload_too_large',
        `body exceeds ${HUB_MAX_BODY_BYTES} bytes`,
        413,
        extra,
      ),
    };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return {
      ok: false,
      response: errorResponse('invalid_request', 'unreadable body', 400, extra),
    };
  }
  if (Buffer.byteLength(text, 'utf8') > HUB_MAX_BODY_BYTES) {
    return {
      ok: false,
      response: errorResponse(
        'payload_too_large',
        `body exceeds ${HUB_MAX_BODY_BYTES} bytes`,
        413,
        extra,
      ),
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: errorResponse('invalid_request', 'invalid JSON body', 400, extra),
    };
  }
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/** 创建 hub 服务；配置非法时同步抛错（fail-closed）。 */
export function createHubServer(options: CreateHubServerOptions): HubServer {
  const { config, hubId, registry, logger } = options;
  const nodeControl = options.nodeControl;
  const inbound: HubNodeInbound | undefined =
    nodeControl !== undefined ? createHubNodeInbound(nodeControl) : undefined;
  // 吊销 token 时立即关闭持有它的入站 WS（remove / re-join 都走这里）。
  const unsubscribeRevoke =
    nodeControl !== undefined
      ? nodeControl.credentials.onRevoke((tokenId) => {
          inbound?.closeByTokenId(tokenId);
        })
      : undefined;
  const clock = options.now ?? Date.now;

  const hostname = config.listen?.hostname ?? HUB_DEFAULT_HOSTNAME;
  if (!isNonEmptyString(hostname) || hostname.includes('/')) {
    throw configError('hub_invalid_hostname', 'hub.listen.hostname must be a bare host or IP');
  }
  const port = config.listen?.port ?? HUB_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw configError('hub_invalid_port', 'hub.listen.port must be an integer in 0..65535');
  }

  const loopback = isLoopbackHostname(hostname);
  const tokenEnv = isNonEmptyString(config.tokenEnv) ? config.tokenEnv : undefined;
  const hubToken = tokenEnv !== undefined ? process.env[tokenEnv] : undefined;

  if (!loopback) {
    if (config.allowRemote !== true) {
      throw configError(
        'hub_remote_disabled',
        `refusing to listen on non-loopback hostname "${hostname}" without hub.allow_remote=true`,
      );
    }
    if (!config.tls?.certFile || !config.tls?.keyFile) {
      throw configError(
        'hub_remote_requires_tls',
        'remote hub requires hub.tls.cert_file and hub.tls.key_file',
      );
    }
    if (tokenEnv === undefined || !isNonEmptyString(hubToken)) {
      throw configError(
        'hub_remote_requires_token',
        'remote hub requires a non-empty hub.token_env resolved from the environment',
      );
    }
  }

  let tlsMaterial: { cert: string; key: string } | undefined;
  if (config.tls !== undefined) {
    if (!config.tls.certFile || !config.tls.keyFile) {
      throw configError('hub_invalid_tls', 'hub.tls requires both cert_file and key_file');
    }
    tlsMaterial = loadTlsMaterial({
      certFile: config.tls.certFile,
      keyFile: config.tls.keyFile,
    });
  }
  const allowedOrigins = normalizeAllowedOrigins(config.allowedOrigins);

  const wsClients = new Set<Ws>();
  const nodeClients = new Set<Ws>();
  /** join 端点每 IP 失败窗口；单进程内存，不做持久化。 */
  const joinFailures = new Map<string, { count: number; resetAt: number }>();
  let directoryRevision = 0;
  let directoryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function isLoopbackPeer(srv: import('bun').Server<HubWsData>, request: Request): boolean {
    const info = srv.requestIP(request);
    if (info === null || info === undefined) return false;
    // 双栈监听时 IPv4 可能以 ::ffff:127.x 形式出现。
    const address = info.address.startsWith('::ffff:')
      ? info.address.slice('::ffff:'.length)
      : info.address;
    return isLoopbackHostname(address);
  }

  /** 对端地址（join 限流用）；无法判定时落到 `unknown`。 */
  function peerAddress(srv: import('bun').Server<HubWsData>, request: Request): string {
    return srv.requestIP(request)?.address ?? 'unknown';
  }

  function joinRetryAfter(ip: string, now: number): number | undefined {
    const window = joinFailures.get(ip);
    if (window === undefined || now >= window.resetAt) return undefined;
    if (window.count < JOIN_RATE_LIMIT_MAX_FAILURES) return undefined;
    return Math.max(1, Math.ceil((window.resetAt - now) / 1000));
  }

  function recordJoinFailure(ip: string, now: number): void {
    const existing = joinFailures.get(ip);
    if (existing === undefined || now >= existing.resetAt) {
      joinFailures.set(ip, { count: 1, resetAt: now + JOIN_RATE_LIMIT_WINDOW_MS });
      return;
    }
    existing.count += 1;
  }

  function readAuthorized(srv: import('bun').Server<HubWsData>, request: Request): boolean {
    if (isLoopbackPeer(srv, request)) return true;
    if (!isNonEmptyString(hubToken)) return false;
    return bearerToken(request) === hubToken;
  }

  function send(ws: Ws, frame: unknown): void {
    if (ws.readyState !== 1) {
      wsClients.delete(ws);
      return;
    }
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      wsClients.delete(ws);
    }
  }

  function helloFrame(): HubClientHelloFrame {
    return {
      v: 1,
      kind: 'hello',
      protocol: HUB_PROTOCOL,
      dialer: 'hub',
      hub_id: hubId,
      revision: directoryRevision,
      observed_at: clock(),
    };
  }

  function directoryFrame(): HubDirectoryFrame {
    return {
      v: 1,
      kind: 'directory',
      protocol: HUB_PROTOCOL,
      dialer: 'hub',
      hub_id: hubId,
      revision: directoryRevision,
      observed_at: clock(),
      nodes: registry.list(),
    };
  }

  function broadcastFrame(frame: unknown): void {
    for (const ws of [...wsClients]) {
      if (ws.data.kind === 'directory' && ws.data.authed) send(ws, frame);
    }
  }

  function broadcastDirectory(): void {
    broadcastFrame(directoryFrame());
  }

  function scheduleDirectoryBroadcast(): void {
    if (directoryTimer !== undefined) return;
    directoryTimer = setTimeout(() => {
      directoryTimer = undefined;
      broadcastDirectory();
    }, DIRECTORY_BROADCAST_DEBOUNCE_MS);
    (directoryTimer as { unref?: () => void }).unref?.();
  }

  function sendDirectory(ws: Ws): void {
    send(ws, helloFrame());
    send(ws, directoryFrame());
  }

  function publishPointer(pointer: HubServerPointerInput): void {
    const frame: HubPointerFrame = {
      v: 1,
      kind: 'pointer',
      protocol: HUB_PROTOCOL,
      dialer: 'hub',
      node_id: pointer.node_id,
      hub_id: hubId,
      team_id: pointer.team_id,
      reason: pointer.reason,
      ts: pointer.ts ?? clock(),
      ...(pointer.request_id !== undefined ? { request_id: pointer.request_id } : {}),
    };
    broadcastFrame(frame);
  }

  function publishDirectory(): void {
    broadcastDirectory();
  }

  /** 兼容旧名：目录协议下等价于 `publishDirectory()`。 */
  function publishSnapshot(_pairingId: string): void {
    broadcastDirectory();
  }

  const unsubscribe = registry.subscribe(() => {
    directoryRevision += 1;
    scheduleDirectoryBroadcast();
  });

  async function handleRemoveNode(
    srv: import('bun').Server<HubWsData>,
    request: Request,
    pairingId: string,
    extra: Record<string, string>,
  ): Promise<Response> {
    if (!isLoopbackPeer(srv, request)) {
      return errorResponse('forbidden', 'loopback peers only', 403, extra);
    }
    const existing = registry.get(pairingId);
    if (!existing) return errorResponse('not_found', 'pairing not found', 404, extra);

    // node-dial：先关闭入站 WS、吊销 hub 签发的 node token，再删除目录记录。
    inbound?.closeByPairing(pairingId);
    if (nodeControl !== undefined) {
      try {
        await nodeControl.credentials.revokePairing(pairingId);
      } catch (error) {
        // 吊销失败不得删目录：token 仍有效，节点可能重新连回来。
        logger?.warn('hub.server.revoke_failed', {
          pairing_id: pairingId,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResponse('revoke_failed', 'failed to revoke node token', 500, extra);
      }
    }

    registry.remove(pairingId);
    return jsonResponse(200, { ok: true, pairing_id: pairingId }, extra);
  }

  async function handleJoin(request: Request, extra: Record<string, string>): Promise<Response> {
    if (nodeControl === undefined) {
      return errorResponse('not_found', 'not found', 404, extra);
    }

    const body = await readJsonBody(request, extra);
    if (!body.ok) return body.response;
    if (!isRecord(body.value)) {
      return errorResponse('invalid_request', 'body must be an object', 400, extra);
    }
    if (body.value.protocol !== HUB_PROTOCOL) {
      return errorResponse('unsupported_protocol', `protocol must be ${HUB_PROTOCOL}`, 426, extra);
    }

    const code = body.value.code;
    const nodeId = body.value.node_id;
    const tenantId = body.value.tenant_id;
    if (!isNonEmptyString(code) || !isNonEmptyString(nodeId) || !isNonEmptyString(tenantId)) {
      return errorResponse(
        'invalid_request',
        'code, node_id and tenant_id are required',
        400,
        extra,
      );
    }
    const alias = body.value.alias;
    if (alias !== undefined && !isNonEmptyString(alias)) {
      return errorResponse('invalid_request', 'alias must be a non-empty string', 400, extra);
    }
    const rawPublicUrl = body.value.public_url;
    if (rawPublicUrl !== undefined && !isNonEmptyString(rawPublicUrl)) {
      return errorResponse('invalid_request', 'public_url must be a non-empty string', 400, extra);
    }
    let publicUrl: string | undefined;
    if (rawPublicUrl !== undefined) {
      try {
        publicUrl = normalizeNodeUrl(rawPublicUrl);
      } catch (error) {
        return errorResponse(
          'invalid_request',
          error instanceof Error ? error.message : 'invalid public_url',
          400,
          extra,
        );
      }
    }

    const pairingId = pairingIdFor(nodeId, tenantId);

    try {
      await nodeControl.joinStore.consume({
        code,
        hub_id: hubId,
        node_id: nodeId,
        tenant_id: tenantId,
      });
    } catch (error) {
      const raw = isRecord(error) ? error.code : undefined;
      const mapped = joinErrorCode(raw);
      return errorResponse(mapped, joinMessage(mapped), joinStatus(raw), extra);
    }

    let issued: IssuedHubNodeToken;
    try {
      issued = await nodeControl.credentials.issue({
        hub_id: hubId,
        node_id: nodeId,
        tenant_id: tenantId,
        pairing_id: pairingId,
      });
    } catch (error) {
      logger?.warn('hub.server.join_issue_failed', {
        pairing_id: pairingId,
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResponse('internal', 'Join failed', 500, extra);
    }

    // 重新 join：保留刚签发的 token，吊销该 pairing 的旧 token（并关闭旧连接）。
    try {
      await nodeControl.credentials.revokePairing(pairingId, issued.token_id);
    } catch (error) {
      logger?.warn('hub.server.revoke_previous_failed', {
        pairing_id: pairingId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await nodeControl.hooks.onJoined({
        pairing_id: pairingId,
        node_id: nodeId,
        tenant_id: tenantId,
        node_token_id: issued.token_id,
        ...(publicUrl !== undefined ? { public_url: publicUrl } : {}),
        ...(alias !== undefined ? { alias } : {}),
      });
    } catch (error) {
      // 目录落盘失败：撤销刚签发的 token，避免“有凭据没目录”的半成品。
      logger?.warn('hub.server.join_hook_failed', {
        pairing_id: pairingId,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await nodeControl.credentials.revoke(issued.token_id);
      } catch {
        // best-effort：token 仍会在 TTL 后过期
      }
      return errorResponse('join_failed', 'Join failed', 500, extra);
    }

    return jsonResponse(
      200,
      {
        hub_id: hubId,
        node_id: nodeId,
        tenant_id: tenantId,
        pairing_id: pairingId,
        token: issued.token,
        token_id: issued.token_id,
        scope: 'node',
        expires_at: issued.expires_at,
      },
      extra,
    );
  }

  /** `POST /v1/hub/join` 的限流包装：失败计数，成功清空窗口。 */
  async function routeJoin(
    srv: import('bun').Server<HubWsData>,
    request: Request,
    extra: Record<string, string>,
  ): Promise<Response> {
    if (nodeControl === undefined) {
      return errorResponse('not_found', 'not found', 404, extra);
    }
    const ip = peerAddress(srv, request);
    const retryAfter = joinRetryAfter(ip, clock());
    if (retryAfter !== undefined) {
      return jsonResponse(
        429,
        { ok: false, error: { code: 'too_many_requests', message: 'Too many join failures' } },
        { ...extra, 'Retry-After': String(retryAfter) },
      );
    }
    const response = await handleJoin(request, extra);
    if (response.status >= 400) recordJoinFailure(ip, clock());
    else joinFailures.delete(ip);
    return response;
  }

  const server = Bun.serve<HubWsData>({
    hostname,
    port,
    idleTimeout: 0,
    ...(tlsMaterial ? { tls: tlsMaterial } : {}),
    async fetch(request, srv) {
      const url = new URL(request.url);
      const path = url.pathname;
      const extra = corsHeaders(request, allowedOrigins);

      try {
        if (request.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: { Allow: 'GET, POST, DELETE, OPTIONS', ...extra },
          });
        }
        if (!hostAllowed(request, hostname)) {
          return errorResponse('invalid_host', 'Host header is not allowed', 403, extra);
        }
        if (!originAllowed(request, allowedOrigins)) {
          return errorResponse('forbidden_origin', 'Origin is not allowed', 403, extra);
        }

        if (path === '/health' && request.method === 'GET') {
          return jsonResponse(
            200,
            {
              ok: true,
              hub_id: hubId,
              nodes: registry.list().length,
              now: clock(),
            },
            extra,
          );
        }

        if (path === '/v1/hub/events' && request.method === 'GET') {
          const local = isLoopbackPeer(srv, request);
          const data: DirectoryWsData = { kind: 'directory', authed: false, alive: true, local };
          const upgraded = srv.upgrade(request, { data });
          if (!upgraded) {
            return errorResponse('upgrade_failed', 'websocket upgrade failed', 400, extra);
          }
          return undefined;
        }

        if (path === HUB_NODE_CONTROL_PATH) {
          if (nodeControl === undefined) {
            return errorResponse('not_found', 'not found', 404, extra);
          }
          if (request.method !== 'GET') {
            return errorResponse('method_not_allowed', 'method not allowed', 405, extra);
          }
          if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
            return errorResponse('upgrade_required', 'WebSocket upgrade required', 400, extra);
          }
          // token 只走首帧，不接受 URL / query。
          if (url.searchParams.has('token')) {
            return errorResponse(
              'invalid_request',
              'WebSocket auth must use the first auth frame; token in query is not supported',
              400,
              extra,
            );
          }
          const data: NodeWsData = { kind: 'node' };
          const upgraded = srv.upgrade(request, { data });
          if (!upgraded) {
            return errorResponse('upgrade_failed', 'websocket upgrade failed', 400, extra);
          }
          return undefined;
        }

        if (path === '/v1/hub/join') {
          if (nodeControl === undefined) {
            return errorResponse('not_found', 'not found', 404, extra);
          }
          if (request.method !== 'POST') {
            return errorResponse('method_not_allowed', 'method not allowed', 405, extra);
          }
          return routeJoin(srv, request, extra);
        }

        if (path === '/v1/hub/directory' && request.method === 'GET') {
          if (!readAuthorized(srv, request)) {
            return errorResponse('unauthorized', 'missing or invalid token', 401, extra);
          }
          return jsonResponse(200, registry.snapshot(), extra);
        }

        const nodeMatch = /^\/v1\/hub\/nodes\/([^/]+)$/.exec(path);
        if (nodeMatch) {
          let pairingId: string;
          try {
            pairingId = decodeURIComponent(nodeMatch[1] ?? '');
          } catch {
            return errorResponse('invalid_request', 'invalid pairing_id', 400, extra);
          }
          if (pairingId === '') {
            return errorResponse('invalid_request', 'invalid pairing_id', 400, extra);
          }
          if (request.method === 'GET') {
            if (!readAuthorized(srv, request)) {
              return errorResponse('unauthorized', 'missing or invalid token', 401, extra);
            }
            const record = registry.get(pairingId);
            if (!record) return errorResponse('not_found', 'pairing not found', 404, extra);
            return jsonResponse(200, record, extra);
          }
          if (request.method === 'DELETE') {
            return handleRemoveNode(srv, request, pairingId, extra);
          }
          return errorResponse('method_not_allowed', 'method not allowed', 405, extra);
        }

        return errorResponse('not_found', 'not found', 404, extra);
      } catch (error) {
        logger?.error('hub.server.request_failed', {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResponse('internal', 'internal error', 500, extra);
      }
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === 'node') {
          nodeClients.add(ws);
          if (inbound === undefined) {
            try {
              ws.close(1011, 'node control unavailable');
            } catch {
              // best-effort
            }
            return;
          }
          ws.data.inbound = inbound.open(ws);
          return;
        }
        const data = ws.data;
        wsClients.add(ws);
        data.alive = true;
        data.authTimer = setTimeout(() => {
          if (!data.authed) ws.close(4401, 'auth timeout');
        }, WS_AUTH_TIMEOUT_MS);
        (data.authTimer as { unref?: () => void }).unref?.();
      },
      message(ws, message) {
        if (ws.data.kind === 'node') {
          const conn = ws.data.inbound;
          if (conn !== undefined && inbound !== undefined) inbound.message(conn, message);
          return;
        }
        if (ws.data.authed) {
          if (typeof message !== 'string') return;
          try {
            const frame: unknown = JSON.parse(message);
            if (isRecord(frame) && frame.kind === 'pong') ws.data.alive = true;
          } catch {
            // 客户端帧只能是 pong；其它一律忽略。
          }
          return;
        }

        if (typeof message !== 'string') {
          ws.close(4400, 'incompatible');
          return;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(message);
        } catch {
          ws.close(4400, 'incompatible');
          return;
        }
        if (
          !isRecord(frame) ||
          frame.v !== 1 ||
          frame.kind !== 'auth' ||
          !isHubProtocol(frame.protocol)
        ) {
          ws.close(4400, 'incompatible');
          return;
        }

        // 回环客户端可匿名；远程必须携带与 hub 配置一致的 Bearer token。
        const token = typeof frame.token === 'string' ? frame.token : undefined;
        const isLocal = ws.data.local;
        if (!isLocal && (!isNonEmptyString(hubToken) || token !== hubToken)) {
          ws.close(4401, 'unauthorized');
          return;
        }

        ws.data.authed = true;
        if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
        ws.data.authTimer = undefined;
        ws.data.alive = true;
        sendDirectory(ws);
      },
      close(ws) {
        if (ws.data.kind === 'node') {
          nodeClients.delete(ws);
          const conn = ws.data.inbound;
          if (conn !== undefined && inbound !== undefined) inbound.close(conn);
          return;
        }
        if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
        ws.data.authTimer = undefined;
        wsClients.delete(ws);
      },
      pong(ws) {
        if (ws.data.kind === 'node') {
          const conn = ws.data.inbound;
          if (conn !== undefined && inbound !== undefined) inbound.pong(conn);
          return;
        }
        ws.data.alive = true;
      },
    },
  });

  const pingTimer = setInterval(() => {
    for (const ws of [...wsClients]) {
      if (ws.data.kind !== 'directory' || !ws.data.authed) continue;
      if (!ws.data.alive) {
        ws.close(1001, 'heartbeat timeout');
        wsClients.delete(ws);
        continue;
      }
      ws.data.alive = false;
      const frame: HubPingFrame = {
        v: 1,
        kind: 'ping',
        protocol: HUB_PROTOCOL,
        dialer: 'hub',
        ts: clock(),
      };
      send(ws, frame);
    }
  }, WS_PING_INTERVAL_MS);
  (pingTimer as { unref?: () => void }).unref?.();

  const actualPort = server.port ?? port;
  const scheme = tlsMaterial ? 'https' : 'http';

  return {
    hostname,
    port: actualPort,
    url: `${scheme}://${hostname}:${actualPort}`,
    publishPointer,
    publishDirectory,
    publishSnapshot,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(pingTimer);
      if (directoryTimer !== undefined) {
        clearTimeout(directoryTimer);
        directoryTimer = undefined;
      }
      unsubscribe();
      unsubscribeRevoke?.();
      for (const ws of [...wsClients]) {
        try {
          ws.close(1001, 'hub stopping');
        } catch {
          // best-effort
        }
      }
      wsClients.clear();
      // node 入站：先标记停止（避免 onStatus），再关闭套接字。
      inbound?.stop();
      for (const ws of [...nodeClients]) {
        try {
          ws.close(1001, 'hub stopping');
        } catch {
          // best-effort
        }
      }
      nodeClients.clear();
      joinFailures.clear();
      await server.stop(true);
    },
  };
}
