/**
 * `vessel token show|list|rotate`（0.56）与 `vessel node token --print`。
 *
 * 用户目标：**一个 token 都不用记**。根密钥在 `<dataDir>/root-secret`（首次启动自动
 * 生成 0600），所有 token 由它 HKDF 派生；显式配置永远优先。
 *
 * 三条安全约定：
 * 1. `show` 只在**回环 + 交互式终端**下打印值；管道 / 重定向 / 非 TTY 一律拒绝
 *    （避免 token 落进 CI 日志、shell 历史重放、`tee` 出来的文件）。
 *    自动化场景显式加 `--allow-non-interactive`（仍然只在本机执行）。
 * 2. `list` **永不打印值**，只给 purpose + 指纹前 8 位。
 * 3. `rotate` 是破坏性操作：必须 `--yes`；新根密钥 ⇒ 所有派生 token 一起换，
 *    显式配置的 token 不受影响；在跑的 node 需要重启才能拿到新值。
 *
 * @module vessel/token-command
 */

import { loadConfig, parseTokenPurpose, purposeLabel, tokenFingerprint } from '../packages/config/src/index';
import type { VesselConfig } from '../packages/config/src/index';
import { formatConfigErrors } from './config-error-format';
import { resolveDataDir } from './data-paths';
import { loadNodeRegistry } from './gateway/node-registry';
import {
  effectiveHubToken,
  effectiveNodeToken,
  effectiveNodeTokenAuto,
  effectivePlatformToken,
  effectiveProxySecret,
  listTokens,
  type RootSecretState,
  rotateRootSecret,
  type TokenResolution,
} from './token-derive';

type EnvMap = Record<string, string | undefined>;

/** 命令结果（与其它一次性命令同形）。 */
export interface TokenCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TokenCommandOptions {
  configPath?: string;
  userConfigPath?: string;
  /** 已加载的配置（调用方已有就直接复用，避免二次加载）。 */
  config?: VesselConfig;
  env?: EnvMap;
  /** 覆盖数据根（`--data-dir`）。 */
  dataDir?: string;
  /** 显式放行非交互调用（自动化用；仍然只在本机执行）。 */
  allowNonInteractive?: boolean;
  /** 终端是否交互（缺省读 stdin/stdout 的 isTTY；测试可注入）。 */
  interactive?: boolean;
}

type LoadedContext =
  | { ok: true; config: VesselConfig; dataDir: string; env: EnvMap }
  | { ok: false; result: TokenCommandResult };

