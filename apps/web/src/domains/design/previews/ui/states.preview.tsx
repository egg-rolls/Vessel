/** 状态块（EmptyState / LoadingState / ErrorState）：空态、加载与错误态的统一样式。 */
import { Button } from '@vessel-agent/plugin-ui';
import { EmptyState, ErrorState, LoadingState } from '../../../../components/States';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'States',
  titleKey: 'designLab.sample.states.name',
  descriptionKey: 'designLab.sample.states.desc',
  group: 'ui',
  order: 120,
};

export default function StatesPreview() {
  return (
    <div className="flex flex-col gap-2.5">
      <EmptyState
        title={t('designLab.demo.states.emptyTitle')}
        description={t('designLab.demo.states.emptyDesc')}
        action={<Button variant="primary">{t('designLab.demo.toolbar.refresh')}</Button>}
      />
      <LoadingState label={t('designLab.demo.states.loading')} />
      <ErrorState message={t('designLab.demo.states.error')} />
    </div>
  );
}
