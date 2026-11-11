/**
 * 思考过程块（唯一实现）：运行态（流式）与终止态（历史回填）共用。
 *
 * 两个入口，同一个组件：
 * - 运行态：live item（run:<runId>:reasoning:<n>，以及未闭合的 liveReasoning 尾部），
 *   由 StreamItems 与 TranscriptWindow 的 renderItem 渲染（streaming 见下）；
 * - 历史态：sessions.get 回填消息自带的 `reasoning_content`，由 Transcript 里的
 *   TranscriptMessage 在该条消息正文**之前**用 streaming=false 渲染。
 *
 * 历史态不会与运行态双出：被 live 认领的 assistant 消息在建 item 流时整条丢弃
 * （transcript-items.ts 的 buildTranscriptItems 里对 claimedAssistant 的那次跳过），
 * 那条消息的思考只由 run:<runId>:reasoning:<n> 负责。
 *
 * 约定沿用 live：
 * - 流式期间默认展开，结束后自动折叠；用户手动开合后不再被自动开合打断；
 * - 历史态 streaming=false → **默认折叠**，点标题展开，没有别的东西会改写这个状态；
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
