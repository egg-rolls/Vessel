/**
 * 跨 session 待处理权限的纯逻辑：判断哪些请求不在当前视图内。
 *
 * 权限卡片只挂在对应 RunCard 上；当前视图没有对应 run 时，用顶部条补偿，
 * 但绝不自动切换会话或弹出全局遮罩（DECISION-024 §2.4）。
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

/**
 * 当前会话里没能挂到 RunCard 的请求（0.17）。
 *
 * - 同一 session 的请求：只有对应 run 没有渲染成卡片时才算未匹配；
 * - 旧流（请求缺 sessionId）：run 已由 `run.started` 反查到当前会话时同样纳入；
 * - 其他 session / 无归属的信息交给 AppShell 的待处理面板。
 */
export function unmatchedPendingForSession<T extends SessionScoped>(
  items: readonly T[],
  sessionId: string | null,
  renderedRunIds: ReadonlySet<string>,
  sessionRunIds?: ReadonlySet<string>,
): T[] {
  if (!sessionId) return [];
  return items.filter((item) => {
    if (renderedRunIds.has(item.runId)) return false;
    if (item.sessionId === sessionId) return true;
    return item.sessionId === undefined && (sessionRunIds?.has(item.runId) ?? false);
  });
}
