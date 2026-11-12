/** 状态块（EmptyState / LoadingState / ErrorState）：空态、加载与错误态的统一样式。 */
import { Button } from '@vessel-agent/plugin-ui';
import { EmptyState, ErrorState, LoadingState } from '../../../../components/States';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'States',
  titleKey: 'designLab.preview.states.title',
  descriptionKey: 'designLab.preview.states.desc',
  group: 'ui',
  order: 100,
};

export default function StatesPreview() {
  return (
    <div className="flex flex-col gap-2.5">
      <EmptyState
        title={t('designLab.preview.states.emptyTitle')}
        description={t('designLab.preview.states.emptyDesc')}
        action={<Button variant="primary">{t('designLab.preview.states.action')}</Button>}
      />
      <LoadingState label={t('designLab.preview.states.loading')} />
      <ErrorState message={t('designLab.preview.states.error')} />
    </div>
  );
}
