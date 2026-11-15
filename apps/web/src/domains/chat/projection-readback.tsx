/**
 * 投影卡的**读回**接线（`sessions.events`，spec §3.3 / 实现要点 6）。
 *
 * 依赖从调用方注入（而不是在组件里 `useConnection`），理由与 `tool-catalog.tsx` 同一条：
 * 静态渲染 / 设计预览 / 单测里直接渲染 `ToolCard` 时不该拉起整个 gateway 连接模块。
 *
 * 三条纪律：
 * 1. 请求固定带 `tool_call_id` + `since_seq`（**排他**游标，`0` = 从日志头按 id 找）；
 * 2. 读回结果**只用于展示**：不回写任何缓存、不塞进消息、不进 store（下一次渲染还是
 *    以 wire 的 `projection` 为准，读回只是这一次的临时展开）；
 * 3. 失败 / 空结果都返回 `undefined`，由渲染层降级成 `gone` 的文案 —— 不弹错误框、
 *    不显示 stack（spec §6.5：读回可能变死链，必须明确降级而不是静默空白）。
 */

import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { GatewayClient } from '../../gateway/client';
import { type ProjectionReadbackEvent, readbackOriginalOf } from './projection';

/** 一次读回最多取几条事件：那条调用自己的 `started` / `completed` 就够，给足余量即可。 */
const READBACK_LIMIT = 50;
/** 读回是用户点出来的动作，超时比后台请求松一档：慢一点也要给出结论（或明确降级）。 */
const READBACK_TIMEOUT_MS = 15_000;
/** 只认这两种事件：原文就在它们的 `result` / `error` 里（见 `readbackOriginalOf`）。 */
const READBACK_TYPES = ['tool.call.completed', 'tool.call.failed'] as const;

/** 读回一页事件，返回原文；`undefined` = 没读到（空结果 / 失败，两者都降级成 gone）。 */
export type ProjectionReadbackLoader = (request: {
  toolCallId: string;
  sinceSeq: number;
}) => Promise<string | undefined>;

/** 没有 Provider（静态渲染 / 设计预览 / 单测）时返回 `undefined`，卡片据此不给读回按钮。 */
const ProjectionReadbackContext = createContext<ProjectionReadbackLoader | null>(null);

export function ProjectionReadbackProvider({
  client,
  sessionId,
  children,
}: {
  client: Pick<GatewayClient, 'request'>;
  /** 这些消息属于哪个会话的事件日志（缺省 = 还没有会话，读回不可用）。 */
  sessionId: string | undefined;
  children: ReactNode;
}) {
  const loader = useMemo<ProjectionReadbackLoader | null>(() => {
    if (sessionId === undefined || sessionId.length === 0) return null;
    return async ({ toolCallId, sinceSeq }) => {
      try {
        const body = await client.request<{ events?: unknown[] }>(
          'sessions.events',
          {
            session_id: sessionId,
            since_seq: sinceSeq,
            limit: READBACK_LIMIT,
            types: [...READBACK_TYPES],
            tool_call_id: toolCallId,
          },
          READBACK_TIMEOUT_MS,
        );
        const events: ProjectionReadbackEvent[] = [];
        for (const raw of body?.events ?? []) {
          if (typeof raw !== 'object' || raw === null) continue;
          const event = raw as { type?: unknown; data?: unknown };
          if (typeof event.type !== 'string') continue;
          events.push({
            type: event.type,
            ...(event.data !== undefined ? { data: event.data } : {}),
          });
        }
        return readbackOriginalOf(events, toolCallId);
      } catch {
        // 死链 / 断线 / 权限不足：一律当「读不回来」，由渲染层写「原文已不可恢复」。
        return undefined;
      }
    };
  }, [client, sessionId]);

  return (
    <ProjectionReadbackContext.Provider value={loader}>
      {children}
    </ProjectionReadbackContext.Provider>
  );
}

export function useProjectionReadback(): ProjectionReadbackLoader | undefined {
  return useContext(ProjectionReadbackContext) ?? undefined;
}
