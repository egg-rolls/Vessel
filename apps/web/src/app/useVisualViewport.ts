import { useEffect } from 'react';

/**
 * iOS visual viewport：键盘弹出 / 收起、页面滚动时把可视高度与底部偏移
 * 写到根元素（`--vvh` / `--vv-bottom-offset`），供 `--dock-max-h` 与
 * `.app-shell` 使用。不支持 `visualViewport` 的浏览器保持 CSS 里的
 * `100dvh` 回退。
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;

    const update = () => {
      root.style.setProperty('--vvh', `${Math.round(viewport.height)}px`);
      root.style.setProperty(
        '--vv-bottom-offset',
        `${Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))}px`,
      );
    };

    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vv-bottom-offset');
    };
  }, []);
}
