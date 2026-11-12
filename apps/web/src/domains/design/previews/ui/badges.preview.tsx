/** 徽标（Badge）：全部 tone —— neutral、accent、info、warn、danger、success。 */
import { Badge, type BadgeTone } from '@vessel-agent/plugin-ui';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'Badge',
  titleKey: 'designLab.preview.badge.title',
  descriptionKey: 'designLab.preview.badge.desc',
  group: 'ui',
  order: 30,
};

const TONES: readonly BadgeTone[] = ['neutral', 'accent', 'info', 'warn', 'danger', 'success'];

export default function BadgePreview() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {TONES.map((tone) => (
        <Badge key={tone} tone={tone}>
          {tone}
        </Badge>
      ))}
    </div>
  );
}
