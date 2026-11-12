/**
 * 输入框的圆形图标控件（composer-controls）：一个形状层 + 两档色调。
 *
 * 清单来自 `COMPOSER_ICON_TONES`、class 来自 `COMPOSER_ICON_TONE_CLASS` —— 加一档
 * 色调只改 `composer-controls.ts` 一处，这里**不用动**。每档都套同一个形状层
 * （`composerIconControlClass`：32px 正圆 + 凹陷底 + 强描边），各出三颗：发送键的
 * 纸飞机（16px）、回形针（14px，墨迹缩到与纸飞机同占地）、以及禁用态。
 * hover 是活的（`enabled:hover:`），把鼠标停上去就能看到第二态。
 *
 * 只读：按钮没有 onClick（点了不发消息、不开附件弹层），也不读草稿。
 */
import { Button, cn, Icon, type IconName } from '../../components/ui';
import { t } from '../../i18n';
import type { PreviewMeta } from '../design/preview-registry';
import {
  COMPOSER_ICON_TONE_CLASS,
  COMPOSER_ICON_TONES,
  type ComposerIconTone,
  composerIconControlClass,
} from './composer-controls';

export const preview: PreviewMeta = {
  title: 'ComposerIconButton',
  titleKey: 'designLab.preview.composerIcon.title',
  descriptionKey: 'designLab.preview.composerIcon.desc',
  // 样例文件跟着组件放在 domains/chat/ 下；分组显式声明（与 previews/chat/ 那些
  // 样例同一个组），否则目录名不再是分组 id。
  group: 'chat',
  order: 90,
};

/** 一颗控件：形状层 + 色调层 + 图标。点击无副作用，所以没有 onClick。 */
function IconControl({
  tone,
  icon,
  size,
  disabled = false,
}: {
  tone: ComposerIconTone;
  icon: IconName;
  /** 图标边长；回形针传 14（与真实调用点 `ComposerAttachButton` 一致）。 */
  size?: number;
  disabled?: boolean;
}) {
  // 可访问名走 i18n（图标本身 aria-hidden），种在 tone 上便于读者对上号。
  const label = t('designLab.preview.composerIcon.sampleLabel', { tone });
  return (
    <Button
      variant="plain"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cn(composerIconControlClass, COMPOSER_ICON_TONE_CLASS[tone])}
    >
      <Icon name={icon} size={size} />
    </Button>
  );
}

export default function ComposerIconPreview() {
  return (
    <div className="flex flex-col gap-3">
      {COMPOSER_ICON_TONES.map((tone) => (
        <div key={tone} className="flex flex-col gap-1.5">
          <span className="font-mono text-2xs text-faint">{tone}</span>
          <div className="flex flex-wrap items-center gap-2">
            <IconControl tone={tone} icon="send" />
            <IconControl tone={tone} icon="attach" size={14} />
            <IconControl tone={tone} icon="send" disabled />
            <span className="text-2xs text-faint">
              {t('designLab.preview.composerIcon.disabled')}
            </span>
          </div>
        </div>
      ))}
      <p className="text-sm text-muted">{t('designLab.preview.composerIcon.note')}</p>
    </div>
  );
}
