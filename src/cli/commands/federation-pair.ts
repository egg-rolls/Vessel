/**
 * q-fed-simple：`vessel federation pair-code|join|discover`（自动配对）。
 *
 * - pair-code（target 侧）：出一次性配对码（hash-only 落盘，TTL，单次消费），
 *   明文只打印一次；跨机配对用，同机回环可免码。
 * - join（initiator 侧）：与目标节点 `POST /v1/federation/pair` 握手 → token
 *   自动交换（明文只在响应出现一次）→ 存 SecretStore → 自动写 peer 配置 →
 *   best-effort 热应用。target 侧在握手内已自动写好它那一侧。免 env_file / 免重启。
 * - discover：读本地 hub registry.json（离线读盘，复用 readHubRegistryRecords），
 *   列同机回环节点；join 给 node_id 时用同一份 registry 解析回环 url。
 *
 * token 绝不打印 / 进 argv / 进错误消息；失败明确报错（哪个节点 / 哪一步）。
 * exit：成功 0，对端拒绝 / 不可达 1，用法 / 配置错误 2。
 *
 * @module vessel/commands/federation-pair
 */

import { join, resolve } from 'node:path';
import { startDeadline } from '@vessel-agent/core';
import {
  classifyOrigin,
  getUserConfigPath,
  isLoopbackHostname,
} from '../../../packages/config/src/index';
import { expandHome } from '../../data/data-paths';
import { FEDERATION_PROTOCOL } from '../../federation/federation-client';
import { createFederationPairStore } from '../../federation/federation-pair-store';
import { upsertPeerEntry } from '../../federation/federation-peer-store';
import { saveFederationPeerSecret } from '../../federation/federation-secrets';
import { readHubRegistryRecords } from '../../hub/registry';
import type { HubNodeRecord } from '../../hub/types';
import { t } from '../../i18n';
import { resolveNodeId } from '../../node/node-identity';
import type { FederationCommand } from '../args';
import { ui } from '../output';
import type { CommandResult } from './agent/agent-command';
import type { FederationCommandOptions } from './federation';
import { peerUrlError, reloadLines, tryReloadGateway } from './federation-peer';

/** 与 config validator 同口径。 */
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const PAIR_PATH = '/v1/federation/pair';
const DEFAULT_TIMEOUT_MS = 10_000;

