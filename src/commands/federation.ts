/**
 * `vessel federation post|peers`（0.20 S7.1；0.21 地址寻址）。
 *
 * 只做参数映射、本地预校验、配置归一化与渲染；
 * wire / allowlist / 网络在 `src/federation-client.ts`，Team 数据不改。
 *
 * - `post` 先解析 `--to` / `--from`，再确认本机 node、Team 与 principal；
 *   任一步失败 exit 2，**零网络请求**；
 * - `peers` 只输出 peer 身份、allow_directory 与 token 是否已设置，绝不输出 token 值；
 * - exit：成功 0，对端拒绝 1，用法 / 配置错误 2。
 *
 * @module vessel/commands/federation
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import type { CommandResult } from '../agent-command';
import type { FederationCommand } from '../cli-args';
import {
  FEDERATION_INVALID_ADDRESS,
  type FederationAddress,
  formatFederationAddress,
  parseFederationAddress,
} from '../federation-address';
import {
  FederationClientError,
  type FederationPostResult,
  type FederationTeamInfoResult,
  postFederation,
  postFederationTeamInfo,
} from '../federation-client';
import { resolveFederationOptions } from '../federation-config';
import { t } from '../i18n';
import { resolveNodeId } from '../node-identity';
import { ui } from '../ui-style';

/** v1 固定 tenant（DECISION-036 §2） */
const FEDERATION_TENANT = 'default';

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
  allow_directory: boolean;
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
      typeof peer.nodeId !== 'string' ||
      typeof peer.teamId !== 'string' ||
      typeof peer.tokenEnv !== 'string'
    ) {
      continue;
    }
    const direction = peer.direction === 'in' || peer.direction === 'out' ? peer.direction : 'both';
    const token = env[peer.tokenEnv];
    const view: PeerView = {
      node_id: peer.nodeId,
      team_id: peer.teamId,
      direction,
      token_env: peer.tokenEnv,
      token_set: typeof token === 'string' && token !== '',
      allow_directory: peer.allowDirectory === true,
    };
    if (typeof peer.localTeamId === 'string' && peer.localTeamId !== '') {
      view.local_team_id = peer.localTeamId;
    }
    peers.push(view);
  }
  return peers;
}

function formatPeers(
  enabled: boolean,
  nodeId: string,
  maxHops: number,
  rateLimitPerMinute: number,
  peers: PeerView[],
): string {
  const lines = [
    ui.section(
      t('federation.peers.title', {
        state: enabled ? t('federation.peers.enabled') : t('federation.peers.disabled'),
      }),
    ),
    ui.kv('node_id', nodeId),
    ui.kv('max_hops', String(maxHops)),
    ui.kv('rate_limit_per_minute', String(rateLimitPerMinute)),
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
        allowDir: String(peer.allow_directory),
        tokenEnv: peer.token_env,
        token: peer.token_set ? t('federation.peers.tokenSet') : t('federation.peers.tokenUnset'),
      }),
    );
  }
  return lines.join('\n');
}

