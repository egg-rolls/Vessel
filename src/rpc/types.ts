/**
 * RPC 客户端冻结形状（0.5 E16 / A-3 §10.2–§10.3、A-4 §11.1）
 *
 * asm 只透传 method/params/result，不做 seq 转换：
 * - `events.list` 返回 trace 的 RunEvent.seq；
 * - `events.subscribe.since` 是 gateway wire seq。
 *
 * @module vessel/rpc
 */

import { FROZEN_RPC_ERROR_CODES } from '@vessel-agent/core';

/** 请求信封 */
export interface RpcRequest {
  v: 1;
  id: string;
  method: string;
  params?: unknown;
}

/**
 * 错误码清单（gw-F2）：联合类型与 `isRpcResponse` 的白名单 Set 都从这一份
 * 派生 —— 不允许手抄第二份码表。q-error-e1 起单源上移到 core
 * `types/error-registry.ts` 的 FROZEN_RPC_ERROR_CODES（serve RpcErrorCode 同源），
 * 三处手抄漂移口结构性消除。新增冻结码只改 core 一处。
 * （历史：过去白名单手抄漏了 8 个已声明码（gateway_restarting 等），合法错误信封
 * 被 `unwrapRpcResponse` 判成 `internal: invalid RPC response envelope`，drain 的
 * 「可重试」语义在 HTTP 客户端侧断裂。）
 */
const RPC_ERROR_CODE_LIST = FROZEN_RPC_ERROR_CODES;

/** 错误码（从单源清单派生） */
export type RpcErrorCode = (typeof RPC_ERROR_CODE_LIST)[number];

/** 成功响应 */
export interface RpcSuccessResponse {
  v: 1;
  id: string;
  ok: true;
  result: unknown;
}

/** 失败响应 */
export interface RpcErrorResponse {
  v: 1;
  id: string;
  ok: false;
  error: {
    code: RpcErrorCode;
    message: string;
    details?: unknown;
  };
}

/** 响应信封 */
export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

/** 客户端错误；错误信息永不包含 token */
export class RpcClientError extends Error {
  readonly code: RpcErrorCode;
  readonly details?: unknown;
  readonly httpStatus?: number;

  constructor(
    code: RpcErrorCode,
    message: string,
    options: { details?: unknown; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = 'RpcClientError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
  }
}

/** 订阅通知（A-3 §10.3 统一形状） */
export interface RpcEventNotification {
  method: 'events.event';
  /** RunEvent */
  params: unknown;
}

/** RPC 客户端 */
export interface RpcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  subscribe(handler: (notification: RpcEventNotification) => void): () => void;
}

/** web 提供、asm LocalRpcClient 消费 */
export type RpcDispatcher = (request: RpcRequest) => Promise<RpcResponse>;

/** 白名单从单源清单派生（gw-F2）：与 `RpcErrorCode` 联合永不漂移。 */
const RPC_ERROR_CODES = new Set<RpcErrorCode>(RPC_ERROR_CODE_LIST);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验响应信封（版本 / id / 形状） */
export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!isRecord(value) || value.v !== 1 || typeof value.id !== 'string') return false;
  if (value.ok === true) return true;
  if (value.ok !== false || !isRecord(value.error)) return false;
  return (
    typeof value.error.code === 'string' &&
    RPC_ERROR_CODES.has(value.error.code as RpcErrorCode) &&
    typeof value.error.message === 'string'
  );
}

/** 解包响应；失败抛 RpcClientError */
export function unwrapRpcResponse<T = unknown>(response: unknown, expectedId: string): T {
  if (!isRpcResponse(response)) {
    throw new RpcClientError('internal', 'invalid RPC response envelope');
  }
  if (response.id !== expectedId) {
    throw new RpcClientError('internal', 'RPC response id mismatch');
  }
  if (response.ok) return response.result as T;

  throw new RpcClientError(response.error.code, response.error.message, {
    ...(response.error.details !== undefined ? { details: response.error.details } : {}),
  });
}
