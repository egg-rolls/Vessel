import type {
  AskUserAnswer,
  AskUserRequest,
  PermissionRequest,
  PermissionScope,
  TeamDetail,
  TeamPostResult,
  TeamRetractResult,
} from '../../gateway/types';
import type { StoredEvent } from '../../state/events';

export interface TeamChatClient {
  getTeam(teamId: string, opts?: { limit?: number; members_limit?: number }): Promise<TeamDetail>;
  postTeam(input: {
    team_id: string;
    content: string;
    mentions?: string[];
  }): Promise<TeamPostResult>;
  retractTeam(input: { team_id: string; message_id: string }): Promise<TeamRetractResult>;
}

export type TeamChatDecidePermission = (
  requestId: string,
  decision: 'allow' | 'deny',
  scope: PermissionScope,
) => void;

export type TeamChatRespondAsk = (requestId: string, answers: AskUserAnswer[]) => void;

export interface TeamChatProps {
  client: TeamChatClient;
  hasToken: boolean;
  connectionState: string;
  epoch: number;
  tenantEpoch: number;
  teamId: string;
  /** Store key discriminator for multi-node Teams; defaults for tests / preview. */
  nodeKey?: string;
  /** 父级节点显示名：作为页头 scope 槽（「in &lt;node&gt;」）。 */
  nodeName?: string;
  /** 父级即为当前连接节点：页头渲染降级的「当前」。 */
  nodeCurrent?: boolean;
  /** 团队被冻结：进页头 status 槽。 */
  frozen?: boolean;
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  events: readonly StoredEvent[];
  /** 正在提交应答的 requestId；由 ConnectionProvider 维护。 */
  responding?: ReadonlySet<string>;
  /** 直接应答成员会话里的权限请求（不切换会话）。 */
  onDecidePermission?: TeamChatDecidePermission;
  /** 直接应答成员会话里的 ask_user。 */
  onRespondAsk?: TeamChatRespondAsk;
  onOpenMember: (agentId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onBackToList: () => void;
  /** 测试 / 预览注入，避免 SSR 依赖 effect。 */
  initialDetail?: TeamDetail;
  initialLimit?: number;
  initialError?: { message: string; code?: string };
}
