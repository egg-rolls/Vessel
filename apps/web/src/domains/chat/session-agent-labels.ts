/**
 * 会话卡片第二行的 agent 标签 name@primary（0.52）。
 *
 * 背景：第二行原本只有两种形态 —— team 成员的 name@node:team（agentAddresses，只覆盖
 * role === 'member' 的 roster 成员）与其余 primary body 会话的裸 primary 徽标。裸 primary
 * 说的是「这条会话是某个 agent 的 primary body」，却没说**是谁**：一个节点上挂着几个
 * 临时成员 / 没入 Team 的 agent 时，卡片之间就分不清了。
 *
 * 这里只给「拿不到节点地址的非 team 成员 primary 会话」补 agent 名；team 成员的会话
 * 一个都不产出（它们的第二行必须还是节点地址，显示逻辑不受这条影响）。
 *
 * 为什么是纯函数 + 本地结构类型：门禁 scripts/check-session-agent-label.ts 在 Node 里
 * 直接 import 它，不能牵进 React / gateway（同 state/archive-visibility.ts 的分工）。
 */

/** roster 上的 live body（ExecutionUnitStatus 的最小结构）。 */
export interface LabelBody {
  session_id?: string | null;
  body_id?: string | null;
  primary?: boolean;
}

/** roster 条目（AgentSummary / TeamMember 的最小结构）。 */
export interface LabelAgent {
  name?: string | null;
  role?: string | null;
  owner?: string | null;
  team_id?: string | null;
  session_id?: string | null;
  bodies?: readonly LabelBody[] | null;
  /** 已退役 body（0.52：`agents.list` / `TeamMember` 都带，rotate 之前的旧身体）。 */
  body_history?: readonly { session_id?: string | null }[] | null;
}

/** NodeRoster 的最小结构（与 gateway/team-roster.ts 同一形状）。 */
export interface LabelRoster {
  node?: { current?: boolean; name?: string | null } | null;
  agents?: readonly LabelAgent[] | null;
  rosters?:
    | readonly {
        team?: { team_id?: string | null } | null;
        members?: readonly LabelAgent[] | null;
      }[]
    | null;
}

/** 会话列表里用得上的唯一字段。 */
export interface LabelSession {
  session_id?: string | null;
}

function trimId(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? undefined : trimmed;
}

/** body_id 恒等于 session_id；旧 gateway 可能只带其中一个。 */
function bodySessionId(body: LabelBody): string | undefined {
  return trimId(body.session_id) ?? trimId(body.body_id);
}

/**
 * agent / member 的 primary body session id。
 *
 * 与 main-session.ts 的 primaryBodySessions 同口径：bodies 里 primary === true 的那条优先
 * （rotate 窗口 / 旧 gateway 精确），否则退回条目自己的 session_id（当前 gateway 的每个
 * agent 恰好一具 live body，session_id 就是 primary body session）。
 */
function primaryBodySessionId(agent: LabelAgent): string | undefined {
  const primaryBody = (agent.bodies ?? []).find((body) => body.primary === true);
  const fromBody = primaryBody ? bodySessionId(primaryBody) : undefined;
  return fromBody ?? trimId(agent.session_id);
}

/**
 * roster 条目口径：是不是 team 成员（第二行由节点地址负责）。
 *
 * 与 domains/team/role.ts 的 roleOf 同一口径：显式 role 优先（single 是旧口径的 member），
 * 缺 role 时 owner 有值 = 0.27 起的 contractor（temporary），否则就是成员。
 */
function rosterEntryIsTeamMember(entry: LabelAgent): boolean {
  const role = entry.role ?? undefined;
  if (role !== undefined) return role === 'member' || role === 'single';
  return entry.owner == null;
}

/**
 * agents.list 口径：同上，只多一条 —— role / owner / team_id 全缺失的 agent 是「未加入任何
 * Team」。roleOf 会把它推断成 member（它假设入参一定在 roster 里），这里必须当**非**成员
 * 处理，否则未绑定 agent 的会话永远补不上名字。
 */
function listedAgentIsTeamMember(agent: LabelAgent): boolean {
  const role = agent.role ?? undefined;
  if (role !== undefined) return role === 'member' || role === 'single';
  if (agent.owner != null) return false;
  return agent.team_id != null;
}

