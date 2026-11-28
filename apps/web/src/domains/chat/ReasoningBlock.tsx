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
 * - 卡头**一行、全部左对齐**：标题（流式时带「正在思考」）→ 复制按钮 → 这一段的时刻
 *   （`time`，`formatClock` 到分钟）。复制与时刻**静止时不显示**，只在 hover 卡头 /
 *   键盘聚焦（`focus-within`）/ 触屏（`pointer-coarse`）时出现 —— 与正文下方
 *   `MessageActions` 工具栏同一套显隐语言（显隐实现见 `.reasoning-actions`，chat.css）。
 *   有思考卡的那一轮，消息时间就只在这里出现 —— 正文下方的 `MessageActions`
 *   不再重复渲染（判据在调用方，见 `Transcript.tsx` 与
 *   `TranscriptWindow.tsx` 的「按 run 汇总」）；
 * - 动画（`styles/motion.css` 是唯一来源，本组件只挂 class）：
 *   入场 = `.motion-appear`（`entering`，只动透明度，只播挂载那一次），
 *   展开 / 收起 = `.motion-disclosure`（`<details>` 的尺寸过渡，原生可访问性不变）。
 *   流式期间思考文本经 `useTypewriterText` 缓冲 reveal（豆包式 rAF 匀速吐字，A）：
 *   到达节奏（50ms 合批）与渲染节拍解耦；入场 / 开合两种动画仍按「节点首次挂载 /
 *   open 变化」跑，不会跟着 delta 重播。
 *
 * 卡外没有别的东西（「助手」发言人名已按用户要求移除：它不提供信息）。
 *
 * 卡头近端动作组（q-tool-card-slot P1a，裁示③）：复用 `MessageActions`（与正文下方
 * 远端工具栏同一组件）——**单复制 + 动作菜单**（有正文可复制时点复制开菜单「复制思考 /
 * 复制正文」，ActionMenu 复用既有行级菜单形态）+ 调用方上移的 quote / retry。
 * 有思考卡的消息，正文下方远端 `MessageActions` **整组不渲染**（判据在调用方
 * Transcript）；无卡消息逐字不变。live 侧 P1b 跟进（缺省 actions/onCopyBody = 只有
 * 复制思考，旧行为）。时间仍在近端动作组右侧，同一容器 hover 显现，键盘可达。
 *
 * 点击细节：动作组在 `<summary>` 里，而点 summary 默认会开合卡片 —— 近端容器统一
 * `preventDefault()` + `stopPropagation()` 把点击吃掉（菜单项 onSelect 在自己的
 * onClick 里已执行），否则「复制」会顺手把卡收起来。键盘 Enter / Space 触发的 click
 * 走同一条处理，所以键盘也安全。
 */
import { useEffect, useState } from 'react';
import {
  Button,
  type MessageAction,
  MessageActions,
  useMessageCopy,
  useTypewriterText,
} from '../../components/ui';
import { formatClock } from '../../format';
import { t } from '../../i18n';

