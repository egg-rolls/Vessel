import { useEffect } from 'react';

const REFRESH_EVENT = 'vessel:refresh';

/** 命令面板「刷新当前视图」：只触发当前订阅者，不做全局重拉。 */
export function requestRefresh(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

export function useRefreshSignal(onRefresh: () => void): void {
  useEffect(() => {
    const handler = () => onRefresh();
    window.addEventListener(REFRESH_EVENT, handler);
    return () => window.removeEventListener(REFRESH_EVENT, handler);
  }, [onRefresh]);
}
