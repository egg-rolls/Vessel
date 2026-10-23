/**
 * `POST /v1/hub/pair`（S5）：用一次性配对码换取 `view` + `exchange` token。
 *
 * - 只在注入 `nodeTokens` 时可用；否则 404。
 * - 配对码本身就是凭据（hub 此时尚无 token），因此该端点不要求 Bearer。
 * - 请求体 1 MiB；`direction` 必须是 `'hub'`，`scope` 必须是 `'view'` 或省略。
 * - 明文 token 只在本次响应出现一次；`Cache-Control: no-store`。
 * - 失败按 IP 限流：每分钟 5 次失败后 429（内存 Map，单进程）。
 * - 不记录 token / code 到日志。
 *
 * @module @vessel-agent/serve
 */

import type {
  IssuedNodeToken,
  NodeTokenControlLike,
  PairingTokenPair,
} from '../node-token-control.js';

/** 端点路径。 */
export const HUB_PAIRING_PATH = '/v1/hub/pair';

/** 请求体上限。 */
const HUB_PAIR_MAX_BODY_BYTES = 1024 * 1024;
/** 每个 IP 的失败窗口。 */
const RATE_LIMIT_WINDOW_MS = 60_000;
/** 窗口内允许的失败次数；达到后下一次请求 429。 */
const RATE_LIMIT_MAX_FAILURES = 5;
/** 未启用时的稳定错误码。 */
const NODE_TOKENS_DISABLED = 'Node token control is not available';

export interface HubPairingRouteDeps {
  /** 缺省 = 端点 404。 */
  nodeTokens?: NodeTokenControlLike;
  /** 可注入时钟（测试用）。 */
  now?: () => number;
}

export interface HubPairingRoute {
  /**
   * 返回 `undefined` 表示路径不匹配。
   * `clientIp` 用于按 IP 限流；缺省落到 `unknown`。
   */
  handle(
    req: Request,
    url: URL,
    extra: Record<string, string>,
    clientIp?: string,
  ): Promise<Response | undefined>;
}

