/**
 * gateway 稳定错误码 → 面向用户的中文说明（DECISION-020 §R1）。
 *
 * 服务端错误文案是英文且可能很长；UI 统一通过本模块补一句可执行的提示，
 * 原始错误仍原样展示（可展开），不吞掉服务端细节。
 */

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  unauthorized: 'token 无效或已过期，请在连接设置中重新输入。',
  forbidden: '当前 token 没有执行该操作的权限。',
  forbidden_origin: '请求来源不在 serve.allowed_origins 中。',
  invalid_host: 'Host 头不被 gateway 允许。',
  not_found: '目标不存在或已被删除。',
  invalid_params: '请求参数不合法。',
  invalid_request: '请求格式不合法。',
  conflict: '操作与当前状态冲突，请刷新后重试。',
  quota_exceeded: '已超出 tenant 配额。',
  tenant_locked: '该 tenant 正被其他进程写入，请稍后重试。',
  rate_limited: '请求过于频繁，请稍后重试。',
  timeout: '请求超时，请重试。',
  unsupported_protocol: 'gateway 协议版本不兼容，请升级客户端或服务端。',
  internal: 'gateway 内部错误，请查看服务端日志。',
  no_runtime: 'gateway 未配置运行 runtime。',
  durable_disabled: 'durable run 未启用。',
  mcp_disabled: 'MCP 未启用。',
  workflow_disabled: 'workflow 未启用。',
  evals_disabled: 'evals 未启用。',
};

/** 已知错误码的中文说明；未知 code 返回 null（不编造文案）。 */
export function describeGatewayError(code: string | null | undefined): string | null {
  if (!code) return null;
  return DESCRIPTIONS[code] ?? null;
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
