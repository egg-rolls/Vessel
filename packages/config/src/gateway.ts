/**
 * 0.49 G1：平台 gateway 配置的纯解析原语。
 *
 * 只做配置解析 / 冲突判定，不接线 server / CLI / Web；
 * 不铸造、不哈希、不落盘任何 token。
 *
 * @module @vessel-agent/config
 */

import { DEFAULT_GATEWAY_OPTIONS } from './defaults.js';
import type { VesselConfig } from './types.js';

type EnvMap = Record<string, string | undefined>;

/** 空串视为未设置（与 resolveGatewayToken 一致）。 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * 解析平台 token：`gateway.token` > `gateway.token_env` 指向的环境变量 > undefined。
 * 空串视为未设置；不铸造 / 不哈希 / 不落盘。
 */
export function resolvePlatformToken(
  config: VesselConfig,
  env: EnvMap = process.env,
): string | undefined {
  return (
    nonEmpty(config.gateway?.token) ??
    nonEmpty(config.gateway?.tokenEnv ? env[config.gateway.tokenEnv] : undefined)
  );
}

/**
 * 平台 token 与 node 生效凭据的冲突检查。
 *
 * `nodeToken` 必须由调用方传入 `resolveGatewayToken(config, env)` 的结果
 * （不能只传 `serve.token`，否则只配 `serve.admin_token` 时会漏判）。
 * 两者都非空且完全相同 → 返回错误码 `platform_token_conflict`；否则返回 null。
 */
export function checkPlatformTokenConflict(input: {
  platformToken?: string;
  nodeToken?: string;
}): 'platform_token_conflict' | null {
  const platformToken = nonEmpty(input.platformToken);
  const nodeToken = nonEmpty(input.nodeToken);
  if (platformToken !== undefined && nodeToken !== undefined && platformToken === nodeToken) {
    return 'platform_token_conflict';
  }
  return null;
}

/**
 * 默认端口映射（config resolver 级 oracle）。
 *
 * - `gateway` 模式：平台 8642；node 为 `serve.port`，未显式设置时 8644。
 * - `legacy` 模式：无独立平台端口；node 为 `serve.port`，未显式设置时 8642。
 *
 * 只读 `config`，不读 env、不启动监听。
 */
export function resolveGatewayNodePorts(
  config: VesselConfig,
  mode: 'gateway' | 'legacy',
): { platformPort: number | undefined; nodePort: number } {
  if (mode === 'gateway') {
    return {
      platformPort: config.gateway?.port ?? DEFAULT_GATEWAY_OPTIONS.port,
      nodePort: config.serve?.port ?? 8644,
    };
  }
  return {
    platformPort: undefined,
    nodePort: config.serve?.port ?? DEFAULT_GATEWAY_OPTIONS.port,
  };
}
