/**
 * 权限 / 提问交互的纯逻辑：过期时间、去重入队、not_found 判定与单次提交守卫。
 *
 * 过期时间必须由**事件时间**推导（`event.ts + TTL`），不能用浏览器收到事件的
 * `Date.now()`：重放/刷新后旧请求会被重新计时，点击时服务端已丢弃 → not_found。
 */
import { t } from '../i18n';

/** 与 gateway interaction TTL 对齐（DECISION-022 §2.1）。 */
export const INTERACTION_TTL_MS = 120_000;

export interface Interaction {
  requestId: string;
  expiresAt: number;
}

/**
 * 事件时间 → 过期时间。缺失/非法 ts（旧 gateway）回退当前时间，避免丢掉实时请求。
 */
export function interactionExpiresAt(
  eventTs: unknown,
  ttl = INTERACTION_TTL_MS,
  fallbackNow = Date.now(),
): number {
  const base =
    typeof eventTs === 'number' && Number.isFinite(eventTs) && eventTs > 0 ? eventTs : fallbackNow;
  return base + ttl;
}

/** 是否已过期（等于 TTL 边界也视为过期）。 */
export function isInteractionExpired(item: Pick<Interaction, 'expiresAt'>, now: number): boolean {
  return item.expiresAt <= now;
}

/**
 * 入队：过期请求直接丢弃（重放旧 `tool.permission.request` 不再弹窗）；
 * 同一 requestId 只保留一份。
 */
export function enqueueInteraction<T extends Interaction>(
  prev: readonly T[],
  item: T,
  now = Date.now(),
): readonly T[] {
  if (isInteractionExpired(item, now)) return prev;
  if (prev.some((entry) => entry.requestId === item.requestId)) return prev;
  return [...prev, item];
}

/** 移除指定请求（应答成功或服务端 not_found）。 */
export function removeInteraction<T extends Interaction>(
  prev: readonly T[],
  requestId: string,
): readonly T[] {
  return prev.some((entry) => entry.requestId === requestId)
    ? prev.filter((entry) => entry.requestId !== requestId)
    : prev;
}

/** 移除已过期项；保留项不变。 */
export function expireInteractions<T extends Pick<Interaction, 'expiresAt'>>(
  prev: readonly T[],
  now: number,
): readonly T[] {
  return prev.filter((entry) => entry.expiresAt > now);
}

/**
 * `not_found` 兼容两种错误形状：
 * - WS RPC：`Error("not_found: Permission request not found")`
 * - HTTP：`GatewayHttpError`，带 `code === 'not_found'`
 */
export function isNotFoundError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === 'not_found') return true;
  }
  return error instanceof Error && error.message.startsWith('not_found:');
}

/** 过期/丢失请求的统一提示（ConnectionProvider 的 toast 与测试共用）。 */
export function interactionExpiredMessage(): string {
  return t('permission.expired');
}

/**
 * 单次提交守卫：`begin()` 同步占位，双击/重复点击只有第一次返回 true。
 * 调用方必须在 finally 中 `end()`。
 */
export class SubmitGuard {
  private readonly inFlight = new Set<string>();

  begin(requestId: string): boolean {
    if (!requestId || this.inFlight.has(requestId)) return false;
    this.inFlight.add(requestId);
    return true;
  }

  end(requestId: string): void {
    this.inFlight.delete(requestId);
  }

  has(requestId: string): boolean {
    return this.inFlight.has(requestId);
  }
}
