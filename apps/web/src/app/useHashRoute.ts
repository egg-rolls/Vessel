import { useCallback, useEffect, useState } from 'react';
import { formatRoute, parseRoute, type Route } from './router';

export interface UseHashRouteResult {
  route: Route;
  navigate: (route: Route) => void;
  /** 替换当前历史条目（弹窗关闭回 chat，不留「后退又打开」的重复条目）。 */
  replace: (route: Route) => void;
}

/**
 * 订阅 `hashchange`。刷新与浏览器前进/后退都会回到同一路由。
 * `navigate` 只写 hash，解析统一由 hashchange 驱动，保证单一事实来源。
 */
export function useHashRoute(): UseHashRouteResult {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const navigate = useCallback((next: Route) => {
    const hash = formatRoute(next);
    if (window.location.hash === hash) return;
    window.location.hash = hash;
  }, []);

  const replace = useCallback((next: Route) => {
    const hash = formatRoute(next);
    if (window.location.hash === hash) return;
    // replaceState 不触发 hashchange：显式同步路由状态，保持单一事实来源。
    window.history.replaceState(null, '', hash);
    setRoute(next);
  }, []);

  return { route, navigate, replace };
}
