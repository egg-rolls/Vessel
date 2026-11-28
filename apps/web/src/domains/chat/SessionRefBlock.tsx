/**
 * 会话引用块的渲染（块 P0 display lift，修与 quote 的不对称）。
 *
 * 历史消息正文开头的 `[引用会话]` / `[Referenced sessions]` 信封（session-ref.ts
 * compose 侧产物）以前按原文渲染：不可点、看不出是引用。这里提升成**静态卡**
 * （CardShell 基座，与 ToolImageCard / AsyncJobCard 同一表面 token）：
 * - 卡头 = 图标 + 「引用会话」标签（i18n 既有键，不新增文案）；
 * - 每条 chip 一行：会话名 + 徽章（agent / 团队 / 节点，信封里带什么显什么 ——
 *   发送恒带全量，披露降噪只属于输入框 chip）；悬浮给完整基础链 + session_id；
 * - 整行是深链（`#/chat/<session_id>`）：点击打开那个会话。目标会话不在当前
 *   gateway 可见范围时由聊天视图既有的「会话不存在」路径兜底 —— 链接指向信封里
 *   真实写着的地址，不画假入口，也不猜可达性。
 *
 * 数据来自 `session-ref.ts#parseSessionRefEnvelope`（zh/en 双词 legacy 必认）；
 * 解析失败一律原文渲染（零回归），本组件不接半截信封。
 */
import { formatRoute } from '../../app/router';
import { CardShell } from '../../components/ui';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n';
import {
  type SessionRefChip,
  sessionRefBadges,
  sessionRefDescription,
} from './session-ref';

export function SessionRefBlock({
  chips,
  className,
}: {
  chips: readonly SessionRefChip[];
  className?: string;
}) {
  if (chips.length === 0) return null;
  return (
    <CardShell className={className} ariaLabel={t('chat.sessionRef.header')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
          <span aria-hidden="true" className="inline-flex text-faint">
            <Icon name="transcript" size={14} />
          </span>
          {t('chat.sessionRef.header')}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {chips.map((chip) => (
          <a
            key={chip.sessionId}
            href={formatRoute({ domain: 'chat', sessionId: chip.sessionId })}
            className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            title={sessionRefDescription(chip)}
          >
            <span className="min-w-0 truncate font-medium text-ink">{chip.title}</span>
            {sessionRefBadges(chip, undefined).map((badge) => (
              <span
                key={badge}
                className="rounded bg-sunken px-1.5 py-0.5 font-mono text-2xs text-faint"
              >
                {badge}
              </span>
            ))}
          </a>
        ))}
      </div>
    </CardShell>
  );
}
