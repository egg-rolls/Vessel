/**
 * 消息引用的轻量渲染（q-message-quote）：气泡上方的引用块 + 输入框顶部预览条。
 *
 * 设计口径（用户裁定「摘要不要过于厚重」）：
 * - 引用块只有「引号图标 + ≤120 字摘要」一行（最多两行，line-clamp），左侧一条
 *   竖线标明「这是引用的话」；不转载全文、不占气泡底色家族之外的视觉重量。
 * - 可跳转（有 message_id + onJump）时整块是按钮：点击滚到原消息并闪一下定位；
 *   不可跳转时是纯展示块（旧数据 / 摘要定位不到），不画假入口。
 * - 预览条（ComposerQuoteBar）多一个来源标识（用户 / 助手）与 × 取消；条身可点
 *   跳转，× 只取消引用、不清正文。
 *
 * 数据来自 `quote-ref.ts` 的信封解析（历史 / 实时 / 待发送气泡同一份），
 * 或草稿槽的 `ComposerQuote`（预览条）。
 *
 * @module web/chat/QuoteBlock
 */

import { cn } from '../../components/ui/cn';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n';
import type { ComposerQuote } from '../../stores/composerDraftStore';

/**
 * 已发消息上方的引用块（user / assistant 同形）。
 * `messageId` / `onJump` 缺一即纯展示（不跳转）。
 */
export function QuoteBlock({
  messageId,
  snippet,
  onJump,
  className,
}: {
  messageId?: string;
  snippet: string;
  onJump?: (messageId: string) => void;
  className?: string;
}) {
  const jumpable = messageId !== undefined && onJump !== undefined;
  const inner = (
    <>
      <span className="msg-quote-icon" aria-hidden="true">
        <Icon name="quote" size={11} />
      </span>
      <span className="msg-quote-snippet">{snippet}</span>
    </>
  );
  if (jumpable) {
    return (
      <button
        type="button"
        className={cn('msg-quote msg-quote-jump', className)}
        title={t('chat.quote.jump')}
        aria-label={t('chat.quote.jump')}
        onClick={() => {
          if (messageId !== undefined) onJump?.(messageId);
        }}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={cn('msg-quote', className)}>
      <span className="sr-only">{t('chat.quote.label')}</span>
      {inner}
    </div>
  );
}

/**
 * 输入框顶部的引用预览条：来源标识 + 摘要 + × 取消。
 * 条身可点跳转（有目标时）；× 是独立按钮，不冒泡成跳转。
 */
export function ComposerQuoteBar({
  quote,
  onRemove,
  onJump,
}: {
  quote: ComposerQuote;
  onRemove: () => void;
  onJump?: (messageId: string) => void;
}) {
  const jumpable = quote.messageId !== undefined && onJump !== undefined;
  const sourceLabel =
    quote.source === 'user' ? t('chat.quote.source.user') : t('chat.quote.source.assistant');
  return (
    <div className="composer-quote-bar">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 条身点击跳转是鼠标便捷入口；键盘流走 × 与输入框，跳转不是必需动作 */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 同上：预览条不是可聚焦控件，键盘等价路径不存在（跳转是增强） */}
      <div
        className={cn('composer-quote-body', jumpable && 'composer-quote-jump')}
        title={jumpable ? t('chat.quote.jump') : undefined}
        onClick={
          jumpable
            ? () => {
                if (quote.messageId !== undefined) onJump?.(quote.messageId);
              }
            : undefined
        }
      >
        <span className="msg-quote-icon" aria-hidden="true">
          <Icon name="quote" size={11} />
        </span>
        <span className="composer-quote-source">{sourceLabel}</span>
        <span className="composer-quote-snippet">{quote.snippet}</span>
      </div>
      <button
        type="button"
        className="composer-quote-remove"
        onClick={onRemove}
        aria-label={t('chat.quote.remove')}
        title={t('chat.quote.remove')}
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
    </div>
  );
}
