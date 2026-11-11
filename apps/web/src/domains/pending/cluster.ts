/**
 * 「待批」汇集的纯逻辑：聚类键、来源判定、会话过滤。
 *
 * 数据源只有一个：`useInteractionStore` 的 pending ask（实时事件 + 既有
 * `interactions.list(status=pending)` 补回）。这里不新开 store、不新增 RPC，
 * 只把同一份 pending 集合投影成「按 agent 聚在一起的审批组」。
 */
import type { AskUserRequest } from '../../gateway/types';

/** 请求的来源面：成员 bridge（团队）还是普通会话。 */
export type PendingSource = 'session' | 'team';

/** 聚类依据：优先 agent，其次会话，最后 run（缺关联字段的旧事件兜底）。 */
export type PendingScope = 'agent' | 'session' | 'run';

/** 同一个 agent / 会话的待批提问聚成一簇，一起提交。 */
export interface PendingCluster {
  key: string;
  scope: PendingScope;
  agentId?: string;
  sessionId?: string;
  teamId?: string;
  source: PendingSource;
  /** 簇内最新一条的请求时间，用于列表排序。 */
  latestAt: number;
  requests: AskUserRequest[];
}

/**
 * 聚类键：**优先 agent id**。
 *
 * 只按 session id 聚类会在主会话切换 / 复用同一会话时把不同 agent 的问题混在一起，
 * 而同一个 agent 连续多次 ask_user 又恰恰是最需要合并提交的情形。
 */
export function pendingClusterKey(request: AskUserRequest): string {
  if (request.agentId !== undefined && request.agentId !== '') {
    return `agent:${request.agentId}`;
  }
  if (request.sessionId !== undefined && request.sessionId !== '') {
    return `session:${request.sessionId}`;
  }
  return `run:${request.runId}`;
}

function clusterScope(request: AskUserRequest): PendingScope {
  if (request.agentId !== undefined && request.agentId !== '') return 'agent';
  if (request.sessionId !== undefined && request.sessionId !== '') return 'session';
  return 'run';
}

/** 带 `team_id` 的记录来自成员 bridge，归到团队面；否则归到会话面。 */
export function pendingSource(request: AskUserRequest): PendingSource {
  return request.teamId !== undefined && request.teamId !== '' ? 'team' : 'session';
}

/**
 * 把 pending ask 分簇。
 *
 * 簇内按请求时间升序（先问的排前面），簇之间按最新一条降序（最需要处理的在前）。
 */
export function groupPendingAsks(asks: readonly AskUserRequest[]): PendingCluster[] {
  const byKey = new Map<string, PendingCluster>();

  for (const request of asks) {
    const key = pendingClusterKey(request);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        key,
        scope: clusterScope(request),
        ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
        ...(request.teamId !== undefined ? { teamId: request.teamId } : {}),
        source: pendingSource(request),
        latestAt: request.requestedAt,
        requests: [request],
      });
      continue;
    }
    existing.requests.push(request);
    if (request.requestedAt > existing.latestAt) existing.latestAt = request.requestedAt;
    // 簇内任一条带 team 归属就算团队的：来源只用于展示，不影响聚类键。
    if (existing.source === 'session' && pendingSource(request) === 'team') {
      existing.source = 'team';
    }
    if (existing.sessionId === undefined && request.sessionId !== undefined) {
      existing.sessionId = request.sessionId;
    }
    if (existing.teamId === undefined && request.teamId !== undefined) {
      existing.teamId = request.teamId;
    }
  }

  const clusters = [...byKey.values()];
  for (const cluster of clusters) {
    cluster.requests.sort((left, right) => left.requestedAt - right.requestedAt);
  }
  clusters.sort((left, right) => {
    if (right.latestAt !== left.latestAt) return right.latestAt - left.latestAt;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
  return clusters;
}

/**
 * 某个会话要显示的待批提问。
 *
 * 成员 bridge 的请求 `sessionId` 是成员会话、`parentSessionId` 是父 chat；
 * 两个都算「属于这个会话」，否则侧栏按钮会漏掉代理提问。
 */
export function asksForSession(
  asks: readonly AskUserRequest[],
  sessionId: string | null | undefined,
): AskUserRequest[] {
  if (sessionId === null || sessionId === undefined || sessionId === '') return [];
  return asks.filter(
    (request) => request.sessionId === sessionId || request.parentSessionId === sessionId,
  );
}
