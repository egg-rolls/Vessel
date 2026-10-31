import type {
  AgentSummary,
  AgentUpdateInput,
  SessionDetail,
  TeamDetail,
} from '../../gateway/types';
import type { StoredEvent } from '../../state/events';
import type { TeamChatClient } from './TeamChat';

export interface MemberDetailClient extends TeamChatClient {
  getSession(sessionId: string): Promise<SessionDetail>;
  updateAgent(input: AgentUpdateInput): Promise<AgentSummary>;
}

export interface MemberDetailProps {
  client: MemberDetailClient;
  hasToken: boolean;
  epoch: number;
  tenantEpoch: number;
  teamId: string;
  memberId: string;
  /** Store key discriminator for multi-node Teams; defaults for tests / preview. */
  nodeKey?: string;
  bodyId?: string;
  events: readonly StoredEvent[];
  /** 返回群聊。 */
  onBack: () => void;
  /** 返回成员详情（去掉 ?body=）。 */
  onBackToMember: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenBody: (sessionId: string) => void;
  /** 嵌在外部详情页里时不再渲染自己的标题栏。 */
  embedded?: boolean;
  initialDetail?: TeamDetail;
  initialSession?: SessionDetail;
  initialError?: { message: string; code?: string };
}
