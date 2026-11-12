/** 按钮（Button）：全部变体 —— plain、primary、danger、dangerGhost、link、chip。 */
import { Button, type ButtonVariant } from '@vessel-agent/plugin-ui';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'Button',
  titleKey: 'designLab.sample.buttons.name',
  descriptionKey: 'designLab.sample.buttons.desc',
  group: 'ui',
  order: 40,
};

const VARIANTS: readonly ButtonVariant[] = [
  'plain',
  'primary',
  'danger',
  'dangerGhost',
  'link',
  'chip',
];

export default function ButtonPreview() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {VARIANTS.map((variant) => (
        <Button key={variant} variant={variant}>
          {variant}
        </Button>
      ))}
      <Button disabled>disabled</Button>
    </div>
  );
}
