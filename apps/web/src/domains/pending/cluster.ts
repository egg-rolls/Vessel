/**
 * 「待批」汇集的纯逻辑：聚类键、来源判定、会话过滤。
 *
 * 数据源只有一个：`useInteractionStore` 的 pending permission + ask（实时事件 +
 * 既有 `interactions.list(status=pending)` 补回）。这里不新开 store、不新增 RPC，
 * 只把同一份 pending 集合投影成「按 agent 聚在一起的审批组」。
 *
 * permission 与 ask 混聚（用户指示：权限卡也要汇集进待批页）：聚类键、归属、
 * 来源判定完全同口径；裁决方式不同 —— ask 逐题勾选分批提交，permission 逐条
 * 裁决（安全口径，不进批量），渲染面见 PendingClusterCard。
 */
import type { AskUserRequest, PermissionRequest } from '../../gateway/types';
import {
  type AttributedInteraction,
  type AttributionIndex,
  attributedSessionId,
  EMPTY_ATTRIBUTION_INDEX,
} from './attribution';

/** 请求的来源面：成员 bridge（团队）还是普通会话。 */
export type PendingSource = 'session' | 'team';

/** 聚类依据：优先 agent，其次会话，最后 run（缺关联字段的旧事件兜底）。 */
export type PendingScope = 'agent' | 'session' | 'run';

/** 混合待批集的一条：权限审批与 ask 提问共用同一套聚类 / 排序口径。 */
export type PendingItem =
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'ask'; request: AskUserRequest };

/** 同一个 agent / 会话的待批请求（permission + ask）聚成一簇。 */
export interface PendingCluster {
  key: string;
  scope: PendingScope;
  agentId?: string;
  sessionId?: string;
  /**
   * 归属会话（0.51）：成员 bridge 的请求 = 父会话；普通请求 = 自己的会话。
   *
   * `sessionId` 仍是「发起请求的那个会话」（成员自己的）—— 两个都留着，展示面才能
   * 同时说清「谁问的」与「算谁的」。历史脏数据靠 roster 上溯兑底（见 attribution.ts）。
   */
  homeSessionId?: string;
  teamId?: string;
  source: PendingSource;
  /** 簇内最新一条的请求时间，用于列表排序。 */
  latestAt: number;
  /** 簇内混排：requestedAt 升序，同时刻 permission 优先（与 pendingQueue 同口径）。 */
  items: PendingItem[];
}

/** 聚类 / 归属需要的字段：permission 与 ask 都满足（旧事件可能缺关联字段）。 */
type ClusterableRequest = AttributedInteraction & { runId: string };

/**
 * 聚类键：**优先 agent id**。
 *
 * 只按 session id 聚类会在主会话切换 / 复用同一会话时把不同 agent 的问题混在一起，
 * 而同一个 agent 连续多次 ask 又恰恰是最需要合并提交的情形。permission 同键口径：
 * 同一个 agent 的权限请求与提问聚在同一个审批组里。
 */
export function pendingClusterKey(request: ClusterableRequest): string {
  if (request.agentId !== undefined && request.agentId !== '') {
    return `agent:${request.agentId}`;
  }
  if (request.sessionId !== undefined && request.sessionId !== '') {
    return `session:${request.sessionId}`;
  }
  return `run:${request.runId}`;
}

function clusterScope(request: ClusterableRequest): PendingScope {
  if (request.agentId !== undefined && request.agentId !== '') return 'agent';
  if (request.sessionId !== undefined && request.sessionId !== '') return 'session';
  return 'run';
}

/** 带 `team_id` 的记录来自成员 bridge，归到团队面；否则归到会话面。 */
export function pendingSource(request: ClusterableRequest): PendingSource {
  return request.teamId !== undefined && request.teamId !== '' ? 'team' : 'session';
}

/** 两份 pending 集合合成混合 items（聚类 / 计数共用，避免两处各拼一遍）。 */
export function pendingItems(
  permissions: readonly PermissionRequest[],
  asks: readonly AskUserRequest[],
): PendingItem[] {
  return [
    ...permissions.map((request) => ({ kind: 'permission' as const, request })),
    ...asks.map((request) => ({ kind: 'ask' as const, request })),
  ];
}

