/**
 * 按钮（Button）：变体与尺寸全量枚举。
 *
 * 清单来自组件自己的运行时数组 `BUTTON_VARIANTS` / `BUTTON_SIZES` ——
 * 加一种变体只改 `Button.tsx` 一处，这里**不用动**，设计实验室自动多一颗按钮。
 */
import { Button, BUTTON_SIZES, BUTTON_VARIANTS } from '@vessel-agent/plugin-ui';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'Button',
  titleKey: 'designLab.sample.buttons.name',
  descriptionKey: 'designLab.sample.buttons.desc',
  group: 'ui',
  order: 40,
};

export default function ButtonPreview() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
        <Button disabled>disabled</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {BUTTON_SIZES.map((size) => (
          <Button key={size} size={size}>
            size: {size}
          </Button>
        ))}
      </div>
    </div>
  );
}
