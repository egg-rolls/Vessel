/**
 * 节点 scoped token 控制面（S5）。
 *
 * 节点只存 token 的 SHA-256 hash；明文只在签发响应中出现一次。
 *
 * scope：
 * - `view`：只读目录，用于 hub 的 control 通道；
 * - `exchange`：只能为本人 tenant 的 team 换短期 `control` token；
 * - `control`：按 team 收窄的 data-plane token；
 * - `admin`：节点管理 + token 管理。
 *
 * @module @vessel-agent/serve/node-token-control
 */

import type { Principal, PrincipalScope } from '@vessel-agent/config';

export type NodeTokenScope = Extract<PrincipalScope, 'view' | 'exchange' | 'control' | 'admin'>;

/** 配对签发 view + exchange 两枚 token，TTL 30 天。 */
export const PAIRING_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** control token 默认 / 最大 TTL（秒）。 */
export const CONTROL_TOKEN_DEFAULT_TTL_S = 3600;
export const CONTROL_TOKEN_MAX_TTL_S = 86_400;

/** 明文 token 的签发结果；只在响应中出现一次。 */
export interface IssuedNodeToken {
  token: string;
  token_id: string;
  scope: NodeTokenScope;
  tenant_id: string;
  node_id: string;
  hub_id?: string;
  team_id?: string;
  pairing_id?: string;
  expires_at: number;
}

/** token 元数据；永不含 token / hash。 */
export interface NodeTokenMeta {
  token_id: string;
  scope: NodeTokenScope;
  tenant_id: string;
  hub_id?: string;
  team_id?: string;
  issued_by: string;
  created_at: number;
  expires_at: number;
  revoked_at?: number;
}

/** 一次配对同时签发两枚 token。 */
export interface PairingTokenPair {
  node_id: string;
  tenant_id: string;
  pairing_id: string;
  view: IssuedNodeToken;
  exchange: IssuedNodeToken;
}

export interface MintPairingTokensInput {
  hub_id: string;
  code: string;
  /** S5 只接受 'hub'；'node' 预留给 S5.1。 */
  direction: 'hub' | 'node';
}

export interface ExchangeTokenInput {
  team_id: string;
  ttl_s?: number;
}

export interface RevokeTokenResult {
  token_id: string;
  revoked_at: number;
}

/**
 * 节点侧 token 控制面。由 app 层实现并注入 gateway。
 *
 * `authenticate` 供 `resolveGatewayAuth` 同步查询内存快照；
 * `onRevoke` 由 gateway 注册，用于关闭匹配的 live WS。
 */
/** `resolveGatewayAuth` 只需要同步认证面。 */
export interface NodeTokenAuthenticator {
  authenticate(token: string): Principal | null;
  /** 是否存在未吊销、未过期的动态 token（用于 configured 判定）。 */
  hasTokens?(): boolean;
}

export interface NodeTokenControlLike extends NodeTokenAuthenticator {
  mintPairingTokens(input: MintPairingTokensInput): Promise<PairingTokenPair>;
  exchange(principal: Principal, input: ExchangeTokenInput): Promise<IssuedNodeToken>;
  revoke(principal: Principal, tokenId: string): Promise<RevokeTokenResult>;
  list(principal: Principal): Promise<NodeTokenMeta[]>;
  onRevoke(listener: (tokenId: string) => void): () => void;
}
