/**
 * Team 输入框：受控 value + mention chips。
 *
 * - Enter 发送 / Shift+Enter 换行；IME composition 内不响应；
 * - `@` 补全的键盘与 ARIA 由这里处理，焦点始终留在 textarea；
 * - 发送只提交 chips 里的 `agent_id`，正文 `@name` 不参与解析；
 * - UTF-8 字节上限 64 KiB。
 */
import { useEffect, useId, useRef, useState } from 'react';
import { AutoGrowTextarea, Button } from '../../components/ui';
import type { TeamMember } from '../../gateway/types';
import { t } from '../../i18n';
import { MentionPopover } from './MentionPopover';
import {
  detectMention,
  exceedsMessageLimit,
  insertMention,
  MAX_MESSAGE_BYTES,
  type MentionCandidate,
  type MentionChip,
  mentionCandidates,
} from './mention';

const LIMIT_KIB = Math.floor(MAX_MESSAGE_BYTES / 1024);

export interface TeamComposerProps {
  value: string;
  onChange: (value: string) => void;
  mentions: readonly MentionChip[];
  onMentionsChange: (chips: MentionChip[]) => void;
  onSend: () => void;
  sending: boolean;
  hasToken: boolean;
  connected: boolean;
  members: readonly TeamMember[];
  targetLabel: string;
  /** 从失败消息“再次发送”填入草稿时的提示（发送即二次确认）。 */
  retryHint?: boolean;
  disabled?: boolean;
}

export function TeamComposer({
  value,
  onChange,
  mentions,
  onMentionsChange,
  onSend,
  sending,
  hasToken,
  connected,
  members,
  targetLabel,
  retryHint = false,
  disabled = false,
}: TeamComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const compositionRef = useRef(false);
  const compositionEndRef = useRef(0);
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  /** Esc 关闭后记住触发点；新的 `@` 或换位置会重新打开。 */
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const listId = useId();

  const trigger = detectMention(value, caret);
  const popoverVisible = trigger !== null && trigger.start !== dismissedStart;
  const candidates = popoverVisible ? mentionCandidates(members, trigger.query) : [];
  const active = candidates.length === 0 ? -1 : Math.min(activeIndex, candidates.length - 1);
  const triggerKey = trigger ? `${trigger.start}:${trigger.query}` : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 触发点或过滤词变化时回到第一条候选
  useEffect(() => {
    setActiveIndex(0);
  }, [triggerKey]);

  const tooLarge = exceedsMessageLimit(value);
  const canSend =
    hasToken && connected && !disabled && !sending && !tooLarge && value.trim().length > 0;

  const syncCaret = () => {
    const element = inputRef.current;
    if (element && typeof element.selectionStart === 'number') setCaret(element.selectionStart);
  };

  const pick = (candidate: MentionCandidate) => {
    const current = trigger ?? detectMention(value, inputRef.current?.selectionStart ?? caret);
    if (!current) return;
    const next = insertMention(value, current, candidate.label);
    onChange(next.value);
    if (!mentions.some((chip) => chip.agentId === candidate.agentId)) {
      onMentionsChange([...mentions, { agentId: candidate.agentId, label: candidate.label }]);
    }
    setDismissedStart(null);
    setCaret(next.caret);
    window.setTimeout(() => {
      const element = inputRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    }, 0);
  };

  const placeholder = !hasToken
    ? t('team.error.noToken')
    : !connected
      ? t('team.composer.disconnected')
      : t('team.composer.input');

  return (
    <div className="composer team-composer">
      <div className="composer-meta">
        <span className="composer-target" title={targetLabel}>
          {targetLabel}
        </span>
        <span className="composer-meta-right">
          <span className="composer-hint dim">{t('team.composer.hint')}</span>
        </span>
      </div>

      {mentions.length > 0 && (
        <fieldset className="team-mention-chips">
          <legend className="sr-only">{t('team.mention.title')}</legend>
          {mentions.map((chip) => (
            <span className="team-mention-chip" key={chip.agentId}>
              <span aria-hidden="true">@</span>
              <span>{chip.label}</span>
              <button
                type="button"
                aria-label={t('team.mention.remove', { name: chip.label })}
                onClick={() =>
                  onMentionsChange(mentions.filter((item) => item.agentId !== chip.agentId))
                }
              >
                ×
              </button>
            </span>
          ))}
        </fieldset>
      )}

      {popoverVisible && (
        <MentionPopover
          candidates={candidates}
          activeIndex={active}
          listId={listId}
          onPick={pick}
          onHover={setActiveIndex}
        />
      )}

      <div className="team-composer-notices">
        {mentions.length === 0 && (
          <p className="team-composer-notice">{t('team.composer.noMention')}</p>
        )}
        {(!hasToken || !connected) && (
          <p className="team-composer-notice" role="status">
            {t('team.composer.disconnected')}
          </p>
        )}
        {tooLarge && (
          <p className="team-composer-notice danger" role="alert">
            {t('team.composer.tooLarge', { limit: LIMIT_KIB })}
          </p>
        )}
        {retryHint && (
          <p className="team-composer-notice" role="status">
            {t('team.delivery.retryHint')}
          </p>
        )}
      </div>

      <div className="composer-row">
        <AutoGrowTextarea
          ref={inputRef}
          className="composer-input team-composer-input"
          rows={1}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onKeyUp={syncCaret}
          onCompositionStart={() => {
            compositionRef.current = true;
          }}
          onCompositionEnd={() => {
            compositionRef.current = false;
            compositionEndRef.current = Date.now();
            syncCaret();
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || compositionRef.current) return;

            if (popoverVisible && trigger) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex(candidates.length === 0 ? -1 : (active + 1) % candidates.length);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex(
                  candidates.length === 0
                    ? -1
                    : (active - 1 + candidates.length) % candidates.length,
                );
                return;
              }
              if (event.key === 'Home') {
                event.preventDefault();
                setActiveIndex(candidates.length > 0 ? 0 : -1);
                return;
              }
              if (event.key === 'End') {
                event.preventDefault();
                setActiveIndex(candidates.length - 1);
                return;
              }
              if ((event.key === 'Enter' || event.key === 'Tab') && candidates.length > 0) {
                event.preventDefault();
                pick(candidates[active] ?? candidates[0]);
                return;
              }
              if (event.key === 'Tab') {
                event.preventDefault();
                setDismissedStart(trigger.start);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDismissedStart(trigger.start);
                return;
              }
            }

            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              // Safari 在 compositionend 后可能再补一个 Enter。
              if (Date.now() - compositionEndRef.current < 50) return;
              if (canSend) onSend();
            }
          }}
          placeholder={placeholder}
          disabled={!hasToken || !connected || sending || disabled}
          spellCheck={false}
          aria-label={t('team.composer.input')}
          role="combobox"
          aria-expanded={popoverVisible}
          aria-controls={popoverVisible ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            popoverVisible && active >= 0 ? `${listId}-option-${active}` : undefined
          }
          enterKeyHint="send"
        />
        <Button variant="primary" onClick={onSend} disabled={!canSend}>
          {sending ? t('team.composer.sending') : t('team.composer.send')}
        </Button>
      </div>
    </div>
  );
}
