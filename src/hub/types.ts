/**
 * Hub 进程共享契约（S5）。
 *
 * 这里只放 registry / secret / token broker 的纯类型，避免 Wave 1 的
 * M 之间互相 import 实现文件。
 *
 * @module vessel/hub/types
 */

import type { HubAgentMeta, HubTeamMeta } from '../../packages/serve/src/hub-control.js';

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

/** 目录中的单个 pairing。禁止字段见 PLAN §8.2。 */
export interface HubNodeRecord {
  pairing_id: string;
  node_id: string;
  tenant_id: string;
  alias?: string;
  url: string;
  ca_file?: string;
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
