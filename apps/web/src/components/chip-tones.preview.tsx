/**
 * 状态胶囊的语义色档（`CHIP_TONES`）：一档一颗胶囊。
 *
 * 清单来自 `StatusChip.tsx` 自己的运行时数组 —— 加一档 tone 只改组件一处，这里
 * **不用动**，实验室自动多一颗胶囊。`StatusChip` 的 tone 由 `status` 派生（颜色
 * 不该由调用点随手点），所以预览反过来从 `STATUS_META` 里挑出「该档的第一颗代表
 * 状态」；`band` 不属字形档（它只换底色 / 文字色，是「胶囊落在有色卡带上」那一档），
 * 走 `variant="onBand"` 单独演示一次。
 *
 * 只读：静态状态值、无回调，不发任何 RPC。
 */
import type { PreviewMeta } from '../domains/design/preview-registry';
import type { StatusKind } from '../gateway/types';
import { t } from '../i18n';
import { CHIP_TONES, type ChipTone, STATUS_META, StatusChip } from './StatusChip';

export const preview: PreviewMeta = {
  title: 'StatusChip tones',
  titleKey: 'designLab.preview.chipTones.title',
  descriptionKey: 'designLab.preview.chipTones.desc',
  // 样例文件跟着组件放在 components/ 下，目录名（'components'）不再是分组 id
  // （契约里组名是 chat / nav / overlays / ui），所以这里显式声明分组。
  group: 'ui',
  order: 115,
};

/**
 * tone → 该档的第一颗代表状态（遍历 `STATUS_META` 的 keys 得出，不手抄第二份清单）。
 * 一档 tone 由多个状态共用（muted 就有 queued / cancelled / skipped …），取第一颗
 * 就足够表达颜色；字形不随档变化，颜色始终不是唯一载体。
 */
const STATUS_FOR_TONE: Partial<Record<ChipTone, StatusKind>> = {};
for (const kind of Object.keys(STATUS_META) as StatusKind[]) {
  const tone = STATUS_META[kind].tone;
  if (STATUS_FOR_TONE[tone] === undefined) STATUS_FOR_TONE[tone] = kind;
}

/** band 档没有代表状态（它的 tone 完全由 variant 决定），字形借 muted 档那颗。 */
const BAND_GLYPH_STATUS = STATUS_FOR_TONE.muted ?? 'pending';

/** 没有字形档的 tone = `band`：从 `CHIP_TONES` 里找出来，不写死这个字面量。 */
const BAND_TONE = CHIP_TONES.find((tone) => STATUS_FOR_TONE[tone] === undefined);

/** 一颗胶囊：tone 名当文本（与 buttons / badges 样例同款，标识符不翻译）。 */
function ChipToneSample({ tone }: { tone: ChipTone }) {
  const status = STATUS_FOR_TONE[tone];
  if (status === undefined) {
    return <StatusChip status={BAND_GLYPH_STATUS} label={tone} variant="onBand" />;
  }
  return <StatusChip status={status} label={tone} />;
}

export default function ChipTonesPreview() {
  return (
    <div className="flex flex-col gap-3">
      {/* 胶囊的 muted 档底色就是 bg-sunken，而样例卡底也是 bg-sunken —— 套一层
          bg-surface（真实调用点所在的抬升面）才看得出来那一档的底。 */}
      <div className="flex flex-wrap items-center gap-2 rounded-sm bg-surface p-2">
        {CHIP_TONES.map((tone) => (
          <ChipToneSample key={tone} tone={tone} />
        ))}
      </div>
      {BAND_TONE !== undefined && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium text-ink">
            {t('designLab.preview.chipTones.onBandTitle')}
          </p>
          {/* band 档的真实场景是排队卡的琥珀带（chat.css 的家族类，不搬进实验室）：
              这里借 info-soft 卡带演示「胶囊落在有色卡带上」的样子。 */}
          <div className="flex flex-wrap items-center gap-2 rounded-sm bg-info-soft p-2">
            <ChipToneSample tone={BAND_TONE} />
          </div>
        </div>
      )}
      <p className="text-sm text-muted">{t('designLab.preview.chipTones.note')}</p>
    </div>
  );
}
