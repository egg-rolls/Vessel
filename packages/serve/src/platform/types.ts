/**
 * 0.49 G1：Platform Gateway 的冻结对外形状。
 *
 * 本模块不 import node runtime / node methods；类型只描述平台入口与 registry 投影。
 *
 * @module @vessel-agent/serve/platform/types
 */

/** 平台侧注入的 node 描述；G3 起一个平台可注入多个本地 node。 */
export interface PlatformNodeDescriptor {
  nodeId: string;
  name: string;
  apiUrl: string;
  version?: string;
}

/**
 * 组合根按 `node_id` 解析 node 生效凭据的结果（0.49 G3b）。
 * `found:false` = registry 无该 node，RPC 映射为 `node_not_found`；
 * `found:true` 且无 token = 该 node 走回环匿名（返回 `{token:null,mode:'none'}`）。
 */
export type PlatformNodeCredential = { found: true; token?: string } | { found: false };

/** registry 投影的健康态；不持久化。 */
export type PlatformNodeStatus = 'up' | 'down' | 'unknown';

/**
 * `platform.nodes.list|get` 的返回项。
 * 永不含 token / token_hash / credential_ref。
 */
export interface PlatformNodeSummary {
  node_id: string;
  name: string;
  api_url: string;
  status: PlatformNodeStatus;
  last_seen?: number;
  version?: string;
}

/** 组合根解析后注入 Platform Gateway 的全部运行参数。 */
export interface PlatformGatewayOptions {
  /** 平台监听端口；由组合根解析（默认 8642）。 */
  port: number;
  /** 平台监听地址；由组合根解析（默认 127.0.0.1）。 */
  hostname: string;
  /** 未配置 = undefined；仅回环匿名只读。 */
  platformToken?: string;
  /** `gateway.allowed_origins`；已由组合根解析。 */
  allowedOrigins?: string[];
  /** 用于 CSP `frame-src` / `connect-src` 的 node origin。 */
  nodeOrigins: string[];
  /** `apps/web/dist`；启动时必须存在 `index.html`。 */
  staticDir: string;
  /** registry 中全部本地 node（`auto_start:false` 也注入，只做健康展示）。 */
  nodes: PlatformNodeDescriptor[];
  /**
   * 组合根按 node_id 解析该 node 生效 token；只读取/透传，不生成、不缓存、不落盘。
   * 省略 nodeId 表示调用方已确认恰好一个节点（RPC 层负责多节点 `invalid_params`）。
   */
  resolveNodeCredential: (nodeId?: string) => PlatformNodeCredential;
  version?: string;
}

/** 已启动的平台监听。 */
export interface PlatformGateway {
  /** 实际监听端口（支持传入 0 由系统分配）。 */
  port: number;
  stop(): Promise<void>;
}
