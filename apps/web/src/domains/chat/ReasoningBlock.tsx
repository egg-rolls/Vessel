/**
 * 思考过程块（唯一实现）：运行态（流式）与终止态（历史回填）共用。
 *
 * 两个入口，同一个组件：
 * - 运行态：live item（run:<runId>:reasoning:<n>，以及未闭合的 liveReasoning 尾部），
 *   由 StreamItems 与 TranscriptWindow 的 renderItem 渲染（streaming 见下）；
 * - 历史态：sessions.get 回填消息自带的 `reasoning_content`，由 Transcript 里的
 *   TranscriptMessage 在该条消息正文**之前**用 streaming=false 渲染。
 *
 * 历史态不会与运行态双出：被 live 认领的 assistant 消息**照常保留**（位置 / key /
 * 操作按钮以历史为准，见 transcript-items.ts 的 claimedTexts），让位的是 live 侧
 * 同文段的 `run-text` / `run-reasoning` item —— 那段思考由这条消息自己的卡负责。
 *
 * 约定沿用 live：
 * - 流式期间默认展开，结束后自动折叠；用户手动开合后不再被自动开合打断；
 * - 历史态 streaming=false → **默认折叠**，点标题展开，没有别的东西会改写这个状态；
 * - 内容按纯文本渲染，不进入正文 Markdown；
 * - **卡头不显示时间 / 耗时**：时间只属于正文内容块（`MessageActions` 的 `meta`），
 *   思考卡的卡头只有标题 + 流式时的「正在思考」小字；
 * - 动画（`styles/motion.css` 是唯一来源，本组件只挂 class）：
 *   入场 = `.motion-appear`（`entering`，只动透明度，只播挂载那一次），
 *   展开 / 收起 = `.motion-disclosure`（`<details>` 的尺寸过渡，原生可访问性不变）。
 *   流式期间思考文本每 flush 增长一次，但这两种动画都按「节点首次挂载 / open 变化」跑，
 *   不会跟着 delta 重播。
 *
 * 卡外还有一样东西：
 * - `speaker`：「助手」发言人名（这一段的第一块是思考卡时才要，与历史态同一个组件）。
 *
 * 卡片自己只有一个动作：卡头（`<summary>`）**左侧**、紧跟标题文字的**「复制思考」小按钮**，
 * 复制的是本卡的思考原文（不是整条消息）。**卡上不挂消息工具栏**（复制正文 / 重试 / 时间
 * 那一组在正文下方一行，见 chat.css 的工具栏说明）—— 用户明确要求「去掉思考过程加的那个
 * 工具栏」，所以这个按钮不是工具栏，只是卡自己的一个小控件，常显、可键盘聚焦。
 *
 * 点击细节：它在 `<summary>` 里，而点 summary 默认会开合卡片 —— 复制按钮必须
 * `preventDefault()` + `stopPropagation()` 把这次点击吃掉，否则「复制」会顺手把卡
 * 收起来。键盘 Enter / Space 触发的 click 走同一条处理，所以键盘也安全。
 */
import { useEffect, useState } from 'react';
import { IconButton } from '../../components/Tooltip';
import { Button, Icon, useMessageCopy } from '../../components/ui';
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

/**
 * 「这里有没有思考卡」的唯一判据（历史消息与 live item 共用这一份）。
 *
 * - 历史消息：思考挂在消息自己身上（`reasoning_content`），空串 / 全空白等于没有卡；
 * - 运行态：思考是**独立的 `run-reasoning` item**，判的是该 run 有没有这样的 item。
 *
 * 门槛只有一条：**有非空白的思考文本**。`historyReasoning`（Transcript.tsx）与
 * 本组件的「复制思考」按钮都过这一道，所以「有没有卡」只有一个答案。
 */
export function hasReasoningCard(text: string | undefined): text is string {
  return typeof text === 'string' && text.trim().length > 0;
}

export function ReasoningBlock({
  text,
  streaming,
  entering = false,
  speaker = false,
}: {
  text: string;
  streaming: boolean;
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
}) {
  const [open, setOpen] = useState(streaming);
  const [userToggled, setUserToggled] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const copy = useMessageCopy(t('chat.reasoning.copied'));

  useEffect(() => {
    if (!userToggled) setOpen(streaming);
  }, [streaming, userToggled]);

  const lines = text.split('\n');
  const clamped = lines.slice(0, PREVIEW_LINES).join('\n');
  const clampedVisible = !showAll && lines.length > PREVIEW_LINES;
  const copyable = hasReasoningCard(text);

  return (
    // 一层无样式的 div 只为「发言人名 + 卡片」还在一起（调用方按 flex 列排 item，
    // 拆成两个兄弟节点会被列间距分开）。卡上没有任何绝对定位覆盖层，也不需要
    // `position: relative` 的定位上下文。
    <div>
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
        {/* 卡头**不显示时间**（用户要求：时间只属于正文内容块，见 MessageActions 的 meta）。
            因此这里没有耗时秒数，也没有 `<time>`。 */}
        <summary className="cursor-pointer select-none px-2.5 py-1.5 text-sm text-faint hover:text-muted">
          {t('chat.reasoning.summary')}
          {streaming ? (
            // 同一个事实只有一个词：流式中的思考过程就是「正在思考」，与页面顶部
            // 0 内容时那行提示（`ThinkingHint`）共用同一个 i18n key。
            <span className="reasoning-live text-info"> · {t('chat.reasoning.thinking')}</span>
          ) : null}
          {/* 「复制思考」：卡头**左侧**、跟在标题文字（流式时含「正在思考」小字）之后 ——
              用户要它跟标题同一行左起，不贴右、也不浮动。`IconButton` 本身就是
              inline-flex，放进 summary 的行内流即可，**summary 保持原生 list-item**
              （展开三角还在，不拆成 flex / 不额外包壳）。`align-middle` 让它与标题文字
              垂直居中，`ml-1` 是它与文字的间距。 */}
          {copyable && (
            <IconButton
              className="ml-1 size-5 align-middle"
              label={t('chat.reasoning.copy')}
              onClick={(event) => {
                // 卡头是 `<summary>`：点击默认会开合卡片。复制必须自己吃掉这次点击，
                // 否则按一下复制就把卡收起来了（键盘 Enter / Space 也走这条路径）。
                event.preventDefault();
                event.stopPropagation();
                copy(text);
              }}
            >
              <Icon name="copy" size={13} />
            </IconButton>
          )}
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
    </div>
  );
}
