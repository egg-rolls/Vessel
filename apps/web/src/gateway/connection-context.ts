import { createContext } from 'react';
import type { EventStore } from '../state/event-store';
import type { ConnectionState, GatewayClient } from './client';
import type {
  AskUserAnswer,
  AskUserRequest,
  HelloInfo,
  PermissionRequest,
  PermissionScope,
} from './types';

export interface ConnectionOptions {
  gatewayUrl: string;
  token: string;
  /** admin 切换租户时传；reconnect 会带 tenant_id。 */
  tenantId?: string;
}

export interface ConnectionContextValue {
  client: GatewayClient;
  eventStore: EventStore;
  connectionState: ConnectionState;
  hello: HelloInfo | null;
  tenantId: string | null;
  features: string[];
  nodeLabel: string;
  gatewayUrl: string;
  token: string;
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
