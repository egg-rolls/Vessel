/** 工具栏（TableToolbar）：表格 / Section 正上方的控件条，搜索与批量动作都放这里。 */
import { Button, SearchInput, TableToolbar } from '@vessel-agent/plugin-ui';
import { useState } from 'react';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'TableToolbar',
  titleKey: 'designLab.preview.toolbar.title',
  descriptionKey: 'designLab.preview.toolbar.desc',
  group: 'ui',
  order: 40,
};

export default function TableToolbarPreview() {
  const [query, setQuery] = useState('');
  return (
    <TableToolbar label={t('designLab.preview.toolbar.label')}>
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder={t('designLab.preview.toolbar.placeholder')}
        ariaLabel={t('designLab.preview.toolbar.placeholder')}
        className="grow basis-60 max-w-search"
      />
      <Button variant="plain" onClick={() => setQuery('')}>
        {t('designLab.preview.toolbar.refresh')}
      </Button>
    </TableToolbar>
  );
}
