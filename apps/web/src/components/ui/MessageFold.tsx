/**
 * 长消息折叠：超过阈值（`--msg-fold-max-h`）时默认收起到该高度，底部渐隐，
 * 气泡内中下侧给一个纯文字开合按钮（「展开全文 / 收起」）。
 *
 * 会话页（用户气泡 / agent 消息卡 / 助手正文）与团队页（人 / agent 气泡）共用这一个
 * 组件与同一套 `.msg-fold*` class（样式在 `styles/domains/chat.css`）—— 不要各自复制
 * 一份阈值或宽度口径。
 *
 * 三条硬约束：
 * - **复制拿全文**：折叠只改显示（max-height + overflow + mask），DOM 里始终是全文；
 *   复制按钮走的是 `message.content` / `item.text` 原文，鼠标手动选中也是同一份文本。
 * - **流式中不折**：`streaming` 期间不裁切、不出按钮 —— 否则正文每长一段就折/展一次。
 * - **溢出判定只看 `scrollHeight`**：裁切状态下它仍是内容全高，所以展开后按钮不会
 *   突然消失、也不会在展开/收起之间反复折。阈值从 CSS 变量读（唯一来源），读不到时
 *   用与 tokens.css 同值的兜底。
 *
 * 没有 ResizeObserver 时（老内核 / 测试环境）只按挂载时那一帧判定：长消息不会被裁切，
 * 这是退化不是错误 —— 绝不因为量不到就把内容锁死。
 */
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { Button } from './Button';

/** 阈值来源（tokens.css）。 */
const MAX_HEIGHT_VAR = '--msg-fold-max-h';
/** 读不到变量时的兜底：与 tokens.css 的 `--msg-fold-max-h` 同值。 */
const FALLBACK_MAX_HEIGHT = 400;
/** 亚像素容差：正好等于阈值不折。 */
const SLACK_PX = 2;

function foldMaxHeight(element: HTMLElement): number {
  const raw = getComputedStyle(element).getPropertyValue(MAX_HEIGHT_VAR).trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_MAX_HEIGHT;
}

export function MessageFold({
  children,
  streaming = false,
}: {
  /** 正文（纯文本 / Markdown，原文整段给，不要预先截断）。 */
  children: ReactNode;
  /** 流式输出中：不折叠、不出按钮（正文还在长）。 */
  streaming?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();

  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (element === null) return;
    const measure = () => {
      setOverflowing(element.scrollHeight > foldMaxHeight(element) + SLACK_PX);
    };
    // 布局阶段先量一次：长内容不会先以全文闪一帧再收起来。
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    // 内容增长（流式收尾、字体落地）与列宽变化都会改 scrollHeight，统一重测。
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 流式期间也不裁切：正文还在长，折起来会把正在读的那段藏掉。
  const clipped = overflowing && !expanded && !streaming;
  return (
    <div className="msg-fold">
      <div
        id={bodyId}
        ref={bodyRef}
        className={clipped ? 'msg-fold-body msg-fold-clipped' : 'msg-fold-body'}
      >
        {children}
      </div>
      {overflowing && !streaming && (
        <Button
          variant="link"
          className="msg-fold-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('chat.message.fold.collapse') : t('chat.message.fold.expand')}
        </Button>
      )}
    </div>
  );
}
