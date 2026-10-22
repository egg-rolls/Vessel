import { useEffect } from 'react';

/**
 * iOS visual viewport：键盘弹出 / 收起时把可视高度写到根元素（`--vvh`），
 * 供 `--dock-max-h` 与 `.app-shell` 使用。不支持 `visualViewport` 的浏览器
 * 保持 CSS 里的 `100dvh` 回退。
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;

    const update = () => {
      root.style.setProperty('--vvh', `${Math.round(viewport.height)}px`);
    };

    update();
    viewport.addEventListener('resize', update);
    return () => {
      viewport.removeEventListener('resize', update);
      root.style.removeProperty('--vvh');
    };
  }, []);
}
