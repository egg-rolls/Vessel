import { t } from '../../i18n';

/**
 * Draft 欢迎页（0.18）：品牌 + 一句问题，居中于消息流、位于 Composer 之上。
 *
 * 不用 `EmptyState` 卡片，也不提供示例 prompt 按钮——首条消息由用户自己写。
 */
export function ChatWelcome() {
  return (
    <div className="chat-welcome">
      <div className="chat-welcome-inner">
        <p className="chat-welcome-brand">{t('chat.welcome.brand')}</p>
        <p className="chat-welcome-question">{t('chat.welcome.question')}</p>
      </div>
    </div>
  );
}
