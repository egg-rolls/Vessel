import { useEffect, useState } from 'react';

/** 视口宽度；与 CSS 媒体查询共用 window.innerWidth。 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => {
      setWidth((current) => (current === window.innerWidth ? current : window.innerWidth));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return width;
}
