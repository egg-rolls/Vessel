/**
 * `vessel federation peer add|list|remove`（q-federation）。
 *
 * peers 是对象数组，不走标量 `config.set` 白名单：这里直接读改写用户配置的
 * `federation.peers`（withConfigLock 跨进程锁 + 原子写，保留其它键）。
 *
 * - add：本地预校验（身份字符集 / 自指 / 重复 / URL 规则，与 config validator
 *   同口径）→ 写盘 → best-effort 触发运行中 gateway 的 `gateway.reload`
 *   （config scope 内含 federation 热应用）；没有运行中 gateway 时由文件监听 /
 *   下次启动生效。**不重启任何进程。**
 * - remove：按 label（`<nodeId>:<teamId>`）或 nodeId 删；多命中要求给全 label。
 * - token 绝不打印 / 落盘：配置只存 `tokenEnv` 名，值由运行时从 env / env_file 解析。
 * - exit：成功 0，未找到 1，用法 / 配置错误 2。
 *
 * @module vessel/commands/federation-peer
 */

import {
  getUserConfigPath,
  isLoopbackHostname,
  readUserConfigRoot,
  withConfigLock,
  writeUserConfigRoot,
} from '../../../packages/config/src/index';
import { deleteFederationPeerSecret } from '../../federation/federation-secrets';
import { isProcessAlive, readGatewayPidRecord } from '../../gateway/pid';
import { reloadGateway } from '../../gateway/reload';
import { resolveGatewayToken } from '../../gateway/transport-factory';
import { t } from '../../i18n';
import { resolveNodeId } from '../../node/node-identity';
import type { FederationCommand } from '../args';
import { ui } from '../output';
import type { CommandResult } from './agent/agent-command';
import type { FederationCommandOptions } from './federation';

/** 与 config validator 同口径（validator.ts NODE_ID_RE / TEAM_ID_RE / ENV_NAME_RE）。 */
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface FederationPeerCommandOptions extends FederationCommandOptions {
  /** 用户配置路径覆盖（测试注入）；缺省 `getUserConfigPath()`。 */
  userConfigPath?: string;
}

/** 带稳定 code 的命令错误（锁内抛出，锁外统一转 exitCode / stderr）。 */
class PeerCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(code: string, detail: string, exitCode = 2): CommandResult {
  return { exitCode, stdout: '', stderr: `${code}: ${detail}` };
}

/** URL 规则与 validator.absoluteBaseUrlError 逐字同口径（loopback 允许 http）。 */
export function peerUrlError(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute http(s) URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must use http or https';
  if (url.username !== '' || url.password !== '') return 'must not contain userinfo';
  if (url.pathname !== '/' && url.pathname !== '') return 'must not contain a path';
  if (url.search !== '' || url.hash !== '') return 'must not contain query or hash';
  if (!isLoopbackHostname(url.hostname) && url.protocol !== 'https:') {
    return 'non-loopback federation peers must use https';
  }
  return null;
}

/** YAML 里 peer 条目的身份（snake_case 为准，容忍手写 camelCase）。 */
function entryIdentity(entry: Record<string, unknown>): { nodeId?: string; teamId?: string } {
  const nodeId = entry.node_id ?? entry.nodeId;
  const teamId = entry.team_id ?? entry.teamId;
  return {
    ...(typeof nodeId === 'string' ? { nodeId } : {}),
    ...(typeof teamId === 'string' ? { teamId } : {}),
  };
}

function entryLabel(entry: Record<string, unknown>): string {
  const { nodeId, teamId } = entryIdentity(entry);
  return `${nodeId ?? '?'}:${teamId ?? '?'}`;
}

/**
 * 读用户配置里的 federation.peers 原始条目（锁内调用）。
 * 返回**原始数组**（含非对象条目）：写回时原样保留，绝不静默丢用户数据；
 * 匹配 / 渲染只对对象条目生效。
 */
function readPeerEntries(root: Record<string, unknown>): unknown[] {
  const federation = root.federation;
  if (federation === undefined || federation === null) return [];
  if (!isRecord(federation)) {
    throw new PeerCommandError(
      'federation_peer_invalid_config',
      t('federation.peer.invalidBlock', { block: 'federation' }),
    );
  }
  const peers = federation.peers;
  if (peers === undefined || peers === null) return [];
  if (!Array.isArray(peers)) {
    throw new PeerCommandError(
      'federation_peer_invalid_config',
      t('federation.peer.invalidBlock', { block: 'federation.peers' }),
    );
  }
  return peers;
}

/** 写回 federation.peers（保留 federation 块与其它根键；空数组保留为 []）。 */
function withPeerEntries(
  root: Record<string, unknown>,
  entries: unknown[],
): Record<string, unknown> {
  const federation = isRecord(root.federation) ? root.federation : {};
  return { ...root, federation: { ...federation, peers: entries } };
}

export interface ReloadOutcome {
  attempted: boolean;
  ok: boolean;
  detail: string;
}

