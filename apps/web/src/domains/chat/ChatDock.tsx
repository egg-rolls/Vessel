import type { ReactNode } from 'react';

/**
 * 底部输入槽外壳（L3）：固定底边距，内容向上生长。
 * Composer 与权限 / 提问卡共用同一个槽位。
 */
export function ChatDock({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <footer className={`composer-area ${className}`.trim()}>{children}</footer>;
}
