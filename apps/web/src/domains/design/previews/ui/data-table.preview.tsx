/** 数据表（DataTable）：列宽自适应、compact 档隐藏列、行 key 由调用方给。 */
import { Badge, type BadgeTone, DataTable, type DataTableColumn } from '@vessel-agent/plugin-ui';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'DataTable',
  titleKey: 'designLab.sample.dataTable.name',
  descriptionKey: 'designLab.sample.dataTable.desc',
  group: 'ui',
  order: 30,
};

interface SampleRow {
  key: string;
  name: string;
  tone: BadgeTone;
  owner: string;
}

const SAMPLE_ROWS: readonly SampleRow[] = [
  { key: 'api-alpha', name: 'api-alpha', tone: 'success', owner: 'alice' },
  { key: 'api-beta', name: 'api-beta', tone: 'warn', owner: 'bob' },
  { key: 'worker-1', name: 'worker-1', tone: 'neutral', owner: 'carol' },
];

export default function DataTablePreview() {
  const columns: DataTableColumn<SampleRow>[] = [
    {
      key: 'name',
      header: t('designLab.demo.table.name'),
      cell: (row) => row.name,
      cellClassName: 'font-mono text-sm',
    },
    {
      key: 'status',
      header: t('designLab.demo.table.status'),
      cell: (row) => <Badge tone={row.tone}>{row.tone}</Badge>,
    },
    {
      key: 'owner',
      header: t('designLab.demo.table.owner'),
      cell: (row) => row.owner,
      hide: 'compact',
    },
  ];
  return <DataTable columns={columns} rows={SAMPLE_ROWS} rowKey={(row) => row.key} />;
}
