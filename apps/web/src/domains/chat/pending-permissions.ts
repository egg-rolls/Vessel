/**
 * 待处理权限 / 提问的纯逻辑：归属、排序与 Composer 槽位的选择。
 *
 * 当前会话的权限/提问在 Composer 槽位串行处理（PermissionPrompt / AskPrompt）；
 * 其他会话只在会话列表徽标与顶部条提示，绝不自动切换会话或弹出全局遮罩
 * （DECISION-024 §2.4）。
 */
import type { AskUserRequest, PermissionRequest } from '../../gateway/types';

interface SessionScoped {
  runId: string;
  sessionId?: string;
}

/** 当前视图可见的会话；`new` 是草稿，不算任何已有会话。 */
export function currentSessionId(sessionId: string | undefined): string | null {
  return sessionId && sessionId !== 'new' ? sessionId : null;
}

/**
 * 返回不归属当前视图的请求（权限/提问都不按时间过期）。
 * 非 chat 页面全部算“其他视图”；chat 已选会话时只排除同 session 的请求。
 */
export function pendingPermissionsOutsideView<T extends SessionScoped>(
  permissions: readonly T[],
  view: { domain: string; sessionId?: string },
): T[] {
  if (view.domain !== 'chat') return [...permissions];
  const current = currentSessionId(view.sessionId);
  if (!current) return [...permissions];
  return permissions.filter((item) => item.sessionId !== current);
}

/** 跳转目标：优先会话，其次运行详情。 */
export function pendingPermissionTarget(
  request: SessionScoped,
): { domain: 'chat'; sessionId: string } | { domain: 'runs'; tab: 'live'; runId: string } {
  if (request.sessionId) return { domain: 'chat', sessionId: request.sessionId };
  return { domain: 'runs', tab: 'live', runId: request.runId };
}

/**
 * 当前会话内的待处理请求（0.18）：应答入口固定在 Composer 槽位。
 *
 * - 请求带 `sessionId` 时按会话归属；
 * - 旧流 / ask 事件缺 `sessionId` 时，run 属于当前会话也算（`sessionRunIds`）。
 */
export function pendingForSession<T extends SessionScoped>(
  items: readonly T[],
  sessionId: string | null,
  sessionRunIds: ReadonlySet<string>,
): T[] {
  if (!sessionId) return [];
  return items.filter(
    (item) =>
      item.sessionId === sessionId ||
      (item.sessionId === undefined && sessionRunIds.has(item.runId)),
  );
}

export type NextPending =
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'ask'; request: AskUserRequest };

/**
 * 串行处理：多个 pending 时只把最早的一条交给 Composer 槽位。
 *
 * 权限与 ask 都按事件的 `requestedAt` 比较；前一条被应答 / 移除后，
 * 下一次调用自然返回下一条。
 */
export function nextPending(
  permissions: readonly PermissionRequest[],
  asks: readonly AskUserRequest[],
): NextPending | null {
  let best: { at: number; next: NextPending } | null = null;
  for (const request of permissions) {
    if (!best || request.requestedAt < best.at) {
      best = { at: request.requestedAt, next: { kind: 'permission', request } };
    }
  }
  for (const request of asks) {
    if (!best || request.requestedAt < best.at) {
      best = { at: request.requestedAt, next: { kind: 'ask', request } };
    }
  }
  return best?.next ?? null;
}
