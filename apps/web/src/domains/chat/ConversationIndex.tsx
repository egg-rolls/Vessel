/**
 * 会话索引竖条（minimap）：纯视图组件，不取数、不判可见性。
 *
 * 形态参考豆包（用户裁定）：vertical flex column，每条 entry 是一个 h-2 rounded-full
 * 的 button（常态宽 8px，高亮加宽到 16px），`data-index-entry-key` 标识对应消息；
 * 竖条自身 overflow-y-auto 且隐藏滚动条，顶底 mask 渐隐，track 首尾留白半屏
 * （让第一条 / 最后一条 dot 也能滚到竖条中央）。
 *
 * 数据与动作全部由调用方注入：
 * - `entries`：数据映射见 conversation-index.ts（item.key / message_id → entry）；
 * - `activeKey`：当前视口对应的 entry（视口追踪在集成侧，见步骤②）；
 * - `onJump`：点击 dot → 调用方负责 scrollIntoView 到对应消息 DOM。
 *
 * 组件自己只做两件「竖条内部」的事：
 * - 高亮 dot 保持在竖条视口内（只滚竖条自己，绝不带动主滚动区）；
 * - 首尾半屏留白随竖条高度动态计算（ResizeObserver）。
 * 定位（右侧 absolute / fixed、窄屏隐藏）由集成侧的 className 给，这里不写死。
 */
import { useEffect, useRef } from 'react';
import { t } from '../../i18n';
import type { ConversationIndexEntry } from './conversation-index';

/** dot 高度（与 CSS `.conversation-index-dot` 的 height 同值）：算半屏留白用。 */
const DOT_HEIGHT_PX = 8;

export function ConversationIndex({
  entries,
  activeKey = null,
  onJump,
  className,
}: {
  entries: readonly ConversationIndexEntry[];
  /** 当前视口对应的 entry key；null = 没有可高亮的（不画高亮态）。 */
  activeKey?: string | null;
  /** 点击 dot：调用方滚动到 `data-index-entry-key` 同值的消息 DOM。 */
  onJump?: (key: string) => void;
  className?: string;
}) {
  const railRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  // 首尾半屏留白：pad = (竖条视口高 - dot 高) / 2，第一条 / 最后一条 dot 恰好能居中。
  // 写在 track 的 paddingBlock 上（CSS 不写死值）；竖条高度变化（窗口 / dock）跟随重算。
  useEffect(() => {
    const rail = railRef.current;
    const track = trackRef.current;
    if (!rail || !track) return;
    const update = () => {
      const pad = Math.max(0, (rail.clientHeight - DOT_HEIGHT_PX) / 2);
      track.style.paddingBlock = `${pad}px`;
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    return () => observer.disconnect();
  }, []);

  // 高亮 dot 滚进竖条视口（居中）。只动竖条自己的 scrollTop：
  // 不用 scrollIntoView —— 它会连带滚动祖先容器，把主转录区也拽走。
  useEffect(() => {
    const rail = railRef.current;
    const track = trackRef.current;
    if (!rail || !track || activeKey === null) return;
    let dot: HTMLElement | null = null;
    for (const child of track.children) {
      const element = child as HTMLElement;
      if (element.dataset.indexEntryKey === activeKey) {
        dot = element;
        break;
      }
    }
    if (!dot) return;
    // dot.offsetTop 相对 track（position:relative）；track 是 rail 内容的首个子节点，
    // 与 rail.scrollTop 同一坐标空间。
    const top = dot.offsetTop - (rail.clientHeight - dot.offsetHeight) / 2;
    rail.scrollTo({ top });
  }, [activeKey]);

  if (entries.length === 0) return null;

  return (
    <nav
      ref={railRef}
      className={className ? `conversation-index ${className}` : 'conversation-index'}
      aria-label={t('chat.index.label')}
    >
      <div ref={trackRef} className="conversation-index-track">
        {entries.map((entry) => {
          const active = entry.key === activeKey;
          return (
            <button
              key={entry.key}
              type="button"
              className="conversation-index-dot"
              data-index-entry-key={entry.key}
              data-active={active ? 'true' : undefined}
              aria-label={entry.label}
              aria-current={active ? 'true' : undefined}
              title={entry.label}
              onClick={() => onJump?.(entry.key)}
            />
          );
        })}
      </div>
    </nav>
  );
}
