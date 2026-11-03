import { useEffect, useState } from 'react';
import { fetchServedBuild, isOutdated } from '../build-info';

/**
 * 「页面已过期」轮询（0.37，原顶部刷新提示的逻辑）。
 *
 * 背景：`dist` 不入 git，gateway 在产物落后于源码时**后台重建**。重建完成后，
 * 已经打开的标签页仍然是旧 bundle（它自己的 JS 不会变），只有重新加载才会拿到新的。
 * 这里定期拉 `dist/build.json`（重建时会改写），与编进 bundle 的构建戳比对。
 *
 * 拉不到（旧产物没有该文件、vite dev、请求失败）时保持静默 —— 无法判断不等于过期。
 */
const POLL_MS = 10_000;

export function useOutdatedBuild(): boolean {
  const [outdated, setOutdated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const check = async (): Promise<void> => {
      const served = await fetchServedBuild(controller.signal);
      if (!cancelled) setOutdated(isOutdated(served));
    };

    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    // 标签页从后台回来时立刻查一次：切走期间很可能错过了重建。
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return outdated;
}
