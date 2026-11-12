/**
 * @ 补全列表（domains/team/MentionPopover）：combobox 的 listbox 部分，
 * 焦点始终留在 textarea，方向键移动 aria-activedescendant。
 * 只渲染：选中回调保留高亮，不发消息。
 */
import { useState } from 'react';
import type { TeamMember } from '../../../../gateway/types';
import { t } from '../../../../i18n';
import type { MentionCandidate } from '../../../team/mention';
import { MentionPopover } from '../../../team/MentionPopover';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'MentionPopover',
  descriptionKey: 'designLab.preview.mention.desc',
  group: 'overlays',
  order: 50,
};

const MEMBERS: readonly TeamMember[] = [
  {
    agent_id: 'agt_7f3c1a2b',
    name: 'reviewer',
    membership: 'present',
    presence: 'live',
    visibility: 'team',
    state: 'running',
  },
  {
    agent_id: 'agt_9d4e5f60',
    name: 'planner',
    membership: 'present',
    presence: 'live',
    visibility: 'team',
    state: 'idle',
  },
  {
    agent_id: 'agt_2b8c4d1e',
    name: 'archivist',
    membership: 'present',
    presence: 'gone',
    visibility: 'private',
  },
];

const CANDIDATES: readonly MentionCandidate[] = MEMBERS.map((member) => ({
  agentId: member.agent_id,
  label: member.name ?? member.agent_id,
  member,
}));

const LIST_ID = 'design-lab-mention-list';

export default function MentionPopoverPreview() {
  const [activeIndex, setActiveIndex] = useState(0);
  return (
    <div className="w-72 max-w-full">
      <MentionPopover
        candidates={CANDIDATES}
        activeIndex={activeIndex}
        listId={LIST_ID}
        onPick={(candidate) => {
          const next = CANDIDATES.findIndex((item) => item.agentId === candidate.agentId);
          if (next >= 0) setActiveIndex(next);
        }}
        onHover={setActiveIndex}
      />
      <p className="mt-1.5 max-w-prose text-sm text-muted">{t('designLab.preview.mention.hint')}</p>
    </div>
  );
}
