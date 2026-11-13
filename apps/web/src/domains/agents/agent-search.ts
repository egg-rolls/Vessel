/**
 * Agents 全局列表的搜索与展示名（纯函数）。
 *
 * 名称优先，缺失时回退短 id，避免列表铺开原始 UUID。
 */
import { t } from '../../i18n';

/** 超过 8 位时截断，与 Team 域的短 id 约定一致。 */
export function shortAgentId(agentId: string): string {
  return agentId.length > 8 ? agentId.slice(0, 8) : agentId;
}

/** 展示名只需要「名字 + id」两字段：按结构声明，避免把 gateway DTO 拖进来。 */
export function agentDisplayName(member: { name?: string | undefined; agent_id: string }): string {
  const name = member.name?.trim();
  // Identity 槽不允许放 id 片段（DESIGN-0.33.0 I4「id 0 命中」）：缺名时给占位词，
  // id 的去处是详情页的 KeyValueList（可复制），不是标题。
  return name && name.length > 0 ? name : t('entity.unnamed');
}

/**
 * 搜索只要「名字 + id」两字段，所以**按结构声明**参数，不 import `gateway/team-roster`。
 *
 * 为什么较这个真：`team-roster` 会牵出 `NodeProvider` / `team-control`（React 与浏览器
 * 全局），而门禁探针在 Node 里 import 本文件 —— 一拉就整条链进根 typecheck，报一堆与
 * 改动无关的 DOM 类型错（0.51 因此红过三次）。
 */
export interface SearchableAgent {
  member: { agent_id: string; name?: string | undefined };
}

/** 名称或完整 id 命中即可（显示的是短 id，但搜索接受完整 id）。 */
export function matchesAgentQuery(agent: SearchableAgent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [agent.member.name ?? '', agent.member.agent_id].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

export function filterAgentsByQuery<T extends SearchableAgent>(
  agents: readonly T[],
  query: string,
): T[] {
  return agents.filter((agent) => matchesAgentQuery(agent, query));
}
