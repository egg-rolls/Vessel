import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  cloneElement,
  type ReactElement,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

const SHOW_DELAY = 300;
const GAP = 8;
const EDGE = 8;
const ARROW_INSET = 10;

type Placement = 'top' | 'bottom';

interface Position {
  top: number;
  left: number;
  side: Placement;
  arrow: number;
}

function forwardEvent<E>(handler: unknown, event: E): void {
  if (typeof handler === 'function') (handler as (event: E) => void)(event);
}

function assignRef(ref: Ref<HTMLElement> | undefined, node: HTMLElement | null): void {
  if (!ref) return;
  if (typeof ref === 'function') ref(node);
  else if (typeof ref === 'object') (ref as { current: HTMLElement | null }).current = node;
}

/**
 * 轻量 tooltip：cloneElement 挂到子元素，不额外包 wrapper。
 * hover / focus 300ms 后显示；Esc / blur / pointerleave / 滚动 / resize 关闭。
 * portal 到 body，按锚点 rect 定位，优先上方，空间不足翻到下方。
 */
export function Tooltip({
  label,
  children,
  placement = 'top',
}: {
  label: string;
  children: ReactElement;
  placement?: Placement;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const showTimer = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);

  const childProps = (children.props ?? {}) as Record<string, unknown>;
  const childRef = childProps.ref as Ref<HTMLElement> | undefined;
  const childRefRef = useRef<Ref<HTMLElement> | undefined>(childRef);
  childRefRef.current = childRef;

  const setAnchor = useCallback((node: HTMLElement | null) => {
    anchorRef.current = node;
    assignRef(childRefRef.current, node);
  }, []);

  const clearTimer = useCallback(() => {
    if (showTimer.current !== null) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  }, []);

  const open = useCallback(() => {
    clearTimer();
    showTimer.current = window.setTimeout(() => {
      showTimer.current = null;
      setVisible(true);
    }, SHOW_DELAY);
  }, [clearTimer]);

  const close = useCallback(() => {
    clearTimer();
    setVisible(false);
  }, [clearTimer]);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const rect = anchor.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let side: Placement = placement;
    if (side === 'top' && rect.top - tipRect.height - GAP < EDGE) side = 'bottom';
    else if (side === 'bottom' && rect.bottom + GAP + tipRect.height > viewportH - EDGE) {
      side = 'top';
    }

    const top = side === 'top' ? rect.top - tipRect.height - GAP : rect.bottom + GAP;
    const centered = rect.left + rect.width / 2 - tipRect.width / 2;
    const left = Math.min(
      Math.max(centered, EDGE),
      Math.max(EDGE, viewportW - tipRect.width - EDGE),
    );
    const arrow = Math.min(
      Math.max(rect.left + rect.width / 2 - left, ARROW_INSET),
      Math.max(ARROW_INSET, tipRect.width - ARROW_INSET),
    );

    setPosition({ top, left, side, arrow });
  }, [placement]);

  useLayoutEffect(() => {
    if (visible) reposition();
  }, [visible, reposition]);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Esc 先只关 tooltip；阻止事件到达同时打开的 modal。
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [visible, close]);

  useEffect(() => clearTimer, [clearTimer]);

  const existingDescribedBy = childProps['aria-describedby'];
  const description =
    typeof existingDescribedBy === 'string' && existingDescribedBy.length > 0
      ? existingDescribedBy
      : undefined;

  const mergedProps: Record<string, unknown> = {
    ref: setAnchor,
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
      forwardEvent(childProps.onPointerEnter, event);
      open();
    },
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
      forwardEvent(childProps.onPointerLeave, event);
      close();
    },
    onFocus: (event: ReactFocusEvent<HTMLElement>) => {
      forwardEvent(childProps.onFocus, event);
      open();
    },
    onBlur: (event: ReactFocusEvent<HTMLElement>) => {
      forwardEvent(childProps.onBlur, event);
      close();
    },
  };
  if (visible) {
    mergedProps['aria-describedby'] = description ? `${description} ${id}` : id;
  } else if (description) {
    mergedProps['aria-describedby'] = description;
  }

  // cloneElement 会按元素泛型收窄 props；这里合并的是动态事件 / aria 属性。
  const cloned = cloneElement(
    children as ReactElement<Record<string, unknown>>,
    mergedProps as never,
  );

  const tipStyle: CSSProperties = {
    top: position?.top ?? 0,
    left: position?.left ?? 0,
    visibility: position ? 'visible' : 'hidden',
  };

  return (
    <>
      {cloned}
      {visible
        ? createPortal(
            <div
              ref={tipRef}
              id={id}
              role="tooltip"
              className="tooltip"
              data-placement={position?.side ?? placement}
              style={tipStyle}
            >
              <span
                className="tooltip-arrow"
                aria-hidden="true"
                style={{ left: position?.arrow ?? 0 }}
              />
              {label}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** icon-only 按钮：始终带 aria-label + tooltip。 */
export function IconButton({
  label,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        className={`icon-btn ${className ?? ''}`.trim()}
        aria-label={label}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}
