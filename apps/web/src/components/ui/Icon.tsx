import type { ReactNode } from 'react';
import { cn } from './cn';

/** 消息操作里使用的图标。只做内联 SVG，颜色继承 `currentColor`。 */
export type IconName = 'copy' | 'edit' | 'retry' | 'transcript' | 'reply';

const PATHS: Record<IconName, ReactNode> = {
  copy: (
    <>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5" />
      <path d="M10.75 3.75v-1a1 1 0 0 0-1-1h-6.5a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h1" />
    </>
  ),
  edit: (
    <>
      <path d="M10.9 2.4a1.55 1.55 0 0 1 2.2 2.2L5.6 12.1l-3 .9.9-3z" />
      <path d="M9.9 3.4l2.2 2.2" />
    </>
  ),
  retry: (
    <>
      <path d="M13.25 8a5.25 5.25 0 1 1-1.55-3.72" />
      <path d="M13.25 2.75v3.25H10" />
    </>
  ),
  transcript: (
    <>
      <path d="M4 2.25h5.5l3 3v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.25a1 1 0 0 1 1-1Z" />
      <path d="M9.25 2.5v3h3" />
      <path d="M5.75 8.5h4.5M5.75 11h4.5" />
    </>
  ),
  reply: (
    <>
      <path d="M6.25 3.5 2.75 7l3.5 3.5" />
      <path d="M2.75 7h6.5A3.75 3.75 0 0 1 13 10.75v2" />
    </>
  ),
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn('size-4 flex-none', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
