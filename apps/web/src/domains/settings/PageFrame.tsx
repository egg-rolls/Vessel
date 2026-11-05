/** 设置类顶层页的共享容器：路由级滚动 + 标准 `PageScaffold`。 */
import { PageScaffold } from '@vessel-agent/plugin-ui';
import type { ReactNode } from 'react';

export function PageFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain">
      <PageScaffold title={title} subtitle={subtitle}>
        {children}
      </PageScaffold>
    </div>
  );
}
