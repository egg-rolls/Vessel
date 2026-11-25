/**
 * 节点展示名表的注入点（agent 工具卡把完整地址的 node 段换成节点名）。
 *
 * 与 `agent-name-context.tsx` 同一个分工理由：`ToolCard` 在设计预览 / 静态渲染里也会
 * 被单独挂起来（见 `design/previews/chat/*`），不能为了显示一个节点名把 gateway 连接
 * 模块（`useNodeNames` → `useNodes`，Provider 外直接 throw）拉进渲染树。所以名字表由
 * **已经在 NodeProvider 里的那一层**（`ChatView`，数据来自 `useNodeNames` 的既有
 * health 轮询 + sessionStorage 缓存，不为这件事新增任何请求）算好注进来。
 *
 * 没有 Provider 时 `useNodeNamesContext()` 返回 `undefined`：卡片一律退**原始 node id**，
 * 绝不去猜名字（与 agent 名字表「查不到退短 id / 原文」同一条降级纪律）。
 */

import { createContext, type ReactNode, useContext } from 'react';

const NodeNamesContext = createContext<ReadonlyMap<string, string> | null>(null);

export function NodeNamesProvider({
  names,
  children,
}: {
  /** nodeKey（nodeId ?? name）→ 展示名（`useNodeNames()` 的结果）。 */
  names: ReadonlyMap<string, string>;
  children: ReactNode;
}) {
  return <NodeNamesContext.Provider value={names}>{children}</NodeNamesContext.Provider>;
}

/** 没有 Provider（静态渲染 / 设计预览）时返回 `undefined`，由调用方退原始 id。 */
export function useNodeNamesContext(): ReadonlyMap<string, string> | undefined {
  return useContext(NodeNamesContext) ?? undefined;
}
