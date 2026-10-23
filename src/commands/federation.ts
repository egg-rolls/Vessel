/**
 * `vessel federation post|peers`（0.20 S7.1）。
 *
 * 只做参数映射、Team 存在性检查、配置归一化与渲染；
 * wire / allowlist / 网络在 `src/federation-client.ts`，Team 数据不改。
 *
 * - `post` 先确认 `<dataDir>/teams/default/<from_team>/team.json` 存在；
 * - `peers` 只输出 peer 身份与 token 是否已设置，绝不输出 token 值；
 * - exit：成功 0，对端拒绝 1，用法 / 配置错误 2。
 *
 * @module vessel/commands/federation
 */

import { join } from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import type { CommandResult } from '../agent-command';
import type { FederationCommand } from '../cli-args';
import {
  FederationClientError,
  type FederationPostResult,
  postFederation,
} from '../federation-client';
import { resolveFederationOptions } from '../federation-config';
import { t } from '../i18n';
import { resolveNodeId } from '../node-identity';
import { ui } from '../ui-style';

/** v1 固定 tenant（DECISION-036 §2） */
const FEDERATION_TENANT = 'default';

/** 与 validator / TeamService 的 team_id 形状一致 */
const TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface FederationCommandOptions {
  dataDir: string;
  config: VesselConfig;
  /** 测试注入 */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface PeerView {
  node_id: string;
  team_id: string;
  direction: 'in' | 'out' | 'both';
  token_env: string;
  token_set: boolean;
  local_team_id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(code: string, detail: string, exitCode = 1): CommandResult {
  return { exitCode, stdout: '', stderr: `${code}: ${detail}` };
}

/** 配置里的 peer 列表（含缺 token 的条目，便于 peers 显示 token_set） */
function configuredPeers(
  config: VesselConfig,
  env: Record<string, string | undefined>,
): PeerView[] {
  const configured = Array.isArray(config.federation?.peers) ? config.federation.peers : [];
  const peers: PeerView[] = [];
  for (const peer of configured) {
    if (!isRecord(peer)) continue;
    if (
      typeof peer.node_id !== 'string' ||
      typeof peer.team_id !== 'string' ||
      typeof peer.tokenEnv !== 'string'
    ) {
      continue;
    }
    const direction = peer.direction === 'in' || peer.direction === 'out' ? peer.direction : 'both';
    const token = env[peer.tokenEnv];
    const view: PeerView = {
      node_id: peer.node_id,
      team_id: peer.team_id,
      direction,
      token_env: peer.tokenEnv,
      token_set: typeof token === 'string' && token !== '',
    };
    if (typeof peer.localTeamId === 'string' && peer.localTeamId !== '') {
      view.local_team_id = peer.localTeamId;
    }
    peers.push(view);
  }
  return peers;
}

function formatPeers(enabled: boolean, nodeId: string, maxHops: number, peers: PeerView[]): string {
  const lines = [
    ui.section(
      t('federation.peers.title', {
        state: enabled ? t('federation.peers.enabled') : t('federation.peers.disabled'),
      }),
    ),
    ui.kv('node_id', nodeId),
    ui.kv('max_hops', String(maxHops)),
    '',
    ui.section(`Peers (${peers.length}):`),
  ];
  if (peers.length === 0) {
    lines.push(`  ${ui.dim(t('federation.peers.empty'))}`);
    return lines.join('\n');
  }
  for (const peer of peers) {
    lines.push(
      t('federation.peers.row', {
        node: peer.node_id,
        team: peer.team_id,
        direction: peer.direction,
        tokenEnv: peer.token_env,
        token: peer.token_set ? t('federation.peers.tokenSet') : t('federation.peers.tokenUnset'),
      }),
    );
  }
  return lines.join('\n');
}

function formatPostResult(
  result: FederationPostResult,
  peer: { nodeId: string; teamId: string },
): string {
  const target = `${peer.nodeId}:${peer.teamId}`;
  if (result.status === 'rejected') {
    return ui.err(t('federation.post.rejected', { code: result.code, reason: result.reason }));
  }
  return ui.ok(
    t(
      result.status === 'deduplicated'
        ? 'federation.post.deduplicated'
        : 'federation.post.delivered',
      { messageId: result.message_id, peer: target, hop: result.hop },
    ),
  );
}

async function peersCommand(
  command: Extract<FederationCommand, { kind: 'peers' }>,
  options: FederationCommandOptions,
): Promise<CommandResult> {
  const env = options.env ?? process.env;
  let nodeId: string;
  try {
    nodeId = await resolveNodeId({
      dataDir: options.dataDir,
      ...(options.config.host?.nodeId !== undefined
        ? { configNodeId: options.config.host.nodeId }
        : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure('federation_error', detail, 2);
  }

  const { options: runtime, issues } = resolveFederationOptions({
    ...(options.config.federation !== undefined ? { federation: options.config.federation } : {}),
    nodeId,
    env,
  });
  const peers = configuredPeers(options.config, env);

  for (const issue of issues) {
    if (issue.reason === 'missing_token') {
      console.error(ui.warn(`federation peer ${issue.peer}: token env is not set`));
    } else {
      console.error(ui.warn(`federation peer ${issue.peer}: invalid config (skipped)`));
    }
  }

  if (command.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          enabled: runtime.enabled,
          node_id: runtime.nodeId,
          max_hops: runtime.maxHops,
          peers,
        },
        null,
        2,
      ),
      stderr: '',
    };
  }
  return {
    exitCode: 0,
    stdout: formatPeers(runtime.enabled, runtime.nodeId, runtime.maxHops, peers),
    stderr: '',
  };
}

async function postCommand(
  command: Extract<FederationCommand, { kind: 'post' }>,
  options: FederationCommandOptions,
): Promise<CommandResult> {
  if (!TEAM_ID_RE.test(command.fromTeam)) {
    return failure(
      'federation_invalid',
      t('federation.error.invalidFromTeam', { id: command.fromTeam }),
      2,
    );
  }
  const metadataPath = join(
    options.dataDir,
    'teams',
    FEDERATION_TENANT,
    command.fromTeam,
    'team.json',
  );
  if (!(await Bun.file(metadataPath).exists())) {
    return failure(
      'team_not_found',
      t('federation.error.teamNotFound', { team: command.fromTeam, path: metadataPath }),
    );
  }

  let nodeId: string;
  try {
    nodeId = await resolveNodeId({
      dataDir: options.dataDir,
      ...(options.config.host?.nodeId !== undefined
        ? { configNodeId: options.config.host.nodeId }
        : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure('federation_error', detail, 2);
  }

  const env = options.env ?? process.env;
  const { options: runtime } = resolveFederationOptions({
    ...(options.config.federation !== undefined ? { federation: options.config.federation } : {}),
    nodeId,
    env,
  });

  let result: FederationPostResult;
  try {
    result = await postFederation(
      runtime,
      {
        to: { node_id: command.nodeId, team_id: command.teamId },
        fromTeamId: command.fromTeam,
        content: command.content,
        ...(command.conversationId !== undefined
          ? { conversation_id: command.conversationId }
          : {}),
      },
      {
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      },
    );
  } catch (error) {
    if (error instanceof FederationClientError) {
      return failure(error.code, error.message, 2);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return failure('federation_error', detail, 2);
  }

  if (command.json) {
    return {
      exitCode: result.status === 'rejected' ? 1 : 0,
      stdout: JSON.stringify(result, null, 2),
      stderr: '',
    };
  }

  const text = formatPostResult(result, { nodeId: command.nodeId, teamId: command.teamId });
  if (result.status === 'rejected') {
    return { exitCode: 1, stdout: '', stderr: text };
  }
  return { exitCode: 0, stdout: text, stderr: '' };
}

/** 执行一个 federation 子命令；不抛错，错误转 exitCode / stderr */
export async function runFederationCommand(
  command: FederationCommand,
  options: FederationCommandOptions,
): Promise<CommandResult> {
  if (command.kind === 'peers') return peersCommand(command, options);
  return postCommand(command, options);
}
