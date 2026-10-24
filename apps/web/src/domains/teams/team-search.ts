/**
 * Teams 列表搜索（纯函数）：按 Team 名称 / team_id 过滤，保留节点级失败。
 */
import type { NodeTeams } from '../../gateway/team-roster';
import type { TeamSummary } from '../../gateway/types';

export function matchesTeamQuery(
  team: Pick<TeamSummary, 'name' | 'team_id'>,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return team.name.toLowerCase().includes(needle) || team.team_id.toLowerCase().includes(needle);
}

/** 过滤每个节点的 Team；失败节点原样保留，便于展示错误。 */
export function filterTeamResults(results: readonly NodeTeams[], query: string): NodeTeams[] {
  const needle = query.trim();
  if (needle === '') return [...results];
  return results
    .map((result) => ({
      ...result,
      teams: result.teams.filter((team) => matchesTeamQuery(team, needle)),
    }))
    .filter((result) => !result.ok || result.teams.length > 0);
}
