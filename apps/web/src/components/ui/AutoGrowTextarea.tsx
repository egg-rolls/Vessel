import {
  forwardRef,
  type TextareaHTMLAttributes,
  useCallback,
  useLayoutEffect,
  useRef,
} from 'react';

export interface AutoGrowTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  maxHeightVar?: string;
}

const FALLBACK_MAX_PX = 200;

function parsePx(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed.endsWith('px')) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/* 优先读取令牌字面 px；min()/calc() 等表达式回退到已解析的 max-height。 */
function resolveMaxPx(element: HTMLTextAreaElement, maxHeightVar: string): number {
  const declared = getComputedStyle(element).getPropertyValue(maxHeightVar);
  const direct = parsePx(declared);
  if (direct !== null) return direct;
  const used = getComputedStyle(element).maxHeight;
  return parsePx(used) ?? FALLBACK_MAX_PX;
}

export const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, AutoGrowTextareaProps>(
  function AutoGrowTextarea(
    { className, rows = 1, maxHeightVar = '--composer-input-max-h', value, ...props },
    forwardedRef,
  ) {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);

    const setRefs = useCallback(
      (node: HTMLTextAreaElement | null) => {
        innerRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    const resize = useCallback(() => {
      const element = innerRef.current;
      if (!element) return;
      element.style.height = 'auto';
      element.style.height = `${Math.min(element.scrollHeight, resolveMaxPx(element, maxHeightVar))}px`;
    }, [maxHeightVar]);

    useLayoutEffect(() => {
      // value 变化 → scrollHeight 变化，需重算高度。
      void value;
      resize();
    }, [resize, value]);

    useLayoutEffect(() => {
      const element = innerRef.current;
      if (!element) return;
      const observer = new ResizeObserver(() => resize());
      observer.observe(element);
      return () => observer.disconnect();
    }, [resize]);

    return (
      <textarea
        {...props}
        ref={setRefs}
        rows={rows}
        className={className}
        value={value}
        style={{ maxHeight: `var(${maxHeightVar}, ${FALLBACK_MAX_PX}px)`, overflowY: 'auto' }}
      />
    );
  },
);
