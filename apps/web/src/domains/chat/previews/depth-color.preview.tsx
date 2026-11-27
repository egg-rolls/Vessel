/**
 * 树深度色板（depth-color）：会话卡地址子标题配色的实时预览。
 *
 * 读当前配置（useDepthColor → configStore 快照），渲染 depth 0–9 两行色板
 * （亮/暗档各自 L/C），oklch() 直出——与 chat.css 的着色规则同一个表达式，
 * 浏览器原生 gamut 映射。调参前后在此可视对比（Settings → Visual → 设计实验室）。
 *
 * 只读：不发 RPC、不改全局状态；两行背景显式给出（亮/暗），与当前主题无关，
 * 任何主题下都能同时对比两档。新增样例 = 新增本文件，Vite glob 自动发现。
 */
import { t } from '../../../i18n';
import { hueOfDepth, useDepthColor } from '../../../state/depth-color';
import type { PreviewMeta } from '../../design/preview-registry';

export const preview: PreviewMeta = {
  title: 'DepthPalette',
  titleKey: 'designLab.preview.depthColor.title',
  descriptionKey: 'designLab.preview.depthColor.desc',
  // 样例跟着会话卡组件放在 domains/chat/ 下；分组显式声明（与 previews/chat/ 同组）。
  group: 'chat',
  order: 95,
};

/** 色板深度档（0–9）：静态值数组，key 用值本身（不是数组下标）。 */
const DEPTHS: readonly number[] = Array.from({ length: 10 }, (_, i) => i);

/** 一档主题的一行色板：depth 0–9，oklch() 直出（与 chat.css 着色规则同表达式）。 */
function SwatchRow({
  label,
  lightness,
  chroma,
  background,
  foreground,
}: {
  label: string;
  lightness: number;
  chroma: number;
  background: string;
  foreground: string;
}) {
  const { params } = useDepthColor();
  return (
    <div className="flex flex-col gap-1.5 rounded-md p-3" style={{ background }}>
      <span className="text-sm font-medium" style={{ color: foreground }}>
        {label}
      </span>
      <div className="flex flex-wrap gap-2">
        {DEPTHS.map((depth) => {
          const hue = hueOfDepth(depth, params);
          return (
            <div key={depth} className="flex flex-col items-center gap-1">
              <span
                role="img"
                aria-label={t('designLab.preview.depthColor.swatchLabel', { depth, hue })}
                className="rounded-sm"
                style={{
                  background: `oklch(${lightness} ${chroma} ${hue})`,
                  width: 44,
                  height: 28,
                }}
              />
              <span className="font-mono text-xs" style={{ color: foreground }}>
                {t('designLab.preview.depthColor.depthLabel', { depth })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function DepthColorPreview() {
  const { enabled, params } = useDepthColor();
  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-sm text-muted">
        {t('designLab.preview.depthColor.params', {
          rootHue: params.rootHue,
          hueStep: params.hueStep,
          lLight: params.lightnessLight,
          cLight: params.chromaLight,
          lDark: params.lightnessDark,
          cDark: params.chromaDark,
        })}
      </p>
      {!enabled && (
        <p className="text-sm text-warn">{t('designLab.preview.depthColor.disabled')}</p>
      )}
      <SwatchRow
        label={t('designLab.preview.depthColor.lightRow')}
        lightness={params.lightnessLight}
        chroma={params.chromaLight}
        background="#ffffff"
        foreground="#101012"
      />
      <SwatchRow
        label={t('designLab.preview.depthColor.darkRow')}
        lightness={params.lightnessDark}
        chroma={params.chromaDark}
        background="#121214"
        foreground="#f2f2f3"
      />
    </div>
  );
}
