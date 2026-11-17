/**
 * gateway token → principal（0.5 E16 / A-3 §10.4、A-4 §11.5）
 *
 * 映射（0.49 T4：单执行面，principal 不再携带 tenant）：
 * - `node.tokens` map → 条目 {role}（仅客户端凭据）
 * - `node.token` → admin（0.4 兼容）
 * - 无 token + 回环 → admin（anonymous）
 * - 已配置 token 但未带 → null（401）
 * - 非回环 + 无 gateway token → 拒绝启动（仅 node.tokens 不够）
 * - 回环 + 仅 node.tokens → 允许启动；in-process dispatcher 用第一个
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

type EnvMap = Record<string, string | undefined>;

/** token → principal（tenant 维度已在 0.49 T4 删除） */
export type GatewayPrincipal = Omit<Principal, 'tenant_id'>;

/** gateway 鉴权面（web 消费） */
export interface GatewayAuth {
  /** 是否配置了任何**显式** token；配置后缺 token → 401（派生值不算「配置」）。 */
  configured: boolean;
  /** 旧单 token（web 可继续用现有校验） */
  legacyToken?: string;
  authenticate(token: string | null): GatewayPrincipal | null;
  /** 无 token + 回环时的匿名 principal */
  anonymous?: GatewayPrincipal;
  /** 生效凭据来源：显式 / 仅派生 / 什么都没有（诊断与 doctor 用，不含值）。 */
  source: 'explicit' | 'derived' | 'none';
  /** 派生值来源说明（`root-secret` 路径等；不含值）。 */
  derivedDetail?: string;
}

/** resolveGatewayAuth 选项 */
export interface ResolveGatewayAuthOptions {
  hostname: string;
  allowRemote: boolean;
  env?: EnvMap;
  /**
   * 0.56：**派生** token（`vessel:node:<id>`，来自 `<dataDir>/root-secret`）。
   *
   * 它是**追加**凭据，不是替代品：
   * - 显式配置（`node.token` / `node.token_env` / `node.tokens` / `VESSEL_GATEWAY_TOKEN`）
   *   永远优先，并且照旧关闭回环匿名；
   * - 只有派生值时，回环匿名**保持不变** —— 这条是本单的「自愈」底线：
   *   任何本地 CLI / WebUI 都不会因为没有手写 token 而被锁在门外；
   * - 非回环监听可以靠派生值满足「必须有 token」的前置（不再要求用户手填）。
   */
  derivedToken?: string;
  /** 派生值的来源说明（只进诊断，不含值）。 */
  derivedDetail?: string;
}

/** 解析结果 */
export type ResolveGatewayAuthResult =
  | { ok: true; auth: GatewayAuth }
  | { ok: false; error: string };

interface TokenCandidate {
  token: string;
  principal: GatewayPrincipal;
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

  // 客户端 token map（键是原始 token，原样保留）
  const tokens = config.node?.tokens;
  if (tokens) {
    for (const [token, entry] of Object.entries(tokens)) {
      if (token === '') continue;
      candidates.push({
        token,
        principal: { role: resolveRole(entry.role) },
      });
    }
  }

  // 旧单 token：node.token > node.token_env > VESSEL_GATEWAY_TOKEN。
  // `transport.token` 只服务 transport 层，不再作为 gateway admin 凭据
  // （DECISION-020 §R1.9）。
  const explicitToken =
    nonEmpty(config.node?.token) ??
    nonEmpty(config.node?.tokenEnv ? env[config.node.tokenEnv] : undefined) ??
    nonEmpty(env.VESSEL_GATEWAY_TOKEN);
  if (explicitToken !== undefined) {
    candidates.push({
      token: explicitToken,
      principal: { role: 'admin' },
    });
  }
  // `configured` = 有**显式**凭据：只有它才关闭「回环匿名」（旧行为逐字不变）。
  const configured = candidates.length > 0;

  // 0.56：派生值只当**追加**凭据（不进 `configured` 计数，也不改变匿名语义）。
  const derivedToken = nonEmpty(options.derivedToken);
  if (derivedToken !== undefined) {
    candidates.push({ token: derivedToken, principal: { role: 'admin' } });
  }
  const legacyToken = explicitToken ?? derivedToken;
  const loopback = isLoopbackHostname(options.hostname);
  // 非回环必须有 token：显式或派生都算（派生是自动生成的稳定值，不是「没有」）。
  const hasGatewayToken = legacyToken !== undefined;

  // 非回环必须有 gateway token；node.tokens 只是客户端凭据，
  // 不能让“仅客户端 token”的 remote gateway 启动。
  if (!loopback && !hasGatewayToken) {
    return {
      ok: false,
      error: configured
        ? 'gateway_requires_token: non-loopback gateway requires node.token; node.tokens entries are client credentials only'
        : 'gateway_requires_token: refusing to start a non-loopback gateway without a token',
    };
  }

  const anonymous: GatewayPrincipal | undefined =
    !configured && loopback ? { role: 'admin' } : undefined;

  /**
   * 回环 + 仅 node.tokens：网关仍要求客户端带 token（anonymous 不设置），
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
    source: configured ? 'explicit' : derivedToken !== undefined ? 'derived' : 'none',
    ...(options.derivedDetail !== undefined && derivedToken !== undefined
      ? { derivedDetail: options.derivedDetail }
      : {}),
    ...(localLegacyToken !== undefined ? { legacyToken: localLegacyToken } : {}),
    ...(anonymous ? { anonymous } : {}),
    authenticate(token: string | null): GatewayPrincipal | null {
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
