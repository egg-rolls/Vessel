/**
 * 待处理权限 / 提问的纯逻辑：归属、排序与 Composer 槽位的选择。
 *
 * 当前会话的权限/提问在 Composer 槽位串行处理（PermissionPrompt / AskPrompt）；
 * 其他会话只在会话列表徽标与顶部条提示，绝不自动切换会话或弹出全局遮罩
 * （DECISION-024 §2.4）。
 *
 * 0.51：**归属**（算谁的 / 跳到哪）与**渲染**（在哪儿出现）是两个问题，判据不许混用 ——
 * 归属走 `domains/pending/attribution.ts`（含历史脏数据上溯），渲染只认
 * 「请求自己的 `sessionId` === 当前会话」。混用的代价就是这一单要修的回归：
 * contractor 的 ask 被「归属到父会话」后既进不了父会话（会话 id 早已不是 agent id），
 * 又在本该出现的待批页之外四处漏。
 */
import type { AskUserRequest, PermissionRequest } from '../../gateway/types';
import {
  attributedSessionId,
  EMPTY_ATTRIBUTION_INDEX,
  type PendingHome,
  pendingHome,
  pendingOwnedBySession,
} from '../pending/attribution';

interface SessionScoped {
  runId: string;
  sessionId?: string;
  /** 成员 bridge 的父会话（0.51 起是真会话 id；旧记录可能是 agent id）。 */
  parentSessionId?: string;
  /** 成员 bridge 的父 agent id（0.51 additive）。 */
  parentAgentId?: string;
  /** 发起请求的成员（bridge 补的 `agent_id`）。 */
  agentId?: string;
}

/** 当前视图可见的会话；`new` 是草稿，不算任何已有会话。 */
export function currentSessionId(sessionId: string | undefined): string | null {
  return sessionId && sessionId !== 'new' ? sessionId : null;
}

/**
 * 返回不归属当前视图的请求（权限/提问都不按时间过期）。
 *
 * 「归不归当前视图」按**能不能在这里应答**算：会话页里能应答的只有「自己的
 * `sessionId` === 当前会话」那批（与 Composer 槽位的守卫同一条判据），所以其余全部
 * 计入顶部条 —— 包括成员 bridge 的请求（它们只能在待批页应答）。非 chat 页面全算
 * 「其他视图」。
 */
export function pendingPermissionsOutsideView<T extends SessionScoped>(
  permissions: readonly T[],
  view: { domain: string; sessionId?: string },
): T[] {
  if (view.domain !== 'chat') return [...permissions];
  const current = currentSessionId(view.sessionId);
  if (!current) return [...permissions];
  const emptyRuns: ReadonlySet<string> = new Set();
  return permissions.filter((item) => !pendingOwnedBySession(item, current, emptyRuns));
}

export interface PendingBarRequest {
  kind: 'permission' | 'ask';
  requestId: string;
  runId: string;
  /** 归属会话（成员 bridge = 父会话；历史脏数据由 roster 上溯兑底）。 */
  sessionId?: string;
  /** 这条请求该去哪儿处理（顶部条按钮的落点）。 */
  home: PendingHome;
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
  index = EMPTY_ATTRIBUTION_INDEX,
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
  if (!first) return { count: permissions.length + asks.length, earliest: null };
  const home = pendingHome(first.request, index);
  const sessionId = attributedSessionId(first.request, index);
  return {
    count: permissions.length + asks.length,
    earliest: {
      kind: first.kind,
      requestId: first.requestId,
      runId: first.request.runId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      home,
      requestedAt: first.at,
    },
  };
}

/**
 * 跳转目标：**能落到界面上**才给跳转。
 *
 * - 普通会话请求 → 会话页（卡片就在那里）；
 * - 成员 bridge 请求 → 待批页（会话页有守卫，跳过去是死链接）；
 * - 什么都解析不出 → 不给跳转（顶部条改说「无法定位所属会话」）。
 */
export function pendingBarTarget(
  summary: PendingBarSummary,
): { domain: 'chat'; sessionId: string } | { domain: 'pending'; sessionId?: string } | null {
  const home = summary.earliest?.home;
  if (home === undefined) return null;
  if (home.kind === 'session') return { domain: 'chat', sessionId: home.sessionId };
  if (home.kind === 'agent') {
    return {
      domain: 'pending',
      ...(home.sessionId !== undefined ? { sessionId: home.sessionId } : {}),
    };
  }
  return null;
}

/**
 * 当前会话内的待处理请求（0.18）：应答入口固定在 Composer 槽位。
 *
 * 0.51 起这条判据**只剩**「请求自己的 `sessionId` 等于当前会话」（旧流缺 `sessionId` 时
 * 退化为 run 属于当前会话）。成员 bridge 的请求即便父会话就是当前会话，也不在这里
 * 渲染 —— 用户裁定它们在待批页处理。
 */
export function pendingForSession<T extends SessionScoped>(
  items: readonly T[],
  sessionId: string | null,
  sessionRunIds: ReadonlySet<string>,
): T[] {
  if (!sessionId) return [];
  return items.filter((item) => pendingOwnedBySession(item, sessionId, sessionRunIds));
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
