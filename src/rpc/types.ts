/**
 * RPC 客户端冻结形状（0.5 E16 / A-3 §10.2–§10.3、A-4 §11.1）
 *
 * asm 只透传 method/params/result，不做 seq 转换：
 * - `events.list` 返回 trace 的 RunEvent.seq；
 * - `events.subscribe.since` 是 gateway wire seq。
 *
 * @module vessel/rpc
 */

/** 请求信封 */
export interface RpcRequest {
  v: 1;
  id: string;
  method: string;
  params?: unknown;
}

/** 错误码 */
export type RpcErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_params'
  | 'tenant_locked'
  | 'quota_exceeded'
  | 'conflict'
  | 'internal'
  // 0.12：可选能力未注入（DECISION-023 §2.3）。
  | 'not_supported'
  // 0.13：权限/交互请求已过期或已取消（DECISION-024 §2.2）。
  | 'expired'
  // 0.13 Addendum A：run 已结束 / 重启后找不到 run。
  | 'run_ended';

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

const RPC_ERROR_CODES = new Set<RpcErrorCode>([
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_params',
  'tenant_locked',
  'quota_exceeded',
  'conflict',
  'internal',
  'not_supported',
  'expired',
  'run_ended',
]);

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
