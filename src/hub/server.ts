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
import { normalizeNodeUrl } from '../node-registry.js';
import type { HubClientHelloFrame, HubDirectoryFrame } from './client-protocol.js';
import type { HubRegistry } from './registry.js';
import {
  type HubNodeRecord,
  type HubTokenBrokerLike,
  pairingIdFor,
  pairingSecretKey,
  type SecretStore,
} from './types.js';

/** 请求体上限 */
export const HUB_MAX_BODY_BYTES = 1024 * 1024;

/** 默认监听 */
export const HUB_DEFAULT_HOSTNAME = '127.0.0.1';
export const HUB_DEFAULT_PORT = 8643;

/** WS 心跳：15s ping，30s（两轮）无 pong 关闭。 */
const WS_PING_INTERVAL_MS = 15_000;
/** WS 首帧 auth 超时。 */
const WS_AUTH_TIMEOUT_MS = 5_000;
/** 配对请求超时。 */
const PAIRING_REQUEST_TIMEOUT_MS = 10_000;
/** 目录变化广播 debounce（与 registry 写合并节奏一致）。 */
const DIRECTORY_BROADCAST_DEBOUNCE_MS = 250;

export interface HubNodeConnection {
  close(): void | Promise<void>;
}

export type HubConnectNode = (
  record: HubNodeRecord,
  viewToken: string,
) => HubNodeConnection | undefined | Promise<HubNodeConnection | undefined>;

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
  secretStore: SecretStore;
  tokenBroker?: HubTokenBrokerLike;
  connectNode?: HubConnectNode;
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

interface HubWsData {
  authed: boolean;
  alive: boolean;
  /** upgrade 时由 requestIP 判定；回环客户端可匿名。 */
  local: boolean;
  authTimer?: ReturnType<typeof setTimeout>;
}

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

interface ParsedPairing {
  node_id: string;
  tenant_id: string;
  pairing_id: string;
  view_token: string;
  exchange_token: string;
}

function parseIssuedToken(
  value: unknown,
  scope: 'view' | 'exchange',
): { token: string } | undefined {
  if (!isRecord(value)) return undefined;
  if (!isNonEmptyString(value.token) || !isNonEmptyString(value.token_id)) return undefined;
  if (value.scope !== scope) return undefined;
  return { token: value.token };
}

/** 配对响应必须是 PairingTokenPair（node_id / tenant_id / pairing_id / view / exchange）。 */
function parsePairingResponse(value: unknown): ParsedPairing | undefined {
  if (!isRecord(value)) return undefined;
  const nodeId = value.node_id;
  const tenantId = value.tenant_id;
  const pairingId = value.pairing_id;
  if (!isNonEmptyString(nodeId) || !isNonEmptyString(tenantId) || !isNonEmptyString(pairingId)) {
    return undefined;
  }
  if (pairingId !== pairingIdFor(nodeId, tenantId)) return undefined;
  const view = parseIssuedToken(value.view, 'view');
  const exchange = parseIssuedToken(value.exchange, 'exchange');
  if (!view || !exchange) return undefined;
  return {
    node_id: nodeId,
    tenant_id: tenantId,
    pairing_id: pairingId,
    view_token: view.token,
    exchange_token: exchange.token,
  };
}

