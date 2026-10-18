/**
 * gateway token → principal（0.5 E16 / A-3 §10.4、A-4 §11.5）
 *
 * 映射（冻结）：
 * - `serve.token` → default/admin（0.4 兼容）
 * - `serve.tokens` map → 条目 {tenantId, role}
 * - `serve.adminToken` → tenant "*" / admin
 * - 无 token + 回环 → default/admin（anonymous）
 * - 已配置 token 但未带 → null（401）
 * - 非回环 + 无 token → 拒绝启动
 *
 * token 比较使用常量时间比较；错误信息与日志永不包含 token。
 *
 * @module vessel/serve-auth
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  isLoopbackHostname,
  type Principal,
  type PrincipalRole,
  type VesselConfig,
} from '../packages/config/src/index';

type EnvMap = Record<string, string | undefined>;

/** gateway 鉴权面（web 消费） */
export interface GatewayAuth {
  /** 是否配置了任何 token；配置后缺 token → 401 */
  configured: boolean;
  /** 旧单 token（web 可继续用现有校验） */
  legacyToken?: string;
  authenticate(token: string | null): Principal | null;
  /** 无 token + 回环时的匿名 principal */
  anonymous?: Principal;
}

/** resolveGatewayAuth 选项 */
export interface ResolveGatewayAuthOptions {
  hostname: string;
  allowRemote: boolean;
  env?: EnvMap;
}

/** 解析结果 */
export type ResolveGatewayAuthResult =
  | { ok: true; auth: GatewayAuth }
  | { ok: false; error: string };

interface TokenCandidate {
  token: string;
  principal: Principal;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 常量时间 token 比较（先固定长度哈希） */
export function safeTokenEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function resolveRole(role: PrincipalRole | undefined): PrincipalRole {
  return role ?? 'read';
}

/** 解析 gateway 鉴权；失败返回 error（不含 token） */
export function resolveGatewayAuth(
  config: VesselConfig,
  options: ResolveGatewayAuthOptions,
): ResolveGatewayAuthResult {
  const env = options.env ?? process.env;
  const candidates: TokenCandidate[] = [];

  // 多租户 token map（键是原始 token，原样保留）
  const tokens = config.serve?.tokens;
  if (tokens) {
    for (const [token, entry] of Object.entries(tokens)) {
      if (token === '') continue;
      candidates.push({
        token,
        principal: {
          tenant_id: entry.tenantId ?? 'default',
          role: resolveRole(entry.role),
        },
      });
    }
  }

  // 跨 tenant admin token（显式值优先，其次 admin_token_env）
  const adminToken =
    nonEmpty(config.serve?.adminToken) ??
    nonEmpty(config.serve?.adminTokenEnv ? env[config.serve.adminTokenEnv] : undefined);
  if (adminToken !== undefined) {
    candidates.push({
      token: adminToken,
      principal: { tenant_id: '*', role: 'admin' },
    });
  }

  // 旧单 token：serve.token > serve.token_env > transport.token > VESSEL_GATEWAY_TOKEN
  const legacyToken =
    nonEmpty(config.serve?.token) ??
    nonEmpty(config.serve?.tokenEnv ? env[config.serve.tokenEnv] : undefined) ??
    nonEmpty(config.transport?.token) ??
    nonEmpty(env.VESSEL_GATEWAY_TOKEN);
  if (legacyToken !== undefined) {
    candidates.push({
      token: legacyToken,
      principal: { tenant_id: 'default', role: 'admin' },
    });
  }

  const configured = candidates.length > 0;
  const loopback = isLoopbackHostname(options.hostname);

  if (!configured && !loopback) {
    return {
      ok: false,
      error: 'gateway_requires_token: refusing to start a non-loopback gateway without a token',
    };
  }

  const anonymous: Principal | undefined =
    !configured && loopback ? { tenant_id: 'default', role: 'admin' } : undefined;

  const auth: GatewayAuth = {
    configured,
    ...(legacyToken !== undefined ? { legacyToken } : {}),
    ...(anonymous ? { anonymous } : {}),
    authenticate(token: string | null): Principal | null {
      if (token === null || token === '') {
        return anonymous ?? null;
      }
      for (const candidate of candidates) {
        if (safeTokenEqual(token, candidate.token)) {
          return candidate.principal;
        }
      }
      return null;
    },
  };

  return { ok: true, auth };
}
