/**
 * 跨 session 待处理权限的纯逻辑：判断哪些请求不在当前视图内。
 *
 * 权限卡片只挂在对应 RunCard 上；当前视图没有对应 run 时，用顶部条补偿，
 * 但绝不自动切换会话或弹出全局遮罩（DECISION-024 §2.4）。
 */
import type { PermissionRequest } from '../../gateway/types';

/** 当前视图可见的会话；`new` 是草稿，不算任何已有会话。 */
export function currentSessionId(sessionId: string | undefined): string | null {
  return sessionId && sessionId !== 'new' ? sessionId : null;
}

/**
 * 返回不归属当前视图的未过期请求。
 * 非 chat 页面全部算“其他视图”；chat 已选会话时只排除同 session 的请求。
 */
export function pendingPermissionsOutsideView(
  permissions: readonly PermissionRequest[],
  view: { domain: string; sessionId?: string },
  now: number,
): PermissionRequest[] {
  const live = permissions.filter((item) => item.expiresAt > now);
  if (view.domain !== 'chat') return live;
  const current = currentSessionId(view.sessionId);
  if (!current) return live;
  return live.filter((item) => item.sessionId !== current);
}

/** 跳转目标：优先会话，其次运行详情。 */
export function pendingPermissionTarget(
  request: PermissionRequest,
): { domain: 'chat'; sessionId: string } | { domain: 'runs'; tab: 'live'; runId: string } {
  if (request.sessionId) return { domain: 'chat', sessionId: request.sessionId };
  return { domain: 'runs', tab: 'live', runId: request.runId };
}
