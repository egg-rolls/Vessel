/**
 * 静态卡片基座（CardShell）：header / children / footer 三槽位各摆一份。
 * 只读静态数据：footer 按钮无 onClick，不导航、不发 RPC。
 */
import type { PreviewMeta } from '../../domains/design/preview-registry';
import { t } from '../../i18n';
import { Badge } from './Badge';
import { Button } from './Button';
import { CardShell } from './CardShell';

export const preview: PreviewMeta = {
  title: 'CardShell',
  titleKey: 'designLab.preview.cardShell.title',
  descriptionKey: 'designLab.preview.cardShell.desc',
  group: 'ui',
};

export default function CardShellPreview() {
  return (
    <CardShell
      ariaLabel={t('designLab.preview.cardShell.sampleTitle')}
      header={
        <span className="flex items-center gap-2">
          <Badge tone="success">{t('designLab.preview.cardShell.sampleStatus')}</Badge>
          <span className="text-sm font-medium">
            {t('designLab.preview.cardShell.sampleTitle')}
          </span>
        </span>
      }
      footer={
        <span className="flex justify-end">
          <Button variant="link">{t('designLab.preview.cardShell.sampleAction')}</Button>
        </span>
      }
    >
      <p className="text-sm text-muted">{t('designLab.preview.cardShell.sampleBody')}</p>
    </CardShell>
  );
}
