/**
 * Hub 进程共享契约（S5）。
 *
 * 这里只放 registry / secret / token broker 的纯类型，避免 Wave 1 的
 * M 之间互相 import 实现文件。
 *
 * @module vessel/hub/types
 */

import type { Logger } from '@vessel-agent/core';
import type {
  HubAgentMeta,
  HubPointerReason,
  HubTeamMeta,
} from '../../packages/serve/src/hub-control.js';

/** 一个配对 = (node_id, tenant_id)；同一 node 可以有多个 pairing。 */
export function pairingIdFor(nodeId: string, tenantId: string): string {
  return `${nodeId}:${tenantId}`;
}

export type HubNodeStatus =
  | 'connecting'
  | 'healthy'
  | 'unreachable'
  | 'incompatible'
  | 'unauthorized'
  | 'identity_mismatch';

/** 连接的发起方向：`hub` = hub 拨号 node；`node` = node 拨号 hub（S5.1）。 */
export type HubNodeDirection = 'hub' | 'node';

/** 数据面可达性：`direct` = 浏览器可直连；`unreachable` = 只有控制面可达。 */
export type HubDataPlane = 'direct' | 'unreachable';

/** 目录中的单个 pairing。禁止字段见 PLAN §8.2。 */
export interface HubNodeRecord {
  pairing_id: string;
  node_id: string;
  tenant_id: string;
  alias?: string;
  /** node-dial 且没有 public_url 时省略。 */
  url?: string;
  /** 浏览器可达的节点 origin；NAT 场景由隧道 / 反代提供。 */
  public_url?: string;
  /** 由 `public_url ?? url` 派生；客户端据此区分控制面与正文可达性。 */
  data_plane?: HubDataPlane;
  ca_file?: string;
  /** 连接方向；旧 registry 缺省按 `'hub'` 读。 */
  direction?: HubNodeDirection;
  /** node-dial 连接使用的 hub 签发 token id；吊销 / 关闭用。 */
  node_token_id?: string;
  status: HubNodeStatus;
  last_seen?: number;
  /** 稳定错误码；不含正文。 */
  last_error?: string;
  /** 节点进程代际；变化时 hub 重置 revision 比较。 */
  incarnation?: string;
  /** 单节点进程内单调；与 incarnation 一起判断新旧。 */
  revision?: number;
  /** teams / agents 是否被上限截断。 */
  truncated: boolean;
  counts: { teams: number; agents: number; live_agents: number };
  teams: HubTeamMeta[];
  agents: HubAgentMeta[];
}

/** `<hubDataDir>/registry.json`。 */
export interface HubRegistryFile {
  v: 1;
  hub_id: string;
  updated_at: number;
  nodes: HubNodeRecord[];
}

/** 密钥存储端口；实现见 `src/hub/secret-store.ts`。 */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** SecretStore key：每个 pairing 两条。 */
export function pairingSecretKey(pairingId: string, kind: 'view' | 'exchange'): string {
  return `pairing:${pairingId}:${kind}`;
}

/** 浏览器拿到的一次性短期 data token（hub 不持久化）。 */
export interface HubDataToken {
  node_id: string;
  pairing_id: string;
  team_id: string;
  url: string;
  token: string;
  token_id: string;
  expires_at: number;
  scope: 'control';
}

/**
 * hub 用 exchange token 向节点换短期 control token。
 * 实现见 `src/hub/token-broker.ts`（M-I5）。
 */
export interface HubTokenBrokerLike {
  exchangeForTeam(input: {
    pairing_id: string;
    node_id: string;
    url: string;
    team_id: string;
    ttl_s?: number;
    ca_file?: string;
  }): Promise<HubDataToken>;
}

/** `<hubDataDir>/hub-join.json`：hub 生成的一次性 join code（只存 hash）。 */
export interface HubJoinFile {
  v: 1;
  code_hash: string;
  hub_id: string;
  tenant_id: string;
  expires_at: number;
  used_at?: number;
  node_id?: string;
  pairing_id?: string;
}

export interface HubJoinIssue {
  code: string;
  expires_at: number;
}

