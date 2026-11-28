/**
 * 视口懒加载门（图片内嵌气泡精炼，承重验收点）：元素进入视口（含 rootMargin
 * 预热带）才置 true，且**一次性 latch**（见过即恒 true，断开观察）——长历史
 * 翻页时视口外的 chip 不发预览 RPC / 不取字节，滚回来不重复探（缓存另兜）。
 *
 * 环境无 IntersectionObserver（测试 / 极旧内核）⇒ 直接 true（退化为即时加载，
 * 不空渲染）。
 */
import { useEffect, useRef, useState } from 'react';

export function useInView<T extends Element>(
  rootMargin = '200px',
): {
  ref: React.RefObject<T | null>;
  inView: boolean;
} {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (inView) return;
    const node = ref.current;
    if (node === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return { ref, inView };
}
