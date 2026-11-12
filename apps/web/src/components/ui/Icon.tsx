import type { ReactNode } from 'react';
import { cn } from './cn';

/** 消息操作 / 输入框里使用的图标。只做内联 SVG，颜色继承 `currentColor`。 */
export type IconName =
  | 'copy'
  | 'edit'
  | 'retry'
  | 'send'
  | 'resend'
  | 'transcript'
  | 'reply'
  | 'retract'
  | 'chevron'
  | 'attach'
  | 'check';

/** 纸飞机：`send`（输入框发送键）与 `resend`（重发消息）共用同一支笔形。 */
const PLANE = (
  <>
    <path d="M13.5 2.5 2.5 7.25l4.75 1.5 1.5 4.75z" />
    <path d="M7.25 8.75 13.5 2.5" />
  </>
);

const PATHS: Record<IconName, ReactNode> = {
  /** 输入框右下角发送键（圆形图标按钮，见 `ComposerSendButton`）。 */
  send: PLANE,
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
  retract: (
    <>
      <path d="M2.75 6.25h7.5a3 3 0 0 1 0 6H7" />
      <path d="M5.25 3.5 2.5 6.25l2.75 2.75" />
    </>
  ),
  resend: PLANE,
  /** 展开 / 收起指示（details 的 summary 右侧，随 open 旋转 90°）。 */
  chevron: <path d="M6.5 4.5 10.5 8l-4 3.5" />,
  /** 回形针：输入框工具栏「引用文件」入口。 */
  attach: (
    <path d="M15.01 7.74 8.58 14.17a4.2 4.2 0 0 1-5.95-5.95l6.44-6.44a2.8 2.8 0 0 1 3.96 3.96l-6.44 6.44a1.4 1.4 0 0 1-1.98-1.98l5.94-5.94" />
  ),
  /**
   * 对勾：唯一的「已完成 / 已处理」图形（排队条带的第三颗键用它）。
   *
   * 为什么不复用 `chevron`：那个在 StreamCard 卡头已经是展开 / 收起，同一个箭头表示
   * 「我已处理」会被读成「展开」——而这个动作不可逆，图形语义错了代价比多一条 path 高。
   */
  check: <path d="M3 8.5 6.25 11.75 13 4.75" />,
};

export function Icon({
  name,
  size,
  className,
}: {
  name: IconName;
  /**
   * 边长（px），缺省 16 = 今天的 `size-4`。只改图标盒子，不改 viewBox：描边
   * （`stroke-width: 1.5` 用户单位）会随盒子等比缩放，所以缩小一档也会略微变细。
   * 传了 size 就不再挂 `size-4`，靠内联 width/height 定尺寸 —— 调用点仍然不传
   * className 尺寸类（40+ 处既有约定不变）。
   */
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn('flex-none', size === undefined && 'size-4', className)}
      style={size === undefined ? undefined : { width: size, height: size }}
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
