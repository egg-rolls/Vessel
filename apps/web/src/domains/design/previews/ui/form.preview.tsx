/** 表单（Field / Input / Select）：标签、输入井与选择器；聚焦用焦点环，不用描边。 */
import { Field, Input, Select } from '@vessel-agent/plugin-ui';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'Field',
  titleKey: 'designLab.sample.form.name',
  descriptionKey: 'designLab.sample.form.desc',
  group: 'ui',
  order: 80,
};

export default function FieldPreview() {
  return (
    <div className="flex flex-wrap items-start gap-5">
      <Field
        label={t('designLab.demo.form.name')}
        htmlFor="design-lab-name"
        hint={t('designLab.demo.form.nameHint')}
        className="w-60"
      >
        <Input
          id="design-lab-name"
          defaultValue="nightly-report"
          placeholder={t('designLab.demo.form.namePlaceholder')}
        />
      </Field>
      <Field label={t('designLab.demo.form.mode')} htmlFor="design-lab-mode" className="w-60">
        <Select id="design-lab-mode" defaultValue="fast">
          <option value="fast">{t('designLab.demo.form.fast')}</option>
          <option value="thorough">{t('designLab.demo.form.thorough')}</option>
        </Select>
      </Field>
    </div>
  );
}
