/**
 * 侧栏容器外壳：会话列与 Team 列共用。
 *
 * 只统一容器关注点：header（标题 + actions）、controls 行、可滚动的 children
 * 区域、背景，以及 ≤1023px 的可选抽屉 / 遮罩 / 关闭按钮。
 * 卡片本身仍是各自组件（session rows、team cards），作为 children 挂载。
 */
import type { ReactNode, Ref } from 'react';
import { IconButton } from '../Tooltip';
import { cn } from './cn';

export interface SidebarDrawerOptions {
  open: boolean;
  onClose: () => void;
  closeLabel: string;
  backdropLabel: string;
}

export interface SidebarShellProps {
  as?: 'aside' | 'div';
  title: ReactNode;
  actions?: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
  /** 容器 aria-label（无标题语义的 div 可省略）。 */
  label?: string;
  id?: string;
  className?: string;
  shellRef?: Ref<HTMLElement>;
  /** 提供时启用窄屏抽屉；不提供则保持普通列。 */
  drawer?: SidebarDrawerOptions;
}

export function SidebarShell({
  as: Tag = 'aside',
  title,
  actions,
  controls,
  children,
  label,
  id,
  className,
  shellRef,
  drawer,
}: SidebarShellProps) {
  // aside / div 都满足 HTMLElement；用回调避免把 Ref<HTMLElement> 窄化成 HTMLDivElement。
  const assignRef = (node: HTMLElement | null) => {
    if (typeof shellRef === 'function') shellRef(node);
    else if (shellRef) (shellRef as { current: HTMLElement | null }).current = node;
  };

  return (
    <>
      <Tag
        {...(drawer ? { role: 'dialog' as const, 'aria-modal': drawer.open } : {})}
        ref={assignRef}
        id={id}
        className={cn('sidebar-shell', drawer && 'is-drawer', drawer?.open && 'open', className)}
        aria-label={label}
        inert={drawer && !drawer.open ? true : undefined}
        aria-hidden={drawer && !drawer.open ? true : undefined}
      >
        <header className="sidebar-head">
          <h2 className="sidebar-title">{title}</h2>
          <div className="sidebar-actions">
            {actions}
            {drawer?.open && (
              <IconButton label={drawer.closeLabel} onClick={drawer.onClose}>
                ×
              </IconButton>
            )}
          </div>
        </header>
        {controls != null && <div className="sidebar-controls">{controls}</div>}
        <div className="sidebar-scroll">{children}</div>
      </Tag>
      {drawer?.open && (
        <button
          type="button"
          className="drawer-backdrop"
          aria-label={drawer.backdropLabel}
          onClick={drawer.onClose}
        />
      )}
    </>
  );
}
