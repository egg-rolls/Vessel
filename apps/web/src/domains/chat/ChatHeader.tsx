import type { SessionDetail, SessionInfo } from '../../gateway/types';
import { t } from '../../i18n';
import type { AgentNode } from '../../state/agents';
import { SessionHeader } from './SessionHeader';

/**
 * 会话顶部：选中会话显示 SessionHeader，草稿态显示标题 / 提示文案。
 * 纯展示，导航回调由 ChatView 注入。
 */
export function ChatHeader({
  selectedId,
  selectedSession,
  sessionDetail,
  contextUsage,
  agents,
  activeAgentId,
  draftActive,
  onSelectAgent,
}: {
  selectedId: string | null;
  selectedSession: SessionInfo | undefined;
  sessionDetail: SessionDetail | null;
  contextUsage?: { used: number; max?: number };
  agents: readonly AgentNode[];
  activeAgentId?: string;
  draftActive: boolean;
  onSelectAgent: (agentId: string | undefined) => void;
}) {
  if (selectedId) {
    return (
      <SessionHeader
        session={selectedSession ?? null}
        sessionId={selectedId}
        detail={sessionDetail}
        contextUsage={contextUsage}
        agents={agents}
        activeAgentId={activeAgentId}
        onSelectAgent={onSelectAgent}
      />
    );
  }
  return (
    <div className="conversation-head draft-head">
      <div className="conversation-heading">
        <h2 className="conversation-title">
          {draftActive ? t('chat.draft.title') : t('nav.domain.chat')}
        </h2>
        <div className="conversation-meta text-muted">
          {draftActive ? t('chat.draft.meta') : t('chat.draft.pickSession')}
        </div>
      </div>
    </div>
  );
}
