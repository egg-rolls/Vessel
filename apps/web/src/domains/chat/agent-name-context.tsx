/**
 * agent 名字表的注入点（工具卡把内部 id 换成人能认的名字）。
 *
 * 为什么不直接在 `ToolCard` 里 `useAgentStore`：那张卡在设计预览 / 静态渲染里也会被
 * 单独挂起来（见 `design/previews/chat/*`），一模一样的理由写在 `tool-catalog.tsx` 头上 ——
 * 卡片不该为了显示一个名字把整个 gateway 连接模块拉进渲染树。所以名字表由**已经有
 * roster 的那一层**（`ChatView`，数据来自 `agentStore.roster`，不为这件事新增任何轮询）
 * 算好注进来（纯计算见 `agent-labels.ts`）。
 *
 * 没有 Provider 时 `useAgentNames()` 返回 `undefined`：卡片一律退短 id，
 * 绝不去猜名字（那是比显示 uuid 更糟的事）。
 */

import { createContext, type ReactNode, useContext } from 'react';
import type { AgentNameIndex } from './agent-labels';

const AgentNamesContext = createContext<AgentNameIndex | null>(null);

export function AgentNamesProvider({
  names,
  children,
}: {
  /** 标识 → 名字（`agentNamesOf(rosters)` 的结果）。 */
  names: AgentNameIndex;
  children: ReactNode;
}) {
  return <AgentNamesContext.Provider value={names}>{children}</AgentNamesContext.Provider>;
}

/** 没有 Provider（静态渲染 / 设计预览 / 还没加载 roster）时返回 `undefined`，由调用方降级。 */
export function useAgentNames(): AgentNameIndex | undefined {
  return useContext(AgentNamesContext) ?? undefined;
}
