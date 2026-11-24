/**
 * Gateway / connect token 解析（0.2 A4；0.6 的 remote / loopback 传输已删除）。
 *
 * 只从显式配置与 env 取值，绝不返回 `node.tokens` 条目；空串视为未设置。
 */

import type { VesselConfig } from '../../packages/config/src/index';

/**
 * 解析 gateway/本地客户端 token（绝不返回 node.tokens 条目）：
 * `node.token` / `node.token_env` → `node.admin_token(_env)` →
 * `VESSEL_GATEWAY_TOKEN` → `transport.token`。
 * `node.tokens` 是客户端认证凭据，不能当作 gateway token。
 * 返回 undefined 表示交给 gateway 生成。
 */
export function resolveGatewayToken(
  config: VesselConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const nonEmpty = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;

  return (
    nonEmpty(config.node?.token) ??
    nonEmpty(config.node?.tokenEnv ? env[config.node.tokenEnv] : undefined) ??
    nonEmpty(env.VESSEL_GATEWAY_TOKEN) ??
    nonEmpty(config.transport?.token)
  );
}

/**
 * 解析 `--connect` / 远程控制面使用的客户端凭据（0.18，DECISION-033）。
 *
 * 优先级（高 → 低）：
 * `options.connectToken` → `VESSEL_CONNECT_TOKEN` → `config.connect.token` →
 * `resolveGatewayToken(config, env)`。
 * 空串视为未设置；永不读取 / 返回 `node.tokens`。
 * token 只返回给调用方，不打印、不进日志或错误消息。
 */
export function resolveConnectToken(
  config: VesselConfig,
  options: { connectToken?: string | null; env?: Record<string, string | undefined> } = {},
): string | undefined {
  const env = options.env ?? process.env;
  const nonEmpty = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value : undefined;

  return (
    nonEmpty(options.connectToken) ??
    nonEmpty(env.VESSEL_CONNECT_TOKEN) ??
    nonEmpty(config.connect?.token) ??
    resolveGatewayToken(config, env)
  );
}
