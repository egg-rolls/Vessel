/**
 * 时长 badge（协作实验 exp-b）：把毫秒时长渲染成一个小圆角徽章。
 * @module
 *
 * 文案完全交给 `formatDuration`（exp-a 的纯函数：`X秒` / `X分Y秒` / `X小时Y分`，
 * 非法输入按 0 处理），本组件只负责形态：rounded-full、sunken 底、line-strong 描边，
 * 色调复用次要信息的 muted 档（参考 MemberModelSwitch 的 quiet 形态）。
 * `title` 挂原始毫秒数，方便悬停核对精度；不做弹出层。
 */

import { formatDuration } from './format-duration';

export function DurationBadge({ ms, className }: { ms: number; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-line-strong bg-sunken px-2 py-0.5 font-mono text-xs text-muted${className ? ` ${className}` : ''}`}
      title={`${ms} ms`}
    >
      {formatDuration(ms)}
    </span>
  );
}