interface FailureWindow {
  count: number;
  resetAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function jsonResponse(
  status: number,
  body: unknown,
  extra: Record<string, string>,
  cacheControl = 'no-store',
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
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

/** 只白名单构造签发结果；不透传实现方附带的字段。 */
function toIssuedToken(issued: IssuedNodeToken): Record<string, unknown> | null {
  if (
    !nonEmptyString(issued.token) ||
    !nonEmptyString(issued.token_id) ||
    !nonEmptyString(issued.node_id) ||
    typeof issued.expires_at !== 'number' ||
    !Number.isFinite(issued.expires_at)
  ) {
    return null;
  }
  return {
    token: issued.token,
    token_id: issued.token_id,
    scope: issued.scope,
    tenant_id: issued.tenant_id,
    node_id: issued.node_id,
    ...(nonEmptyString(issued.hub_id) ? { hub_id: issued.hub_id } : {}),
    ...(nonEmptyString(issued.team_id) ? { team_id: issued.team_id } : {}),
    ...(nonEmptyString(issued.pairing_id) ? { pairing_id: issued.pairing_id } : {}),
    expires_at: issued.expires_at,
  };
}

function toPairingResponse(pair: PairingTokenPair): Record<string, unknown> | null {
  if (
    !nonEmptyString(pair.node_id) ||
    !nonEmptyString(pair.tenant_id) ||
    !nonEmptyString(pair.pairing_id)
  ) {
    return null;
  }
  const view = toIssuedToken(pair.view);
  const exchange = toIssuedToken(pair.exchange);
  if (view === null || exchange === null) return null;
  return {
    node_id: pair.node_id,
    tenant_id: pair.tenant_id,
    pairing_id: pair.pairing_id,
    view,
    exchange,
  };
}

/** 配对错误码 → HTTP 状态。 */
function pairingStatus(code: unknown): number {
  switch (code) {
    case 'pairing_not_found':
      return 404;
    case 'pairing_invalid':
      return 401;
    case 'pairing_expired':
    case 'pairing_used':
      return 410;
    case 'unsupported_direction':
      return 400;
    default:
      return 500;
  }
}

function pairingErrorCode(code: unknown): string {
  switch (code) {
    case 'pairing_not_found':
    case 'pairing_invalid':
    case 'pairing_expired':
    case 'pairing_used':
    case 'unsupported_direction':
      return code;
    default:
      return 'internal';
  }
}

/** 对外错误文案；不包含文件路径或配对细节。 */
function pairingMessage(code: string): string {
  switch (code) {
    case 'pairing_not_found':
      return 'Pairing code not found';
    case 'pairing_invalid':
      return 'Invalid pairing code';
    case 'pairing_expired':
      return 'Pairing code expired';
    case 'pairing_used':
      return 'Pairing code already used';
    case 'unsupported_direction':
      return 'direction must be "hub"';
    default:
      return 'Pairing failed';
  }
}

/** 创建配对路由。 */
export function createHubPairingRoute(deps: HubPairingRouteDeps): HubPairingRoute {
  const clock = deps.now ?? Date.now;
  /** 每 IP 的失败窗口；单进程内存，不做持久化。 */
  const failures = new Map<string, FailureWindow>();

  function failureWindow(ip: string, now: number): FailureWindow {
    const existing = failures.get(ip);
    if (existing === undefined || now >= existing.resetAt) {
      const fresh: FailureWindow = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      failures.set(ip, fresh);
      return fresh;
    }
    return existing;
  }

  function isRateLimited(ip: string, now: number): number | undefined {
    const window = failures.get(ip);
    if (window === undefined || now >= window.resetAt) return undefined;
    if (window.count < RATE_LIMIT_MAX_FAILURES) return undefined;
    return Math.max(1, Math.ceil((window.resetAt - now) / 1000));
  }

  function recordFailure(ip: string, now: number): void {
    const window = failureWindow(ip, now);
    window.count += 1;
  }

  async function readBody(
    req: Request,
    extra: Record<string, string>,
  ): Promise<unknown | Response> {
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > HUB_PAIR_MAX_BODY_BYTES) {
      return errorResponse(
        'payload_too_large',
        `Request body exceeds ${HUB_PAIR_MAX_BODY_BYTES} bytes`,
        413,
        extra,
      );
    }
    let text: string;
    try {
      text = await req.text();
    } catch {
      return errorResponse('invalid_request', 'Cannot read request body', 400, extra);
    }
    if (Buffer.byteLength(text) > HUB_PAIR_MAX_BODY_BYTES) {
      return errorResponse(
        'payload_too_large',
        `Request body exceeds ${HUB_PAIR_MAX_BODY_BYTES} bytes`,
        413,
        extra,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return errorResponse('invalid_request', 'Invalid JSON', 400, extra);
    }
  }

  async function pair(req: Request, extra: Record<string, string>): Promise<Response> {
    const nodeTokens = deps.nodeTokens;
    if (nodeTokens === undefined) {
      return errorResponse('not_found', NODE_TOKENS_DISABLED, 404, extra);
    }

    const body = await readBody(req, extra);
    if (body instanceof Response) return body;
    if (!isRecord(body)) {
      return errorResponse('invalid_request', 'Request body must be a JSON object', 400, extra);
    }
    if (body.protocol !== 'vessel.hub/1') {
      return errorResponse('unsupported_protocol', 'protocol must be vessel.hub/1', 426, extra);
    }
    const code = body.code;
    const hubId = body.hub_id;
    if (!nonEmptyString(code)) {
      return errorResponse('invalid_request', 'code is required', 400, extra);
    }
    if (!nonEmptyString(hubId)) {
      return errorResponse('invalid_request', 'hub_id is required', 400, extra);
    }
    if (body.direction !== 'hub') {
      return errorResponse('unsupported_direction', 'direction must be "hub"', 400, extra);
    }
    if (body.scope !== undefined && body.scope !== 'view') {
      return errorResponse('invalid_request', 'scope must be "view"', 400, extra);
    }

    let issuedPair: PairingTokenPair;
    try {
      issuedPair = await nodeTokens.mintPairingTokens({
        hub_id: hubId,
        code,
        direction: 'hub',
      });
    } catch (error) {
      const codeValue = (error as { code?: unknown }).code;
      const mapped = pairingErrorCode(codeValue);
      // 不回传实现方 message（可能含文件路径 / 配对细节）。
      return errorResponse(mapped, pairingMessage(mapped), pairingStatus(codeValue), extra);
    }

    const payload = toPairingResponse(issuedPair);
    if (payload === null) {
      return errorResponse(
        'internal',
        'Node token control returned an invalid pairing',
        500,
        extra,
      );
    }
    return jsonResponse(200, payload, extra);
  }

  return {
    async handle(req, url, extra, clientIp) {
      if (url.pathname !== HUB_PAIRING_PATH) return undefined;
      if (deps.nodeTokens === undefined) {
        return errorResponse('not_found', NODE_TOKENS_DISABLED, 404, extra);
      }
      if (req.method !== 'POST') {
        return errorResponse('method_not_allowed', 'Method not allowed', 405, extra);
      }

      const ip = clientIp ?? 'unknown';
      const now = clock();
      const retryAfter = isRateLimited(ip, now);
      if (retryAfter !== undefined) {
        return jsonResponse(
          429,
          { ok: false, error: { code: 'too_many_requests', message: 'Too many pairing failures' } },
          { ...extra, 'Retry-After': String(retryAfter) },
        );
      }

      const response = await pair(req, extra);
      if (response.status >= 400) recordFailure(ip, clock());
      else failures.delete(ip);
      return response;
    },
  };
}
