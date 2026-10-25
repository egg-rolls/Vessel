/**
 * 跨节点 Team / roster 聚合（0.24 Web IA）。
 *
 * 每个节点独立成功 / 失败：一个节点 401 / 网络失败不拒绝其它节点。
 * 数据只来自 canonical `teams.list` / `teams.get`；不消费 federation team-info，
 * 也不经 hub 代理正文。
 */
import type { NodeView } from './NodeProvider';
import { nodeKeyOf } from './nodes';
import type { TeamControl } from './team-control';
import type { TeamMember, TeamSummary } from './types';

export interface NodeTeams {
  node: NodeView;
  ok: boolean;
  error?: string;
  code?: string;
  teams: readonly TeamSummary[];
}

export interface TeamRosterEntry {
  team: TeamSummary;
  members: readonly TeamMember[];
}

export interface NodeRoster extends NodeTeams {
  rosters: readonly TeamRosterEntry[];
  /** 列表成功、个别 Team 详情失败的个数（不伪装成空团队）。 */
  partialErrors: number;
  /** 本轮请求失败，但保留了上一次成功的 teams / rosters。 */
  stale?: boolean;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function fetchNodeTeams(node: NodeView, control: TeamControl): Promise<NodeTeams> {
  try {
    return { node, ok: true, teams: await control.listTeams() };
  } catch (error) {
    return {
      node,
      ok: false,
      teams: [],
      error: messageOf(error),
      ...(codeOf(error) ? { code: codeOf(error) } : {}),
    };
  }
}

export async function fetchAllNodeTeams(
  nodes: readonly NodeView[],
  teamControl: (node: NodeView) => TeamControl,
): Promise<NodeTeams[]> {
  return Promise.all(nodes.map((node) => fetchNodeTeams(node, teamControl(node))));
}

/** Teams 页 / Node 面板：列表 + 每个 Team 的 roster（最多 100 成员）。 */
export async function fetchNodeRoster(node: NodeView, control: TeamControl): Promise<NodeRoster> {
  const list = await fetchNodeTeams(node, control);
  if (!list.ok) {
    return { ...list, rosters: [], partialErrors: 0 };
  }
  const settled = await Promise.allSettled(
    list.teams.map(async (team) => ({
      team,
      members: (await control.getTeam(team.team_id, { members_limit: 100 })).members,
    })),
  );
  const rosters: TeamRosterEntry[] = [];
  let partialErrors = 0;
  for (const result of settled) {
    if (result.status === 'fulfilled') rosters.push(result.value);
    else partialErrors += 1;
  }
  return { ...list, rosters, partialErrors };
}

function hasRosterData(roster: NodeRoster | undefined): roster is NodeRoster {
  if (!roster) return false;
  return roster.teams.length > 0 || roster.rosters.length > 0;
}

/**
 * 合并相邻两轮节点结果：失败节点保留上一轮成功数据并标 `stale`，
 * 成功节点清掉旧数据 / stale 标记。没有历史数据时才返回空列表（由 UI 报错）。
 */
export function mergeNodeRosters(
  previous: readonly NodeRoster[],
  next: readonly NodeRoster[],
): NodeRoster[] {
  const previousByNode = new Map(previous.map((roster) => [nodeKeyOf(roster.node), roster]));
  return next.map((roster) => {
    if (roster.ok) return { ...roster, stale: false };
    const known = previousByNode.get(nodeKeyOf(roster.node));
    if (!hasRosterData(known)) return { ...roster, stale: false };
    return {
      ...known,
      node: roster.node,
      ok: false,
      error: roster.error,
      ...(roster.code ? { code: roster.code } : {}),
      partialErrors: known.partialErrors,
      stale: true,
    };
  });
}

export interface RosterAgent {
  node: NodeView;
  team: TeamSummary;
  member: TeamMember;
}

/** 展平为全局 agent 列表；一个成员只属于一个 Team。 */
export function flattenRoster(rosters: readonly NodeRoster[]): RosterAgent[] {
  const agents: RosterAgent[] = [];
  for (const roster of rosters) {
    for (const entry of roster.rosters) {
      for (const member of entry.members) {
        agents.push({ node: roster.node, team: entry.team, member });
      }
    }
  }
  return agents;
}

export interface AgentFilter {
  nodeKey?: string;
  teamId?: string;
  /** 引擎状态（idle / running / waiting_permission / closed …）。 */
  state?: string;
  /** presence：live / gone。 */
  presence?: string;
}

export function matchesAgentFilter(agent: RosterAgent, filter: AgentFilter): boolean {
  if (filter.nodeKey && nodeKeyOf(agent.node) !== filter.nodeKey) return false;
  if (filter.teamId && agent.team.team_id !== filter.teamId) return false;
  if (filter.state && agent.member.state !== filter.state) return false;
  if (filter.presence && agent.member.presence !== filter.presence) return false;
  return true;
}

export function filterRosterAgents(
  agents: readonly RosterAgent[],
  filter: AgentFilter,
): RosterAgent[] {
  return agents.filter((agent) => matchesAgentFilter(agent, filter));
}

/** 过滤下拉的取值：按节点 / Team / state / presence 去重排序。 */
export function agentFilterOptions(agents: readonly RosterAgent[]): {
  nodes: { key: string; label: string }[];
  teams: { id: string; label: string }[];
  states: string[];
} {
  const nodes = new Map<string, string>();
  const teams = new Map<string, string>();
  const states = new Set<string>();
  for (const agent of agents) {
    nodes.set(nodeKeyOf(agent.node), agent.node.name);
    teams.set(agent.team.team_id, agent.team.name || agent.team.team_id);
    if (agent.member.state) states.add(agent.member.state);
  }
  return {
    nodes: [...nodes]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    teams: [...teams]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    states: [...states].sort(),
  };
}
