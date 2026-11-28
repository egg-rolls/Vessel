/**
 * 组件清单区（q-design-lab-restore）：components/ui 共享组件的复用度审计。
 *
 * 数据 = 构建期快照（component-inventory.data.ts，gen-component-inventory.ts 生成）：
 * 消费方计数 + 预览覆盖 + 单消费方/零消费方标记。复用第一原则：新 UI 先查本清单，
 * 单消费方组件 = 疑似一次性（应复用共享或退役候选）。
 */
import { Badge, DataTable, type DataTableColumn } from '../../components/ui';
import { t } from '../../i18n';
import {
  COMPONENT_INVENTORY,
  INVENTORY_COMMIT,
  type InventoryEntry,
} from './component-inventory.data';

function purposeKey(entry: InventoryEntry): string {
  return `designLab.inventory.purpose.${entry.module}`;
}

/** 复用度标记：0 = 退役候选；1 = 疑似一次性；≥2 = 共享中。 */
function reuseFlag(entry: InventoryEntry): { label: string; tone: 'danger' | 'warn' | 'success' } {
  if (entry.consumerCount === 0)
    return { label: t('designLab.inventory.flagZero'), tone: 'danger' };
  if (entry.consumerCount === 1)
    return { label: t('designLab.inventory.flagSingle'), tone: 'warn' };
  return { label: t('designLab.inventory.flagShared'), tone: 'success' };
}

/** 列定义在渲染期构建（表头走 t，locale 切换时随重渲染更新）。 */
function inventoryColumns(): readonly DataTableColumn<InventoryEntry>[] {
  return [
    {
      key: 'module',
      header: t('designLab.inventory.colComponent'),
      cell: (entry) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-sm">{entry.module}</span>
          <Badge tone="neutral">{t(`designLab.inventory.kind.${entry.kind}`)}</Badge>
          {entry.reexport && <Badge tone="info">{t('designLab.inventory.reexport')}</Badge>}
        </span>
      ),
    },
    {
      key: 'purpose',
      header: t('designLab.inventory.colPurpose'),
      cell: (entry) => <span className="text-sm text-muted">{t(purposeKey(entry))}</span>,
      hide: 'compact',
    },
    {
      key: 'reuse',
      header: t('designLab.inventory.colReuse'),
      cell: (entry) => {
        const flag = reuseFlag(entry);
        const detail = [...entry.consumers, ...entry.uiConsumers].join('\n');
        return (
          <span className="flex flex-wrap items-center gap-1.5" title={detail}>
            <span className="font-mono text-sm">{entry.consumerCount}</span>
            <Badge tone={flag.tone}>{flag.label}</Badge>
          </span>
        );
      },
    },
    {
      key: 'preview',
      header: t('designLab.inventory.colPreview'),
      cell: (entry) =>
        entry.previews.length > 0 ? (
          <span className="font-mono text-2xs text-muted" title={entry.previews.join('\n')}>
            {t('designLab.inventory.previewCovered', { count: entry.previews.length })}
          </span>
        ) : (
          <Badge tone="warn">{t('designLab.inventory.previewMissing')}</Badge>
        ),
      hide: 'compact',
    },
  ];
}

export function ComponentInventorySection() {
  const rows = COMPONENT_INVENTORY;
  const shared = rows.filter((entry) => entry.consumerCount >= 2).length;
  const single = rows.filter((entry) => entry.consumerCount === 1).length;
  const zero = rows.filter((entry) => entry.consumerCount === 0).length;
  const noPreview = rows.filter((entry) => entry.previews.length === 0).length;

  return (
    <section className="flex flex-col gap-5" aria-labelledby="design-lab-inventory">
      <div className="flex flex-col gap-1.5">
        <h2 id="design-lab-inventory" className="font-serif text-xl leading-snug text-ink">
          {t('designLab.inventory.title')}
        </h2>
        <p className="max-w-prose text-md leading-normal text-muted">
          {t('designLab.inventory.subtitle')}
        </p>
        <p className="max-w-prose text-sm leading-normal text-muted">
          {t('designLab.inventory.snapshotNote', { commit: INVENTORY_COMMIT })}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <Badge tone="neutral">{t('designLab.inventory.total', { count: rows.length })}</Badge>
        <Badge tone="success">{t('designLab.inventory.shared', { count: shared })}</Badge>
        <Badge tone="warn">{t('designLab.inventory.single', { count: single })}</Badge>
        <Badge tone="danger">{t('designLab.inventory.zero', { count: zero })}</Badge>
        <Badge tone="warn">{t('designLab.inventory.noPreview', { count: noPreview })}</Badge>
      </div>

      <DataTable columns={inventoryColumns()} rows={rows} rowKey={(entry) => entry.module} />
    </section>
  );
}
