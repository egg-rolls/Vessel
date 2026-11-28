/**
 * 侧栏壳（SidebarShell）：普通列模式（不启用抽屉，避免样例里出现遮罩）。
 * header / controls / 滚动区三槽位都摆上；行内容是静态占位，不导航、不发 RPC。
 */

import { useState } from 'react';
import type { PreviewMeta } from '../../domains/design/preview-registry';
import { t } from '../../i18n';
import { SearchInput } from './SearchInput';
import { SidebarShell } from './SidebarShell';

export const preview: PreviewMeta = {
  title: 'SidebarShell',
  titleKey: 'designLab.preview.sidebarShell.title',
  descriptionKey: 'designLab.preview.sidebarShell.desc',
  group: 'ui',
};

export default function SidebarShellPreview() {
  const [query, setQuery] = useState('');
  const rows = [1, 2, 3, 4, 5, 6];
  return (
    <div className="h-64 max-w-72 overflow-hidden rounded-md border border-line">
      <SidebarShell
        as="div"
        title={t('designLab.preview.sidebarShell.sampleTitle')}
        controls={
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('designLab.preview.sidebarShell.sampleSearch')}
            ariaLabel={t('designLab.preview.sidebarShell.sampleSearch')}
          />
        }
      >
        <ul className="flex flex-col gap-1 p-2">
          {rows.map((row) => (
            <li key={row} className="rounded-sm bg-raised px-3 py-2 text-sm text-muted">
              {t('designLab.preview.sidebarShell.sampleRow', { index: row })}
            </li>
          ))}
        </ul>
      </SidebarShell>
    </div>
  );
}
