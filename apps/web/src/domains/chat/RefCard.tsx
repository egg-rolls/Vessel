/**
 * 统一文件卡（q-block-cardshell-unify，用户新 UI 方向③）：CardShell 表面 +
 * 左 ICON 槽右一行文字槽。图片缩略图进 ICON 槽 + 文件名；PDF / 其他文件换
 * RefIcon 图标；点击统一走既有 ImageLightbox（图片有字节时）/ 复制路径
 * （无字节可预览时，与插件 FileRefLinkCard 同一语义，绝不导航）。
 * q-pdf-preview-channel：PDF 点击 = 懒取字节开宿主 PdfLightbox（原生查看器）；
 * 字节不可用回落复制路径（图片卡路径不动）。
 *
 * 复用体系（不另造壳 / 预览 / 取值）：
 * - 表面 = CardShell（与 ToolImageCard 同一基座）；
 * - 取值 = image-preview 的 useImageBlob（sha256 寻址，匹配到结构化 ref 时）
 *   与 useAttachmentPreview（path 寻址，无 ref 的正文 token）—— 两 RPC 语义
 *   不同不合并（设计稿 §2.6）；
 * - 放大 = ImageLightbox（ModalShell 既有 a11y）；
 * - 图标 = RefIcon（宿主唯一实现）；投递 chip = MessageRefs 同一份文案 / 配色。
 *
 * `RefCardRow` 是共享的「ICON 槽 + 一行文字槽」行（ToolImageCard 的图条目
 * 收敛到同一行形）；`RefCard` = CardShell + RefCardRow + Lightbox 接线。
 * 形态照 FileRefLinkCard（单 button 行），表面统一 CardShell —— 插件 bundle
 * 零改动。
 */
import { type ReactNode, useContext, useState } from 'react';
import { CardShell, useMessageCopy } from '../../components/ui';
import { ConnectionContext } from '../../gateway/connection-context';
import type { MessageRefKind } from '../../gateway/types';
import { t } from '../../i18n';
import { useSessionStore } from '../../stores/sessionStore';
import { openAttachmentPreview } from './attachment-lightbox';
import type { FileTokenCard } from './file-token';
import { isPdfPath, refKindForPath } from './file-token';
import { ImageLightbox, useAttachmentPreview, useImageBlob } from './image-preview';
import { deliveryClass, imageDeliveryLabel, refDisplayName } from './MessageRefs';
import { RefIcon } from './RefIcon';

/**
 * 共享行：左 ICON 槽（缩略图 / 加载骨架 / 种类图标）+ 右一行文件名 + 尾部
 * 徽标 / chip 槽。单 button（整行可点）；缩略图是裸 img（不嵌套 button）。
 */
export function RefCardRow({
  url,
  loading = false,
  kind,
  name,
  title,
  ariaLabel,
  onClick,
  trailing,
}: {
  /** 缩略图 data URL（ready 时有；缺省画图标 / 骨架）。 */
  url?: string;
  loading?: boolean;
  kind: MessageRefKind;
  name: string;
  /** hover 全路径（+ 元信息）。 */
  title: string;
  ariaLabel: string;
  onClick: () => void;
  /** 尾部槽：过期 / 临时徽标、投递 chip 等（调用方组织）。 */
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      className="ref-card-row"
      title={title}
      aria-label={ariaLabel}
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
      {trailing}
    </button>
  );
}

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
  // PDF（q-pdf-preview-channel）：点击才取字节（无缩略图可画，不预取）；
  // 走与插件 openPreview 同一共享接缝，弹窗 = App 根单例 PdfLightbox。
  const connection = useContext(ConnectionContext);
  const client = connection?.client;
  const isPdf = kind !== 'image' && isPdfPath(card.path);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfExpired, setPdfExpired] = useState(false);

  const url = sha256 !== undefined ? blob.url : pathPreview.url;
  const loading =
    (sha256 !== undefined ? blob.status === 'loading' : pathPreview.status === 'loading') ||
    pdfLoading;
  const expired = (sha256 === undefined && pathPreview.status === 'gone') || pdfExpired;
  const staging = sha256 === undefined && pathPreview.staging === true;
  const deliveryText = card.delivery !== undefined ? imageDeliveryLabel(card.delivery) : undefined;

  const onClick = () => {
    if (url !== undefined) {
      setLightbox(true);
      return;
    }
    if (isPdf && client !== undefined && !pdfLoading && !pdfExpired) {
      setPdfLoading(true);
      void openAttachmentPreview(client, card.path)
        .catch((error: unknown) => {
          // gone ⇒ 过期态；其余不可用（denied / too_large / 旧 gateway）⇒
          // 回落既有复制路径契约（诚实降级，绝不导航）。
          if (error instanceof Error && error.message.endsWith(': gone')) setPdfExpired(true);
          else copyPath(card.path);
        })
        .finally(() => {
          setPdfLoading(false);
        });
      return;
    }
    copyPath(card.path);
  };

  return (
    <CardShell className="ref-card" ariaLabel={name}>
      <RefCardRow
        url={url}
        loading={loading}
        kind={kind}
        name={name}
        title={card.path}
        ariaLabel={
          url !== undefined
            ? t('chat.toolImage.previewNamed', { name })
            : isPdf && !expired
              ? t('chat.pdf.previewNamed', { name })
              : `${name} — ${t('chat.refCard.copyPath')}`
        }
        onClick={onClick}
        trailing={
          <>
            {expired && (
              <span className="ref-card-badge is-expired">{t('chat.refCard.expired')}</span>
            )}
            {staging && (
              <span className="ref-card-badge is-temp">{t('chat.refCard.temporary')}</span>
            )}
            {deliveryText !== undefined && (
              <span className={deliveryClass(card.delivery)} title={deliveryText}>
                {deliveryText}
              </span>
            )}
          </>
        }
      />
      {lightbox && url !== undefined && (
        <ImageLightbox url={url} name={name} onClose={() => setLightbox(false)} />
      )}
    </CardShell>
  );
}
