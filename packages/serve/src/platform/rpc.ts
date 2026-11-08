/**
 * 0.49 G1：Platform RPC（`POST /platform/rpc`）。
 *
 * 独立 allowlist + 显式 switch；复用 RPC 信封类型，但**不** import node dispatcher /
 * node principal / `gateway/methods/**`。未知方法一律 `not_found`，绝不透传到 node。
 *
 * @module @vessel-agent/serve/platform/rpc
 */

import { RPC_VERSION, type RpcRequest } from '../rpc.js';
import type { PlatformAuthResult } from './auth.js';
import { PlatformNodeNotFoundError, type PlatformRegistry } from './registry.js';
import type { PlatformNodeCredential } from './types.js';

/** 平台只读方法 allowlist（契约 §2.3 冻结）。 */
export type PlatformRpcMethod =
  | 'platform.nodes.list'
  | 'platform.nodes.get'
  | 'platform.nodes.credentials'
  | 'platform.whoami'
  | 'platform.health.get';

export const PLATFORM_RPC_METHODS: readonly PlatformRpcMethod[] = [
  'platform.nodes.list',
  'platform.nodes.get',
  'platform.nodes.credentials',
  'platform.whoami',
  'platform.health.get',
];

/** 平台侧错误码；只新增平台码，不改 node 冻结错误码。 */
export type PlatformRpcErrorCode =
  | 'invalid_params'
  | 'not_found'
  | 'platform_unauthorized'
  | 'platform_credentials_unavailable'
  | 'node_not_found'
  | 'node_unreachable';

export interface PlatformRpcContext {
  auth: PlatformAuthResult;
  registry: PlatformRegistry;
  /** 组合根注入：按 node_id 读取该 node 生效凭据；只读取/透传。 */
  resolveNodeCredential: (nodeId?: string) => PlatformNodeCredential;
  /** 平台版本（`gateway.health.get` / `/health` 共用）。 */
  version: string;
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

function success(
  id: string,
  result: unknown,
  extra: Record<string, string>,
  status = 200,
): Response {
  return json({ v: RPC_VERSION, id, ok: true, result }, status, extra);
}

function failure(
  id: string,
  code: PlatformRpcErrorCode,
  message: string,
  status: number,
  extra: Record<string, string>,
): Response {
  return json({ v: RPC_VERSION, id, ok: false, error: { code, message } }, status, extra);
}

function paramsRecord(params: unknown): Record<string, unknown> | null {
  if (params === undefined) return {};
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  return params as Record<string, unknown>;
}

/**
 * 校验信封并分发。HTTP 语义：
 * - 信封错误 → 400；方法不存在 → 200 + `not_found`；
 * - `node_not_found` → 404；凭据来源不可读 → 503。
 */
export async function handlePlatformRpc(
  req: Request,
  ctx: PlatformRpcContext,
  extra: Record<string, string> = {},
): Promise<Response> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return failure('', 'invalid_params', 'Failed to read request body', 400, extra);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failure('', 'invalid_params', 'Invalid JSON', 400, extra);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return failure('', 'invalid_params', 'Request body must be an object', 400, extra);
  }
  const record = body as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  if (record.v !== RPC_VERSION) {
    return failure(id, 'invalid_params', 'v must be 1', 400, extra);
  }
  if (id === '') {
    return failure('', 'invalid_params', 'id is required', 400, extra);
  }
  if (typeof record.method !== 'string' || record.method === '') {
    return failure(id, 'invalid_params', 'method is required', 400, extra);
  }

  const request: RpcRequest = {
    v: RPC_VERSION,
    id,
    method: record.method,
    ...(record.params !== undefined ? { params: record.params } : {}),
  };

  switch (request.method) {
    case 'platform.nodes.list': {
      const nodes = await ctx.registry.list();
      return success(id, { nodes }, extra);
    }
    case 'platform.nodes.get': {
      const params = paramsRecord(request.params);
      if (params === null) {
        return failure(id, 'invalid_params', 'params must be an object', 400, extra);
      }
      const nodeId = params.node_id;
      if (nodeId !== undefined && typeof nodeId !== 'string') {
        return failure(id, 'invalid_params', 'node_id must be a string', 400, extra);
      }
      try {
        const node = await ctx.registry.get(nodeId);
        return success(id, { node }, extra);
      } catch (error) {
        if (error instanceof PlatformNodeNotFoundError) {
          return failure(id, 'node_not_found', 'Node not found', 404, extra);
        }
        return failure(id, 'node_unreachable', 'Node registry probe failed', 503, extra);
      }
    }
    case 'platform.nodes.credentials': {
      // 只接受回环来源；非回环一律 401（P4 oracle）。
      if (!ctx.auth.loopback) {
        return failure(
          id,
          'platform_unauthorized',
          'Node credentials are only available on loopback',
          401,
          extra,
        );
      }
      const params = paramsRecord(request.params);
      if (params === null) {
        return failure(id, 'invalid_params', 'params must be an object', 400, extra);
      }
      const requestedNodeId = params.node_id;
      if (requestedNodeId !== undefined && typeof requestedNodeId !== 'string') {
        return failure(id, 'invalid_params', 'node_id must be a string', 400, extra);
      }
      // 省略 node_id：恰好一个节点 → 该节点（G1 兼容）；多节点 → 必须指定。
      if (requestedNodeId === undefined && ctx.registry.count() !== 1) {
        return failure(
          id,
          'invalid_params',
          'node_id is required when more than one node is registered',
          400,
          extra,
        );
      }
      let resolved: PlatformNodeCredential;
      try {
        resolved = ctx.resolveNodeCredential(requestedNodeId);
      } catch {
        // 不回显底层错误（可能含配置细节）；不缓存、不落盘。
        return failure(
          id,
          'platform_credentials_unavailable',
          'Node credentials are unavailable',
          503,
          extra,
        );
      }
      if (!resolved.found) {
        return failure(id, 'node_not_found', 'Node not found', 404, extra);
      }
      const token = resolved.token;
      const result =
        typeof token === 'string' && token !== ''
          ? { token, mode: 'token' as const }
          : { token: null, mode: 'none' as const };
      return success(id, result, extra);
    }
    case 'platform.whoami': {
      return success(id, { authenticated: ctx.auth.mode === 'token', mode: ctx.auth.mode }, extra);
    }
    case 'platform.health.get': {
      return success(
        id,
        { status: 'ok', version: ctx.version, node_count: ctx.registry.count() },
        extra,
      );
    }
    default:
      // 未列出的方法（含任意 node 方法名）一律 not_found，不触达 node dispatcher。
      return failure(id, 'not_found', 'Unknown platform method', 200, extra);
  }
}