/** 创建 hub 服务；配置非法时同步抛错（fail-closed）。 */
export function createHubServer(options: CreateHubServerOptions): HubServer {
  const { config, hubId, registry, secretStore, tokenBroker, connectNode, logger } = options;
  const clock = options.now ?? Date.now;

  if (config.direction !== undefined && config.direction !== 'hub') {
    throw configError(
      'hub_direction_unsupported',
      `hub.direction "${config.direction}" is not supported in S5`,
    );
  }

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
  const connections = new Map<string, HubNodeConnection>();
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
      if (ws.data.authed) send(ws, frame);
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

  /** 从节点响应里拿到的 token 只进 SecretStore，永不出现在日志 / 响应 / 目录。 */
  async function handleAddNode(
    srv: import('bun').Server<HubWsData>,
    request: Request,
    extra: Record<string, string>,
  ): Promise<Response> {
    if (!isLoopbackPeer(srv, request)) {
      return errorResponse('forbidden', 'loopback peers only', 403, extra);
    }
    const body = await readJsonBody(request, extra);
    if (!body.ok) return body.response;
    if (!isRecord(body.value)) {
      return errorResponse('invalid_request', 'body must be an object', 400, extra);
    }

    const rawUrl = body.value.url;
    const code = body.value.code;
    if (!isNonEmptyString(rawUrl) || !isNonEmptyString(code)) {
      return errorResponse('invalid_request', 'url and code are required', 400, extra);
    }
    const direction = body.value.direction;
    if (direction !== undefined && direction !== 'hub') {
      return errorResponse('invalid_request', 'direction must be "hub"', 400, extra);
    }
    const alias = body.value.alias;
    if (alias !== undefined && !isNonEmptyString(alias)) {
      return errorResponse('invalid_request', 'alias must be a non-empty string', 400, extra);
    }
    const caFile = body.value.ca_file;
    if (caFile !== undefined && !isNonEmptyString(caFile)) {
      return errorResponse('invalid_request', 'ca_file must be a non-empty string', 400, extra);
    }

    let url: string;
    try {
      url = normalizeNodeUrl(rawUrl);
    } catch (error) {
      return errorResponse(
        'invalid_request',
        error instanceof Error ? error.message : 'invalid node url',
        400,
        extra,
      );
    }

    let ca: string | undefined;
    if (caFile !== undefined) {
      try {
        ca = await Bun.file(caFile).text();
      } catch {
        return errorResponse('invalid_request', 'cannot read ca_file', 400, extra);
      }
      if (ca.trim() === '') {
        return errorResponse('invalid_request', 'ca_file is empty', 400, extra);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAIRING_REQUEST_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    const init: RequestInit & { tls?: { ca: string } } = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: HUB_PROTOCOL,
        code,
        hub_id: hubId,
        direction: 'hub',
        scope: 'view',
      }),
      signal: controller.signal,
    };
    if (ca !== undefined) init.tls = { ca };

    let pairing: ParsedPairing | undefined;
    try {
      const response = await fetch(`${url}/v1/hub/pair`, init as RequestInit);
      if (!response.ok) {
        return errorResponse('pairing_failed', `node returned ${response.status}`, 502, extra);
      }
      pairing = parsePairingResponse(await response.json());
    } catch (error) {
      const aborted = isRecord(error) && error.name === 'AbortError';
      logger?.warn('hub.server.pairing_failed', {
        node_id: 'unknown',
        reason: aborted ? 'timeout' : 'network',
      });
      return errorResponse('pairing_failed', 'node unreachable or invalid response', 502, extra);
    } finally {
      clearTimeout(timer);
    }

    if (!pairing) {
      return errorResponse('pairing_failed', 'invalid pairing response', 502, extra);
    }

    await secretStore.set(pairingSecretKey(pairing.pairing_id, 'view'), pairing.view_token);
    await secretStore.set(pairingSecretKey(pairing.pairing_id, 'exchange'), pairing.exchange_token);

    const record: HubNodeRecord = {
      pairing_id: pairing.pairing_id,
      node_id: pairing.node_id,
      tenant_id: pairing.tenant_id,
      url,
      status: 'connecting',
      truncated: false,
      counts: { teams: 0, agents: 0, live_agents: 0 },
      teams: [],
      agents: [],
      ...(alias !== undefined ? { alias } : {}),
      ...(caFile !== undefined ? { ca_file: caFile } : {}),
    };
    registry.upsert(record);

    if (connectNode) {
      try {
        const connection = await connectNode(record, pairing.view_token);
        if (connection) connections.set(pairing.pairing_id, connection);
      } catch (error) {
        // 配对已成功；连接失败保留目录记录（status=connecting），由调用方重试。
        logger?.warn('hub.server.connect_failed', {
          pairing_id: pairing.pairing_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return jsonResponse(
      200,
      {
        pairing_id: pairing.pairing_id,
        node_id: pairing.node_id,
        tenant_id: pairing.tenant_id,
      },
      extra,
    );
  }

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

    const connection = connections.get(pairingId);
    connections.delete(pairingId);
    if (connection) {
      try {
        await connection.close();
      } catch {
        // best-effort：连接已断也继续清理
      }
    }

    for (const kind of ['view', 'exchange'] as const) {
      try {
        await secretStore.delete(pairingSecretKey(pairingId, kind));
      } catch (error) {
        logger?.warn('hub.server.secret_delete_failed', {
          pairing_id: pairingId,
          kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    registry.remove(pairingId);
    return jsonResponse(200, { ok: true, pairing_id: pairingId }, extra);
  }

  async function handleDataToken(
    srv: import('bun').Server<HubWsData>,
    request: Request,
    extra: Record<string, string>,
  ): Promise<Response> {
    if (!readAuthorized(srv, request)) {
      return errorResponse('unauthorized', 'missing or invalid token', 401, extra);
    }
    if (!tokenBroker) {
      return errorResponse('not_supported', 'token broker is not configured', 501, extra);
    }
    const body = await readJsonBody(request, extra);
    if (!body.ok) return body.response;
    if (!isRecord(body.value)) {
      return errorResponse('invalid_request', 'body must be an object', 400, extra);
    }
    const pairingId = body.value.pairing_id;
    const teamId = body.value.team_id;
    if (!isNonEmptyString(pairingId) || !isNonEmptyString(teamId)) {
      return errorResponse('invalid_request', 'pairing_id and team_id are required', 400, extra);
    }
    const ttl = body.value.ttl_s;
    if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0)) {
      return errorResponse('invalid_request', 'ttl_s must be a positive number', 400, extra);
    }

    const record = registry.get(pairingId);
    if (!record) return errorResponse('not_found', 'pairing not found', 404, extra);

    try {
      const token = await tokenBroker.exchangeForTeam({
        pairing_id: record.pairing_id,
        node_id: record.node_id,
        url: record.url,
        team_id: teamId,
        ...(ttl !== undefined ? { ttl_s: ttl } : {}),
        ...(record.ca_file !== undefined ? { ca_file: record.ca_file } : {}),
      });
      return jsonResponse(200, token, extra);
    } catch (error) {
      logger?.warn('hub.server.data_token_failed', {
        pairing_id: pairingId,
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResponse('exchange_failed', 'token exchange failed', 502, extra);
    }
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
          const upgraded = srv.upgrade(request, {
            data: { authed: false, alive: true, local },
          });
          if (!upgraded) {
            return errorResponse('upgrade_failed', 'websocket upgrade failed', 400, extra);
          }
          return undefined;
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

        if (path === '/v1/hub/nodes' && request.method === 'POST') {
          return handleAddNode(srv, request, extra);
        }

        if (path === '/v1/hub/data-token' && request.method === 'POST') {
          return handleDataToken(srv, request, extra);
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
        wsClients.add(ws);
        ws.data.alive = true;
        ws.data.authTimer = setTimeout(() => {
          if (!ws.data.authed) ws.close(4401, 'auth timeout');
        }, WS_AUTH_TIMEOUT_MS);
        (ws.data.authTimer as { unref?: () => void }).unref?.();
      },
      message(ws, message) {
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
        if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
        ws.data.authTimer = undefined;
        wsClients.delete(ws);
      },
      pong(ws) {
        ws.data.alive = true;
      },
    },
  });

  const pingTimer = setInterval(() => {
    for (const ws of [...wsClients]) {
      if (!ws.data.authed) continue;
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
      for (const ws of [...wsClients]) {
        try {
          ws.close(1001, 'hub stopping');
        } catch {
          // best-effort
        }
      }
      wsClients.clear();
      for (const connection of connections.values()) {
        try {
          await connection.close();
        } catch {
          // best-effort
        }
      }
      connections.clear();
      await server.stop(true);
    },
  };
}