/**
 * best-effort 触发运行中 node gateway 的 `gateway.reload`（config scope）。
 * 写盘已成功：这里失败只降级为提示（文件监听 / 下次启动兜底），绝不回失败码。
 */
export async function tryReloadGateway(
  options: FederationPeerCommandOptions,
): Promise<ReloadOutcome> {
  const record = await readGatewayPidRecord(options.dataDir);
  if (record === null || !isProcessAlive(record.pid)) {
    return { attempted: false, ok: false, detail: '' };
  }
  const env = options.env ?? process.env;
  const token = resolveGatewayToken(options.config, env) ?? '';
  const result = await reloadGateway({
    record,
    token,
    scopes: ['config'],
    tls: options.config.node?.tls !== undefined,
    requestTimeoutMs: 5_000,
  });
  if (!result.ok) return { attempted: true, ok: false, detail: result.error };
  return {
    attempted: true,
    ok: true,
    detail: result.result.reloaded.join(', ') || '(none)',
  };
}

/** reload 结果 → 输出行（成功 / 未运行 / 失败三种提示）。 */
export function reloadLines(reload: ReloadOutcome): string[] {
  if (!reload.attempted) return [ui.dim(t('federation.peer.reloadSkipped'))];
  if (reload.ok) return [ui.ok(t('federation.peer.reloaded', { scopes: reload.detail }))];
  return [ui.warn(t('federation.peer.reloadFailed', { detail: reload.detail }))];
}

type PeerAddCommand = Extract<FederationCommand, { kind: 'peer-add' }>;
type PeerRemoveCommand = Extract<FederationCommand, { kind: 'peer-remove' }>;

/** add 的本地预校验（validator 同口径；任何 I/O 之前失败 exit 2）。 */
function validateAdd(command: PeerAddCommand): void {
  if (!NODE_ID_RE.test(command.nodeId)) {
    throw new PeerCommandError(
      'federation_peer_invalid',
      t('federation.peer.invalidNodeId', { value: command.nodeId }),
    );
  }
  if (!TEAM_ID_RE.test(command.teamId)) {
    throw new PeerCommandError(
      'federation_peer_invalid',
      t('federation.peer.invalidTeamId', { value: command.teamId }),
    );
  }
  if (!ENV_NAME_RE.test(command.tokenEnv)) {
    throw new PeerCommandError(
      'federation_peer_invalid',
      t('federation.peer.invalidTokenEnv', { value: command.tokenEnv }),
    );
  }
  if (command.localTeamId !== undefined && !TEAM_ID_RE.test(command.localTeamId)) {
    throw new PeerCommandError(
      'federation_peer_invalid',
      t('federation.peer.invalidLocalTeamId', { value: command.localTeamId }),
    );
  }
  if (command.url !== undefined) {
    const message = peerUrlError(command.url);
    if (message !== null) {
      throw new PeerCommandError(
        'federation_peer_invalid',
        t('federation.peer.invalidUrl', { value: command.url, message }),
      );
    }
  }
  if (command.caFile !== undefined && command.caFile.trim() === '') {
    throw new PeerCommandError('federation_peer_invalid', t('federation.peer.invalidCaFile'));
  }
}

