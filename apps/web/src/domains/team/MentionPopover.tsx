/**
 * `@` 补全列表：combobox 的 listbox 部分。
 *
 * 焦点始终留在 textarea；本组件不接收焦点，键盘由 TeamComposer 处理，
 * 通过 `aria-activedescendant` 指向当前 option。
 */
import { StatusChip } from '../../components/StatusChip';
import { t } from '../../i18n';
import { memberStatus } from './member-status';
import type { MentionCandidate } from './mention';

export interface MentionPopoverProps {
  candidates: readonly MentionCandidate[];
  activeIndex: number;
  listId: string;
  onPick: (candidate: MentionCandidate) => void;
  onHover: (index: number) => void;
}

export function MentionPopover({
  candidates,
  activeIndex,
  listId,
  onPick,
  onHover,
}: MentionPopoverProps) {
  return (
    <div className="team-mention-popover">
      <p className="team-mention-title">{t('team.mention.title')}</p>
      <div
        className="team-mention-list"
        id={listId}
        role="listbox"
        aria-label={t('team.a11y.mentionList')}
      >
        {candidates.length === 0 && (
          <p className="team-mention-empty" role="status">
            {t('team.mention.empty')}
          </p>
        )}
        {candidates.map((candidate, index) => {
          const status = memberStatus(candidate.member);
          const selected = index === activeIndex;
          return (
            <button
              key={candidate.agentId}
              id={`${listId}-option-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={selected}
              className={`team-mention-option ${selected ? 'active' : ''}`.trim()}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(candidate)}
            >
              <span className="team-avatar" aria-hidden="true">
                {candidate.label.slice(0, 1).toUpperCase()}
              </span>
              <span className="team-mention-name">{candidate.label}</span>
              <StatusChip
                status={status.chipStatus}
                label={t(status.labelKey)}
                title={status.titleKey ? t(status.titleKey) : undefined}
              />
              <span
                role="img"
                className={`team-presence-dot ${candidate.member.presence}`}
                aria-label={
                  candidate.member.presence === 'live'
                    ? t('team.presence.live')
                    : t('team.presence.gone')
                }
              />
            </button>
          );
        })}
      </div>
      <p className="team-mention-hint">{t('team.mention.hint')}</p>
    </div>
  );
}
