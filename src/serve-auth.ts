/**
 * gateway token → principal（0.5 E16 / A-3 §10.4、A-4 §11.5）
 *
 * 映射（冻结）：
 * - `serve.token` → default/admin（0.4 兼容）
 * - `serve.tokens` map → 条目 {tenantId, role}（仅客户端凭据）
 * - `serve.adminToken` → tenant "*" / admin
 * - 无 token + 回环 → default/admin（anonymous）
 * - 已配置 token 但未带 → null（401）
 * - 非回环 + 无 gateway/admin token → 拒绝启动（仅 serve.tokens 不够）
 * - 回环 + 仅 serve.tokens → 允许启动；in-process dispatcher 用第一个
 *   token 的 role（最小权限），HTTP 客户端仍必须带 token
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
import type { NodeTokenAuthenticator } from '../packages/serve/src/index';

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
  /**
   * 节点动态 token 认证面（S5）。null / 空 token 仍走 anonymous；
   * 静态候选优先，未命中再查动态 store。
   */
  tokenStore?: NodeTokenAuthenticator;
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

  // 旧单 token：serve.token > serve.token_env > VESSEL_GATEWAY_TOKEN。
  // `transport.token` 只服务 transport 层，不再作为 gateway admin 凭据
  // （DECISION-020 §R1.9）。
  const legacyToken =
    nonEmpty(config.serve?.token) ??
    nonEmpty(config.serve?.tokenEnv ? env[config.serve.tokenEnv] : undefined) ??
    nonEmpty(env.VESSEL_GATEWAY_TOKEN);
  if (legacyToken !== undefined) {
    candidates.push({
      token: legacyToken,
      principal: { tenant_id: 'default', role: 'admin' },
    });
  }

  const tokenStore = options.tokenStore;
  const configured = candidates.length > 0 || tokenStore?.hasTokens?.() === true;
  const loopback = isLoopbackHostname(options.hostname);
  const hasGatewayToken = legacyToken !== undefined || adminToken !== undefined;

  // 非回环必须有 gateway/admin token；serve.tokens 只是客户端凭据，
  // 不能让“仅 tenant token”的 remote gateway 启动。
  if (!loopback && !hasGatewayToken) {
    return {
      ok: false,
      error: configured
        ? 'gateway_requires_token: non-loopback gateway requires serve.token or serve.admin_token; serve.tokens entries are client credentials only'
        : 'gateway_requires_token: refusing to start a non-loopback gateway without a token',
    };
  }

  const anonymous: Principal | undefined =
    !configured && loopback ? { tenant_id: 'default', role: 'admin' } : undefined;

  /**
   * 回环 + 仅 serve.tokens：网关仍要求客户端带 token（anonymous 不设置），
   * 但 in-process LocalRpcClient 没有凭据，按**第一个** token 的 principal
   * 解析（最小权限，避免退化成 admin）。该值只用于本地 dispatcher，不打印。
   */
  const firstToken =
    !hasGatewayToken && loopback && tokens
      ? Object.keys(tokens).find((token) => token !== '')
      : undefined;
  const localLegacyToken = legacyToken ?? firstToken;

  const auth: GatewayAuth = {
    configured,
    ...(localLegacyToken !== undefined ? { legacyToken: localLegacyToken } : {}),
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
      if (tokenStore !== undefined) {
        return tokenStore.authenticate(token);
      }
      return null;
    },
  };

  return { ok: true, auth };
}
