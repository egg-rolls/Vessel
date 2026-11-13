/**
 * Teams 列表搜索（纯函数）：按 Team 名称 / team_id 过滤，保留节点级失败。
 *
 * 参数按结构声明而不是 import `gateway/team-roster` / `gateway/types`：那两个模块会牵出
 * `NodeProvider`（React 与浏览器全局），而门禁探针在 Node 里 import 本文件。
 */
interface SearchableTeam {
  name: string;
  team_id: string;
}

export function matchesTeamQuery(team: SearchableTeam, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return team.name.toLowerCase().includes(needle) || team.team_id.toLowerCase().includes(needle);
}

/** 过滤每个节点的 Team；失败节点原样保留，便于展示错误。
 *
 * 泛型只约束「可搜索的那两个字段」，返回**原类型 T**（`node` / `stale` / `partialErrors`
 * 等调用方还要用的字段一个都不能丢 —— 早先写成结构类型曾把 `node` 丢掉，一并报了 6 处红）。
 */
export function filterTeamResults<T extends { ok: boolean; teams: readonly SearchableTeam[] }>(
  results: readonly T[],
  query: string,
): T[] {
  const needle = query.trim();
  if (needle === '') return [...results];
  return results
    .map(
      (result) =>
        ({ ...result, teams: result.teams.filter((team) => matchesTeamQuery(team, needle)) }) as T,
    )
    .filter((result) => !result.ok || result.teams.length > 0);
}
