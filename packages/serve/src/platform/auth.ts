/**
 * 0.49 G1：Platform Gateway 的独立鉴权链。
 *
 * 与 node 的 `resolveNodeAuth` 不共享 principal：平台 token 只表示“平台入口已认证”，
 * 不映射成任何 node principal。token 不进 URL/query，错误体不回显 token。
 *
 * @module @vessel-agent/serve/platform/auth
 */

import { timingSafeEqual } from 'node:crypto';
import { isLoopbackAddress } from '../gateway/auth.js';

/** 平台凭据模式：token = 平台 bearer；anonymous = 回环只读。 */
export type PlatformAuthMode = 'token' | 'anonymous';

/** 鉴权结果；`ok:false` 时由调用方回 401。 */
export interface PlatformAuthResult {
  ok: boolean;
  mode: PlatformAuthMode;
  /** 请求来源 socket 是否回环（credentials 端点额外要求）。 */
  loopback: boolean;
}

export interface ResolvePlatformAuthInput {
  req: Request;
  /** `server.requestIP(req)?.address`；缺失视为非回环（fail-closed）。 */
  address: string | null | undefined;
  /** 未配置 = undefined。 */
  platformToken?: string;
}

/** 从 Authorization: Bearer 取 token；空串视为未提供。 */
export function bearerToken(req: Request): string | null {
  const authorization = req.headers.get('authorization');
  if (authorization === null || !authorization.startsWith('Bearer ')) return null;
  const value = authorization.slice('Bearer '.length);
  return value === '' ? null : value;
}

/** 定长比较，避免按字节提前返回。 */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 平台鉴权矩阵（契约 §3.2）：
 * - 配置了 `platformToken`：必须匹配，回环也不例外。
 * - 未配置：仅回环 socket → 匿名只读；非回环 → 拒绝（即使未配置）。
 */
export function resolvePlatformAuth(input: ResolvePlatformAuthInput): PlatformAuthResult {
  const loopback = isLoopbackAddress(input.address);
  const expected = input.platformToken;
  if (typeof expected === 'string' && expected !== '') {
    const provided = bearerToken(input.req);
    const ok = provided !== null && constantTimeEqual(provided, expected);
    return { ok, mode: ok ? 'token' : 'anonymous', loopback };
  }
  return { ok: loopback, mode: 'anonymous', loopback };
}
