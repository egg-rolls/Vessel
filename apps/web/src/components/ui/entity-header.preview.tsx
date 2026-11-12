/**
 * 实体身份头部（EntityHeader）：两个尺寸档并排。
 *
 * 清单来自组件自己的运行时数组 `ENTITY_HEADER_SIZES` —— 加一档尺寸只改
 * `EntityHeader.tsx` 一处，这里**不用动**，实验室自动多一栏。四槽位（Identity /
 * Scope / Status / Detail）都摆上：尺寸差主要看标题的字族与字号，scope / status 的
 * 层次在两档里都严格递减。
 *
 * 只读：scope 项不给 onOpen、actions 按钮没有 onClick、details 是空回调 ——
 * 不导航、不发 RPC。
 */
import type { PreviewMeta } from '../../domains/design/preview-registry';
import { t } from '../../i18n';
import { Badge } from './Badge';
import { Button } from './Button';
import { ENTITY_HEADER_SIZES, EntityHeader } from './EntityHeader';

export const preview: PreviewMeta = {
  title: 'EntityHeader',
  titleKey: 'designLab.preview.entityHeader.title',
  descriptionKey: 'designLab.preview.entityHeader.desc',
  // 样例文件跟着组件放在 components/ui/ 下，分组显式声明（与 previews/ui/ 那些
  // 样例同一个组），不靠目录名兜底。
  group: 'ui',
  order: 95,
};

export default function EntityHeaderPreview() {
  return (
    <div className="grid gap-4 wide:grid-cols-2">
      {ENTITY_HEADER_SIZES.map((size) => (
        <div key={size} className="flex flex-col gap-2">
          <span className="font-mono text-2xs text-faint">size: {size}</span>
          <EntityHeader
            size={size}
            // 标题层级跟着尺寸走（page 一屏唯一的 h1 / 面板 h2）：两档都传 h1 会让
            // 同一张样例卡里出现两个 h1。新增第三档时这里要重新想一次层级。
            titleAs={size === 'page' ? 'h1' : 'h2'}
            title={t('designLab.preview.entityHeader.sampleTitle')}
            scope={[{ label: t('designLab.preview.entityHeader.sampleNode') }]}
            status={<Badge tone="warn">{t('designLab.preview.entityHeader.sampleStatus')}</Badge>}
            actions={<Button>{t('designLab.preview.entityHeader.sampleAction')}</Button>}
            detailsLabel={t('designLab.preview.entityHeader.sampleDetails')}
            onOpenDetails={() => undefined}
          />
        </div>
      ))}
    </div>
  );
}
