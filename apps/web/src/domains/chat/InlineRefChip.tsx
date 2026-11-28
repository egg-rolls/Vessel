/**
 * 气泡内内联文件 chip（图片内嵌气泡精炼 D2）：text-height 行内形态，照
 * composer FileRefCard 落定态（1em 缩略图 / 种类 ICON + 文件名 + 临时 / 过期
 * 徽标 + 投递 chip；hover 全路径）。历史只读 ⇒ 无 ×删除。
 *
 * 复用不另造：取值 / 点击 = useRefPreview（RefCard 同一逻辑体）；放大 =
 * ImageLightbox（带完整路径行 + 复制 + 临时徽标，与 composer 弹窗同形）；
 * 图标 = RefIcon；投递 chip = MessageRefs 同一份文案 / 配色。
 *
 * 承重验收点：useInView 懒加载门 —— 进入视口（含预热带）才探预览 / 取字节；
 * 同 path 重复请求由 attachment-preview-cache / image-blob-cache 去重。
 */
import { t } from '../../i18n';
import type { FileTokenCard } from './file-token';
import { ImageLightbox } from './image-preview';
import { deliveryClass } from './MessageRefs';
import { RefIcon } from './RefIcon';
import { useInView } from './use-in-view';
import { useRefPreview } from './use-ref-preview';

export function InlineRefChip({ card }: { card: FileTokenCard }) {
  const { ref, inView } = useInView<HTMLSpanElement>();
  const preview = useRefPreview(card, inView);
  const { kind, name, url, loading, expired, staging, deliveryText, onClick } = preview;

  return (
    <span
      ref={ref}
      className={`inline-ref-chip${expired ? ' is-expired' : ''}`}
      data-kind={kind}
      data-path={card.path}
    >
      <button
        type="button"
        className="inline-ref-chip-body"
        title={card.path}
        aria-label={
          url !== undefined
            ? t('chat.toolImage.previewNamed', { name })
            : `${name} — ${t('chat.refCard.copyPath')}`
        }
        onClick={onClick}
      >
        {url !== undefined ? (
          <img className="inline-ref-thumb" src={url} alt="" loading="lazy" decoding="async" />
        ) : loading ? (
          <span className="inline-ref-thumb inline-ref-thumb-loading animate-pulse" aria-busy="true">
            <span className="sr-only">{t('chat.toolImage.loading')}</span>
          </span>
        ) : (
          <span className="inline-ref-icon" aria-hidden="true">
            <RefIcon kind={kind} size={12} />
          </span>
        )}
        <span className="inline-ref-name">{name}</span>
        {expired && <span className="ref-card-badge is-expired">{t('chat.refCard.expired')}</span>}
        {staging && <span className="ref-card-badge is-temp">{t('chat.refCard.temporary')}</span>}
        {deliveryText !== undefined && (
          <span className={deliveryClass(card.delivery)} title={deliveryText}>
            {deliveryText}
          </span>
        )}
      </button>
      {preview.lightbox && url !== undefined && (
        <ImageLightbox
          url={url}
          name={name}
          onClose={preview.closeLightbox}
          path={card.path}
          staging={staging}
        />
      )}
    </span>
  );
}
