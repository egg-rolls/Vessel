/**
 * 飞书渠道状态网关边界（0.4 W2，DECISION-009 §5.3.4）。
 *
 * gateway 只读：asm 注入 ext `FeishuChannel.status()` 的适配器。
 * 只暴露冻结字段；app_id 再做一次防御性掩码，避免适配器误传完整凭据。
 *
 * @module @vessel-agent/serve/feishu
 */

/** 渠道状态（与 ext `FeishuStatus` 字段一致） */
export interface FeishuStatus {
  connected: boolean;
  appIdMasked: string;
  active_chats: number;
  queued_messages: number;
  last_error?: string;
}

/** gateway 注入面；缺省 = 飞书端点关闭 */
export interface FeishuGatewayOptions {
  status(): FeishuStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** 只保留前 4 个字符 + `***`；已掩码的值原样返回 */
export function maskAppId(value: string): string {
  if (value.length === 0) return '';
  if (value.endsWith('***')) return value;
  return `${value.slice(0, 4)}***`;
}

/** 归一化 provider 返回值：只暴露冻结字段，凭据二次掩码。 */
export function normalizeFeishuStatus(input: unknown): FeishuStatus {
  const record = isRecord(input) ? input : {};
  const rawAppId = typeof record.appIdMasked === 'string' ? record.appIdMasked : '';
  const lastError = typeof record.last_error === 'string' ? record.last_error : undefined;
  return {
    connected: record.connected === true,
    appIdMasked: maskAppId(rawAppId),
    active_chats: toCount(record.active_chats),
    queued_messages: toCount(record.queued_messages),
    ...(lastError !== undefined ? { last_error: lastError } : {}),
  };
}
