import type { ComposerAttachment } from '@vessel-agent/plugin-ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from '../../components/Tooltip';
import { AutoGrowTextarea, Button } from '../../components/ui';
import type { MessageRef } from '../../gateway/types';
import { t } from '../../i18n';
import type { AttachBrowseClient } from './AttachDialog';
import { ChatDock } from './ChatDock';
import { composerAttachBinding } from './ComposerAttach';
import {
  type ComposerContextUsage,
  ComposerField,
  ComposerRefsArea,
  ComposerSendButton,
  focusComposerInputOnBlankClick,
  refIndexForId,
  refsToAttachments,
} from './ComposerChrome';
import { MemberModelSwitch, type MemberModelSwitchProps } from './MemberModelSwitch';
import {
  parseSessionRefPayload,
  SESSION_REF_MIME,
  type SessionRefChip,
  type SessionRefScope,
  sessionRefBadges,
  sessionRefDescription,
} from './session-ref';

/**
 * 会话输入框卡片：卡片 > 引用区 > 字段容器 > (textarea + 工具栏)。
 *
 * - 上：引用区（附件 / 文档 / 引用项，受控 `refs` + `onRemoveRef`；空则不占高）；
 * - 下：{@link ComposerField} 把 textarea 与横向工具栏包成一块凹槽 —— 底色、圆角、
 *   内衬、焦点环都由容器承担，两者背景透明；
 * - textarea 行为不变：Enter 发送 / Shift+Enter 换行 / IME 保护；
 * - 指针：点卡片留白 / 引用区留白 / 工具栏空白都把焦点交给 textarea，
 *   按钮自己的点击不被接管（`focusComposerInputOnBlankClick`，两页共用）。
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  submitting,
  targetLabel,
  hasToken,
  connected,
  onOpenConnection,
  focusSignal = 0,
  onStop,
  stopping = false,
  refs,
  onRemoveRef,
  onAddRef,
  client,
  contextUsage,
  memberModel,
  sessionRefs,
  onRemoveSessionRef,
  onAddSessionRef,
  currentScope,
  sessionId,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  submitting: boolean;
  targetLabel: string;
  hasToken: boolean;
  connected: boolean;
  onOpenConnection: () => void;
  /** 值变化时把焦点移入输入框（新建会话草稿）。 */
  focusSignal?: number;
  /** 当前会话有 running run 时的停止入口（0.18，替代 run 卡片上的取消按钮）。 */
  onStop?: () => void;
  stopping?: boolean;
  /**
   * 待发送的附件引用（只有路径，没有正文）。缺省 / 空数组时不渲染 chip 行。
   * 状态由调用方持有（草稿槽）；工具栏的「引用文件」入口与文件选择共用这一份。
   */
  refs?: readonly MessageRef[];
  /** 删除一条引用（下标即 refs 里的位置）。 */
  onRemoveRef?: (index: number) => void;
  /**
   * 加一条引用（现有 `addRef`：本地只拦形状，路径边界在 `runs.start` 判）。
   * 缺省时不渲染「引用文件」入口。
   */
  onAddRef?: (ref: MessageRef) => boolean;
  /**
   * 「引用文件」弹层的目录浏览数据源（节点侧 `attachments.list`）。
   * 与 `onAddRef` 一起缺一不可；两者都在才出工具栏按钮。
   */
  client?: AttachBrowseClient;
  /** 发送键左侧的上下文用量；缺省（未知）时不渲染。 */
  contextUsage?: ComposerContextUsage;
  /**
   * 会话归属成员的模型切换入口（工具栏紧凑 pill，model-registry P2）。
   * 缺省（会话无归属成员 / 草稿态）不渲染；数据由 ChatView 从选中会话喂入。
   */
  memberModel?: MemberModelSwitchProps;
  /**
   * 待发送的会话引用（拖拽会话卡到输入框产生；草稿槽持有，与 refs 同族）。
   * 缺省 / 空数组时不渲染会话引用 chip。
   */
  sessionRefs?: readonly SessionRefChip[];
  /** 删除一条会话引用（下标即 sessionRefs 里的位置）。 */
  onRemoveSessionRef?: (index: number) => void;
  /**
   * 加一条会话引用（drop 落点）：去重 / 上限在草稿 store 判。
   * 缺省时整张卡片不作为会话引用 drop 目标（普通文本拖放行为不变）。
   */
  onAddSessionRef?: (chip: SessionRefChip) => boolean;
  /** 渐进披露基准：当前会话的节点 / 团队（同队同节点不显 team / node 徽章）。 */
  currentScope?: SessionRefScope;
  /** 当前会话 id（P3 思考强度菜单 sessionScoped write）；缺省（草稿态）按全局默认。 */
  sessionId?: string;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mountedRef = useRef(true);
  const wasSubmittingRef = useRef(submitting);
  const compositionEndRef = useRef(0);
  /** 会话卡拖拽悬停在卡片上（drop 目标高亮）；只认 SESSION_REF_MIME。 */
  const [dropActive, setDropActive] = useState(false);
  const canSend = hasToken && connected && !disabled && !submitting && value.trim().length > 0;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  // 发送结束后把焦点还给输入框；用户已把焦点移走时不抢。
  useEffect(() => {
    if (wasSubmittingRef.current && !submitting && mountedRef.current) {
      const active = document.activeElement;
      const focusLeftInput =
        active === document.body ||
        (active instanceof Element && active.closest('.composer-field') !== null);
      if (focusLeftInput && hasToken && connected && !disabled) inputRef.current?.focus();
    }
    wasSubmittingRef.current = submitting;
  }, [submitting, hasToken, connected, disabled]);

  const placeholder = !hasToken
    ? t('chat.composer.placeholderNoToken')
    : !connected
      ? t('chat.composer.placeholderDisconnected')
      : t('chat.composer.placeholder');

  // 引用区唯一实现：MessageRef[] → 通用 chip 行（id 用 path），删除按 path 回写下标。
  // 会话引用 chip 并进同一行（id 用 `session-ref:<sessionId>`，与团队页 mention chip
  // 同一套「前缀分流」做法）：label = 会话名，徽章 = agent / 跨队 team / 跨节点 node。
  const sessionRefItems: ComposerAttachment[] = (sessionRefs ?? []).map((chip) => ({
    id: `session-ref:${chip.sessionId}`,
    label: chip.title,
    kind: 'ref',
    note: t('chat.sessionRef.note'),
    description: sessionRefDescription(chip),
    badges: sessionRefBadges(chip, currentScope),
  }));
  const refItems = [...refsToAttachments(refs ?? []), ...sessionRefItems];
  const removeRef = (id: string) => {
    if (id.startsWith('session-ref:')) {
      const sessionId = id.slice('session-ref:'.length);
      const index = (sessionRefs ?? []).findIndex((chip) => chip.sessionId === sessionId);
      if (index >= 0) onRemoveSessionRef?.(index);
      return;
    }
    const index = refIndexForId(refs ?? [], id);
    if (index >= 0) onRemoveRef?.(index);
  };

  // 「引用文件」入口的接线：弹层（浏览 / 粘贴）只交路径 + 种类，种类按扩展名粗判
  // （`kind` 只影响 chip 的图标，不读内容、不上传）。
  const refCount = refs?.length ?? 0;
  const attach = useMemo(
    () => composerAttachBinding({ client, onAddRef, refCount }),
    [client, onAddRef, refCount],
  );

  return (
    <ChatDock>
      {/* 焦点环由 `.composer-field` 的 `:focus-within` 出（一层，标出「输入 + 工具栏」），
          卡片自己不再叠加第二层环。点卡片留白（标题行 / 引用区 / 内衬）也进输入框，
          按钮与输入框自己的点击不被接管（见 `focusComposerInputOnBlankClick`）。 */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 点卡片留白聚焦 textarea 是鼠标便捷入口（卡片不是可点控件） */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 键盘流不变：Tab 直接到输入框 / 按钮，留白处不需要键盘等价键 */}
      <div
        className={`w-full max-w-[var(--dock-width)] mx-auto px-3.5 pt-2.25 pb-3 rounded-lg bg-raised shadow-elev-2${
          dropActive ? ' ring-2 ring-accent' : ''
        }`}
        onClick={focusComposerInputOnBlankClick}
        onDragOver={(event) => {
          // 只认会话引用 MIME：普通文本 / 文件拖入不接管，textarea 原生拖放不变。
          if (onAddSessionRef === undefined) return;
          if (!event.dataTransfer.types.includes(SESSION_REF_MIME)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDropActive(true);
        }}
        onDragLeave={(event) => {
          // 只在真正离开卡片时熄灯（子元素间移动 relatedTarget 仍在卡片内）。
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          setDropActive(false);
        }}
        onDrop={(event) => {
          setDropActive(false);
          if (onAddSessionRef === undefined) return;
          const raw = event.dataTransfer.getData(SESSION_REF_MIME);
          if (raw === '') return;
          event.preventDefault();
          const chip = parseSessionRefPayload(raw);
          if (chip === null) return;
          onAddSessionRef(chip);
          inputRef.current?.focus();
        }}
      >
        <div className="flex items-center justify-between gap-3 mb-1.5 text-xs text-faint">
          <Tooltip label={targetLabel}>
            <span className="composer-target">{targetLabel}</span>
          </Tooltip>
          <span className="flex-none flex items-center gap-2.5">
            {onStop && (
              <Button
                type="button"
                variant="link"
                className="text-danger hover:text-danger disabled:opacity-60"
                onClick={onStop}
                disabled={stopping}
              >
                {stopping ? t('chat.run.stopping') : t('chat.run.stop')}
              </Button>
            )}
            <span className="flex-none font-mono text-xs text-muted">
              {t('chat.composer.hint')}
            </span>
          </span>
        </div>
        <ComposerRefsArea
          className="composer-refs-row"
          items={refItems}
          onRemove={
            onRemoveRef === undefined && onRemoveSessionRef === undefined ? undefined : removeRef
          }
          removeLabel={(item) =>
            item.kind === 'ref'
              ? t('chat.sessionRef.remove', { name: item.label })
              : t('composer.refs.remove', { name: item.label })
          }
        />
        <ComposerField
          contextUsage={contextUsage}
          attach={attach}
          sessionId={sessionId}
          slot={memberModel !== undefined ? <MemberModelSwitch {...memberModel} /> : undefined}
          primary={
            !hasToken || !connected ? (
              <Button variant="primary" onClick={onOpenConnection}>
                {t('common.configureConnection')}
              </Button>
            ) : (
              <ComposerSendButton
                label={submitting ? t('chat.composer.sending') : t('chat.composer.send')}
                disabled={!canSend}
                onClick={onSubmit}
              />
            )
          }
        >
          <AutoGrowTextarea
            ref={inputRef}
            className="composer-input"
            rows={1}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onCompositionEnd={() => {
              compositionEndRef.current = Date.now();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              // Ctrl / Cmd + Enter 是显式发送和弦；裸 Enter 保持既有发送行为，
              // Shift+Enter 仍换行。三条路径共用同一个 canSend 判定。
              const chord = event.ctrlKey || event.metaKey;
              if (!chord && event.shiftKey) return;
              event.preventDefault();
              // Safari 在 compositionend 后可能再补一个 Enter：时间窗内只阻止默认行为。
              if (Date.now() - compositionEndRef.current < 50) return;
              if (canSend) onSubmit();
            }}
            placeholder={placeholder}
            disabled={!hasToken || !connected || submitting || disabled}
            spellCheck={false}
            aria-label={t('chat.composer.input')}
            enterKeyHint="send"
          />
        </ComposerField>
      </div>
    </ChatDock>
  );
}
