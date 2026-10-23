/**
 * S7 federation 配置归一化（asm 层）。
 *
 * validator 只做 schema 校验；这里把 YAML 形状变成运行时形状：
 * - `tokenEnv` 只在此处解析为内存 token，绝不落盘 / 打印；
 * - 缺 token 的 peer 直接丢弃（fail closed），不生成空凭据；
 * - URL 去尾斜杠；direction 缺省 both；maxHops 缺省 4。
 *
 * @module vessel/federation-config
 */

import type { FederationConfig, FederationPeerConfig } from '../packages/config/src/index';

export type FederationDirection = 'in' | 'out' | 'both';

export interface FederationRuntimePeer {
  node_id: string;
  team_id: string;
  direction: FederationDirection;
  localTeamId?: string;
  url?: string;
  caFile?: string;
  tokenEnv: string;
  /** 解析后的内存值；只用于出站 / 入站比较，不序列化。 */
  token: string;
}

export interface FederationRuntimeOptions {
  enabled: boolean;
  nodeId: string;
  maxHops: number;
  /** 已解析 token 的 peer；缺失 token 的条目不在其中。 */
  peers: FederationRuntimePeer[];
}

export type FederationResolutionIssue =
  | { peer: string; reason: 'missing_token' }
  | { peer: string; reason: 'invalid_config' };

const DEFAULT_MAX_HOPS = 4;

function peerLabel(peer: FederationPeerConfig, index: number): string {
  const node = typeof peer.node_id === 'string' ? peer.node_id : `#${index}`;
  const team = typeof peer.team_id === 'string' ? peer.team_id : '?';
  return `${node}:${team}`;
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * 归一化 federation 配置。
 *
 * `env` 缺省读 `process.env`；测试传显式 map。
 */
export function resolveFederationOptions(input: {
  federation?: FederationConfig;
  nodeId: string;
  env?: Record<string, string | undefined>;
}): { options: FederationRuntimeOptions; issues: FederationResolutionIssue[] } {
  const env = input.env ?? process.env;
  const federation = input.federation;
  const issues: FederationResolutionIssue[] = [];
  const peers: FederationRuntimePeer[] = [];

  const configured = Array.isArray(federation?.peers) ? federation.peers : [];
  configured.forEach((peer, index) => {
    if (peer === null || typeof peer !== 'object') {
      issues.push({ peer: `#${index}`, reason: 'invalid_config' });
      return;
    }
    const label = peerLabel(peer, index);
    if (
      typeof peer.node_id !== 'string' ||
      typeof peer.team_id !== 'string' ||
      typeof peer.tokenEnv !== 'string'
    ) {
      issues.push({ peer: label, reason: 'invalid_config' });
      return;
    }
    const token = env[peer.tokenEnv];
    if (typeof token !== 'string' || token === '') {
      issues.push({ peer: label, reason: 'missing_token' });
      return;
    }
    const direction: FederationDirection =
      peer.direction === 'in' || peer.direction === 'out' ? peer.direction : 'both';
    const resolved: FederationRuntimePeer = {
      node_id: peer.node_id,
      team_id: peer.team_id,
      direction,
      tokenEnv: peer.tokenEnv,
      token,
    };
    if (typeof peer.localTeamId === 'string' && peer.localTeamId !== '') {
      resolved.localTeamId = peer.localTeamId;
    }
    if (typeof peer.url === 'string' && peer.url.trim() !== '') {
      resolved.url = trimTrailingSlashes(peer.url.trim());
    }
    if (typeof peer.caFile === 'string' && peer.caFile.trim() !== '') {
      resolved.caFile = peer.caFile.trim();
    }
    peers.push(resolved);
  });

  const maxHops =
    typeof federation?.maxHops === 'number' &&
    Number.isInteger(federation.maxHops) &&
    federation.maxHops >= 1 &&
    federation.maxHops <= 16
      ? federation.maxHops
      : DEFAULT_MAX_HOPS;

  return {
    options: {
      enabled: federation?.enabled === true,
      nodeId: input.nodeId,
      maxHops,
      peers,
    },
    issues,
  };
}
