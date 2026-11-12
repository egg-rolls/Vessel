/**
 * Tooltip / IconButton（components/Tooltip）：hover 或聚焦 300ms 后出现，
 * Esc / blur / 滚动 / resize 关闭；portal 到 body，空间不足自动翻到下方。
 */
import { Button } from '@vessel-agent/plugin-ui';
import { IconButton, Tooltip } from '../../../../components/Tooltip';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'Tooltip',
  descriptionKey: 'designLab.preview.tooltip.desc',
  group: 'overlays',
  order: 30,
};

export default function TooltipPreview() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Tooltip label={t('designLab.preview.tooltip.label')}>
        <Button variant="plain">{t('designLab.preview.tooltip.trigger')}</Button>
      </Tooltip>
      <Tooltip label={t('designLab.preview.tooltip.bottom')} placement="bottom">
        <Button variant="plain">{t('designLab.preview.tooltip.bottomTrigger')}</Button>
      </Tooltip>
      <IconButton label={t('designLab.preview.tooltip.icon')}>
        <span aria-hidden="true">?</span>
      </IconButton>
    </div>
  );
}
