/**
 * 工具图片卡（q-media-image-card）：media `action=view` 注入消息的结构化呈现。
 *
 * 替代原始「[tool image] … delivery facts」文本 dump：缩略图（图片内容可见，点击
 * 放大）+ 文件名 + 尺寸（浏览器实测）+ 字节 + 投递状态 chip（复用 imageDeliveryLabel
 * 三态闭集文案，含 provider / token 成本）；原始注记收进折叠区（原文不丢，可查）。
 *
 * 复用体系（用户裁定「卡片可复用更好」）：
 * - 表面 = CardShell（与 AsyncJobCard / 未来工具卡同一基座）；
 * - 放大 = ModalShell（既有 a11y 弹窗）经 ImageLightbox；
 * - 缩略图 / 取值 = image-preview.tsx（useImageBlob + ImageThumb，LRU 缓存）；
 * - 状态 chip = MessageRefs 的 imageDeliveryLabel / deliveryClass（同一份文案与配色）；
 * - 非图片引用 = MessageRefs 原样（零回归）。
 *
 * 模型侧投递一个字不改：本卡只是那条注入消息的**渲染层**；字节经 `images.blob`
 * （内容寻址只读）来，拿不到时退回纯元数据 —— 不显示破图，不声称「模型看到了」。
 */
import { useState } from 'react';
import { CardShell } from '../../components/ui';
import { formatBytes, formatClock } from '../../format';
import type { ImageDelivery, MessageRef } from '../../gateway/types';
import { t } from '../../i18n';
import { useSessionStore } from '../../stores/sessionStore';
import { occurrenceKeys } from '../../text';
import { ImageLightbox, ImageThumb, useImageBlob } from './image-preview';
import { deliveryClass, imageDeliveryLabel, MessageRefs, refDisplayName } from './MessageRefs';
import { RefIcon } from './RefIcon';

/** 一张图：缩略图 + 文件名 + 尺寸 / 字节 + 投递 chip。 */
function ToolImageEntry({
  imageRef,
  delivery,
  sessionId,
  onOpen,
}: {
  imageRef: MessageRef;
  delivery: ImageDelivery | undefined;
  /** 图所属会话（服务端可见性闸；缺省 = 不取字节，只留元数据）。 */
  sessionId: string | undefined;
  onOpen: (url: string, name: string) => void;
}) {
  const state = useImageBlob(imageRef.sha256, sessionId);
  const name = refDisplayName(imageRef);
  const deliveryText = delivery === undefined ? undefined : imageDeliveryLabel(delivery);
  const sizeText =
    state.width !== undefined && state.height !== undefined
      ? t('chat.toolImage.dimensions', { width: state.width, height: state.height })
      : undefined;
  const bytesText = formatBytes(imageRef.bytes);
  return (
    <div className="tool-image-entry">
      <ImageThumb state={state} name={name} onOpen={(url) => onOpen(url, name)} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-mono text-xs text-ink" title={imageRef.path}>
          {name}
        </span>
        {(sizeText !== undefined || bytesText !== '') && (
          <span className="font-mono text-2xs tabular-nums text-faint">
            {sizeText !== undefined && sizeText}
            {sizeText !== undefined && bytesText !== '' && ' · '}
            {bytesText !== '' && bytesText}
          </span>
        )}
        {deliveryText !== undefined && (
          <span className={deliveryClass(delivery)} title={deliveryText}>
            {deliveryText}
          </span>
        )}
      </div>
    </div>
  );
}

export function ToolImageCard({
  refs,
  imageDelivery,
  note,
  ts,
}: {
  /** 注入消息的引用（图片为主；非图片项原样走 MessageRefs，零回归）。 */
  refs: readonly MessageRef[];
  /** 每张图的投递状态（与 refs 的 image 项同序；服务端随历史下发）。 */
  imageDelivery?: readonly ImageDelivery[];
  /** 原始注记全文（「[tool image] …」）：收进折叠区，不丢原文。 */
  note: string;
  ts?: number;
}) {
  const [lightbox, setLightbox] = useState<{ url: string; name: string } | null>(null);
  // 图所属会话 = 当前转录的那份 detail（服务端 images.blob 的可见性闸入参）。
  // 只订阅 id（原始值）：detail 刷新不重渲染本卡。
  const sessionId = useSessionStore((state) => state.detailId) ?? undefined;
  const images = refs.filter((ref) => ref.kind === 'image');
  const others = refs.filter((ref) => ref.kind !== 'image');
  const clock = formatClock(ts);
  // 投递状态按 image 项同序消费（与 MessageRefs 同一口径）。
  let imageIndex = 0;
  // key 口径与 MessageRefs 同一份实现（occurrenceKeys）。
  const keys = occurrenceKeys(images.map((ref) => ref.path));
  return (
    <CardShell className="tool-image-card" ariaLabel={t('chat.toolImage.group')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
          <RefIcon kind="image" size={14} />
          {t('chat.toolImage.title')}
        </span>
        {images.length > 1 && (
          <span className="font-mono text-2xs tabular-nums text-faint">
            {t('chat.toolImage.count', { count: images.length })}
          </span>
        )}
        {clock !== '' && (
          <span className="ml-auto font-mono text-2xs tabular-nums text-faint">{clock}</span>
        )}
      </div>
      {images.map((ref, index) => {
        const delivery = imageDelivery !== undefined ? imageDelivery[imageIndex++] : undefined;
        return (
          <ToolImageEntry
            key={keys[index] ?? `${ref.path}#${index}`}
            imageRef={ref}
            delivery={delivery}
            sessionId={sessionId}
            onOpen={(url, name) => setLightbox({ url, name })}
          />
        );
      })}
      {others.length > 0 && <MessageRefs refs={others} />}
      {/* 原始注记：默认折叠（冗长文本不再 dump），展开逐字可查。 */}
      <details className="tool-image-raw">
        <summary className="cursor-pointer text-2xs text-faint">{t('chat.toolImage.raw')}</summary>
        <pre className="m-0 mt-1 whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-faint">
          {note}
        </pre>
      </details>
      {lightbox !== null && (
        <ImageLightbox url={lightbox.url} name={lightbox.name} onClose={() => setLightbox(null)} />
      )}
    </CardShell>
  );
}
