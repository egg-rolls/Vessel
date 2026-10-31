import { useCallback } from 'react';
import { useInteractionStore } from '../stores/interactionStore';
import type { GatewayClient } from './client';
import { buildHydrationSnapshot, stalePendingIds } from './interaction-hydration';

interface Current<T> {
  current: T;
}

export interface InteractionHydrationDeps {
  client: GatewayClient;
  recordSettled: (requestId: string) => void;
  settledRef: Current<Map<string, number>>;
  tokenRef: Current<string>;
  tenantIdRef: Current<string | null>;
  hydrationGenerationRef: Current<number>;
}

/**
 * 从 `interactions.list` 补回刷新 / 重连 / 选会话后丢失的卡片。
 *
 * 并行拉 pending + orphaned（都显式带 hello tenant）；orphaned 只作终态集合
 * 移除旧卡片，不再渲染本地列表，也不弹 toast（历史失效只在 Observe → Attention）。
 * 任何失败都只影响本轮 hydration，不阻塞。
 */
export function useInteractionHydration({
  client,
  recordSettled,
  settledRef,
  tokenRef,
  tenantIdRef,
  hydrationGenerationRef,
}: InteractionHydrationDeps): () => Promise<void> {
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs 与 useRef 一样稳定
  return useCallback(async (): Promise<void> => {
    if (client.connectionState !== 'open') return;
    const tokenAtStart = tokenRef.current;
    if (!tokenAtStart.trim()) return;
    const tenantAtStart = tenantIdRef.current ?? undefined;
    const clientAtStart = client;
    const generation = hydrationGenerationRef.current + 1;
    hydrationGenerationRef.current = generation;
    const stillCurrent = () =>
      hydrationGenerationRef.current === generation &&
      client === clientAtStart &&
      tokenRef.current === tokenAtStart &&
      (tenantIdRef.current ?? undefined) === tenantAtStart;
    const tenantParam = tenantAtStart !== undefined ? { tenant_id: tenantAtStart } : {};

    // 本轮 fetch 前本地已有的 id：只对它们做“服务端已无该 pending”的收敛，
    // fetch 期间新到的实时请求不在列表快照里，不能被误删。
    const localIds = [
      ...useInteractionStore.getState().permissions.map((item) => item.requestId),
      ...useInteractionStore.getState().asks.map((item) => item.requestId),
    ];

    const [pendingResult, orphanedResult] = await Promise.allSettled([
      client.listInteractionsPage({ status: 'pending', limit: 100, ...tenantParam }),
      client.listInteractions({ status: 'orphaned', limit: 100, ...tenantParam }),
    ]);
    if (!stillCurrent()) return;

    // 旧 gateway（method_not_allowed / not_found）与其他失败都按空结果处理。
    const pendingPage = pendingResult.status === 'fulfilled' ? pendingResult.value : null;
    const pending = pendingPage?.interactions ?? [];
    const orphanedListed = orphanedResult.status === 'fulfilled' ? orphanedResult.value : [];

    // 服务端 orphaned 去重后只用于移除旧卡片；orphaned 历史在 Observe → Attention 查看。
    const orphanIds = [
      ...new Set(
        orphanedListed
          .filter((item) => item.status === 'orphaned' && item.request_id.length > 0)
          .map((item) => item.request_id),
      ),
    ];

    const settled = new Set(settledRef.current.keys());
    // 只有拿到“完整”的 pending 列表才能据此删除本地卡片：RPC 失败或还有下一页时
    // 列表不是全集，仍按“只增不减”合并。
    const pendingComplete = pendingPage !== null && pendingPage.next_cursor === undefined;
    const snapshot = {
      ...buildHydrationSnapshot({ pending, orphaned: orphanedListed, settled }),
      ...(pendingComplete ? { staleIds: stalePendingIds(localIds, pending, settled) } : {}),
    };
    if (!stillCurrent()) return;
    // 终态 id 写进 settled：之后重放的事件 / 迟到的 pending 列表都不能复活卡片。
    for (const requestId of snapshot.terminalIds) recordSettled(requestId);
    for (const requestId of snapshot.staleIds ?? []) recordSettled(requestId);
    useInteractionStore.getState().hydrate(snapshot, new Set(settledRef.current.keys()), orphanIds);
  }, [client, recordSettled]);
}
