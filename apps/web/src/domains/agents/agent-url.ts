/**
 * Agents 详情 / 编辑 hash（纯函数）。
 *
 * `app/router.ts` 的 Route 不包含 agent 深链；Agents 域直接识别
 * `#/agents/<nodeKey>/<agentId>[/edit]`，查询串仍由壳层解析。
 */

export type AgentHashMode = 'detail' | 'edit';

export interface AgentHashTarget {
  nodeKey: string;
  agentId: string;
  mode: AgentHashMode;
  /** `?body=<sessionId>`：该成员的只读会话正文深链。 */
  bodyId?: string;
}

function withoutHash(hash: string): string {
  return hash.startsWith('#') ? hash.slice(1) : hash;
}

function decodeSegment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 解析 Agent 深链；不是 agents path 时返回 undefined。 */
export function agentHashTarget(hash: string): AgentHashTarget | undefined {
  const [pathPart = '', queryPart = ''] = withoutHash(hash).split('?', 2);
  const segments = pathPart.split('/').filter(Boolean);
  if (segments[0] !== 'agents' || segments.length < 3) return undefined;
  const nodeKey = decodeSegment(segments[1]);
  const agentId = decodeSegment(segments[2]);
  if (!nodeKey || !agentId) return undefined;
  const bodyId = decodeSegment(new URLSearchParams(queryPart).get('body') ?? undefined);
  return {
    nodeKey,
    agentId,
    mode: segments[3] === 'edit' ? 'edit' : 'detail',
    ...(bodyId ? { bodyId } : {}),
  };
}

export function agentDetailHash(nodeKey: string, agentId: string): string {
  return `#/agents/${encodeURIComponent(nodeKey)}/${encodeURIComponent(agentId)}`;
}

export function agentEditHash(nodeKey: string, agentId: string): string {
  return `${agentDetailHash(nodeKey, agentId)}/edit`;
}

/** 成员只读会话正文深链：`#/agents/<nodeKey>/<agentId>?body=<sessionId>`。 */
export function agentBodyHash(nodeKey: string, agentId: string, sessionId: string): string {
  return `${agentDetailHash(nodeKey, agentId)}?${new URLSearchParams({ body: sessionId }).toString()}`;
}

/** 把当前列表过滤 query 附加到深链，返回列表时保留过滤。 */
export function withQuery(hash: string, query: string): string {
  const normalized = query.startsWith('?') ? query.slice(1) : query;
  if (normalized === '') return hash;
  return `${hash}${hash.includes('?') ? '&' : '?'}${normalized}`;
}
