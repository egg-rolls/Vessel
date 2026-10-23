/**
 * 节点 side 的 `NodeTokenControlLike` 实现（S5）。
 *
 * 组合 `hub-pairing`（一次性配对码）与 `node-token-store`（token hash 存储）：
 * - 配对：消费 code 后一次签发 `view` + `exchange`（30 天）；
 * - exchange：把 `exchange` / `admin` principal 换成按 team 收窄的短期 `control`；
 * - revoke / list：仅 admin。
 *
 * 明文 token 只出现在签发返回值中，日志只记录 `token_id`。
 *
 * @module vessel/node-token-control
 */

import type { Logger } from '@vessel-agent/core';
import type { Principal } from '../packages/config/src/index';
import {
  CONTROL_TOKEN_DEFAULT_TTL_S,
  CONTROL_TOKEN_MAX_TTL_S,
  type ExchangeTokenInput,
  type IssuedNodeToken,
  type MintPairingTokensInput,
  type NodeTokenControlLike,
  type NodeTokenMeta,
  PAIRING_TOKEN_TTL_MS,
  type PairingTokenPair,
  type RevokeTokenResult,
} from '../packages/serve/src/index';
import { pairingIdFor } from './hub/types';
import { consumePairingCode } from './hub-pairing';
import { type IssueNodeTokenResult, NodeTokenStore } from './node-token-store';

export interface CreateNodeTokenControlOptions {
  dataDir: string;
  tenantId: string;
  nodeId: string;
  logger?: Logger;
  /** 可注入时钟（测试用）；缺省 `Date.now`。 */
  now?: () => number;
}

function controlError(code: string, reason: string): Error {
  return Object.assign(new Error(`${code}: ${reason}`), { code });
}

function isAdmin(principal: Principal): boolean {
  return principal.role === 'admin' || principal.scope === 'admin';
}

function normalizeTtlSeconds(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return CONTROL_TOKEN_DEFAULT_TTL_S;
  }
  return Math.min(CONTROL_TOKEN_MAX_TTL_S, Math.floor(value));
}

/**
 * 创建节点 token 控制面；会先加载 `<dataDir>/hub-tokens.json`。
 * 文件损坏时抛 `hub_tokens_corrupt`（不得静默重建）。
 */
export async function createNodeTokenControl(
  options: CreateNodeTokenControlOptions,
): Promise<NodeTokenControlLike> {
  const { dataDir, tenantId, nodeId, logger } = options;
  const clock = options.now ?? Date.now;
  const store = new NodeTokenStore({ dataDir, now: clock });
  await store.load();

  const pairingId = pairingIdFor(nodeId, tenantId);

  function toIssued(
    result: IssueNodeTokenResult,
    extras: { hub_id?: string; team_id?: string; pairing_id?: string } = {},
  ): IssuedNodeToken {
    const issued: IssuedNodeToken = {
      token: result.token,
      token_id: result.record.token_id,
      scope: result.record.scope,
      tenant_id: result.record.tenant_id,
      node_id: nodeId,
      expires_at: result.record.expires_at,
    };
    if (extras.hub_id !== undefined) issued.hub_id = extras.hub_id;
    if (extras.team_id !== undefined) issued.team_id = extras.team_id;
    if (extras.pairing_id !== undefined) issued.pairing_id = extras.pairing_id;
    return issued;
  }

  return {
    authenticate(token: string): Principal | null {
      return store.authenticate(token);
    },

    hasTokens(): boolean {
      return store.hasTokens();
    },

    async mintPairingTokens(input: MintPairingTokensInput): Promise<PairingTokenPair> {
      if (input.direction !== 'hub') {
        throw controlError('unsupported_direction', `direction=${String(input.direction)}`);
      }

      const consumed = await consumePairingCode({
        dataDir,
        code: input.code,
        now: clock(),
      });
      if (consumed.tenant_id !== tenantId) {
        throw controlError('pairing_invalid', 'pairing tenant does not match this node');
      }

      const viewResult = await store.issue('view', tenantId, {
        hub_id: input.hub_id,
        issued_by: 'pairing',
        ttl_ms: PAIRING_TOKEN_TTL_MS,
      });
      const exchangeResult = await store.issue('exchange', tenantId, {
        hub_id: input.hub_id,
        issued_by: 'pairing',
        ttl_ms: PAIRING_TOKEN_TTL_MS,
      });

      logger?.info('node.pairing.minted', {
        node_id: nodeId,
        tenant_id: tenantId,
        hub_id: input.hub_id,
        pairing_id: pairingId,
        view_token_id: viewResult.record.token_id,
        exchange_token_id: exchangeResult.record.token_id,
      });

      return {
        node_id: nodeId,
        tenant_id: tenantId,
        pairing_id: pairingId,
        view: toIssued(viewResult, { hub_id: input.hub_id, pairing_id: pairingId }),
        exchange: toIssued(exchangeResult, { hub_id: input.hub_id, pairing_id: pairingId }),
      };
    },

    async exchange(principal: Principal, input: ExchangeTokenInput): Promise<IssuedNodeToken> {
      // 静态 admin token（serve.token / admin_token）没有 scope；与 handler 放行规则一致。
      if (principal.scope !== 'exchange' && !isAdmin(principal)) {
        throw controlError('forbidden', 'exchange requires exchange or admin scope');
      }
      const tenant = principal.tenant_id;
      if (typeof tenant !== 'string' || tenant === '' || tenant === '*') {
        throw controlError('invalid_tenant', 'exchange requires a concrete tenant');
      }
      const teamId = input.team_id;
      if (typeof teamId !== 'string' || teamId === '') {
        throw controlError('invalid_team', 'team_id is required');
      }

      const ttlSeconds = normalizeTtlSeconds(input.ttl_s);
      const result = await store.issue('control', tenant, {
        team_id: teamId,
        ...(principal.hub_id !== undefined ? { hub_id: principal.hub_id } : {}),
        issued_by: principal.token_id ?? principal.scope ?? 'admin',
        ttl_ms: ttlSeconds * 1000,
      });

      logger?.info('node.token.exchanged', {
        node_id: nodeId,
        tenant_id: tenant,
        team_id: teamId,
        token_id: result.record.token_id,
        ttl_s: ttlSeconds,
      });

      return toIssued(result, { hub_id: principal.hub_id, team_id: teamId });
    },

    async revoke(principal: Principal, tokenId: string): Promise<RevokeTokenResult> {
      if (!isAdmin(principal)) {
        throw controlError('forbidden', 'revoke requires admin');
      }
      const result = await store.revoke(tokenId);
      if (result === null) {
        throw controlError('token_not_found', tokenId);
      }
      if (result.changed) {
        logger?.info('node.token.revoked', { node_id: nodeId, token_id: tokenId });
      }
      return { token_id: result.token_id, revoked_at: result.revoked_at };
    },

    async list(principal: Principal): Promise<NodeTokenMeta[]> {
      if (!isAdmin(principal)) {
        throw controlError('forbidden', 'list requires admin');
      }
      return store.list();
    },

    onRevoke(listener: (tokenId: string) => void): () => void {
      return store.onRevoke(listener);
    },
  };
}
