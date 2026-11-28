/**
 * 文件引用取值 / 点击逻辑体（图片内嵌气泡精炼：从 RefCard 抽出共享，不重写）。
 * RefCard（CardShell 卡形）与 InlineRefChip（气泡内 text-height chip 形）共用
 * 同一份取值 + 点击语义：
 * - 有 sha256（匹配到结构化 ref）走 useImageBlob（内容寻址，LRU 缓存）；
 *   否则 path 寻址 useAttachmentPreview（只对图片发 RPC，经预览缓存去重）——
 *   两 RPC 语义不同不合并（设计稿 §2.6）；
 * - 点击：有字节 → 开 ImageLightbox（lightbox 态在本 hook）；无字节 → 复制路径
 *   （与插件 FileRefLinkCard 同一语义，绝不导航）。
 *
 * `active=false` ⇒ 两个取值 hook 都不发 RPC（chip 视口懒加载门：进入视口才探；
 * 卡形消费点不传参，缺省 true 零回归）。
 */
import { useState } from 'react';
import { useMessageCopy } from '../../components/ui';
import type { MessageRefKind } from '../../gateway/types';
import { t } from '../../i18n';
import { useSessionStore } from '../../stores/sessionStore';
import { type FileTokenCard, refKindForPath } from './file-token';
import { useAttachmentPreview, useImageBlob } from './image-preview';
import { imageDeliveryLabel, refDisplayName } from './MessageRefs';

export interface RefPreviewState {
  kind: MessageRefKind;
  name: string;
  /** 缩略图 / 大图 data URL（ready 时有）。 */
  url?: string;
  loading: boolean;
  /** path 寻址探出 gone（暂存副本已过期）。 */
  expired: boolean;
  /** 暂存未入池（「临时」徽标）。 */
  staging: boolean;
  /** 投递状态文案（匹配 ref 带 delivery 时有）。 */
  deliveryText?: string;
  /** ImageLightbox 开合态（渲染由消费组件负责）。 */
  lightbox: boolean;
  closeLightbox: () => void;
  /** 有字节开大图，无字节复制路径。 */
  onClick: () => void;
}

export function useRefPreview(card: FileTokenCard, active = true): RefPreviewState {
  const kind = card.ref?.kind ?? refKindForPath(card.path);
  const name = card.ref !== undefined ? refDisplayName(card.ref) : card.name;
  // 图所属会话 = 当前转录的 detail（images.blob 可见性闸；与 ToolImageCard 同源）。
  const sessionId = useSessionStore((state) => state.detailId) ?? undefined;
  // 有 sha256（匹配到结构化 ref）走内容寻址；否则 path 寻址预览（只对图片发 RPC）。
  const sha256 = kind === 'image' ? card.ref?.sha256 : undefined;
  const blob = useImageBlob(sha256, sessionId, active);
  const pathPreview = useAttachmentPreview(
    card.path,
    active && kind === 'image' && sha256 === undefined,
  );
  const [lightbox, setLightbox] = useState(false);
  const copyPath = useMessageCopy(t('chat.refCard.pathCopied'));

  const url = sha256 !== undefined ? blob.url : pathPreview.url;
  const loading =
    active && (sha256 !== undefined ? blob.status === 'loading' : pathPreview.status === 'loading');
  const expired = sha256 === undefined && pathPreview.status === 'gone';
  const staging = sha256 === undefined && pathPreview.staging === true;
  const deliveryText = card.delivery !== undefined ? imageDeliveryLabel(card.delivery) : undefined;

  const onClick = () => {
    if (url !== undefined) setLightbox(true);
    else copyPath(card.path);
  };

  return {
    kind,
    name,
    url,
    loading,
    expired,
    staging,
    deliveryText,
    lightbox,
    closeLightbox: () => setLightbox(false),
    onClick,
  };
}
