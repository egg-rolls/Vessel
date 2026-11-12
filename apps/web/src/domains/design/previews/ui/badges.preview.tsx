/**
 * 徽标（Badge / CountBadge）：tone 全量枚举。
 *
 * 清单来自组件自己的运行时数组 `BADGE_TONES` / `COUNT_BADGE_TONES` ——
 * 加一档 tone 只改组件一处，这里**不用动**。
 */
import { Badge, BADGE_TONES, CountBadge, COUNT_BADGE_TONES } from '@vessel-agent/plugin-ui';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'Badge',
  titleKey: 'designLab.sample.badges.name',
  descriptionKey: 'designLab.sample.badges.desc',
  group: 'ui',
  order: 50,
};

export default function BadgePreview() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {BADGE_TONES.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {COUNT_BADGE_TONES.map((tone) => (
          <CountBadge key={tone} count={3} tone={tone} />
        ))}
      </div>
    </div>
  );
}
