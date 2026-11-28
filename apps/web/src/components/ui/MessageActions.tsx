import { type ReactNode, useCallback } from 'react';
import { t } from '../../i18n';
import { ActionMenu, type ActionMenuItem } from '../ActionMenu';
import { useOptionalToast } from '../ToastProvider';
import { IconButton } from '../Tooltip';
import { copyText } from './clipboard';
import { cn } from './cn';
import { Icon } from './Icon';

export interface MessageAction {
  id:
    | 'copy'
    | 'edit'
    | 'retry'
    | 'resend'
    | 'transcript'
    | 'reply'
    | 'quote'
    | 'retract'
    | 'delete';
  /** 已 i18n，直接进 Tooltip / aria-label。 */
  label: string;
  disabled?: boolean;
  onSelect: () => void;
  /**
   * 动作菜单（q-tool-card-slot 裁示③）：给了它，本动作的按钮点开菜单而不是直接
   * 执行 onSelect —— 单按钮多语义（如「复制」→ 复制思考 / 复制正文），不重复按钮。
   * 菜单形态复用既有 ActionMenu（FilterPopover 同族），触发器图标 = 本动作 id。
   */
  menu?: readonly ActionMenuItem[];
}

export interface MessageActionsProps {
  actions: readonly MessageAction[];
  /**
   * 图标左侧的元信息槽（消息时间等）。与图标同一排、同一 hover 显隐容器：
   * 时间从气泡/卡片头搬到这里，默认隐藏，hover / focus 时一起显现；
   * `pointer-coarse`（触屏）下整组常显，时间才不至于是“看不见的信息”。
   */
  meta?: ReactNode;
  /** 布局覆盖。 */
  className?: string;
  /**
   * 摆放档（q-message-toolbar）：
   * - `bottom`（缺省）＝正文下方一行、左对齐 —— run 结束消息 / 用户气泡 / 团队页的既定形态；
   * - `side`＝浮在消息卡**右上角内部**（absolute，不占下方空间）：非 run 结束的 AI 消息
   *   （只有复制的那一段）用这一档，避免工具栏在正文下方空开一行造成割裂。
   *   调用方容器必须是 `relative` + `group`（`.msg-assistant` 已具备）。
   *   浮层自带底色 / 圆角 / 浅投影：hover 显现时压在正文首行右上角也读得清；
   *   显隐触发与 bottom 档同源（group-hover / focus-within / 触屏常显）。
   */
  placement?: 'bottom' | 'side';
}

/**
 * 复制文本并以 toast 反馈；没有 ToastProvider 时只复制、不提示。
 * `successLabel` 默认是聊天操作组文案；团队消息传 `common.copied`。
 */
export function useMessageCopy(
  successLabel: string = t('chat.message.copied'),
): (text: string) => void {
  const toast = useOptionalToast();
  return useCallback(
    (text: string) => {
      void copyText(text)
        .then(() => toast?.success(successLabel))
        .catch((error: unknown) => {
          toast?.error(error instanceof Error ? error.message : String(error));
        });
    },
    [toast, successLabel],
  );
}

/**
 * 消息操作组：默认 hover / focus-within 显示，触屏常显。
 * 只负责布局与可访问性；具体动作由调用方提供。
 * 摆放两档（`placement`）：bottom＝正文下方一行（run 结束消息等既定形态）；
 * side＝消息卡右上角内嵌浮层（非 run 结束的 AI 消息，不占下方空间）。
 *
 * 「只有时间、没有动作」的消息也要能显示时间，所以早退条件是「两者都空」而不是
 * `actions.length === 0`。
 */
export function MessageActions({
  actions,
  meta,
  className,
  placement = 'bottom',
}: MessageActionsProps) {
  const hasMeta = meta !== undefined && meta !== null && meta !== false;
  const hasActions = actions.length > 0;
  if (!hasActions && !hasMeta) return null;
  const row = (
    <div
      // 只有时间、没有动作时不冒充「消息操作」组：读屏不该听到一个空的 action group。
      {...(hasActions ? { role: 'group' as const, 'aria-label': t('chat.message.actions') } : {})}
      className={cn(
        'flex w-fit flex-row flex-nowrap items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100',
        className,
      )}
    >
      {hasMeta && (
        // 时间不抢焦点、不进 tab 序列：`<time>` 本身不可聚焦，读屏随正文一起读到。
        <span className="mr-0.5 shrink-0 font-mono text-2xs tabular-nums text-faint">{meta}</span>
      )}
      {actions.map((action) =>
        action.menu !== undefined ? (
          <ActionMenu
            key={action.id}
            label={action.label}
            items={action.menu}
            disabled={action.disabled}
            trigger={<Icon name={action.id} />}
          />
        ) : (
          <IconButton
            key={action.id}
            label={action.label}
            disabled={action.disabled}
            onClick={action.onSelect}
          >
            <Icon name={action.id} />
          </IconButton>
        ),
      )}
    </div>
  );
  if (placement === 'bottom') return row;
  // side 档：浮层壳负责定位与「显现时压字也读得清」的底色；显隐规则与内层 row 同源
  // （同一个 group-hover / focus-within / pointer-coarse 触发），两层 opacity 同步 0→1。
  // 壳始终 absolute ⇒ 不占布局高度，正文下方不再空开一行。
  return (
    <div className="absolute right-0 top-0 z-10 rounded-md bg-surface/90 p-0.5 opacity-0 shadow-elev-1 backdrop-blur-sm transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
      {row}
    </div>
  );
}
