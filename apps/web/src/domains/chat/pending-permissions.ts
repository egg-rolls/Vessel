/**
 * 跨 session 待处理权限的纯逻辑：判断哪些请求不在当前视图内。
 *
 * 当前会话的权限/提问在 Composer 槽位处理（PendingComposer）；
 * 其他会话只在会话列表徽标与顶部条提示，绝不自动切换会话或弹出全局遮罩
 * （DECISION-024 §2.4）。
 */
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
