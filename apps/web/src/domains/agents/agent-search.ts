/**
 * Agents 全局列表的搜索与展示名（纯函数）。
 *
 * 名称优先，缺失时回退短 id，避免列表铺开原始 UUID。
 */
import type { RosterAgent } from '../../gateway/team-roster';
import type { TeamMember } from '../../gateway/types';

/** 超过 8 位时截断，与 Team 域的短 id 约定一致。 */
export function shortAgentId(agentId: string): string {
  return agentId.length > 8 ? agentId.slice(0, 8) : agentId;
}

export function agentDisplayName(member: Pick<TeamMember, 'name' | 'agent_id'>): string {
  const name = member.name?.trim();
  return name && name.length > 0 ? name : shortAgentId(member.agent_id);
}

/** 名称或完整 id 命中即可（显示的是短 id，但搜索接受完整 id）。 */
export function matchesAgentQuery(agent: RosterAgent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [agent.member.name ?? '', agent.member.agent_id].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

export function filterAgentsByQuery(agents: readonly RosterAgent[], query: string): RosterAgent[] {
  return agents.filter((agent) => matchesAgentQuery(agent, query));
}
