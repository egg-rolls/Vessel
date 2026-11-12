/** 结构面板（Section）：带标题、说明与可选动作的抬升面板。 */
import { Badge, Section } from '@vessel-agent/plugin-ui';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'Section',
  titleKey: 'designLab.sample.section.name',
  descriptionKey: 'designLab.sample.section.desc',
  group: 'ui',
  order: 70,
};

export default function SectionPreview() {
  return (
    <Section
      title={t('designLab.demo.section.title')}
      description={t('designLab.demo.section.description')}
      actions={<Badge tone="accent">section</Badge>}
    >
      <p className="text-md text-muted">{t('designLab.demo.section.body')}</p>
    </Section>
  );
}
