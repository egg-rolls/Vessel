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
  nodeId: string;
  teamId: string;
  direction: FederationDirection;
  localTeamId?: string;
  url?: string;
  caFile?: string;
  tokenEnv: string;
  /** 解析后的内存值；只用于出站 / 入站比较，不序列化。 */
  token: string;
  /** 入站 team-info 目录查询开关；只有显式 `true` 才开启。 */
  allowDirectory: boolean;
}

export interface FederationRuntimeOptions {
  enabled: boolean;
  nodeId: string;
  maxHops: number;
  /** 每 peer 入站速率上限；合法范围 1..600（DECISION-037 §9，无“不限制”值）。 */
  rateLimitPerMinute: number;
  /** 已解析 token 的 peer；缺失 token 的条目不在其中。 */
  peers: FederationRuntimePeer[];
}

export type FederationResolutionIssue =
  | { peer: string; reason: 'missing_token' }
  | { peer: string; reason: 'self_peer' }
  | { peer: string; reason: 'invalid_config' };

const DEFAULT_MAX_HOPS = 4;

/** 缺省每 peer 每分钟入站上限；合法范围 1..600。 */
const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
const MAX_RATE_LIMIT_PER_MINUTE = 600;

/** 归一化 `rateLimitPerMinute`：1..600 采用；缺失 / 越界回缺省。 */
function resolveRateLimit(value: unknown): number {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_RATE_LIMIT_PER_MINUTE
  ) {
    return value;
  }
  return DEFAULT_RATE_LIMIT_PER_MINUTE;
}

function peerLabel(peer: FederationPeerConfig, index: number): string {
  const node = typeof peer.nodeId === 'string' ? peer.nodeId : `#${index}`;
  const team = typeof peer.teamId === 'string' ? peer.teamId : '?';
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
      typeof peer.nodeId !== 'string' ||
      typeof peer.teamId !== 'string' ||
      typeof peer.tokenEnv !== 'string'
    ) {
      issues.push({ peer: label, reason: 'invalid_config' });
      return;
    }
    // node.json 解析出的本机身份这里才可知；自指 peer 直接丢弃（fail closed）。
    if (peer.nodeId === input.nodeId) {
      issues.push({ peer: label, reason: 'self_peer' });
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
      nodeId: peer.nodeId,
      teamId: peer.teamId,
      direction,
      tokenEnv: peer.tokenEnv,
      token,
      allowDirectory: peer.allowDirectory === true,
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

  const rateLimitPerMinute = resolveRateLimit(federation?.rateLimitPerMinute);

  return {
    options: {
      enabled: federation?.enabled === true,
      nodeId: input.nodeId,
      maxHops,
      rateLimitPerMinute,
      peers,
    },
    issues,
  };
}
