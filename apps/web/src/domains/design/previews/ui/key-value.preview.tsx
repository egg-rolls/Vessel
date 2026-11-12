/** 键值列表（KeyValueList）：两列定义列表，值可断行。 */
import { KeyValueList } from '@vessel-agent/plugin-ui';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'KeyValueList',
  titleKey: 'designLab.preview.keyValue.title',
  descriptionKey: 'designLab.preview.keyValue.desc',
  group: 'ui',
  order: 90,
};

export default function KeyValueListPreview() {
  return (
    <KeyValueList
      items={[
        {
          key: 'gateway',
          label: t('designLab.preview.keyValue.gateway'),
          value: 'ws://127.0.0.1:8642',
        },
        { key: 'tenant', label: t('designLab.preview.keyValue.tenant'), value: 'local' },
        {
          key: 'protocol',
          label: t('designLab.preview.keyValue.protocol'),
          value: 'vessel.gateway/1',
        },
      ]}
    />
  );
}