/**
 * 簇内排序，与 composer 队列 `pendingQueue`（domains/chat/pending-permissions.ts
 * 的 compareSeed）同一口径：requestedAt 升序 → 同时刻 permission 优先（rank 0）
 * → requestId 稳定兜底。两处口径必须一致，否则同一批请求在槽位与待批页顺序不同。
 */
function compareItems(left: PendingItem, right: PendingItem): number {
  const at = left.request.requestedAt - right.request.requestedAt;
  if (at !== 0) return at;
  const rank = (item: PendingItem) => (item.kind === 'permission' ? 0 : 1);
  if (rank(left) !== rank(right)) return rank(left) - rank(right);
  const leftId = left.request.requestId;
  const rightId = right.request.requestId;
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

/**
 * 把 pending permission + ask 混聚分簇。
 *
 * 簇内按请求时间升序（先来的排前面，同时刻权限优先），簇之间按最新一条降序
 * （最需要处理的在前）。
 *
 * `index` 是归属兑底用的 roster 索引：给不出时（roster 没加载 / 旧 gateway）
 * 归属退化成「`parentSessionId` 就是会话 id」的旧行为，绝不会因此丢卡片。
 */
export function groupPending(
  permissions: readonly PermissionRequest[],
  asks: readonly AskUserRequest[],
  index: AttributionIndex = EMPTY_ATTRIBUTION_INDEX,
): PendingCluster[] {
  const byKey = new Map<string, PendingCluster>();

  for (const item of pendingItems(permissions, asks)) {
    const request = item.request;
    const key = pendingClusterKey(request);
    const homeSessionId = attributedSessionId(request, index);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        key,
        scope: clusterScope(request),
        ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
        ...(homeSessionId !== undefined ? { homeSessionId } : {}),
        ...(request.teamId !== undefined ? { teamId: request.teamId } : {}),
        source: pendingSource(request),
        latestAt: request.requestedAt,
        items: [item],
      });
      continue;
    }
    existing.items.push(item);
    if (request.requestedAt > existing.latestAt) existing.latestAt = request.requestedAt;
    // 簇内任一条带 team 归属就算团队的：来源只用于展示，不影响聚类键。
    if (existing.source === 'session' && pendingSource(request) === 'team') {
      existing.source = 'team';
    }
    if (existing.sessionId === undefined && request.sessionId !== undefined) {
      existing.sessionId = request.sessionId;
    }
    if (existing.homeSessionId === undefined && homeSessionId !== undefined) {
      existing.homeSessionId = homeSessionId;
    }
    if (existing.teamId === undefined && request.teamId !== undefined) {
      existing.teamId = request.teamId;
    }
  }

  const clusters = [...byKey.values()];
  for (const cluster of clusters) {
    cluster.items.sort(compareItems);
  }
  clusters.sort((left, right) => {
    if (right.latestAt !== left.latestAt) return right.latestAt - left.latestAt;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
  return clusters;
}

/**
 * 某个会话的「待批」入口要数的请求（0.51 口径，permission + ask 同算）。
 *
 * 归到**这个会话**的请求都算：普通请求 = 自己的会话；成员 bridge 的请求 = 父会话
 * （历史脏数据靠 roster 上溯兑底）。注意它与会话页 Composer 槽位的守卫**不是**同一条
 * 判据 —— 这里数的是「去待批页能看到几条」，不是「能在这个会话里渲出几张卡」。
 */
export function itemsForSession(
  items: readonly PendingItem[],
  sessionId: string | null | undefined,
  index: AttributionIndex = EMPTY_ATTRIBUTION_INDEX,
): PendingItem[] {
  if (sessionId === null || sessionId === undefined || sessionId === '') return [];
  return items.filter(
    (item) =>
      item.request.sessionId === sessionId ||
      attributedSessionId(item.request, index) === sessionId,
  );
}
