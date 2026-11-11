import type { PaneResizeApi } from '../../app/usePaneResize';
import type {
  AskUserAnswer,
  AskUserRequest,
  MessageRef,
  PermissionRequest,
  PermissionScope,
  TeamDetail,
  TeamPostResult,
  TeamRetractResult,
} from '../../gateway/types';
import type { StoredEvent } from '../../state/events';

export interface TeamChatClient {
  getTeam(
    teamId: string,
    opts?: { limit?: number; members_limit?: number; before?: string },
  ): Promise<TeamDetail>;
  postTeam(input: {
    team_id: string;
    content: string;
    mentions?: string[];
    /**
     * 附件引用（0.52，additive）：只有路径与种类。随 @ 投递写成成员侧 core
     * `Message.refs`，也写进 Team 日志并回显在结果 `refs`；不传 = 无引用，
     * 旧 gateway 忽略未知键。
     */
    refs?: MessageRef[];
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
  /**
   * 右侧成员栏是否展开。状态由 `useTeamsView` 持有（单一 boolean，入口在 Team 卡
   * 的 ActionMenu），因此**切换 Team 不强制关闭**：打开成员栏后切到别的 Team，
   * 成员栏保持展开；`≤1023px` 时同一布尔量控制固定抽屉 + 遮罩。
   */
  membersOpen: boolean;
  /** 关闭成员栏：抽屉遮罩 / Esc / 头部 × 的 `onClose` 都走这里，不直接改 store。 */
  onCloseMembers: () => void;
  /**
   * 内容列宽度控件（与会话页**同一个** `chat` pane，共用
   * `--chat-content-w` / `--chat-half-w` 与 `vessel.ui.layout.v1`，不新增键）。
   * 手柄渲染条件与 `ChatView` 一致：`!narrow && !panes.disabled('chat')`。
   */
  panes: PaneResizeApi;
  /** 测试 / 预览注入，避免 SSR 依赖 effect。 */
  initialDetail?: TeamDetail;
  initialError?: { message: string; code?: string };
}
