/**
 * 默认会话（`main` primary body）与会话行 body 归属的纯函数：无 React / 无 store。
 *
 * - `findMainSession`：从 `agents.list` 结果（`AgentSummary[]`）解析 `main` 的
 *   primary body，即 Web 默认会话的 `session_id`；
 * - `sessionBodyOwners`：从同一份 roster 的 `bodies` 反查会话的 agent / primary 归属，
 *   供会话列表加 primary 标记；`bodies` 缺省时**不产出任何条目**（完全退化为现状）。
 */
import type { NodeRoster } from '../../gateway/team-roster';
import type { AgentSummary, BodyStatus } from '../../gateway/types';

/** `main` 的 agent id（team 成员，Web 默认投递目标）。 */
export const MAIN_AGENT_ID = 'main';

export interface MainSession {
  /** primary body（body id ≡ session id）：默认会话。 */
  sessionId: string;
  /** 展示名；`agents.list` 缺 name 时回落 `main`。 */
  name: string;
  /** live body 的 session 列表，primary 恒在首位。 */
  bodies: readonly string[];
}

/** `body_id ≡ session_id`；旧 gateway 可能只带其中一个。 */
function bodySessionId(body: BodyStatus): string | undefined {
  const id = body.session_id ?? body.body_id;
  const trimmed = typeof id === 'string' ? id.trim() : '';
  return trimmed || undefined;
}

/**
 * `agents.list` 里 `main` 的 primary body。
 *
 * 匹配 `(agent.id ?? agent.agent_id) === 'main'`；priority：`bodies` 中
 * `primary === true` 的那条 → `session_id`；都缺失返回 `null`（调用方不本地造 id）。
 */
export function findMainSession(agents: readonly AgentSummary[]): MainSession | null {
  const agent = agents.find((entry) => (entry.id ?? entry.agent_id) === MAIN_AGENT_ID);
  if (!agent) return null;
  const bodies = (agent.bodies ?? [])
    .map((body) => bodySessionId(body))
    .filter((id): id is string => id !== undefined);
  const primaryBody = (agent.bodies ?? []).find((body) => body.primary === true);
  const primaryId = primaryBody ? bodySessionId(primaryBody) : undefined;
  const sessionId = primaryId ?? agent.session_id?.trim() ?? '';
  if (!sessionId) return null;
  return {
    sessionId,
    name: agent.name?.trim() || MAIN_AGENT_ID,
    bodies: [sessionId, ...bodies.filter((id) => id !== sessionId)],
  };
}

/**
 * roster → 属于某个 agent primary body 的 `session_id` 集合。
 *
 * 0.28 起 `body_id ≡ session_id` 且每个 agent 恰好一具 live body（rotate 窗口除外），
 * 所以**每个成员条目的 `session_id` 本身就是它的 primary body session**。
 * 因此不再要求 `bodies` 字段存在：
 * - 有 `bodies` 时以 `bodies[].primary === true` 为准（rotate 窗口 / 旧 gateway 精确）；
 * - 没有 `bodies` 时退回 `session_id`（当前 gateway 根本不发 `bodies`，
 *   按旧逻辑这里会恒为空集，会话列表的 primary 标记就永远不会渲染）。
 */
export function primaryBodySessions(rosters: readonly NodeRoster[]): ReadonlySet<string> {
  const primaryIds = new Set<string>();
  const add = (sessionId: string | undefined, bodies: readonly BodyStatus[] | undefined) => {
    const trimmed = sessionId?.trim() ?? '';
    const primaryBody = (bodies ?? []).find((body) => body.primary === true);
    const primaryId =
      (primaryBody ? bodySessionId(primaryBody) : undefined) ?? (trimmed || undefined);
    if (primaryId) primaryIds.add(primaryId);
  };
  for (const roster of rosters) {
    for (const agent of roster.agents ?? []) add(agent.session_id, agent.bodies);
    for (const entry of roster.rosters) {
      for (const member of entry.members) add(member.session_id, member.bodies);
    }
  }
  return primaryIds;
}
