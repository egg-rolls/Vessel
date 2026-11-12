/** 指标块（Stat）：mono 数值配弱化标签。 */
import { Stat } from '@vessel-agent/plugin-ui';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'Stat',
  titleKey: 'designLab.preview.stat.title',
  descriptionKey: 'designLab.preview.stat.desc',
  group: 'ui',
  order: 80,
};

export default function StatPreview() {
  return (
    <div className="flex flex-wrap gap-2">
      <Stat
        label={t('designLab.preview.stat.runs')}
        value="12"
        hint={t('designLab.preview.stat.runsHint')}
        className="w-48"
      />
      <Stat
        label={t('designLab.preview.stat.agents')}
        value="4"
        hint={t('designLab.preview.stat.agentsHint')}
        className="w-48"
      />
    </div>
  );
}
