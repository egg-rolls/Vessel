/**
 * 思考过程块（唯一实现）：运行态（流式）与终止态（历史回填）共用。
 *
 * 以前只有运行态能渲染 reasoning_delta 拼出来的思考块，sessions.get 回填的历史消息
 * 里同样持久化着 `reasoning_content`，却没有入口渲染 —— 同一轮对话「跑的时候能看到
 * 思考、结束后消失」。这里把块独立出来，两边都用它，而不是各写一份。
 *
 * 约定沿用 live：
 * - 流式期间默认展开，结束后自动折叠；用户手动开合后不再被自动开合打断；
 * - 内容按纯文本渲染，不进入正文 Markdown；
 * - `startedAt` / `endedAt` 齐全时标题显示耗时（历史消息没有这两项，就不显示）。
 */
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import { t } from '../../i18n';

const PREVIEW_LINES = 12;

export function ReasoningBlock({
  text,
  streaming,
  startedAt,
  endedAt,
}: {
  text: string;
  streaming: boolean;
  startedAt?: number;
  endedAt?: number;
}) {
  const [open, setOpen] = useState(streaming);
  const [userToggled, setUserToggled] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!userToggled) setOpen(streaming);
  }, [streaming, userToggled]);

  const lines = text.split('\n');
  const clamped = lines.slice(0, PREVIEW_LINES).join('\n');
  const clampedVisible = !showAll && lines.length > PREVIEW_LINES;
  const seconds =
    startedAt !== undefined && endedAt !== undefined && endedAt > startedAt
      ? Math.max(1, Math.round((endedAt - startedAt) / 1000))
      : undefined;

  return (
    <details
      className="reasoning-block"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === open) return;
        setUserToggled(true);
        setOpen(next);
      }}
    >
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-sm text-faint hover:text-muted">
        {t('chat.reasoning.summary')}
        {seconds !== undefined ? ` · ${seconds}s` : ''}
        {streaming ? (
          <span className="reasoning-live text-info"> · {t('chat.reasoning.live')}</span>
        ) : null}
      </summary>
      <div className="px-2.5 py-2 text-md leading-relaxed whitespace-pre-wrap wrap-anywhere">
        {clampedVisible ? clamped : text}
      </div>
      {lines.length > PREVIEW_LINES && (
        <Button
          variant="link"
          className="mx-2.5 mb-2 text-xs"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? t('chat.reasoning.collapse') : t('chat.reasoning.expand')}
        </Button>
      )}
    </details>
  );
}
