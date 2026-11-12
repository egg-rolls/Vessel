import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import type { GatewayClient } from '../../gateway/client';

/**
 * 工具描述目录（`tools.list`）。
 *
 * 工具卡片只在弹窗里展示描述；目录是展示增强，拉取失败时静默降级为
 * “描述不可用”，不阻塞聊天、不 toast。
 *
 * 依赖从调用方注入（而不是在组件里 useConnection），这样静态渲染 / 单测
 * 直接渲染 ToolCard 时不会拉起整个 gateway 连接模块。
 */
const ToolCatalogContext = createContext<ReadonlyMap<string, string> | null>(null);

export function ToolCatalogProvider({
  client,
  enabled,
  epoch,
  agentId,
  children,
}: {
  client: Pick<GatewayClient, 'listTools' | 'listToolsForAgent'>;
  enabled: boolean;
  /** 每次 hello 递增：重启 / 重连后重新拉目录。 */
  epoch: number;
  /**
   * 当前会话的成员 id（已知时带 `agent_id` 拉一次）。
   *
   * 为什么按成员拉：`inbox` 这类工具只注册在成员身体自己的宿主里，节点插件面永远
   * 看不到它们 —— 不带 `agent_id` 时这些卡片只能显示“描述不可用”。拿不到 id
   * （无选中会话 / 旧 gateway）就保持原行为，不猜、不另建 RPC。
   */
  agentId?: string;
  children: ReactNode;
}) {
  const [descriptions, setDescriptions] = useState<ReadonlyMap<string, string>>(() => new Map());

  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch 是 hello 后的显式刷新触发器
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (
      agentId !== undefined
        ? client.listToolsForAgent(agentId).then((body) => body.tools ?? [])
        : client.listTools()
    )
      .then((tools) => {
        if (cancelled) return;
        setDescriptions(
          new Map(
            tools
              .filter((tool) => tool.name.length > 0 && tool.description.length > 0)
              .map((tool) => [tool.name, tool.description]),
          ),
        );
      })
      .catch(() => {
        // 旧 gateway / 权限不足 / 断线：保留空目录，弹窗显示“描述不可用”。
      });
    return () => {
      cancelled = true;
    };
  }, [client, enabled, epoch, agentId]);

  const value = useMemo(() => descriptions, [descriptions]);
  return <ToolCatalogContext.Provider value={value}>{children}</ToolCatalogContext.Provider>;
}

/** 没有 Provider（静态渲染 / 单测）时返回 undefined，由调用方降级。 */
export function useToolDescription(name: string): string | undefined {
  return useContext(ToolCatalogContext)?.get(name);
}