const PREVIEW_LINES = 12;

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
  time,
  actions,
  onCopyBody,
}: {
  text: string;
  streaming: boolean;
  /**
   * 本块是事件流里**新追加**的一项（不是历史回填）：首次挂载时淡入一次。
   * 判据在调用方（会话页首屏那批不算追加）；历史消息不传。
   */
  entering?: boolean;
  /**
   * 这一段的时刻（ms）：`formatClock` 到分钟，渲染在卡头**复制按钮右边**（与复制按钮
   * 同属 hover 显现的操作组，静止时不显示）。
   * live 给 `run-reasoning` item 的 `startedAt`（这一段自己的首条 delta 时间，也是
   * 排序依据，只读），历史给该消息的 `timestamp`。缺省 / 非法时间不渲染时钟。
   */
  time?: number;
  /**
   * 近端附加动作（q-tool-card-slot P1a 裁示③）：quote / retry 从正文下方远端工具栏
   * 上移到卡头近端，与复制同组（复用 MessageActions）。有思考卡的消息远端整组不渲染
   * （判据在调用方 Transcript）；live 侧 P1b 跟进，缺省 = 只有复制（旧行为）。
   */
  actions?: readonly MessageAction[];
  /**
   * 复制正文（单复制 + 动作菜单，裁示③）：给了它，复制按钮点开菜单
   * 「复制思考 / 复制正文」；缺省 = 直接复制思考（live 流式 / 无正文消息）。
   */
  onCopyBody?: () => void;
}) {
  const [open, setOpen] = useState(streaming);
  const [userToggled, setUserToggled] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const copy = useMessageCopy(t('chat.reasoning.copied'));

  useEffect(() => {
    if (!userToggled) setOpen(streaming);
  }, [streaming, userToggled]);

  // 打字机 reveal（流式平滑化 A，豆包式缓冲 + rAF 匀速吐字）：思考卡是纯文本，
  // 无 markdown parse 成本，先行逐字释放；上游 50ms 合批的到达节奏与渲染节拍解耦。
  // 非流式 / reduced-motion 直通全文；复制按钮复制的仍是完整原文（不是 reveal 前缀）。
  const revealed = useTypewriterText(text, streaming);
  const lines = revealed.split('\n');
  const clamped = lines.slice(0, PREVIEW_LINES).join('\n');
  const clampedVisible = !showAll && lines.length > PREVIEW_LINES;
  const copyable = hasReasoningCard(text);
  const clock = formatClock(time);
  // 近端动作组（裁示③）：单复制（有正文 ⇒ 菜单「复制思考 / 复制正文」）+ quote / retry
  // （调用方上移）。复用 MessageActions —— 与远端工具栏同一组件 / 同一显隐语言。
  const nearActions: MessageAction[] = [];
  if (copyable) {
    nearActions.push(
      onCopyBody !== undefined
        ? {
            id: 'copy',
            label: t('chat.message.copy'),
            onSelect: () => copy(text),
            menu: [
              {
                id: 'copy-reasoning',
                label: t('chat.reasoning.copy'),
                onSelect: () => copy(text),
              },
              { id: 'copy-body', label: t('chat.reasoning.copyBody'), onSelect: onCopyBody },
            ],
          }
        : { id: 'copy', label: t('chat.reasoning.copy'), onSelect: () => copy(text) },
    );
  }
  if (actions !== undefined) nearActions.push(...actions);

  return (
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
      {/* 卡头元素顺序（从左到右）：标题（流式时带「正在思考」）→ 复制按钮 → 时间，
          三者都在 `<summary>` 的行内流里、全部左对齐。不加任何「靠右」的排法
          （既不 float 也不 ml-auto —— 见 chat.css 的说明）。
          `<summary>` 必须保持原生 `display: list-item`：改成 flex 容器会让
          Chromium / WebKit 丢掉 `::marker` 展开三角。 */}
      <summary className="group cursor-pointer select-none px-2.5 py-1.5 text-sm text-faint hover:text-muted">
        {t('chat.reasoning.summary')}
        {streaming ? (
          // 同一个事实只有一个词：流式中的思考过程就是「正在思考」，与页面顶部
          // 0 内容时那行提示（`ThinkingHint`）共用同一个 i18n key。
          <span className="reasoning-live text-info"> · {t('chat.reasoning.thinking')}</span>
        ) : null}
        {/* 复制按钮 + 时间：**同一个容器**（`.reasoning-actions`），显隐只切 opacity
            —— 容器始终占着行内宽度，出现 / 消失时卡头不位移（`display: none` 会让
            后半行重排，抖）。触发条件三条，与正文下方 `MessageActions` 同源：
            hover 卡头（`summary` 上的 `group`）/ 键盘 `focus-within` / 触屏常显
            （`pointer-coarse`）。过渡时长在 chat.css 用 `--motion-fast` 给。
            间距：容器 `ml-1` 与标题隔开，容器内 `gap-1` 隔开复制与时间。 */}
        {(nearActions.length > 0 || clock !== '') && (
          // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 容器不是交互面：交互全在内部按钮（自带键盘可达）；这里的 onClick 只取消 <summary> 默认开合（preventDefault），不产生新交互，键盘激活按钮派发的 click 同路取消。
          <span
            className="reasoning-actions ml-1 inline-flex items-center gap-1 align-middle opacity-0 group-hover:opacity-100 group-has-[button:focus-visible]:opacity-100 pointer-coarse:opacity-100"
            onClick={(event) => {
              // 卡头是 `<summary>`：点击默认会开合卡片。近端动作组（复制菜单 /
              // quote / retry）必须自己吃掉这次点击，否则按一下就把卡收起来了
              // （键盘 Enter / Space 触发的 click 也走这条路径）。菜单项的 onSelect
              // 在自己的 onClick 里已执行，preventDefault 只取消 summary 开合。
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {nearActions.length > 0 && <MessageActions actions={nearActions} />}
            {clock !== '' && (
              // hover 工具栏那套（正文下方）不再重复这一段的时刻：有思考卡时时间只在这里。
              // `tabular-nums` 让数字等宽（流式时时间会从 14:02 走到 14:03，不跳宽）。
              <time
                className="font-mono text-2xs tabular-nums"
                dateTime={new Date(time ?? 0).toISOString()}
              >
                {clock}
              </time>
            )}
          </span>
        )}
      </summary>
      <div className="px-2.5 py-2 text-md leading-relaxed whitespace-pre-wrap wrap-anywhere">
        {clampedVisible ? clamped : revealed}
        {/* 流式光标（D，motion.css `.stream-caret` + pulse-soft）：纯文本尾部内联挂载，
            收字结束 streaming=false 即移除；reduced-motion 下静止常亮（base.css 防线）。 */}
        {streaming && <span className="stream-caret pulse-soft" aria-hidden="true" />}
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
