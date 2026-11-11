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
      // 高度必须由 `scrollHeight` 决定：`<textarea>` 的自动高度由 `rows` 决定，不随
      // 内容长高（实测 5 行内容在 `height: auto` 下仍是一行高度），不能直接量自然高度。
      // 但 `scrollHeight` 只有整数字节，而行高带小数：会话输入框 14px × 1.6 = 22.39px/行
      // （内边距 8+8），1 行的真实内容高度是 38.39px，却被报成 38。把 38 写回
      // `box-sizing: border-box`（base.css 的 `*`）的 `height`，内容盒就比那一行矮
      // 0.39px —— 这是真的溢出，`overflow-y: auto` 于是没撑到 max-height 也能画出滚动条。
      // 所以除了边框 / 横向滚动条（`offsetHeight - clientHeight`），再补 1px 取整余量：
      // 写出的高度永远不低于真实内容高度，滚动条只在内容真的超过 max-height 时出现。
      const extra = element.offsetHeight - element.clientHeight;
      const maxPx = resolveMaxPx(element, maxHeightVar);
      element.style.height = `${Math.min(element.scrollHeight + extra + 1, maxPx)}px`;
    }, [maxHeightVar]);

    useLayoutEffect(() => {
      // value 变化 → 内容高度变化，需重算。
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
