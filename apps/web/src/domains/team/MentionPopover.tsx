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
    <div className="mb-1.5 overflow-hidden rounded-md border border-line-strong bg-surface shadow-elev-2">
      <p className="m-0 px-2.5 pt-2 pb-1 font-mono text-2xs uppercase tracking-wider text-faint">
        {t('team.mention.title')}
      </p>
      <div
        className="max-h-60 overflow-y-auto px-1 pb-1"
        id={listId}
        role="listbox"
        aria-label={t('team.a11y.mentionList')}
      >
        {candidates.length === 0 && (
          <p className="m-0 px-2.5 py-2 text-sm text-muted" role="status">
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
              className={`flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-inherit hover:bg-hover ${
                selected ? 'bg-hover' : ''
              }`.trim()}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(candidate)}
            >
              <span
                className="grid size-7 flex-none place-items-center rounded-full bg-sunken font-mono text-xs uppercase text-muted"
                aria-hidden="true"
              >
                {candidate.label.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{candidate.label}</span>
              <StatusChip
                status={status.chipStatus}
                label={t(status.labelKey)}
                title={status.titleKey ? t(status.titleKey) : undefined}
              />
              <span
                role="img"
                className={`size-1.5 flex-none rounded-full ${
                  candidate.member.presence === 'live'
                    ? 'bg-success'
                    : 'border border-faint bg-transparent'
                }`}
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
      <p className="m-0 px-2.5 pt-1 pb-2 text-xs text-faint">{t('team.mention.hint')}</p>
    </div>
  );
}
