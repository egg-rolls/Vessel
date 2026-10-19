import { useCallback, useEffect, useState } from 'react';
import { formatRoute, parseRoute, type Route } from './router';

export interface UseHashRouteResult {
  route: Route;
  navigate: (route: Route) => void;
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

  return { route, navigate };
}
