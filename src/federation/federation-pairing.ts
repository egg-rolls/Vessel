/**
 * q-fed-simple：入站配对握手的 asm 实现（`FederationPairingPort`）。
 *
 * 判定镜像 hub `decideJoinRegistration` 的形状：
 * - 带 code → 消费（hash / TTL / 单次；校验失败不烧码）；
 * - 无 code + 回环 socket → 同机自助放行（信任边界 = 同机同用户，与
 *   `/v1/local/token` 既有拍板同口径）；
 * - 无 code + 非回环 → 400 `code_required`。
 *
 * 成功后：生成 32 字节随机共享 token → 存 SecretStore（key `peer:<发起方>`）→
 * upsert 用户配置 peer 条目（`token_secret:true`）→ 进程内热应用（best-effort，
 * 配置监听兜底）→ 返回 `{nodeId: 本机, teamId: 本机配对 team, token}`。
 * 明文 token 只在返回值出现一次；绝不进日志 / 事件 / 配置。
 *
 * 重复配对 = 轮转 token（幂等修复）：secret 覆盖写，peer 条目整条替换。
 *
 * @module vessel/federation-pairing
 */

import { randomBytes } from 'node:crypto';
import type { Logger } from '@vessel-agent/core';
import type {
  FederationPairingPort,
  FederationPairOutcome,
  TeamControlLike,
} from '../../packages/serve/src/index';
import { createFederationPairStore, type FederationPairStore } from './federation-pair-store';
import { upsertPeerEntry } from './federation-peer-store';
import { saveFederationPeerSecret } from './federation-secrets';

export interface FederationPairingDeps {
  dataDir: string;
  /** 本机 node_id（响应身份）。 */
  nodeId: string;
  /** 用户配置路径（peer 条目写入点；与 federation peer add 同口径）。 */
  userConfigPath: string;
  /** 缺省 true；显式 false 时平台密钥库不可用即 fail-closed。 */
  allowFileSecrets?: boolean;
  /** 本机 Team 控制面：校验发起方请求配对的本机 team 存在（不存在不烧码）。 */
  teams?: TeamControlLike;
  /** 进程内热应用（cli 注入 reloadRunner config scope）；失败只 warn，监听兜底。 */
  hotApply?: () => Promise<unknown>;
  logger?: Logger;
  /** 注入面（默认实现见各模块）。 */
  pairStore?: FederationPairStore;
  saveSecret?: (
    options: { dataDir: string; allowFileSecrets?: boolean },
    peer: { nodeId: string; teamId: string },
    token: string,
  ) => Promise<void>;
  upsertPeer?: typeof upsertPeerEntry;
}

function fail(code: string, message: string, status: number): FederationPairOutcome {
  return { ok: false, code, message, status };
}

/** 配对码错误 → HTTP 映射（与 hub join 同语义：过期/已用 410，其余 400）。 */
function pairCodeStatus(code: string): number {
  return code === 'pairing_expired' || code === 'pairing_used' ? 410 : 400;
}

export function createFederationPairingPort(deps: FederationPairingDeps): FederationPairingPort {
  const store = deps.pairStore ?? createFederationPairStore({ dataDir: deps.dataDir });
  const saveSecret = deps.saveSecret ?? saveFederationPeerSecret;
  const upsertPeer = deps.upsertPeer ?? upsertPeerEntry;

  return {
    async pair(input) {
      // 1. 自指 fail closed（任何消费之前）。
      if (input.nodeId === deps.nodeId) {
        return fail('federation_peer_self', 'pair request claims this node identity', 400);
      }

      // 2. 本机落点 team 必须存在（校验在消费之前：404 不烧码）。
      if (deps.teams !== undefined) {
        let team: Awaited<ReturnType<TeamControlLike['get']>>;
        try {
          team = await deps.teams.get(input.peerTeamId);
        } catch {
          team = undefined;
        }
        if (team === undefined) {
          return fail(
            'federation_unknown_team',
            `team ${input.peerTeamId} does not exist on this node`,
            404,
          );
        }
      }

      // 3. 码判定（镜像 decideJoinRegistration）。
      if (input.code !== undefined) {
        try {
          await store.consume({ code: input.code, node_id: input.nodeId });
        } catch (error) {
          const code =
            typeof error === 'object' && error !== null && 'code' in error
              ? String((error as { code: unknown }).code)
              : 'pairing_invalid';
          const message = error instanceof Error ? error.message : String(error);
          return fail(code, message, pairCodeStatus(code));
        }
      } else if (!input.loopback) {
        return fail(
          'code_required',
          'cross-machine pairing requires a one-time code (vessel federation pair-code on the target)',
          400,
        );
      }

      // 4. 生成共享 token（32 字节随机；明文只进 SecretStore 与本次响应）。
      const token = randomBytes(32).toString('hex');
      try {
        await saveSecret(
          {
            dataDir: deps.dataDir,
            allowFileSecrets: deps.allowFileSecrets,
          },
          { nodeId: input.nodeId, teamId: input.teamId },
          token,
        );
      } catch (error) {
        deps.logger?.warn('federation.pair.secret_failed', {
          peer: `${input.nodeId}:${input.teamId}`,
        });
        return fail(
          'federation_secret_write_failed',
          error instanceof Error ? error.message : String(error),
          500,
        );
      }

      // 5. 自动写 peer 配置（secret 已在先：热应用解析不会 missing_token）。
      try {
        await upsertPeer(deps.userConfigPath, {
          nodeId: input.nodeId,
          teamId: input.teamId,
          url: input.url,
          tokenSecret: true,
          direction: 'both',
          ...(input.peerTeamId !== input.teamId ? { localTeamId: input.peerTeamId } : {}),
          allowDirectory: input.allowDirectory,
        });
      } catch (error) {
        deps.logger?.warn('federation.pair.config_failed', {
          peer: `${input.nodeId}:${input.teamId}`,
        });
        return fail(
          'federation_peer_write_failed',
          error instanceof Error ? error.message : String(error),
          500,
        );
      }

      // 6. 进程内热应用（best-effort；失败由配置监听 / 下次启动兜底）。
      if (deps.hotApply !== undefined) {
        try {
          await deps.hotApply();
        } catch (error) {
          deps.logger?.warn('federation.pair.reload_failed', {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      deps.logger?.info('federation.paired', {
        peer_node: input.nodeId,
        peer_team: input.teamId,
        local_team: input.peerTeamId,
        via: input.code !== undefined ? 'code' : 'loopback',
      });
      return { ok: true, nodeId: deps.nodeId, teamId: input.peerTeamId, token };
    },
  };
}
