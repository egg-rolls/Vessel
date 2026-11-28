/**
 * 工具图片卡（q-media-image-card）：media `action=view` 注入消息的结构化呈现。
 *
 * 替代原始「[tool image] … delivery facts」文本 dump。图片内嵌气泡精炼 P-B：
 * 图条目换 InlineRefChip（与用户气泡内联 chip / 助手 vessel-ref 同形）——
 * 取值 / 点击 / 放大 / 懒加载全走共享逻辑体（useRefPreview + useInView），
 * 不再各持一份 RefCardRow 接线；投递 chip / 字节元信息不吞（titleMeta）。
 * 原始注记收进折叠区（裁示②：保留折叠，原文不丢可查；零模型侧变化）。
 *
 * 复用体系（用户裁定「卡片可复用更好」）：
 * - 表面 = CardShell（与 AsyncJobCard / 未来工具卡同一基座）；
 * - 图条目 = InlineRefChip（同形 chip；放大 = ImageLightbox 带路径行 + 复制）；
 * - 状态 chip = MessageRefs 的 imageDeliveryLabel / deliveryClass（同一份文案与配色）；
 * - 非图片引用 = MessageRefs 原样（零回归）。
 *
 * 模型侧投递一个字不改：本卡只是那条注入消息的**渲染层**；字节经 `images.blob`
 * （内容寻址只读）来，拿不到时退回纯元数据 —— 不显示破图，不声称「模型看到了」。
 */
import { CardShell } from '../../components/ui';
import { formatBytes, formatClock } from '../../format';
import type { ImageDelivery, MessageRef } from '../../gateway/types';
import { t } from '../../i18n';
import { occurrenceKeys } from '../../text';
import { InlineRefChip } from './InlineRefChip';
import { MessageRefs, refDisplayName } from './MessageRefs';
import { RefIcon } from './RefIcon';

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
      <div className="flex flex-wrap items-center gap-1.5">
        {images.map((ref, index) => {
          const delivery = imageDelivery !== undefined ? imageDelivery[imageIndex++] : undefined;
          const bytesText = formatBytes(ref.bytes);
          return (
            <InlineRefChip
              key={keys[index] ?? `${ref.path}#${index}`}
              card={{
                name: refDisplayName(ref),
                path: ref.path,
                ref,
                ...(delivery !== undefined ? { delivery } : {}),
              }}
              {...(bytesText !== '' ? { titleMeta: bytesText } : {})}
            />
          );
        })}
      </div>
      {others.length > 0 && <MessageRefs refs={others} />}
      {/* 原始注记：默认折叠（冗长文本不再 dump），展开逐字可查。 */}
      <details className="tool-image-raw">
        <summary className="cursor-pointer text-2xs text-faint">{t('chat.toolImage.raw')}</summary>
        <pre className="m-0 mt-1 whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-faint">
          {note}
        </pre>
      </details>
    </CardShell>
  );
}
