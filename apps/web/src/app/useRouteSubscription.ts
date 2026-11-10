/**
 * 路由级事件订阅接线（CONTRACT-msg-system §4.1，S3）。
 *
 * 每个 node 只有一条 WS；路由变化时由壳层调用 `subscription.apply(scope)`，
 * 控制器负责 `events.subscribe` 的收敛、feature gate 与订阅 epoch hello。
 * 不要把控制器塞进各域组件：这里只翻译路由，不持有页面状态。
 */
import { useEffect, useMemo } from 'react';
import { useConnection } from '../gateway/ConnectionProvider';
import type { SubscriptionScope } from '../gateway/subscription';
import type { Route } from './router';

/** 路由 → 订阅范围（契约 §4.1 表格）；旧 gateway 的降级由控制器处理。 */
function scopeForRoute(route: Route): SubscriptionScope {
  switch (route.domain) {
    case 'chat':
      // `new` 是草稿态，没有会话归属；退回「不重放」。
      return route.sessionId && route.sessionId !== 'new'
        ? { kind: 'chat', sessionId: route.sessionId }
        : { kind: 'none' };
    case 'teams':
      return { kind: 'team' };
    case 'runs':
      // 详情页（带 runId）需要 llm / tool 事件；列表页只收 run 生命周期。
      return route.runId ? { kind: 'run', runId: route.runId } : { kind: 'runs' };
    default:
      return { kind: 'none' };
  }
}

export function useRouteSubscription(route: Route): void {
  const { subscription } = useConnection();
  // `route` 在两次 hashchange 之间保持同一身份，scope 不会每渲染重建。
  const scope = useMemo(() => scopeForRoute(route), [route]);
  useEffect(() => {
    void subscription.apply(scope);
  }, [subscription, scope]);
}