async function peerAddCommand(
  command: PeerAddCommand,
  options: FederationPeerCommandOptions,
): Promise<CommandResult> {
  validateAdd(command);

  // 自指 peer fail closed（与 resolver / validator 同语义）。
  let localNodeId: string;
  try {
    localNodeId = await resolveNodeId({
      dataDir: options.dataDir,
      ...(options.config.host?.nodeId !== undefined
        ? { configNodeId: options.config.host.nodeId }
        : {}),
    });
  } catch (error) {
    return failure('federation_error', error instanceof Error ? error.message : String(error));
  }
  if (command.nodeId === localNodeId) {
    return failure('federation_peer_self', t('federation.peer.selfPeer', { node: command.nodeId }));
  }

  const target = options.userConfigPath ?? getUserConfigPath();
  const label = `${command.nodeId}:${command.teamId}`;
  try {
    await withConfigLock(target, async () => {
      const root = await readUserConfigRoot(target);
      const entries = readPeerEntries(root);
      const duplicate = entries.some((entry) => {
        if (!isRecord(entry)) return false;
        const identity = entryIdentity(entry);
        return identity.nodeId === command.nodeId && identity.teamId === command.teamId;
      });
      if (duplicate) {
        throw new PeerCommandError(
          'federation_peer_duplicate',
          t('federation.peer.duplicate', { label, path: target }),
        );
      }
      // 新条目只写合法键（validator FEDERATION_PEER_KEYS 的 snake_case 形）；
      // 绝不写 token 值 / label 之类非法键。
      const entry: Record<string, unknown> = {
        node_id: command.nodeId,
        team_id: command.teamId,
        token_env: command.tokenEnv,
        direction: command.direction,
        allow_directory: command.allowDirectory,
      };
      if (command.url !== undefined) entry.url = command.url;
      if (command.localTeamId !== undefined) entry.local_team_id = command.localTeamId;
      if (command.caFile !== undefined) entry.ca_file = command.caFile;
      await writeUserConfigRoot(target, withPeerEntries(root, [...entries, entry]));
    });
  } catch (error) {
    if (error instanceof PeerCommandError) {
      return failure(error.code, error.message, error.exitCode);
    }
    return failure(
      'federation_peer_write_failed',
      t('federation.peer.writeFailed', {
        path: target,
        detail: error instanceof Error ? error.message : String(error),
      }),
      1,
    );
  }

  const reload = await tryReloadGateway(options);
  const env = options.env ?? process.env;
  const tokenSet = typeof env[command.tokenEnv] === 'string' && env[command.tokenEnv] !== '';
  const view = {
    node_id: command.nodeId,
    team_id: command.teamId,
    direction: command.direction,
    token_env: command.tokenEnv,
    token_set: tokenSet,
    allow_directory: command.allowDirectory,
    ...(command.url !== undefined ? { url: command.url } : {}),
    ...(command.localTeamId !== undefined ? { local_team_id: command.localTeamId } : {}),
    ...(command.caFile !== undefined ? { ca_file: command.caFile } : {}),
  };
  if (command.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          added: view,
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
  const lines = [
    ui.ok(t('federation.peer.added', { label, path: target })),
    ...reloadLines(reload),
  ];
  if (!tokenSet) {
    lines.push(ui.warn(t('federation.peer.tokenUnset', { env: command.tokenEnv })));
  }
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}

async function peerRemoveCommand(
  command: PeerRemoveCommand,
  options: FederationPeerCommandOptions,
): Promise<CommandResult> {
  const target = options.userConfigPath ?? getUserConfigPath();
  const isLabel = command.target.includes(':');
  let removedLabel = '';
  let secretCleanup: { nodeId: string; teamId: string } | undefined;
  try {
    await withConfigLock(target, async () => {
      const root = await readUserConfigRoot(target);
      const entries = readPeerEntries(root);
      const matches = entries.filter((entry): entry is Record<string, unknown> => {
        if (!isRecord(entry)) return false;
        const identity = entryIdentity(entry);
        if (isLabel) {
          return `${identity.nodeId}:${identity.teamId}` === command.target;
        }
        return identity.nodeId === command.target;
      });
      if (matches.length === 0) {
        throw new PeerCommandError(
          'federation_peer_not_found',
          t('federation.peer.notFound', { target: command.target }),
          1,
        );
      }
      if (matches.length > 1) {
        throw new PeerCommandError(
          'federation_peer_ambiguous',
          t('federation.peer.ambiguous', {
            target: command.target,
            labels: matches.map(entryLabel).join(', '),
          }),
        );
      }
      const removed = matches[0];
      if (removed === undefined) return;
      removedLabel = entryLabel(removed);
      // q-fed-simple：token_secret peer 删除后清理 SecretStore（best-effort）。
      const removedIdentity = entryIdentity(removed);
      if (
        (removed.token_secret ?? removed.tokenSecret) === true &&
        removedIdentity.nodeId !== undefined &&
        removedIdentity.teamId !== undefined
      ) {
        secretCleanup = { nodeId: removedIdentity.nodeId, teamId: removedIdentity.teamId };
      }
      const next = entries.filter((entry) => entry !== removed);
      await writeUserConfigRoot(target, withPeerEntries(root, next));
    });
  } catch (error) {
    if (error instanceof PeerCommandError) {
      return failure(error.code, error.message, error.exitCode);
    }
    return failure(
      'federation_peer_write_failed',
      t('federation.peer.writeFailed', {
        path: target,
        detail: error instanceof Error ? error.message : String(error),
      }),
      1,
    );
  }

  if (secretCleanup !== undefined) {
    try {
      await deleteFederationPeerSecret(
        {
          dataDir: options.dataDir,
          allowFileSecrets: options.config.federation?.allowFileSecrets,
        },
        secretCleanup,
      );
    } catch {
      // best-effort：孤儿 secret 不影响行为（peer 已删，入站不再匹配）；下次配对覆盖写。
    }
  }

  const reload = await tryReloadGateway(options);
  if (command.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          removed: removedLabel,
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
      ui.ok(t('federation.peer.removed', { label: removedLabel, path: target })),
      ...reloadLines(reload),
    ].join('\n'),
    stderr: '',
  };
}

/** 执行 peer add / remove；不抛错，错误转 exitCode / stderr。 */
export async function runFederationPeerCommand(
  command: PeerAddCommand | PeerRemoveCommand,
  options: FederationPeerCommandOptions,
): Promise<CommandResult> {
  try {
    if (command.kind === 'peer-add') return await peerAddCommand(command, options);
    return await peerRemoveCommand(command, options);
  } catch (error) {
    if (error instanceof PeerCommandError) {
      return failure(error.code, error.message, error.exitCode);
    }
    return failure('federation_error', error instanceof Error ? error.message : String(error));
  }
}
