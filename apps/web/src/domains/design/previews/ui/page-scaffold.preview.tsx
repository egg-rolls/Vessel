/** 页面骨架（PageScaffold）：标题 + 副标题 + 内容；页面头部只放这两行。 */
import { PageScaffold } from '@vessel-agent/plugin-ui';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'PageScaffold',
  titleKey: 'designLab.preview.pageScaffold.title',
  descriptionKey: 'designLab.preview.pageScaffold.desc',
  group: 'ui',
  order: 120,
};

export default function PageScaffoldPreview() {
  return (
    <div className="rounded-md bg-bg">
      <PageScaffold
        title={t('designLab.preview.pageScaffold.sampleTitle')}
        subtitle={t('designLab.preview.pageScaffold.sampleSubtitle')}
        className="p-4 pb-4"
      >
        <p className="text-md text-muted">{t('designLab.preview.pageScaffold.sampleBody')}</p>
      </PageScaffold>
    </div>
  );
}
