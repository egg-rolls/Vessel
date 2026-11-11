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
 * - `startedAt` / `endedAt` 齐全时标题显示耗时（历史消息没有这两项，就不显示）；
 * - 动画（`styles/motion.css` 是唯一来源，本组件只挂 class）：
 *   入场 = `.motion-appear`（`entering`，只动透明度，只播挂载那一次），
 *   展开 / 收起 = `.motion-disclosure`（`<details>` 的尺寸过渡，原生可访问性不变）。
 *   流式期间思考文本每 flush 增长一次，但这两种动画都按「节点首次挂载 / open 变化」跑，
 *   不会跟着 delta 重播。
 *
 * 卡外还有两样东西（都在 `.reasoning-wrap` 里，**不改卡片自身的盒模型**）：
 * - `speaker`：「助手」发言人名（这一段的第一块是思考卡时才要，与历史态同一个组件）；
 * - `actions`：这一段的消息工具栏。绝对定位贴在**卡片右上角**（`.reasoning-actions`），
 *   不占垂直空间，所以 hover 出现 / 消失都不会推挤正文（布局说明见 chat.css）。
 *   有思考卡时工具条只挂在这里，调用方不再在正文下方重复一份。
 */
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import { t } from '../../i18n';

const PREVIEW_LINES = 12;

/**
 * 「助手」发言人名（唯一实现）。
 *
 * 三处共用同一份标记与字号：历史消息（`Transcript.tsx` 的 `groupStart`）、
 * live 正文（`AssistantText` 的 `speaker`）、live 思考卡（本组件的 `speaker`）。
 * 放在本文件是因为这里是依赖链的叶子：`StreamItems` 与 `Transcript` 都已经 import
 * 本文件，反过来放会形成循环导入。
 *
 * 类名照抄历史态原来那行（`mb-1.5 block font-mono text-2xs tracking-widest
 * uppercase text-faint`）：发言人头只有一种写法，不要另造一套标签或字号。
 */
export function AssistantSpeaker() {
  return (
    <div className="mb-1.5 block font-mono text-2xs tracking-widest uppercase text-faint">
      {t('chat.role.assistant')}
    </div>
  );
}

export function ReasoningBlock({
  text,
  streaming,
  startedAt,
  endedAt,
  entering = false,
  speaker = false,
  actions,
}: {
  text: string;
  streaming: boolean;
  startedAt?: number;
  endedAt?: number;
  /**
   * 本块是事件流里**新追加**的一项（不是历史回填）：首次挂载时淡入一次。
   * 判据在调用方（会话页首屏那批不算追加）；历史消息不传。
   */
  entering?: boolean;
  /**
   * 本块是这一轮助手的**第一块**：卡头上方补一行「助手」发言人名。
   * 一个 run 只出现一次（判据在调用方，与历史态的 groupStart 同一口径）。
   */
  speaker?: boolean;
  /**
   * 这一轮的消息工具栏（复制 / 重试 / 时间）。贴卡片右上角、绝对定位，**不占高度**；
   * 窄屏（≤1023px）退化成卡片下方一行（见 chat.css 的 `.reasoning-actions`）。
   */
  actions?: ReactNode;
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
    // `.reasoning-wrap` 只是定位上下文（`position: relative`）：卡片与工具条都在它里面，
    // 工具条绝对定位在右上角，因此**不参与**高度计算。`group` 让 `MessageActions` 的
    // `group-hover` 在本卡（而不是整条消息）上生效 —— live 的思考卡是顶层 item，
    // 外面没有 `.msg-assistant` 那个 group。
    <div className="reasoning-wrap group">
      {speaker && <AssistantSpeaker />}
      <details
        className={`reasoning-block motion-disclosure${entering ? ' motion-appear' : ''}`}
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
            // 同一个事实只有一个词：流式中的思考过程就是「正在思考」，与页面顶部
            // 0 内容时那行提示（`ThinkingHint`）共用同一个 i18n key。
            <span className="reasoning-live text-info"> · {t('chat.reasoning.thinking')}</span>
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
      {/* 工具条在 `<details>` 之后：窄屏退化（`position: static`）时它就是卡片下方那一行，
          宽屏时被绝对定位吸到卡头右侧 —— DOM 顺序不随断点变，键盘 Tab 顺序才稳定。 */}
      {actions !== undefined && <div className="reasoning-actions">{actions}</div>}
    </div>
  );
}
