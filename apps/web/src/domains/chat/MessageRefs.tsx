// biome-ignore-all lint/a11y/noSvgWithoutTitle: decorative icons are marked aria-hidden
import type { ImageDelivery, MessageRef } from '../../gateway/types';
import { t } from '../../i18n';
import { occurrenceKeys } from '../../text';
import { RefIcon } from './RefIcon';

/**
 * 附件引用的一行 chip（输入框上方 / 已发消息上方共用）。
 *
 * 只有**路径**：组件不读文件、不请求解析、不显示任何正文，也不判断路径存在性。
 * 全路径只放在 `title` 里（hover 可见），列表里显示文件名。
 */
export function refDisplayName(ref: MessageRef): string {
  const named = ref.name?.trim();
  if (named !== undefined && named.length > 0) return named;
  // 不引入 node:path：Windows / Unix 分隔符都认。
  const parts = ref.path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? ref.path;
}

/** 引用种类文案（aria-label / 空文件名兜底用）。 */
export function refKindLabel(ref: MessageRef): string {
  switch (ref.kind) {
    case 'image':
      return t('chat.refs.kind.image');
    case 'document':
      return t('chat.refs.kind.document');
    default:
      return t('chat.refs.kind.file');
  }
}

/** 种类图标：宿主唯一实现在 RefIcon.tsx（块 P0 收编，chip 13px 默认）。 */

/**
 * 图片投递状态的文案（0.56）。
 *
 * 三态（决策 3）+ 一档「无记录」（0.56 P1）：
 * - `sent` ⇒「已发送 · <provider> · <tokens> tok」（隐私知情：图去了哪家、花了多少）；
 * - `dropped` ⇒「已丢弃 · <原因>」（预算 / 格式 / 缺 blob / 占位 / 压缩）；
 * - `not_sent` ⇒「未发送 · <原因>」（视觉被关 / 模型无视觉 / 没入池）；
 * - `unknown` ⇒「无记录」（派生覆盖不到那段历史）—— **不是**「未发送」：这两个在长会话里
 *   是完全不同的事实，把后者写成前者就是显示错误。
 *
 * 原因走闭集 `chat.refs.image.reason.*`；服务端给的是稳定短标签（`over per-request budget`
 * 这种是日志口径），**UI 一律按 code 查词**，查不到就原样显示 —— 不显示 `error` 这种
 * 不可操作的字眼（那是「状态靠猜」的反面）。
 */
export function imageDeliveryLabel(delivery: ImageDelivery | undefined): string {
  if (delivery === undefined) return t('chat.composer.sending');
  if (delivery.status === 'sent') {
    const provider = delivery.backend ?? delivery.model;
    if (provider !== undefined && delivery.tokens !== undefined) {
      return t('chat.refs.image.sent', { provider, tokens: delivery.tokens });
    }
    return t('chat.refs.image.sentPlain');
  }
  if (delivery.status === 'unknown') return t('chat.refs.image.noRecord');
  const reason = t(`chat.refs.image.reason.${reasonCodeOf(delivery.reason)}`);
  return delivery.status === 'dropped'
    ? t('chat.refs.image.dropped', { reason })
    : t('chat.refs.image.notSent', { reason });
}

/**
 * 服务端 `reason` → i18n code。
 *
 * 两个来源：`vision/plan.ts` 的 `ImageDropReason` 闭集（下划线形式）与服务端的
 * `label` 短标签（空格形式，日志口径）。这里只做「短标签 → 闭集 code」的归一，
 * 认不出就当 `unknown`（**不显示原始英文短标签**：那是给运维看的，用户看不懂）。
 */
function reasonCodeOf(reason: string | undefined): string {
  if (reason === undefined || reason.length === 0) return 'unknown';
  const normalized = reason
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'budget':
    case 'over_per_request_budget':
      return 'budget';
    case 'bytes_budget':
    case 'over_per_request_byte_budget':
      return 'bytes_budget';
    case 'unsupported_format':
      return 'unsupported_format';
    case 'not_an_image':
      return 'not_an_image';
    case 'too_large':
      return 'too_large';
    case 'blob_missing':
    case 'attachment_blob_missing':
      return 'blob_missing';
    case 'not_ingested':
      return 'not_ingested';
    case 'vision_disabled':
      return 'vision_disabled';
    case 'no_vision':
    case 'no_vision_backend':
      return 'no_vision';
    case 'placeholder':
      return 'placeholder';
    case 'compaction':
      return 'compaction';
    case 'no_delivery_event':
      return 'no_delivery_event';
    case 'no_delivery_record':
      return 'no_delivery_record';
    default:
      return 'unknown';
  }
}

/** 投递状态 → chip 的修饰类（颜色由 CSS 决定；三态各一档）。图片卡复用同一口径。 */
export function deliveryClass(delivery: ImageDelivery | undefined): string {
  if (delivery === undefined) return 'msg-ref-delivery pending';
  return `msg-ref-delivery ${delivery.status.replace('_', '-')}`;
}

/**
 * 引用 chip 行。`onRemove` 缺省即只读（已发消息一侧不传）。
 *
 * 0.56：`imageDelivery` 与 `refs` 里的 **image** 引用一一对应（同序）。给了就渲染三态；
 * 没给（输入框草稿 / 实时流的新消息）= 不渲染状态（草稿还没投递，猜「已发送」是最坏的错）。
 *
 * 缺省 / 空数组渲染 `null`（不占位、不留空行）。
 */
export function MessageRefs({
  refs,
  imageDelivery,
  onRemove,
  className = '',
}: {
  refs?: readonly MessageRef[];
  /** 每张图的投递状态（与 refs 的 image 项同序；缺省 = 不显示状态）。 */
  imageDelivery?: readonly ImageDelivery[];
  /** 传了才可删；参数是 refs 里的下标。 */
  onRemove?: (index: number) => void;
  className?: string;
}) {
  if (refs === undefined || refs.length === 0) return null;
  // key 用「同一路径的第几次引用」（宿主唯一实现 occurrenceKeys）：在渲染前建表，
  // 既不用数组下标，也不会因为同一路径被引用多次而撞 key（列表本身不排序、不重排）。
  const keys = occurrenceKeys(refs.map((ref) => ref.path));
  // 图片引用在 `refs` 里的有序位次 → 投递状态（服务端按 image 项同序下发）。
  let imageIndex = 0;
  return (
    <ul className={`msg-refs ${className}`.trim()} aria-label={t('chat.refs.label')}>
      {refs.map((ref, index) => {
        const name = refDisplayName(ref);
        const delivery =
          ref.kind === 'image' && imageDelivery !== undefined
            ? imageDelivery[imageIndex++]
            : undefined;
        const deliveryText = delivery === undefined ? undefined : imageDeliveryLabel(delivery);
        return (
          <li key={keys[index] ?? `${ref.path}#${index}`} className="msg-ref" title={ref.path}>
            <span className="msg-ref-icon" aria-hidden="true">
              <RefIcon kind={ref.kind} />
            </span>
            {/* 图标是装饰：种类以 sr-only 文本保留可访问名。 */}
            <span className="sr-only">{refKindLabel(ref)}</span>
            <span className="msg-ref-name">{name}</span>
            {deliveryText !== undefined && (
              <span className={deliveryClass(delivery)} title={deliveryText}>
                {deliveryText}
              </span>
            )}
            {onRemove !== undefined && (
              <button
                type="button"
                className="msg-ref-remove"
                onClick={() => onRemove(index)}
                aria-label={t('chat.refs.remove', { name })}
                title={t('chat.refs.remove', { name })}
              >
                <svg
                  width={11}
                  height={11}
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
                </svg>
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
