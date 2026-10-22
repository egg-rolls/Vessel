import type { KeyboardEvent, PointerEvent, ReactElement } from 'react';
import { useRef, useState } from 'react';
import {
  applyPaneResize,
  PANE_LIMITS,
  type PaneKey,
  type PaneResizeApi,
} from '../app/usePaneResize';

const KEY_STEP = 16;

interface DragState {
  pointerId: number;
  startX: number;
  startValue: number;
  value: number;
}

export function ResizeHandle({
  pane,
  api,
  label,
  className = '',
}: {
  pane: PaneKey;
  api: PaneResizeApi;
  label: string;
  className?: string;
}): ReactElement {
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);
  const limits = PANE_LIMITS[pane];
  const disabled = api.disabled(pane);
  const current = api.layout[pane];

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startValue: current,
      value: current,
    };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const value = applyPaneResize(pane, drag.startValue, event.clientX - drag.startX);
    drag.value = value;
    // rAF 合并在 hook 内：一帧内多次 move 只写最后一次。
    api.preview(pane, value);
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    api.commit(pane, drag.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    let value: number;
    switch (event.key) {
      case 'ArrowLeft':
        value = current - KEY_STEP;
        break;
      case 'ArrowRight':
        value = current + KEY_STEP;
        break;
      case 'Home':
        value = limits.min;
        break;
      case 'End':
        value = limits.max;
        break;
      default:
        // Enter / Space 不处理。
        return;
    }
    event.preventDefault();
    api.commit(pane, value);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: 拖拽手柄需要 pointer capture / 键盘方向键，<hr> 只表达静态分隔线。
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={current}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      tabIndex={disabled ? -1 : 0}
      className={className}
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        if (!disabled) api.reset(pane);
      }}
    />
  );
}
