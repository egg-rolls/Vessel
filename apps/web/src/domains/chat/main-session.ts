/**
 * 默认会话（`main` primary body）与会话行 body 归属的纯函数：无 React / 无 store。
 *
 * - `findMainSession`：从 `agents.list` 结果（`AgentSummary[]`）解析 `main` 的
 *   primary body，即 Web 默认会话的 `session_id`；
 * - `sessionBodyOwners`：从同一份 roster 反查会话的 agent 归属（session_id → agent id），
 *   事件树为空（历史会话 / 进程重启后）时 catalogAgentId 的 roster 兜底（inbox 统一批 §4.1）。
 */
import type { NodeRoster } from '../../gateway/team-roster';
import type { AgentSummary, ExecutionUnitStatus } from '../../gateway/types';

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
function bodySessionId(body: ExecutionUnitStatus): string | undefined {
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
  const add = (
    sessionId: string | undefined,
    bodies: readonly ExecutionUnitStatus[] | undefined,
  ) => {
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

/**
 * roster → `session_id` 到归属 agent id 的反查表（inbox 统一批 §4.1 的 roster 兜底）。
 *
 * 事件树（`agents.tree`）只有活着的 run 才有节点：历史会话 / 进程重启后事件树为空，
 * catalogAgentId 就取不到 agent。roster 是盘上事实的另一份投影 —— `body_id ≡ session_id`，
 * 每个条目的 `session_id`（primary）与 `bodies[]`（live）都是它拥有的会话；
 * `body_history[]`（已退役 body，≤20）再兜住 rotate 之前的历史会话。
 *
 * 两轮扫描：live body 先入表，退役 body 后入且**不覆盖** —— 迟到的 `body_history`
 * 不许把现役会话的归属改写成旧身体时代的 agent（与 sessionAgentRetiredLabels 同口径）。
 * 同一会话多节点重复时先到先得；缺 agent id 的条目跳过（不可寻址，不猜）。
 */
export function sessionBodyOwners(rosters: readonly NodeRoster[]): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  const put = (sessionId: string | undefined, agentId: string | undefined) => {
    const session = sessionId?.trim() ?? '';
    const agent = agentId?.trim() ?? '';
    if (!session || !agent || owners.has(session)) return;
    owners.set(session, agent);
  };
  for (const roster of rosters) {
    for (const agent of roster.agents ?? []) {
      const agentId = agent.agent_id ?? agent.id;
      put(agent.session_id, agentId);
      for (const body of agent.bodies ?? []) put(bodySessionId(body), agentId);
    }
    for (const entry of roster.rosters) {
      for (const member of entry.members) {
        put(member.session_id, member.agent_id);
        for (const body of member.bodies ?? []) put(bodySessionId(body), member.agent_id);
      }
    }
  }
  for (const roster of rosters) {
    for (const entry of roster.rosters) {
      for (const member of entry.members) {
        for (const body of member.body_history ?? []) put(body.session_id, member.agent_id);
      }
    }
  }
  return owners;
}