function formatPostResult(result: FederationPostResult, to: FederationAddress): string {
  const target = formatFederationAddress(to);
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

/** 人类可读目录：名字 / 描述 / 默认接头人 / 在线数 / 成员活跃度。 */
function formatTeamInfo(result: Extract<FederationTeamInfoResult, { status: 'ok' }>): string {
  const team = result.team;
  const lines: string[] = [
    ui.section(t('federation.teamInfo.title', { teamId: team.team_id })),
    ui.kv('name', team.name),
    ui.kv('description', team.description ?? ''),
    ui.kv('default_principal', team.default_principal ?? ''),
    ui.kv(
      'members',
      `${team.member_count} (${t('federation.teamInfo.online', {
        online: team.online_count,
        total: team.member_count,
      })})`,
    ),
    '',
    ui.section(t('federation.teamInfo.members', { count: team.members.length })),
  ];
  if (team.members.length === 0) {
    lines.push(`  ${ui.dim(t('federation.teamInfo.empty'))}`);
    return lines.join('\n');
  }
  for (const member of team.members) {
    const lastSeen =
      member.last_seen !== undefined ? new Date(member.last_seen).toISOString() : '-';
    lines.push(
      t('federation.teamInfo.memberRow', {
        name: member.name,
        presence: member.presence,
        lastSeen,
      }),
    );
  }
  return lines.join('\n');
}

async function teamInfoCommand(
  command: Extract<FederationCommand, { kind: 'team-info' }>,
  options: FederationCommandOptions,
): Promise<CommandResult> {
  // 非法地址在任何 I/O / 网络之前 exit 2；principal 不参与 team 查询。
  const to = parseAddressFlag('--to', command.to);
  if ('exitCode' in to) return to;

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

  let result: FederationTeamInfoResult;
  try {
    result = await postFederationTeamInfo(
      runtime,
      { to, ...(command.members !== undefined ? { members_limit: command.members } : {}) },
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

  if (result.status === 'rejected') {
    return {
      exitCode: 1,
      stdout: '',
      stderr: ui.err(
        t('federation.teamInfo.rejected', { code: result.code, reason: result.reason }),
      ),
    };
  }
  return { exitCode: 0, stdout: formatTeamInfo(result), stderr: '' };
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
    } else if (issue.reason === 'self_peer') {
      console.error(ui.warn(`federation peer ${issue.peer}: node id equals this node (skipped)`));
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
          rate_limit_per_minute: runtime.rateLimitPerMinute,
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
    stdout: formatPeers(
      runtime.enabled,
      runtime.nodeId,
      runtime.maxHops,
      runtime.rateLimitPerMinute,
      peers,
    ),
    stderr: '',
  };
}

/** 解析一个地址 flag；非法时返回可直接返回给 CLI 的用法错误。 */
function parseAddressFlag(flag: '--to' | '--from', raw: string): FederationAddress | CommandResult {
  const parsed = parseFederationAddress(raw);
  if (!parsed.ok) {
    return failure(
      FEDERATION_INVALID_ADDRESS,
      t('federation.error.invalidAddress', { flag, message: parsed.message }),
      2,
    );
  }
  return parsed.address;
}

/**
 * 读取本机成员快照中指定 Team 的 present、非 private 名字。
 * 快照缺失 / 损坏返回 `ok:false`（调用方 exit 2，不新建第二套 roster）。
 */
async function readLocalMemberNames(
  dataDir: string,
  teamId: string,
): Promise<{ ok: true; names: Set<string> } | { ok: false; path: string }> {
  const path = join(dataDir, 'agents', `${FEDERATION_TENANT}.json`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { ok: false, path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, path };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.members)) return { ok: false, path };

  const names = new Set<string>();
  for (const member of parsed.members) {
    if (!isRecord(member)) continue;
    if (member.team_id !== teamId) continue;
    if (member.membership !== 'present') continue;
    if (member.visibility === 'private') continue;
    if (typeof member.name === 'string' && member.name !== '') names.add(member.name);
  }
  return { ok: true, names };
}

async function postCommand(
  command: Extract<FederationCommand, { kind: 'post' }>,
  options: FederationCommandOptions,
): Promise<CommandResult> {
  // 1. 地址形状；非法地址在任何 I/O / 网络之前 exit 2。
  const to = parseAddressFlag('--to', command.to);
  if ('exitCode' in to) return to;
  const from = parseAddressFlag('--from', command.from);
  if ('exitCode' in from) return from;

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

  // 2. `--from` 必须是本机节点（发送节点自证，但也只能自证本机）。
  if (from.node_id !== nodeId) {
    return failure(
      'federation_invalid_from',
      t('federation.error.fromNodeMismatch', { node: from.node_id, local: nodeId }),
      2,
    );
  }

  // 3. `--from.team_id` 必须是本机存在的 Team。
  const metadataPath = join(options.dataDir, 'teams', FEDERATION_TENANT, from.team_id, 'team.json');
  if (!(await Bun.file(metadataPath).exists())) {
    return failure(
      'team_not_found',
      t('federation.error.teamNotFound', { team: from.team_id, path: metadataPath }),
      2,
    );
  }

  // 4. `--from.principal` 必须是该 Team 的 present 非 private 成员，或 `human`。
  if (from.principal !== 'human') {
    const snapshot = await readLocalMemberNames(options.dataDir, from.team_id);
    if (!snapshot.ok) {
      return failure(
        'federation_invalid_from',
        t('federation.error.rosterUnavailable', { path: snapshot.path }),
        2,
      );
    }
    if (!snapshot.names.has(from.principal)) {
      return failure(
        'federation_invalid_from',
        t('federation.error.unknownPrincipal', {
          principal: from.principal,
          team: from.team_id,
        }),
        2,
      );
    }
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
        from,
        to,
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

  const text = formatPostResult(result, to);
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
  if (command.kind === 'team-info') return teamInfoCommand(command, options);
  return postCommand(command, options);
}