function failure(code: string, detail: string, exitCode = 2): CommandResult {
  return { exitCode, stdout: '', stderr: `${code}: ${detail}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/** `federation pair-code`：target 侧出码（无 HTTP 领码面，与 hub join-code 同范式）。 */
export async function pairCodeCommand(
  command: { kind: 'pair-code'; ttl?: number; json: boolean },
  options: FederationCommandOptions,
): Promise<CommandResult> {
  const store = createFederationPairStore({ dataDir: options.dataDir });
  let issued: { code: string; expires_at: number };
  try {
    issued = await store.issue(command.ttl !== undefined ? { ttl_s: command.ttl } : undefined);
  } catch (error) {
    return failure(
      'federation_pair_write_failed',
      error instanceof Error ? error.message : String(error),
      1,
    );
  }
  const expires = new Date(issued.expires_at).toISOString();
  if (command.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        { code: issued.code, expires_at: issued.expires_at, data_dir: options.dataDir },
        null,
        2,
      ),
      stderr: '',
    };
  }
  return {
    exitCode: 0,
    stdout: [
      ui.ok(t('federation.pairCode.issued', { code: issued.code, expires })),
      ui.dim(t('federation.pairCode.hint')),
    ].join('\n'),
    stderr: '',
  };
}

/** 本地 hub registry 路径（与 gateway-command 同口径：缺省 `<dataDir>/hub`）。 */
function hubRegistryPath(options: FederationCommandOptions): string {
  const configured = options.config.hub?.dataDir;
  const hubDir =
    configured === undefined ? join(options.dataDir, 'hub') : resolve(expandHome(configured));
  return join(hubDir, 'registry.json');
}

/** 记录里的回环入口（entries 优先，其次旧 url / public_url）；无则 undefined。 */
function loopbackUrlOf(record: HubNodeRecord): string | undefined {
  const candidates = [
    ...(record.entries ?? []).map((entry) => entry.url),
    record.url,
    record.public_url,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    if (classifyOrigin(candidate) === 'loopback') return trimTrailingSlashes(candidate);
  }
  return undefined;
}

/** 本机 node base URL 派生（node.hostname/port；通配监听回退 127.0.0.1）。 */
function deriveSelfUrl(options: FederationCommandOptions): string {
  let hostname = options.config.node?.hostname ?? '127.0.0.1';
  if (hostname === '0.0.0.0' || hostname === '::' || hostname === '') hostname = '127.0.0.1';
  const port = options.config.node?.port ?? 8644;
  const scheme = isLoopbackHostname(hostname) ? 'http' : 'https';
  const host = hostname.includes(':') ? `[${hostname}]` : hostname;
  return `${scheme}://${host}:${port}`;
}

type JoinCommand = Extract<FederationCommand, { kind: 'join' }>;

/** `federation join <url|node-id>`：握手 + token 交换 + 自动写配置 + 热应用。 */
export async function joinCommand(
  command: JoinCommand,
  options: FederationCommandOptions,
): Promise<CommandResult> {
  // 1. 本机身份与 team 形状（任何网络之前）。
  let nodeId: string;
  try {
    nodeId = await resolveNodeId({
      dataDir: options.dataDir,
      ...(options.config.host?.nodeId !== undefined
        ? { configNodeId: options.config.host.nodeId }
        : {}),
    });
  } catch (error) {
    return failure('federation_error', error instanceof Error ? error.message : String(error));
  }
  if (!TEAM_ID_RE.test(command.teamId)) {
    return failure(
      'federation_peer_invalid',
      t('federation.peer.invalidTeamId', { value: command.teamId }),
    );
  }
  const peerTeamId = command.peerTeamId ?? command.teamId;
  if (!TEAM_ID_RE.test(peerTeamId)) {
    return failure(
      'federation_peer_invalid',
      t('federation.peer.invalidTeamId', { value: peerTeamId }),
    );
  }
  if (command.selfUrl !== undefined) {
    const message = peerUrlError(command.selfUrl);
    if (message !== null) {
      return failure(
        'federation_peer_invalid',
        t('federation.peer.invalidUrl', { value: command.selfUrl, message }),
      );
    }
  }

  // 2. 目标 URL：显式 http(s) 或 node_id（经本地 hub registry 解析回环入口）。
  let targetUrl: string;
  if (/^https?:\/\//i.test(command.target)) {
    targetUrl = trimTrailingSlashes(command.target);
    const message = peerUrlError(targetUrl);
    if (message !== null) {
      return failure(
        'federation_peer_invalid',
        t('federation.peer.invalidUrl', { value: command.target, message }),
      );
    }
  } else {
    if (!NODE_ID_RE.test(command.target)) {
      return failure(
        'federation_peer_invalid',
        t('federation.peer.invalidNodeId', { value: command.target }),
      );
    }
    if (command.target === nodeId) {
      return failure(
        'federation_peer_self',
        t('federation.peer.selfPeer', { node: command.target }),
      );
    }
    const registryPath = hubRegistryPath(options);
    const records = await readHubRegistryRecords(registryPath);
    const record = records.find((candidate) => candidate.node_id === command.target);
    if (record === undefined) {
      return failure(
        'federation_discover_unknown_node',
        t('federation.join.unknownNode', { node: command.target, path: registryPath }),
        1,
      );
    }
    const url = loopbackUrlOf(record);
    if (url === undefined) {
      return failure(
        'federation_discover_no_loopback',
        t('federation.join.noLoopback', { node: command.target }),
        1,
      );
    }
    targetUrl = url;
  }

  const selfUrl =
    command.selfUrl !== undefined ? trimTrailingSlashes(command.selfUrl) : deriveSelfUrl(options);

  // 3. 握手。token 只在响应体出现一次；绝不进错误消息 / 输出。
  const payload = {
    protocol: FEDERATION_PROTOCOL,
    node_id: nodeId,
    team_id: command.teamId,
    peer_team_id: peerTeamId,
    url: selfUrl,
    allow_directory: command.allowDirectory,
    ...(command.code !== undefined ? { code: command.code } : {}),
  };
  const deadline = startDeadline(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${targetUrl}${PAIR_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: deadline.signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure(
      'federation_peer_unreachable',
      t('federation.join.unreachable', { url: targetUrl, detail }),
      1,
    );
  } finally {
    deadline.dispose();
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const detail = isRecord(body) && isRecord(body.error) ? body.error : {};
    const code = typeof detail.code === 'string' ? detail.code : `http_${response.status}`;
    const message = typeof detail.message === 'string' ? detail.message : `HTTP ${response.status}`;
    return failure(
      'federation_pair_failed',
      t('federation.join.failed', { code, message, url: targetUrl }),
      1,
    );
  }
  if (
    !isRecord(body) ||
    body.ok !== true ||
    typeof body.node_id !== 'string' ||
    typeof body.team_id !== 'string' ||
    typeof body.token !== 'string' ||
    body.token === ''
  ) {
    return failure(
      'federation_pair_failed',
      t('federation.join.badResponse', { url: targetUrl }),
      1,
    );
  }
  const remoteNodeId = body.node_id;
  const remoteTeamId = body.team_id;
  const token = body.token;
  if (remoteNodeId === nodeId) {
    return failure('federation_peer_self', t('federation.peer.selfPeer', { node: remoteNodeId }));
  }
  if (!NODE_ID_RE.test(remoteNodeId) || !TEAM_ID_RE.test(remoteTeamId)) {
    return failure(
      'federation_pair_failed',
      t('federation.join.badResponse', { url: targetUrl }),
      1,
    );
  }

  // 4. token 存 SecretStore（先于配置写盘：热应用解析时 secret 必须已在）。
  try {
    await saveFederationPeerSecret(
      {
        dataDir: options.dataDir,
        allowFileSecrets: options.config.federation?.allowFileSecrets,
      },
      { nodeId: remoteNodeId, teamId: remoteTeamId },
      token,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure(
      'federation_secret_write_failed',
      t('federation.join.secretFailed', { detail }),
      1,
    );
  }

  // 5. 自动写 peer 配置（token_secret:true；两侧 team 不同名时映射 localTeamId）。
  const target = getUserConfigPath();
  try {
    await upsertPeerEntry(target, {
      nodeId: remoteNodeId,
      teamId: remoteTeamId,
      url: targetUrl,
      tokenSecret: true,
      direction: 'both',
      ...(remoteTeamId !== command.teamId ? { localTeamId: command.teamId } : {}),
      allowDirectory: command.allowDirectory,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure(
      'federation_peer_write_failed',
      t('federation.peer.writeFailed', { path: target, detail }),
      1,
    );
  }

  // 6. best-effort 热应用（写盘已成功；失败只降级提示）。
  const reload = await tryReloadGateway(options);
  const label = `${remoteNodeId}:${remoteTeamId}`;
  if (command.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          paired: {
            node_id: remoteNodeId,
            team_id: remoteTeamId,
            url: targetUrl,
            token_secret: true,
            ...(remoteTeamId !== command.teamId ? { local_team_id: command.teamId } : {}),
          },
          path: target,
          reloaded: reload.ok,
          ...(reload.attempted && !reload.ok ? { reload_error: reload.detail } : {}),
        },
        null,
        2,
      ),
      stderr: '',
    };
  }
  return {
    exitCode: 0,
    stdout: [
      ui.ok(t('federation.join.paired', { label, url: targetUrl, path: target })),
      ...reloadLines(reload),
      ui.dim(t('federation.join.hint')),
    ].join('\n'),
    stderr: '',
  };
}

/** `federation discover`：本地 hub registry 里的同机回环节点（离线读盘）。 */
export async function discoverCommand(
  command: { kind: 'discover'; json: boolean },
  options: FederationCommandOptions,
): Promise<CommandResult> {
  let nodeId: string;
  try {
    nodeId = await resolveNodeId({
      dataDir: options.dataDir,
      ...(options.config.host?.nodeId !== undefined
        ? { configNodeId: options.config.host.nodeId }
        : {}),
    });
  } catch (error) {
    return failure('federation_error', error instanceof Error ? error.message : String(error));
  }
  const registryPath = hubRegistryPath(options);
  const records = await readHubRegistryRecords(registryPath);
  const nodes = records
    .filter((record) => record.node_id !== nodeId)
    .map((record) => ({ record, url: loopbackUrlOf(record) }))
    .filter((entry): entry is { record: HubNodeRecord; url: string } => entry.url !== undefined)
    .map(({ record, url }) => ({
      node_id: record.node_id,
      name: record.name ?? record.alias ?? '',
      url,
      status: record.status,
      teams: record.counts.teams,
      ...(record.last_seen !== undefined ? { last_seen: record.last_seen } : {}),
    }));

  if (command.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ registry: registryPath, nodes }, null, 2),
      stderr: '',
    };
  }
  const lines = [ui.section(t('federation.discover.title', { path: registryPath }))];
  if (nodes.length === 0) {
    lines.push(`  ${ui.dim(t('federation.discover.empty'))}`);
  } else {
    for (const node of nodes) {
      lines.push(
        t('federation.discover.row', {
          node: node.node_id,
          name: node.name === '' ? '-' : node.name,
          url: node.url,
          status: node.status,
          teams: node.teams,
        }),
      );
    }
    lines.push('', ui.dim(t('federation.discover.hint')));
  }
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