/**
 * roster + 会话列表 -> session_id 到 name@primary 的映射。
 *
 * - 只产出「非 team 成员的 primary body 会话」；team 成员（含 rosters[].members 里出现的
 *   成员会话）一个都不产出 —— 它们的第二行必须还是节点地址 / 原徽标；
 * - agent.name 为空 / 缺失时**不产出**：宁可不显示，也不要出现半个 @primary，渲染自然
 *   落回原来的 primary 徽标；
 * - sessions 缺省 = 不过滤；给了就只为列表里真实存在的会话产出（列表外的没人渲染）；
 * - primaryWord 由调用方传 t('team.member.primaryBadge')（en / zh-CN 都是 primary），这里
 *   缺省成同一个词，纯函数不碰 i18n，也不新增任何 i18n key。
 */
/**
 * 已退役 body 的会话 -> 名字标签（0.52）。
 *
 * rotate 换身体之后，旧 body 的 session 仍在会话列表里，但 `bodies[]` 只列 live body、
 * `primaryBodySessions` 也只认 primary ⇒ 这类会话的第二行**一片空白**（用户报的「子标题为空」
 * 最常见的一种）。归属信息就在 `body_history[]` 里，只是没人读。
 *
 * `formatName` 由调用方给（`{{name}}（旧身体）` 这种带 locale 的写法），纯函数不碰 i18n。
 * 已经作为 live body 出现的 session 不会被标成旧身体 —— 迟到的 `body_history` 不许覆盖现状。
 */
export function sessionAgentRetiredLabels(
  rosters: readonly LabelRoster[],
  sessions: readonly LabelSession[] | undefined,
  formatName: (name: string) => string,
): ReadonlyMap<string, string> {
  const listed = sessions
    ? new Set(
        sessions
          .map((session) => trimId(session.session_id))
          .filter((id): id is string => id !== undefined),
      )
    : undefined;

  const live = new Set<string>();
  const labels = new Map<string, string>();
  const entries: LabelAgent[] = [];
  for (const roster of rosters) {
    for (const agent of roster.agents ?? []) entries.push(agent);
    for (const team of roster.rosters ?? []) {
      for (const member of team.members ?? []) entries.push(member);
    }
  }
  for (const entry of entries) {
    for (const body of entry.bodies ?? []) {
      const sessionId = bodySessionId(body);
      if (sessionId) live.add(sessionId);
    }
    const primary = primaryBodySessionId(entry);
    if (primary) live.add(primary);
  }

  for (const entry of entries) {
    const name = trimId(entry.name);
    if (!name) continue;
    for (const body of entry.body_history ?? []) {
      const sessionId = trimId(body.session_id);
      if (sessionId === undefined) continue;
      if (live.has(sessionId)) continue;
      if (listed && !listed.has(sessionId)) continue;
      if (labels.has(sessionId)) continue;
      labels.set(sessionId, formatName(name));
    }
  }
  return labels;
}

export function sessionAgentLabels(
  rosters: readonly LabelRoster[],
  sessions?: readonly LabelSession[],
  primaryWord?: string,
): ReadonlyMap<string, string> {
  const word = trimId(primaryWord) ?? 'primary';

  // 1. team 成员的会话：地址算不算得出来都一律不碰。
  const memberSessions = new Set<string>();
  for (const roster of rosters) {
    for (const entry of roster.rosters ?? []) {
      for (const member of entry.members ?? []) {
        if (!rosterEntryIsTeamMember(member)) continue;
        const sessionId = primaryBodySessionId(member);
        if (sessionId) memberSessions.add(sessionId);
      }
    }
  }

  const listed = sessions
    ? new Set(
        sessions
          .map((session) => trimId(session.session_id))
          .filter((id): id is string => id !== undefined),
      )
    : undefined;

  // 2. 非 team 成员的 primary body：补名字。先到先得，不覆盖已有标签。
  const labels = new Map<string, string>();
  for (const roster of rosters) {
    for (const agent of roster.agents ?? []) {
      if (listedAgentIsTeamMember(agent)) continue;
      const sessionId = primaryBodySessionId(agent);
      if (!sessionId) continue;
      if (memberSessions.has(sessionId)) continue;
      if (listed && !listed.has(sessionId)) continue;
      const name = trimId(agent.name);
      if (!name) continue;
      if (labels.has(sessionId)) continue;
      labels.set(sessionId, `${name}@${word}`);
    }
  }
  return labels;
}
