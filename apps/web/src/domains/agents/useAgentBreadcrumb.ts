/**
 * 顶栏面包屑的 agent 深链感知：`#/agents/<nodeKey>/<agentId>[/edit][?body=…]`
 * 不在壳层 Route 里（Agents 域自解析），AppBar 用它补出「智能体 › <名字>」。
 * 名字来自跨节点 roster；roster 未加载 / 查不到时退 agentId 原文，不丢深链语义。
 */
import { useEffect, useMemo, useState } from 'react';
import { resourceData } from '../../state/useResource';
import { findRosterAgent, useAgentStore } from '../../stores/agentStore';
import { agentDisplayName } from './agent-search';
import { type AgentHashTarget, agentHashTarget } from './agent-url';

export interface AgentBreadcrumb {
  target: AgentHashTarget;
  name: string;
}

export function useAgentBreadcrumb(): AgentBreadcrumb | undefined {
  const [target, setTarget] = useState<AgentHashTarget | undefined>(() =>
    agentHashTarget(window.location.hash),
  );
  useEffect(() => {
    const sync = () => setTarget(agentHashTarget(window.location.hash));
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const rosterState = useAgentStore((state) => state.roster);
  return useMemo(() => {
    if (!target) return undefined;
    const agent = findRosterAgent(resourceData(rosterState) ?? [], target.nodeKey, target.agentId);
    return { target, name: agent ? agentDisplayName(agent.member) : target.agentId };
  }, [target, rosterState]);
}
