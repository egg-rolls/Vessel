import { createContext } from 'react';
import type { EventStore } from '../state/event-store';
import type { ConnectionState, GatewayClient } from './node';
import type {
  AskUserAnswer,
  AskUserRequest,
  HelloInfo,
  PermissionRequest,
  PermissionScope,
} from './types';

/** 连接模式：pending = 平台探测中；legacy = 页面由旧 `--serve` 宿主提供。 */
export type ConnectionMode = 'pending' | 'platform' | 'legacy';

export interface ConnectionOptions {
  /** 平台 origin；空串 = 页面同源。 */
  platformUrl?: string;
  /** 平台 token；legacy 回退时等旧 node token。 */
  token?: string;
  /** 平台模式下可选手填 node token（覆盖 credentials）。 */
  nodeToken?: string;
  /** 只切换 node 连接的 tenant（不改 URL / token）。 */
  tenantId?: string;
}

export interface ConnectionContextValue {
  /** node 客户端（`/v1/rpc`、`/v1/events`）。 */
  client: GatewayClient;
  eventStore: EventStore;
  connectionState: ConnectionState;
  hello: HelloInfo | null;
  tenantId: string | null;
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
  /** tenant 变化递增；Chat 用它清空选择。 */
  tenantEpoch: number;
  stale: boolean;
  /** 最近一次 WS close code（诊断用；重连开始时清空）。 */
  closeCode: number | null;
  permissions: readonly PermissionRequest[];
  asks: readonly AskUserRequest[];
  /** 从 `interactions.list` 补回 pending，并把 orphaned 记为终态；失败静默。 */
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
  respondAsk: (requestId: string, answers: AskUserAnswer[]) => Promise<void>;
}

export const ConnectionContext = createContext<ConnectionContextValue | null>(null);
