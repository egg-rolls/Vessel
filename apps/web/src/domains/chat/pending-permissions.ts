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

export interface PendingBarRequest {
  kind: 'permission' | 'ask';
  requestId: string;
  runId: string;
  sessionId?: string;
  requestedAt: number;
}

export interface PendingBarSummary {
  count: number;
  earliest: PendingBarRequest | null;
}

/**
 * compact bar 摘要：权限与提问合并计数（ask 不按问题数拆）。
 *
 * earliest 与 Composer 队列同序：`requestedAt` 升序 → 同时间权限优先 →
 * `requestId` 稳定排序。
 */
export function pendingBarSummary(
  permissions: readonly PermissionRequest[],
  asks: readonly AskUserRequest[],
): PendingBarSummary {
  const seeds: QueueSeed[] = [
    ...permissions.map((request) => ({
      at: request.requestedAt,
      rank: 0,
      requestId: request.requestId,
      kind: 'permission' as const,
      request,
    })),
    ...asks.map((request) => ({
      at: request.requestedAt,
      rank: 1,
      requestId: request.requestId,
      kind: 'ask' as const,
      request,
    })),
  ];
  seeds.sort(compareSeed);
  const first = seeds[0];
  return {
    count: permissions.length + asks.length,
    earliest: first
      ? {
          kind: first.kind,
          requestId: first.requestId,
          runId: first.request.runId,
          ...(first.request.sessionId !== undefined ? { sessionId: first.request.sessionId } : {}),
          requestedAt: first.at,
        }
      : null,
  };
}

/** 关闭动作的目标：bar 内全部 orphaned，不是只关最早一条。 */
export function orphanedDismissIds(items: readonly { requestId: string }[]): string[] {
  return items.map((item) => item.requestId);
}

/** 跳转目标：只有最早一条带非空 `sessionId` 才能落到会话；否则不提供跳转。 */
export function pendingBarTarget(
  summary: PendingBarSummary,
): { domain: 'chat'; sessionId: string } | null {
  const sessionId = summary.earliest?.sessionId;
  return sessionId ? { domain: 'chat', sessionId } : null;
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

/** 队列项：一条权限 = 1 项，一条 ask 按问题拆成多项（1 裁决）。 */
export type PendingQueueItem =
  | { kind: 'permission'; request: PermissionRequest; key: string }
  | { kind: 'ask'; request: AskUserRequest; questionIndex: number; key: string };

interface QueueSeed {
  at: number;
  /** 同时间戳时权限优先（0 = 权限，1 = ask）。 */
  rank: number;
  requestId: string;
  kind: 'permission' | 'ask';
  request: PermissionRequest | AskUserRequest;
}

function compareSeed(a: QueueSeed, b: QueueSeed): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.requestId === b.requestId) return 0;
  return a.requestId < b.requestId ? -1 : 1;
}

/**
 * 队列顺序：`requestedAt` 升序 → 同时间戳权限优先于 ask → `requestId` 稳定排序。
 *
 * 同一 ask 的多问题按 `questionIndex` 连续展开，key 为 `${requestId}:${questionIndex}`；
 * 权限 key 为 `perm:${requestId}`。当前只渲染第一项，其余作为队列摘要。
 */
export function pendingQueue(
  permissions: readonly PermissionRequest[],
  asks: readonly AskUserRequest[],
): PendingQueueItem[] {
  const seeds: QueueSeed[] = [
    ...permissions.map((request) => ({
      at: request.requestedAt,
      rank: 0,
      requestId: request.requestId,
      kind: 'permission' as const,
      request,
    })),
    ...asks.map((request) => ({
      at: request.requestedAt,
      rank: 1,
      requestId: request.requestId,
      kind: 'ask' as const,
      request,
    })),
  ];
  seeds.sort(compareSeed);

  return seeds.flatMap<PendingQueueItem>((seed) => {
    if (seed.kind === 'permission') {
      const request = seed.request as PermissionRequest;
      return [{ kind: 'permission', request, key: `perm:${request.requestId}` }];
    }
    const request = seed.request as AskUserRequest;
    // 空问题列表仍占一项，避免请求被静默跳过；正常 ask 至少有 1 题。
    const count = Math.max(1, request.questions.length);
    return Array.from({ length: count }, (_, questionIndex) => ({
      kind: 'ask' as const,
      request,
      questionIndex,
      key: `${request.requestId}:${questionIndex}`,
    }));
  });
}

/**
 * 串行处理：多个 pending 时只把队列第一项交给 Composer 槽位。
 *
 * 排序由 `pendingQueue` 统一（权限优先 / 按 requestedAt / requestId 稳定）；
 * 前一条被应答 / 移除后，下一次调用自然返回下一条。
 */
export function nextPending(
  permissions: readonly PermissionRequest[],
  asks: readonly AskUserRequest[],
): NextPending | null {
  const first = pendingQueue(permissions, asks)[0];
  if (!first) return null;
  if (first.kind === 'permission') return { kind: 'permission', request: first.request };
  return { kind: 'ask', request: first.request };
}
