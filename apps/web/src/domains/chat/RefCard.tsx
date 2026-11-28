/**
 * 统一文件卡（q-block-cardshell-unify，用户新 UI 方向③）：CardShell 表面 +
 * 左 ICON 槽右一行文字槽。图片缩略图进 ICON 槽 + 文件名；PDF / 其他文件换
 * RefIcon 图标；点击统一走既有 ImageLightbox（图片有字节时）/ 复制路径
 * （无字节可预览时，与插件 FileRefLinkCard 同一语义，绝不导航）。
 *
 * 复用体系（不另造壳 / 预览 / 取值）：
 * - 表面 = CardShell（与 ToolImageCard 同一基座）；
 * - 取值 = image-preview 的 useImageBlob（sha256 寻址，匹配到结构化 ref 时）
 *   与 useAttachmentPreview（path 寻址，无 ref 的正文 token）—— 两 RPC 语义
 *   不同不合并（设计稿 §2.6）；
 * - 放大 = ImageLightbox（ModalShell 既有 a11y）；
 * - 图标 = RefIcon（宿主唯一实现）；投递 chip = MessageRefs 同一份文案 / 配色。
 *
 * 形态照 FileRefLinkCard（单 button 行：缩略图 / 图标 + 名称 + 徽标），表面换成
 * CardShell —— 插件 bundle 零改动，宿主侧静态卡统一视觉。
 */
import { useState } from 'react';
import { CardShell, useMessageCopy } from '../../components/ui';
import { t } from '../../i18n';
import { useSessionStore } from '../../stores/sessionStore';
import type { FileTokenCard } from './file-token';
import { refKindForPath } from './file-token';
import { ImageLightbox, useAttachmentPreview, useImageBlob } from './image-preview';
import { deliveryClass, imageDeliveryLabel, refDisplayName } from './MessageRefs';
import { RefIcon } from './RefIcon';

export function RefCard({ card }: { card: FileTokenCard }) {
  const kind = card.ref?.kind ?? refKindForPath(card.path);
  const name = card.ref !== undefined ? refDisplayName(card.ref) : card.name;
  // 图所属会话 = 当前转录的 detail（images.blob 可见性闸；与 ToolImageCard 同源）。
  const sessionId = useSessionStore((state) => state.detailId) ?? undefined;
  // 有 sha256（匹配到结构化 ref）走内容寻址；否则 path 寻址预览（只对图片发 RPC）。
  const sha256 = kind === 'image' ? card.ref?.sha256 : undefined;
  const blob = useImageBlob(sha256, sessionId);
  const pathPreview = useAttachmentPreview(card.path, kind === 'image' && sha256 === undefined);
  const [lightbox, setLightbox] = useState(false);
  const copyPath = useMessageCopy(t('chat.refCard.pathCopied'));

  const url = sha256 !== undefined ? blob.url : pathPreview.url;
  const loading =
    sha256 !== undefined ? blob.status === 'loading' : pathPreview.status === 'loading';
  const expired = sha256 === undefined && pathPreview.status === 'gone';
  const staging = sha256 === undefined && pathPreview.staging === true;
  const deliveryText = card.delivery !== undefined ? imageDeliveryLabel(card.delivery) : undefined;

  const onClick = () => {
    if (url !== undefined) setLightbox(true);
    else copyPath(card.path);
  };

  return (
    <CardShell className="ref-card" ariaLabel={name}>
      <button
        type="button"
        className="ref-card-row"
        title={card.path}
        aria-label={
          url !== undefined
            ? t('chat.toolImage.previewNamed', { name })
            : `${name} — ${t('chat.refCard.copyPath')}`
        }
        onClick={onClick}
      >
        {url !== undefined ? (
          <img className="ref-card-thumb" src={url} alt="" loading="lazy" decoding="async" />
        ) : loading ? (
          <span className="ref-card-thumb ref-card-thumb-loading animate-pulse" aria-busy="true">
            <span className="sr-only">{t('chat.toolImage.loading')}</span>
          </span>
        ) : (
          <span className="ref-card-icon" aria-hidden="true">
            <RefIcon kind={kind} size={18} />
          </span>
        )}
        <span className="ref-card-name">{name}</span>
        {expired && <span className="ref-card-badge is-expired">{t('chat.refCard.expired')}</span>}
        {staging && <span className="ref-card-badge is-temp">{t('chat.refCard.temporary')}</span>}
        {deliveryText !== undefined && (
          <span className={deliveryClass(card.delivery)} title={deliveryText}>
            {deliveryText}
          </span>
        )}
      </button>
      {lightbox && url !== undefined && (
        <ImageLightbox url={url} name={name} onClose={() => setLightbox(false)} />
      )}
    </CardShell>
  );
}
