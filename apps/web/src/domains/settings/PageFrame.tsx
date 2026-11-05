/** 设置类顶层页的共享容器：PageHeader + 路由级滚动。 */
import type { ReactNode } from 'react';
import { PageHeader } from '../../components/PageHeader';
import { useConnection } from '../../gateway/ConnectionProvider';

export function PageFrame({ title, children }: { title: string; children: ReactNode }) {
  const { tenantId } = useConnection();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
      <PageHeader title={title} tenantId={tenantId} />
      <div className="mt-5 flex flex-col gap-5">{children}</div>
    </div>
  );
}
