/**
 * gateway 稳定错误码 → 面向用户的中文说明（DECISION-020 §R1）。
 *
 * 服务端错误文案是英文且可能很长；UI 统一通过本模块补一句可执行的提示，
 * 原始错误仍原样展示（可展开），不吞掉服务端细节。
 */

import { t } from '../i18n';

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  unauthorized: 'gateway.error.unauthorized',
  forbidden: 'gateway.error.forbidden',
  forbidden_origin: 'gateway.error.forbidden_origin',
  invalid_host: 'gateway.error.invalid_host',
  not_found: 'gateway.error.not_found',
  invalid_params: 'gateway.error.invalid_params',
  invalid_request: 'gateway.error.invalid_request',
  conflict: 'gateway.error.conflict',
  quota_exceeded: 'gateway.error.quota_exceeded',
  tenant_locked: 'gateway.error.tenant_locked',
  rate_limited: 'gateway.error.rate_limited',
  timeout: 'gateway.error.timeout',
  unsupported_protocol: 'gateway.error.unsupported_protocol',
  internal: 'gateway.error.internal',
  no_runtime: 'gateway.error.no_runtime',
  durable_disabled: 'gateway.error.durable_disabled',
  mcp_disabled: 'gateway.error.mcp_disabled',
  evals_disabled: 'gateway.error.evals_disabled',
};

/** 已知错误码的可执行说明；未知 code 返回 null（不编造文案）。 */
export function describeGatewayError(code: string | null | undefined): string | null {
  if (!code) return null;
  const key = DESCRIPTIONS[code];
  return key ? t(key) : null;
}

/** 从 `code: message` 文本里取稳定错误码前缀；没有则返回 null。 */
export function gatewayErrorCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = /^([a-z][a-z0-9_]*):/.exec(text.trim());
  return match?.[1] ?? null;
}

/** 从一段原始错误文本得到中文说明；未知/无 code 返回 null。 */
export function describeGatewayErrorText(text: string | null | undefined): string | null {
  return describeGatewayError(gatewayErrorCode(text));
}
