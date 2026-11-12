/** 结构面板（Section）：带标题、说明与可选动作的抬升面板。 */
import { Badge, Section } from '@vessel-agent/plugin-ui';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'Section',
  titleKey: 'designLab.preview.section.title',
  descriptionKey: 'designLab.preview.section.desc',
  group: 'ui',
  order: 60,
};

export default function SectionPreview() {
  return (
    <Section
      title={t('designLab.preview.section.sampleTitle')}
      description={t('designLab.preview.section.sampleDesc')}
      actions={<Badge tone="accent">section</Badge>}
    >
      <p className="text-md text-muted">{t('designLab.preview.section.sampleBody')}</p>
    </Section>
  );
}
