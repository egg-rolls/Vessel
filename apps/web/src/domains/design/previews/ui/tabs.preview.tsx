/** 分段 tab（SegmentedTabs）：域内一级 tab，支持方向键切换。 */
import { SegmentedTabs } from '@vessel-agent/plugin-ui';
import { useState } from 'react';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'SegmentedTabs',
  titleKey: 'designLab.preview.tabs.title',
  descriptionKey: 'designLab.preview.tabs.desc',
  group: 'ui',
  order: 70,
};

const TABS = [
  { id: 'overview', labelKey: 'designLab.preview.tabs.overview' },
  { id: 'details', labelKey: 'designLab.preview.tabs.details' },
  { id: 'history', labelKey: 'designLab.preview.tabs.history' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function SegmentedTabsPreview() {
  const [tab, setTab] = useState<TabId>('overview');
  return (
    <SegmentedTabs
      label={t('designLab.preview.tabs.label')}
      tabs={TABS.map((item) => ({ id: item.id, label: t(item.labelKey) }))}
      value={tab}
      onChange={setTab}
      className="mt-0"
    />
  );
}