export interface HubJoinConsumeResult {
  hub_id: string;
  tenant_id: string;
  node_id: string;
  pairing_id: string;
}

/** hub 侧 join code 端口。 */
export interface HubJoinStoreLike {
  /** 生成并覆盖当前 code；返回明文一次。 */
  issue(input: { tenant_id: string; ttl_s?: number }): Promise<HubJoinIssue>;
  /** 校验并烧掉 code；失败抛带 `code` 的 Error。 */
  consume(input: {
    code: string;
    hub_id: string;
    node_id: string;
    tenant_id: string;
  }): Promise<HubJoinConsumeResult>;
}

/** hub 签发的 node token（hash-only 落盘）。 */
export interface HubNodeTokenRecord {
  token_id: string;
  token_hash: string;
  scope: 'node';
  hub_id: string;
  node_id: string;
  tenant_id: string;
  pairing_id: string;
  issued_by: string;
  created_at: number;
  expires_at: number;
  revoked_at?: number;
}

export interface HubNodeTokensFile {
  v: 1;
  tokens: HubNodeTokenRecord[];
}

export interface IssuedHubNodeToken {
  token: string;
  token_id: string;
  expires_at: number;
  scope: 'node';
  hub_id: string;
  node_id: string;
  tenant_id: string;
  pairing_id: string;
}

/** hub 侧 node token 端口；`authenticate` 必须同步（WS 首帧用）。 */
export interface HubNodeCredentialStoreLike {
  issue(input: {
    hub_id: string;
    node_id: string;
    tenant_id: string;
    pairing_id: string;
    ttl_ms?: number;
  }): Promise<IssuedHubNodeToken>;
  authenticate(token: string): HubNodeTokenRecord | null;
  revoke(
    tokenId: string,
  ): Promise<{ token_id: string; revoked_at: number; changed: boolean } | null>;
  /** 吊销某个 pairing 的所有 token；返回实际变更数。 */
  revokePairing(pairingId: string): Promise<number>;
  list(): HubNodeTokenRecord[];
  onRevoke(listener: (tokenId: string) => void): () => void;
}

/** `<gatewayDataDir>/hub-node.json`：非秘密的 join 状态。 */
export interface HubNodeState {
  v: 1;
  hub_url: string;
  hub_id: string;
  node_id: string;
  tenant_id: string;
  pairing_id: string;
  token_id: string;
  expires_at: number;
  joined_at: number;
  ca_file?: string;
  public_url?: string;
  alias?: string;
}

/** 入站 receiver 接受的 snapshot（与 `HubControlSnapshot` 同形）。 */
export interface HubNodeSnapshot {
  node_id: string;
  hub_id: string;
  incarnation: string;
  revision: number;
  observed_at: number;
  truncated: boolean;
  counts: { teams: number; agents: number; live_agents: number };
  teams: HubTeamMeta[];
  agents: HubAgentMeta[];
}

export interface HubNodePointer {
  node_id: string;
  hub_id: string;
  team_id: string;
  request_id?: string;
  reason: HubPointerReason;
  ts: number;
}

/** `POST /v1/hub/join` 成功后交给 runtime 落目录的输入。 */
export interface HubNodeJoinedInput {
  pairing_id: string;
  node_id: string;
  tenant_id: string;
  node_token_id: string;
  /** 已归一化的浏览器可达 origin；缺省表示数据面不可达。 */
  public_url?: string;
  alias?: string;
}

/** hub 入站连接的状态回调；由 runtime 提供。 */
export interface HubNodeInboundHooks {
  onSnapshot(pairingId: string, snapshot: HubNodeSnapshot): void;
  onPointer(pointer: HubNodePointer): void;
  onStatus(pairingId: string, status: HubNodeStatus, error?: string): void;
  /** join 成功；由 runtime 构造并 upsert 目录记录。 */
  onJoined?(input: HubNodeJoinedInput): void;
}

/** `/v1/hub/node-control` 的依赖。 */
export interface HubNodeInboundDeps {
  hubId: string;
  joinStore: HubJoinStoreLike;
  credentials: HubNodeCredentialStoreLike;
  hooks: HubNodeInboundHooks;
  authTimeoutMs?: number;
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
  logger?: Logger;
}
