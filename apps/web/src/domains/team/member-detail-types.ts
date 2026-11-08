import type {
  AgentSummary,
  AgentUpdateInput,
  SessionCreateInput,
  SessionCreateResult,
  SessionDetail,
  TeamDetail,
} from '../../gateway/types';
import type { StoredEvent } from '../../state/events';
import type { TeamChatClient } from './TeamChat';

export interface MemberDetailClient extends TeamChatClient {
  getSession(sessionId: string): Promise<SessionDetail>;
  updateAgent(input: AgentUpdateInput): Promise<AgentSummary>;
  /** 0.39：新建 session（无来源）；旧 session 退役但保留。 */
  createSession(input: SessionCreateInput): Promise<SessionCreateResult>;
}

export interface MemberDetailProps {
  client: MemberDetailClient;
  hasToken: boolean;
  epoch: number;
  teamId: string;
  memberId: string;
  /** Store key discriminator for multi-node Teams; defaults for tests / preview. */
  nodeKey?: string;
  events: readonly StoredEvent[];
  /** 返回群聊。 */
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenBody: (sessionId: string) => void;
  initialDetail?: TeamDetail;
  initialError?: { message: string; code?: string };
}
