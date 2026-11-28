import type { PaneResizeApi } from '../../app/usePaneResize';
import type { AttachmentListParams, AttachmentListResult } from '../../gateway/node/attachments';
import type {
  AskUserAnswer,
  AskUserRequest,
  MessageRef,
  PermissionRequest,
  PermissionScope,
  TeamDetail,
  TeamPostResult,
  TeamRecallDeliveryResult,
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
  /**
   * 编辑的级联收口：消费该消息投进各成员 inbox 的那一份（不写 tombstone、不改日志）。
   * 旧 gateway 没有该方法时报错，editMessage 按失败处理（不回填草稿）。
   */
  recallTeamDelivery(input: {
    team_id: string;
    message_id: string;
  }): Promise<TeamRecallDeliveryResult>;
  /**
   * 附件引用浏览（节点侧只读 `attachments.list`）。
   *
   * file-ref P3 起入口归 file-refs 插件弹层，经编辑端口消费本能力；
   * 列的是**这个 Team 所在节点**的目录。旧 gateway 没有这个方法时
   * 插件弹层给降级提示，粘贴路径那条路仍可用。
   */
  listAttachments(params?: AttachmentListParams): Promise<AttachmentListResult>;
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
  /** 直接应答成员会话里的 ask。 */
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
