/**
 * 静态卡片基座（q-media-image-card 抽出的共享表面）。
 *
 * 来源：AsyncJobCard 的 article 表面逐字抽出 —— 异步作业卡 / 工具图片卡 / 未来
 * 其他工具卡共用同一条 class 串与同一组槽位，避免各造一套表面样式漂移
 * （与 `CARD_SURFACE_CLASS` 同一判据；那条是**可点列表卡**的表面，这条是
 * **静态内容卡**的表面：无 hover 抬起、无 cursor-pointer）。
 *
 * 槽位：`header`（状态 / 标题行，可选）→ `children`（卡体）→ `footer`（操作行，可选）。
 * 纯展示：无数据获取、无状态；开合 / 交互由调用方在槽位里自己组织
 * （需要「折叠一行 + 展开体」的时间线卡走 StreamCard，不是这里）。
 */
import type { ReactNode } from 'react';
import { cn } from './cn';

/** 静态内容卡的统一表面（只使用既有 token；forced-colors 下补边框）。 */
export const CARD_SHELL_CLASS =
  'flex flex-col gap-2 rounded-md bg-raised px-4 py-3.5 shadow-elev-1 forced-colors:border';

export interface CardShellProps {
  /** 卡头行（状态徽标 / 标题 / 元信息）；缺省不渲染。 */
  header?: ReactNode;
  /** 卡体。 */
  children?: ReactNode;
  /** 卡尾行（操作 / 链接）；缺省不渲染。 */
  footer?: ReactNode;
  className?: string;
  /** 卡片的可访问名（读屏用；缺省不挂 role）。 */
  ariaLabel?: string;
}

export function CardShell({ header, children, footer, className, ariaLabel }: CardShellProps) {
  return (
    <article
      className={cn(CARD_SHELL_CLASS, className)}
      {...(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {})}
    >
      {header}
      {children}
      {footer}
    </article>
  );
}