async function loadContext(options: TokenCommandOptions): Promise<LoadedContext> {
  const env = options.env ?? process.env;
  if (options.config !== undefined) {
    const dataDir =
      options.dataDir !== undefined ? options.dataDir : resolveDataDir(options.config, env);
    return { ok: true, config: options.config, dataDir, env };
  }
  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig({
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
      env,
    });
  } catch (error) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        stdout: '',
        stderr: `config_load_failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (loaded.validation.errors.length > 0) {
    return {
      ok: false,
      result: {
        exitCode: 2,
        stdout: '',
        stderr: formatConfigErrors(loaded.validation.errors),
      },
    };
  }
  const dataDir =
    options.dataDir !== undefined ? options.dataDir : resolveDataDir(loaded.config, env);
  return { ok: true, config: loaded.config, dataDir, env };
}

function isInteractive(options: TokenCommandOptions): boolean {
  if (options.interactive !== undefined) return options.interactive;
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * 打印值的前置检查：交互式终端，或显式 `--allow-non-interactive`。
 *
 * 拒绝时的文案必须**可照做**（告诉用户两种放行方式），而不是一句 "forbidden"。
 */
function printGuard(options: TokenCommandOptions): string | null {
  if (isInteractive(options)) return null;
  if (options.allowNonInteractive === true) return null;
  return (
    'refusing to print a token value to a non-interactive output (pipe / redirect / CI log).\n' +
    '  - interactive terminal: run the same command directly;\n' +
    '  - automation: add --allow-non-interactive (still local only).\n' +
    '  Tip: "vessel token list" prints fingerprints only and is always safe.'
  );
}

/** 解析 `--node <id>` 对应的 dataDir：优先 registry，其次全局 dataDir。 */
async function nodeDataDir(
  globalDataDir: string,
  nodeId: string,
): Promise<{ dataDir: string; known: boolean }> {
  try {
    const load = await loadNodeRegistry(globalDataDir);
    if (load.kind === 'ready') {
      const entry = load.registry.nodes.find((node) => node.node_id === nodeId);
      if (entry !== undefined) return { dataDir: entry.data_dir, known: true };
    }
  } catch {
    // registry 损坏不应让 token 查询失败：退回全局 dataDir（下面会说明来源）。
  }
  return { dataDir: globalDataDir, known: false };
}

function formatResolution(label: string, resolution: TokenResolution): string {
  if (!resolution.ok) return `${label}: ERROR ${resolution.code}: ${resolution.message}`;
  const value = resolution.value;
  if (value.source === 'none') return `${label}: none (not configured; nothing derived)`;
  const fingerprint = value.token !== undefined ? `fp=${tokenFingerprint(value.token)}` : '';
  return `${label}: ${value.source}${fingerprint === '' ? '' : ` ${fingerprint}`} (${value.detail ?? ''})`;
}

/** `vessel token show --purpose <p> [--node <id>] [--instance <id>] [--json]` */
export async function tokenShowCommand(
  command: { purpose: string; id?: string; json: boolean },
  options: TokenCommandOptions = {},
): Promise<TokenCommandResult> {
  const guard = printGuard(options);
  if (guard !== null) return { exitCode: 1, stdout: '', stderr: guard };

  const context = await loadContext(options);
  if (!context.ok) return context.result;

  const parsed = parseTokenPurpose(command.purpose, command.id);
  if (!parsed.ok) return { exitCode: 2, stdout: '', stderr: parsed.error };
  const purpose = parsed.purpose;
  let resolution: TokenResolution;
  let extraNote: string | undefined;

  if (purpose.kind === 'node') {
    const resolvedDir = await nodeDataDir(context.dataDir, purpose.id);
    if (!resolvedDir.known) {
      extraNote =
        `node ${purpose.id} is not in the registry; derived from the global data dir ` +
        `(${resolvedDir.dataDir}). A node that runs under its own data dir would derive a ` +
        'different value — register it with "vessel gateway nodes add".';
    }
    resolution = effectiveNodeToken({
      config: context.config,
      dataDir: resolvedDir.dataDir,
      nodeId: purpose.id,
      env: context.env,
    });
  } else if (purpose.kind === 'proxy') {
    resolution = effectiveProxySecret({
      config: context.config,
      dataDir: context.dataDir,
      instanceId: purpose.id,
      env: context.env,
      includeCandidate: true,
    });
    if (resolution.ok && resolution.value.source === 'derived') {
      extraNote =
        'candidate value only: the reverse proxy does not use it until you set ' +
        'gateway.proxy_secret_env to an env var holding this value (then restarted). ' +
        'Deriving it automatically would lock every existing reverse proxy out.';
    }
  } else if (purpose.kind === 'hub') {
    resolution = effectiveHubToken({
      config: context.config,
      dataDir: context.dataDir,
      env: context.env,
    });
  } else {
    resolution = effectivePlatformToken({
      config: context.config,
      dataDir: context.dataDir,
      env: context.env,
    });
  }
  const purposeLabelText = purposeLabel(purpose);

  if (!resolution.ok) {
    return { exitCode: 1, stdout: '', stderr: `${resolution.code}: ${resolution.message}` };
  }
  const value = resolution.value;
  if (value.token === undefined) {
    return {
      exitCode: 1,
      stdout: '',
      stderr:
        `no token for purpose "${purposeLabelText}": nothing is configured and nothing is derived ` +
        '(this purpose is opt-in and stays off until you configure it).',
    };
  }

  if (command.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          purpose: purpose.kind,
          ...('id' in purpose ? { id: purpose.id } : {}),
          token: value.token,
          source: value.source,
          detail: value.detail,
          fingerprint: tokenFingerprint(value.token),
          ...(extraNote !== undefined ? { note: extraNote } : {}),
        },
        null,
        2,
      ),
      stderr: '',
    };
  }

  const lines = [
    `purpose  ${purposeLabelText}`,
    `source   ${value.source}${value.detail !== undefined ? ` (${value.detail})` : ''}`,
    `token    ${value.token}`,
    `fp       ${tokenFingerprint(value.token)}`,
  ];
  if (value.source === 'derived') {
    lines.push(
      'note     derived from <dataDir>/root-secret; stable until "vessel token rotate", ' +
        'and overridden by any explicit config for this purpose.',
    );
  }
  if (extraNote !== undefined) lines.push(`note     ${extraNote}`);
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}

/** `vessel token list [--json]`：只列 purpose + 指纹，**永不打印值**。 */
export async function tokenListCommand(
  command: { json: boolean },
  options: TokenCommandOptions = {},
): Promise<TokenCommandResult> {
  const context = await loadContext(options);
  if (!context.ok) return context.result;

  let nodeIds: string[] = [];
  try {
    const load = await loadNodeRegistry(context.dataDir);
    if (load.kind === 'ready') nodeIds = load.registry.nodes.map((node) => node.node_id);
  } catch {
    // registry 不可读：照常列出其余用途（不因为一次查询失败而整体报错）。
  }

  const listed = listTokens({
    config: context.config,
    dataDir: context.dataDir,
    env: context.env,
    nodeIds,
    instanceId: 'default',
  });
  if (!listed.ok) {
    return { exitCode: 1, stdout: '', stderr: `${listed.code}: ${listed.message}` };
  }

  const rootInfo: Omit<RootSecretState, 'secret'> = listed.root;
  if (command.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          root: {
            path: rootInfo.path,
            source: rootInfo.source,
            fingerprint: rootInfo.fingerprint,
            ...(rootInfo.envName !== undefined ? { env: rootInfo.envName } : {}),
          },
          tokens: listed.rows,
        },
        null,
        2,
      ),
      stderr: '',
    };
  }

  const lines = [
    `root secret  ${rootInfo.path}`,
    `             source=${rootInfo.source}${
      rootInfo.envName !== undefined ? ` (env ${rootInfo.envName})` : ''
    } fp=${rootInfo.fingerprint}`,
    '',
    'purpose                    source     fp        detail',
  ];
  for (const row of listed.rows) {
    lines.push(
      `${row.label.padEnd(26)} ${row.source.padEnd(10)} ${(row.fingerprint ?? '-').padEnd(9)} ${
        row.detail ?? ''
      }`,
    );
  }
  lines.push('');
  lines.push('values are never printed here; use "vessel token show --purpose <p>" in a terminal.');
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}

/** `vessel token rotate --yes [--json]`：新根密钥 ⇒ 所有派生 token 一起换。 */
export async function tokenRotateCommand(
  command: { yes: boolean; json: boolean },
  options: TokenCommandOptions = {},
): Promise<TokenCommandResult> {
  if (!command.yes) {
    return {
      exitCode: 2,
      stdout: '',
      stderr:
        'token rotate replaces <dataDir>/root-secret and invalidates every derived token ' +
        '(platform / hub / node / proxy). Re-run with --yes to confirm. ' +
        'Explicitly configured tokens are unaffected.',
    };
  }
  const context = await loadContext(options);
  if (!context.ok) return context.result;

  const rotated = rotateRootSecret({
    config: context.config,
    dataDir: context.dataDir,
    env: context.env,
  });
  if (!rotated.ok) {
    return { exitCode: 1, stdout: '', stderr: `${rotated.code}: ${rotated.message}` };
  }
  const value = rotated.value;
  if (command.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        { rotated: true, path: value.path, fingerprint: value.fingerprint, hint: value.restartHint },
        null,
        2,
      ),
      stderr: '',
    };
  }
  return {
    exitCode: 0,
    stdout: [
      `rotated  ${value.path}`,
      `fp       ${value.fingerprint}`,
      `note     ${value.restartHint}`,
    ].join('\n'),
    stderr: '',
  };
}

/**
 * `vessel node token [--print] [--json]`：本机 node 自己该用的 token。
 *
 * 给「node 不是 gateway 拉起的」那种独立部署一个最小出口：不用把它写进配置，
 * 需要时读出来（同样只在交互式终端打印值）。
 */
export async function nodeTokenCommand(
  command: { print: boolean; json: boolean; nodeId?: string },
  options: TokenCommandOptions = {},
): Promise<TokenCommandResult> {
  const context = await loadContext(options);
  if (!context.ok) return context.result;

  const resolution = effectiveNodeTokenAuto({
    config: context.config,
    dataDir: context.dataDir,
    ...(command.nodeId !== undefined ? { nodeId: command.nodeId } : {}),
    env: context.env,
  });
  if (!resolution.ok) {
    return { exitCode: 1, stdout: '', stderr: `${resolution.code}: ${resolution.message}` };
  }
  const value = resolution.value;

  if (!command.print) {
    // 不带 `--print`：只说明「你这个 node 的 token 从哪来」，不打印值。
    return {
      exitCode: 0,
      stdout: formatResolution('node token', resolution),
      stderr: '',
    };
  }

  const guard = printGuard(options);
  if (guard !== null) return { exitCode: 1, stdout: '', stderr: guard };
  if (value.token === undefined) {
    return {
      exitCode: 1,
      stdout: '',
      stderr:
        'no node token: this data dir has no node.json yet. Start the node once ' +
        '("vessel node start") so it can create its identity, or pass --node <id>.',
    };
  }
  if (command.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          token: value.token,
          source: value.source,
          detail: value.detail,
          fingerprint: tokenFingerprint(value.token),
        },
        null,
        2,
      ),
      stderr: '',
    };
  }
  return {
    exitCode: 0,
    stdout: [value.token, `# source=${value.source} fp=${tokenFingerprint(value.token)}`].join(
      '\n',
    ),
    stderr: '',
  };
}
