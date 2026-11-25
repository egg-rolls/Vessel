import { useCallback } from 'react';
import { useInteractionStore } from '../stores/interactionStore';
import type { GatewayClient } from './client';
import {
  buildHydrationSnapshot,
  type PendingFetchState,
  resolvePendingFetch,
  stalePendingIds,
} from './interaction-hydration';

interface Current<T> {
  current: T;
}

export interface InteractionHydrationDeps {
  client: GatewayClient;
  recordSettled: (requestId: string) => void;
  settledRef: Current<Map<string, number>>;
  tokenRef: Current<string>;
  /**
   * canConnect 判据同步（ISSUE-CR22-1）：匿名回环（anonymousNode）与平台代理
   * （proxyMode，cookie 登录时 token 可空）都是合法的无 token 连接，
   * hydration 不能因 token 为空整段跳过。
   */
  canConnectRef?: Current<boolean>;
  hydrationGenerationRef: Current<number>;
  /**
   * 本轮结果回报（0.59）。**成功也回报** —— 界面要能区分「真的没有待批」与「拉不到」，
   * 也要在恢复后自己把提示收回去。
   */
  onFetchState?: (state: PendingFetchState) => void;
}

/**
 * 从 `interactions.list` 补回刷新 / 重连 / 选会话后丢失的卡片。
 *
 * 并行拉 pending + orphaned；orphaned 只作终态集合移除旧卡片，不再渲染本地列表，
 * 也不弹 toast（历史失效只在 Observe → Attention）。任何失败都只影响本轮
 * hydration，不阻塞 —— 但失败**会被如实上报**（`onFetchState`），不再冒充空列表。
 */
export function useInteractionHydration({
  client,
  recordSettled,
  settledRef,
  tokenRef,
  canConnectRef,
  hydrationGenerationRef,
  onFetchState,
}: InteractionHydrationDeps): () => Promise<void> {
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs 与 useRef 一样稳定
  return useCallback(async (): Promise<void> => {
    if (client.connectionState !== 'open') return;
    const tokenAtStart = tokenRef.current;
    // 与 canConnect 对齐：匿名回环 / 平台代理等合法无 token 连接也要重建审批卡。
    if (!tokenAtStart.trim() && !canConnectRef?.current) return;
    const clientAtStart = client;
    const generation = hydrationGenerationRef.current + 1;
    hydrationGenerationRef.current = generation;
    const stillCurrent = () =>
      hydrationGenerationRef.current === generation &&
      client === clientAtStart &&
      tokenRef.current === tokenAtStart;

    // 本轮 fetch 前本地已有的 id：只对它们做“服务端已无该 pending”的收敛，
    // fetch 期间新到的实时请求不在列表快照里，不能被误删。
    const localIds = [
      ...useInteractionStore.getState().permissions.map((item) => item.requestId),
      ...useInteractionStore.getState().asks.map((item) => item.requestId),
    ];

    const [pendingResult, orphanedResult] = await Promise.allSettled([
      client.listInteractionsPage({ status: 'pending', limit: 100 }),
      client.listInteractions({ status: 'orphaned', limit: 100 }),
    ]);
    // 归一化（含「失败 ≠ 空列表」的判定）是纯函数，可单独测。
    const resolved = resolvePendingFetch(pendingResult, orphanedResult);
    if (!stillCurrent()) return;

    onFetchState?.(resolved.state);

    // 服务端 orphaned 去重后只用于移除旧卡片；orphaned 历史在 Observe → Attention 查看。
    const orphanIds = [
      ...new Set(
        resolved.orphaned
          .filter((item) => item.status === 'orphaned' && item.request_id.length > 0)
          .map((item) => item.request_id),
      ),
    ];

    const settled = new Set(settledRef.current.keys());
    // 只有拿到“完整”的 pending 列表才能据此删除本地卡片：RPC 失败或还有下一页时
    // 列表不是全集，仍按“只增不减”合并。
    const snapshot = {
      ...buildHydrationSnapshot({
        pending: resolved.pending,
        orphaned: resolved.orphaned,
        settled,
      }),
      ...(resolved.pendingComplete
        ? { staleIds: stalePendingIds(localIds, resolved.pending, settled) }
        : {}),
    };
    if (!stillCurrent()) return;
    // 终态 id 写进 settled：之后重放的事件 / 迟到的 pending 列表都不能复活卡片。
    for (const requestId of snapshot.terminalIds) recordSettled(requestId);
    for (const requestId of snapshot.staleIds ?? []) recordSettled(requestId);
    useInteractionStore.getState().hydrate(snapshot, new Set(settledRef.current.keys()), orphanIds);
  }, [client, recordSettled, onFetchState]);
}
