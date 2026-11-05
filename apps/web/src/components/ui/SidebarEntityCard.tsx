/**
 * 侧栏实体卡片统一外壳：会话行与 Team 卡片共用同一套
 * hover / active / focus / radius / padding / border 规则。
 *
 * 槽位：leading（状态点等）、title（必填）、subtitle（第二行）、meta（行内计数）、
 * trailing（ActionMenu 等右侧动作）。`onClick` 缺省时渲染不可点击的静态行（draft）。
 * 外层可以是 `div`（会话列表）或 `li`（Team 网格）。
 */
import type { ReactNode } from 'react';
import { cn } from './cn';

export interface SidebarEntityCardProps {
  as?: 'div' | 'li';
  active?: boolean;
  onClick?: () => void;
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  /** 原生 title 提示（不是标题槽）。 */
  titleText?: string;
  className?: string;
}

export function SidebarEntityCard({
  as: Tag = 'div',
  active = false,
  onClick,
  leading,
  title,
  subtitle,
  meta,
  trailing,
  titleText,
  className,
}: SidebarEntityCardProps) {
  const body = (
    <>
      {leading != null && <span className="sidebar-entity-leading">{leading}</span>}
      <span className="sidebar-entity-body">
        <span className="sidebar-entity-title">{title}</span>
        {subtitle != null && <span className="sidebar-entity-subtitle">{subtitle}</span>}
        {meta != null && <span className="sidebar-entity-meta">{meta}</span>}
      </span>
    </>
  );

  return (
    <Tag
      className={cn(
        'sidebar-entity-card group',
        active && 'is-active',
        !onClick && 'is-static',
        className,
      )}
    >
      {onClick ? (
        <button
          type="button"
          className="sidebar-entity-main"
          title={titleText}
          aria-current={active ? 'true' : undefined}
          onClick={onClick}
        >
          {body}
        </button>
      ) : (
        <div className="sidebar-entity-main" title={titleText}>
          {body}
        </div>
      )}
      {trailing != null && <div className="sidebar-entity-trailing">{trailing}</div>}
    </Tag>
  );
}
