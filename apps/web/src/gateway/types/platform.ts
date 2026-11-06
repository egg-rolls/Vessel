/**
 * 0.49 G1：Platform Gateway 的只读协议类型（与 `packages/serve/src/platform/types.ts` 对齐）。
 *
 * 前端独立构建，不 import 服务端源码。平台/node 两个客户端共用本文件，
 * 但平台客户端与 node 客户端互不 import。
 */

/** 平台鉴权模式；匿名只在回环且未配置平台 token 时出现。 */
export type PlatformAuthMode = 'token' | 'anonymous';

/** `platform.whoami` 返回。匿名时 `authenticated: false`。 */
export interface PlatformWhoAmI {
  authenticated: boolean;
  mode: PlatformAuthMode;
}

export type PlatformNodeStatus = 'up' | 'down' | 'unknown';

/** `platform.nodes.list|get` 的节点投影；永不含 token。 */
export interface PlatformNodeSummary {
  node_id: string;
  name: string;
  api_url: string;
  status: PlatformNodeStatus;
  last_seen?: number;
  version?: string;
}

export interface PlatformNodesListResult {
  nodes: PlatformNodeSummary[];
}

/**
 * `platform.nodes.credentials` 返回 Node API 实际接受的生效凭据。
 * `mode: 'none'` 表示 node 走回环匿名语义，Web 以空 token 连接。
 */
export interface PlatformNodeCredentials {
  token: string | null;
  mode: 'token' | 'none';
}
