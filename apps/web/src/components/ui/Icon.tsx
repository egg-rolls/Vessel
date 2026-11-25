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
  | 'delete'
  | 'chevron'
  | 'attach'
  | 'check'
  | 'archive'
  | 'github'
  | 'microsoft'
  | 'gitee';

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
  /**
   * 垃圾桶：Team 消息的「删除」键（原「撤回」）。语义是删除该消息投进成员收件箱的
   * 那一份（inbox 真删）+ 视图隐藏，不是「撤回来还能再发」—— 图形用垃圾桶而不是
   * 撤回箭头，与 `retract`（条带取消排队那颗）区分开。
   */
  delete: (
    <>
      <path d="M2.75 4.25h10.5" />
      <path d="M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25" />
      <path d="M4.25 4.25l.6 8.5a1 1 0 0 0 1 .95h4.3a1 1 0 0 0 1-.95l.6-8.5" />
      <path d="M6.75 7v4M9.25 7v4" />
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
  /**
   * 归档盒：「取消 hold / 留档」那一颗（条带上 agent 源的卡）。
   *
   * 为什么不复用 `retract`（取消排队那颗）：那个的语义是「撤回来、别发了」，而 recall 对
   * 非 human 源是 unhold —— 消息不删、退回可读 unread，只是不再 hold 住。图形选「入档」，
   * 与「撤回」区分开，名字（`chat.pending.unhold`）说的是同一件事。
   */
  archive: (
    <>
      <rect x="2" y="2.75" width="12" height="3" rx="0.75" />
      <path d="M3.25 5.75v6.25a1.25 1.25 0 0 0 1.25 1.25h7a1.25 1.25 0 0 0 1.25-1.25V5.75" />
      <path d="M6.5 8.75h3" />
    </>
  ),
  /**
   * GitHub 标记（登录页按钮左侧的品牌图形）。
   *
   * **实心**图标：官方 Octocat 轮廓本身就是面，描边化会失去辨识度。
   * `fill`/`stroke` 在 path 上就地覆盖（SVG 属性的优先级高于 `<svg>` 上的继承）。
   */
  github: (
    <path
      fill="currentColor"
      stroke="none"
      d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
    />
  ),
  /**
   * Microsoft 标记（登录页按钮左侧）。官方四色方块的单色版：四块 6×6 方片留 2 单位缝，
   * 在 16 的 viewBox 里正好铺满。
   */
  microsoft: (
    <>
      <rect x="1" y="1" width="6" height="6" fill="currentColor" stroke="none" />
      <rect x="9" y="1" width="6" height="6" fill="currentColor" stroke="none" />
      <rect x="1" y="9" width="6" height="6" fill="currentColor" stroke="none" />
      <rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none" />
    </>
  ),
  /**
   * Gitee 标记（登录页按钮左侧）。圆形徽标 + 镂空「G」；路径取自 simple-icons 的
   * 24 单位画稿，整体缩到 16 的 viewBox（描边关闭，只留填充）。
   */
  gitee: (
    <g transform="scale(0.6666667)">
      <path
        fill="currentColor"
        stroke="none"
        d="M11.984 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.016 0zm6.09 5.333c.328 0 .593.266.592.593v1.482a.594.594 0 0 1-.593.592H9.777c-.982 0-1.778.796-1.778 1.778v5.63c0 .327.266.592.593.592h5.63c.982 0 1.778-.796 1.778-1.778v-.296a.593.593 0 0 0-.592-.593h-4.15a.592.592 0 0 1-.592-.592v-1.482a.593.593 0 0 1 .593-.592h6.815c.327 0 .593.265.593.592v3.408a4 4 0 0 1-4 4H5.926a.593.593 0 0 1-.593-.593V9.778a4.444 4.444 0 0 1 4.445-4.444h8.296Z"
      />
    </g>
  ),
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
