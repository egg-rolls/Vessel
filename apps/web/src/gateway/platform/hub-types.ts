/**
 * Hub 服务 HTTP / WS 的 Web 侧最小 DTO（CONTRACT-0.49 §8）。
 *
 * Hub 类型定义在 app 层 `src/hub/types.ts`；web 不能 import `src`，这里只镜像
 * 页面消费的字段，不新增 wire 字段。
 */

/** 必须与 `@vessel-agent/serve` 的 `HUB_PROTOCOL` 一致；旧 v1 peer 显式失败。 */
export const HUB_PROTOCOL = 'vessel.hub/2' as const;

export type HubNodeStatus =
  | 'connecting'
  | 'healthy'
  | 'unreachable'
  | 'incompatible'
  | 'unauthorized'
  | 'identity_mismatch';

/** `direct` = 浏览器可直连；`unreachable` = 只有控制面可达。 */
export type HubDataPlane = 'direct' | 'unreachable';

export interface HubNodeCounts {
  teams: number;
  agents: number;
  live_agents: number;
}

export interface HubNodeRecord {
  node_id: string;
  name?: string;
  alias?: string;
  url?: string;
  public_url?: string;
  data_plane?: HubDataPlane;
  direction?: 'hub' | 'node';
  status: HubNodeStatus;
  last_seen?: number;
  last_error?: string;
  truncated: boolean;
  counts: HubNodeCounts;
}

/** `GET /v1/hub/directory` 与 WS `directory` 帧的页面视图。 */
export interface HubDirectory {
  v: 1;
  hub_id: string;
  updated_at: number;
  nodes: HubNodeRecord[];
  /** 0.50 additive：hub app 版本；旧 hub 缺省。 */
  version?: string;
}

/** `GET /health`：URL / CORS 连通性预检。 */
export interface HubHealth {
  ok: boolean;
  hub_id: string;
  nodes: number;
  now: number;
  /** 0.50 additive：hub app 版本；旧 hub 缺省。 */
  version?: string;
}

export interface HubHelloFrame {
  v: 1;
  kind: 'hello';
  protocol: typeof HUB_PROTOCOL;
  dialer: string;
  hub_id: string;
  revision?: number;
  observed_at?: number;
}

export interface HubPointerFrame {
  v: 1;
  kind: 'pointer';
  protocol: typeof HUB_PROTOCOL;
  dialer: string;
  node_id: string;
  hub_id: string;
  team_id: string;
  reason: string;
  ts: number;
  request_id?: string;
}

/** WS 上页面关心的事件；`ping` 只需回 `pong`。 */
export type HubServerEvent =
  | { kind: 'hello'; hubId: string; revision?: number }
  | { kind: 'directory'; directory: HubDirectory }
  | { kind: 'pointer'; pointer: HubPointerFrame }
  | { kind: 'ping' }
  /** 帧里的协议不是 `vessel.hub/2`：按现有 `incompatible` 面显式失败。 */
  | { kind: 'incompatible' };
