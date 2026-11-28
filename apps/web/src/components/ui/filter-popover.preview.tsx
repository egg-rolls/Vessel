/**
 * 过滤浮层（FilterPopover）：表头筛选触发器 + 下拉面板（本地状态，只读选项）。
 * 选项超过 searchThreshold 时出搜索框——样例给 10 项演示该档位。不发 RPC。
 */
import { useState } from 'react';
import type { PreviewMeta } from '../../domains/design/preview-registry';
import { t } from '../../i18n';
import { FilterPopover } from './FilterPopover';

export const preview: PreviewMeta = {
  title: 'FilterPopover',
  titleKey: 'designLab.preview.filterPopover.title',
  descriptionKey: 'designLab.preview.filterPopover.desc',
  group: 'ui',
};

const OPTIONS = Array.from({ length: 10 }, (_, index) => ({
  value: `opt-${index + 1}`,
  label: `Option ${index + 1}`,
}));

export default function FilterPopoverPreview() {
  const [value, setValue] = useState('all');
  return (
    <div className="flex items-center gap-2">
      <FilterPopover
        label={t('designLab.preview.filterPopover.sampleLabel')}
        allValue="all"
        value={value}
        options={OPTIONS}
        onChange={setValue}
        searchPlaceholder={t('designLab.preview.filterPopover.sampleSearch')}
        searchLabel={t('designLab.preview.filterPopover.sampleSearch')}
      />
      <span className="font-mono text-2xs text-faint">{value}</span>
    </div>
  );
}
