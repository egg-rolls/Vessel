/** 表单（Field / Input / Select）：标签、输入井与选择器；聚焦用焦点环，不用描边。 */
import { Field, Input, Select } from '@vessel-agent/plugin-ui';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'Field',
  titleKey: 'designLab.preview.form.title',
  descriptionKey: 'designLab.preview.form.desc',
  group: 'ui',
  order: 20,
};

export default function FieldPreview() {
  return (
    <div className="flex flex-wrap items-start gap-5">
      <Field
        label={t('designLab.preview.form.name')}
        htmlFor="design-lab-name"
        hint={t('designLab.preview.form.nameHint')}
        className="w-60"
      >
        <Input
          id="design-lab-name"
          defaultValue="nightly-report"
          placeholder={t('designLab.preview.form.namePlaceholder')}
        />
      </Field>
      <Field label={t('designLab.preview.form.mode')} htmlFor="design-lab-mode" className="w-60">
        <Select id="design-lab-mode" defaultValue="fast">
          <option value="fast">{t('designLab.preview.form.fast')}</option>
          <option value="thorough">{t('designLab.preview.form.thorough')}</option>
        </Select>
      </Field>
    </div>
  );
}
