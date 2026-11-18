import { createContext } from 'react';
import type { EventStore } from '../state/event-store';
import type { PendingFetchState } from './interaction-hydration';
import type { ConnectionState, GatewayClient } from './node';
import type { NodeSelectionFallback } from './node-selection';
import type { GatewayRpcBlock } from './session-invalid';
import type { SubscriptionController } from './subscription';
import type {
  AskUserAnswer,
  AskUserRequest,
  HelloInfo,
  PermissionRequest,
  PermissionScope,
} from './types';
import type { PlatformNodeSummary } from './types/platform';

/** 连接模式：pending = 平台探测中；legacy = 页面由旧 `--serve` 宿主提供。 */
export type ConnectionMode = 'pending' | 'platform' | 'legacy';

export interface ConnectionOptions {
  /** 平台 origin；空串 = 页面同源。 */
  platformUrl?: string;
  /** 平台 token；legacy 回退时等旧 node token。 */
  token?: string;
  /** 平台模式下可选手填 node token（覆盖 credentials）。 */
  nodeToken?: string;
}

export interface ConnectionContextValue {
  /** node 客户端（`/v1/rpc`、`/v1/events`）。 */
  client: GatewayClient;
  eventStore: EventStore;
  /**
   * 路由级事件订阅控制器（S2 数据层）。S3 在路由变化时调用
   * `subscription.apply({kind:'chat', sessionId})` 等；控制器负责 feature gate
   * 与订阅 epoch hello 的区分。
   */
  subscription: SubscriptionController;
  connectionState: ConnectionState;
  hello: HelloInfo | null;
  features: string[];
  nodeLabel: string;
  /** 平台 origin；空串 = 页面同源。 */
  platformUrl: string;
  /** 当前 node origin；空串 = 同源（legacy）。 */
  nodeUrl: string;
  /** 平台 token 槽（sessionStorage）。 */
  platformToken: string;
  /** 当前 node token；空串 + anonymous = node 回环匿名。 */
  nodeToken: string;
  mode: ConnectionMode;
  /** 平台模式节点来源：`platform.nodes.list` 全量投影；legacy 模式为空。 */
  platformNodes: readonly PlatformNodeSummary[];
  /** 平台模式当前已连接节点的 `node_id`。 */
  selectedNodeId: string | null;
  /** 持久化节点失效时的可见回退状态；`fallback: null` = 未回退。 */
  nodeSelection: { preferredNodeId: string | null; fallback: NodeSelectionFallback | null };
  /** 平台模式显式切换节点：按 `node_id` 重新取 credentials 并直连。 */
  selectPlatformNode: (nodeId: string) => void;
  /** 平台探测 / 凭据错误；401 时 UI 必须提示输入平台 token。 */
  platformError: string | null;
  /** 是否具备连接 node 的条件（有 token，或 credentials 明确 mode:'none'）。 */
  hasToken: boolean;
  /** 是否由开发代理注入鉴权（占位 token，不持久化、不展示）。 */
  devProxyAuth: boolean;
  gatewayError: string | null;
  tokenError: string | null;
  lastError: string | null;
  reconnectAttempt: number;
  /** 每次成功 hello 递增；资源用它作为刷新依赖。 */
  epoch: number;
  stale: boolean;
  /** 最近一次 WS close code（诊断用；重连开始时清空）。 */
  closeCode: number | null;
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  /**
   * 最近一次 `interactions.list` 的结果（0.59）：`failed` 时界面必须明说
   * 「待批列表拉取失败」，不能拿空列表冒充「没有待批」。
   */
  pendingFetch: PendingFetchState;
  /**
   * 最近一次被拒的 RPC 事实（401 会话失效 / 403 Origin 被拒）；null = 当前没有。
   *
   * 这条状态存在的唯一理由：**不许静默**。它的来源是传输层（`node/rpc.ts` 的
   * `httpJson`），不是连接探测 —— 探测成功但 RPC 全 401 正是那次真 bug 的形状。
   */
  sessionInvalid: GatewayRpcBlock | null;
  /** 走既有 `notifyAuthRequired()` 通道重新鉴权（不新造通道）。 */
  relogin: () => void;
  /**
   * 「重新登录」在当前部署里有没有目标（0.59）。
   *
   * `phase === 'disabled'`（没配任何登录后端）/ `'unknown'`（`/auth/status` 打不通）时为
   * false：那时 `AuthProvider.refresh()` 不会切到登录页，按钮点下去像没反应 ——
   * 界面要把它降级成「打开连接设置」。
   */
  canRelogin: boolean;
  /** 从 `interactions.list` 补回 pending，并把 orphaned 记为终态；失败会写进 `pendingFetch`。 */
  hydrateInteractions: () => Promise<void>;
  /** 正在提交应答的 requestId；UI 据此禁用按钮，避免双击重复提交。 */
  responding: ReadonlySet<string>;
  connect: (options: ConnectionOptions) => boolean;
  disconnect: () => void;
  clearToken: () => void;
  retry: () => void;
  dismissError: () => void;
  clearTokenError: () => void;
  respondPermission: (
    requestId: string,
    decision: 'allow' | 'deny',
    scope?: PermissionScope,
  ) => Promise<void>;
  /**
   * 回答 ask；`batchId` = 待批页「一起提交」这一次点击的标记（additive）。
   * 同批的多个应答带同一个 batchId 发出去，gateway 会合并成一条消息 + 一次 run。
   */
  respondAsk: (requestId: string, answers: AskUserAnswer[], batchId?: string) => Promise<void>;
}

export const ConnectionContext = createContext<ConnectionContextValue | null>(null);
