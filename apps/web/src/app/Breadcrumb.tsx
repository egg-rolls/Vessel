import { Fragment } from 'react';
import type { BreadcrumbSegment } from './nav';
import { formatRoute, type Route } from './router';

/**
 * 统一面包屑（q-breadcrumb-clickable）：全部路由共用，全段可点击、同权重同色口径
 * （text-muted hover:text-ink hover:underline，与原 agent 父级 button 一致）。
 *
 * - route 段 → navigate(route)（壳层既有导航）；hash 段（agent 深链）→ 写 location.hash。
 * - 末段 = 当前页：aria-current="page"，仍可点击（导航自身，用户裁定全可点击）。
 * - 「›」分隔 aria-hidden；button 原生键盘可达（Tab + Enter/Space）。
 * - 窄屏截断由 AppBar 外层 span 的 ellipsis 口径承担，这里不另造响应式。
 */
export function Breadcrumb({
  segments,
  navigate,
}: {
  segments: BreadcrumbSegment[];
  navigate: (route: Route) => void;
}) {
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment
          key={`${segment.label}:${segment.route ? formatRoute(segment.route) : (segment.hash ?? '')}`}
        >
          {index > 0 && (
            <span aria-hidden="true" className="mx-1.5 text-faint">
              ›
            </span>
          )}
          <button
            type="button"
            className="cursor-pointer bg-transparent p-0 text-muted underline-offset-4 hover:text-ink hover:underline focus-visible:text-ink focus-visible:underline"
            aria-current={index === segments.length - 1 ? 'page' : undefined}
            onClick={() => {
              if (segment.route) navigate(segment.route);
              else if (segment.hash) window.location.hash = segment.hash;
            }}
          >
            {segment.label}
          </button>
        </Fragment>
      ))}
    </>
  );
}
