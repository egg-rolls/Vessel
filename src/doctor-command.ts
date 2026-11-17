/**
 * `vessel doctor`（0.6.1 P2）：本机配置与运行环境自检。
 *
 * 检查项：provider key / 配置校验 / data_dir 可写 / session 后端路径 /
 * 插件目录与启用项 / MCP server 形状 / serve 端口占用 / 可选能力开关。
 *
 * 默认不联网、不构造 runtime、不调用 provider；`--deep` 额外查询本地 gateway 的
 * health / mcp 列表（只读 RPC）。退出码 0 = 无失败项，1 = 有失败项。
 *
 * @module vessel/doctor-command
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  getUserConfigPath,
  loadConfig,
  resolveEffectiveApiKey,
  resolvePlatformProxySecret,
  resolvePlatformToken,
  resolveServeProxySecret,
  rootSecretPath,
  tokenFingerprint,
  type VesselConfig,
} from '../packages/config/src/index';
import { isLoopbackHostname } from '../packages/serve/src/index';
import type { DoctorCommandArgs } from './cli-args';
import { type ControlPlaneTarget, resolveControlPlaneTarget } from './control-plane-target';
import { resolveDataDir, resolveEffectiveTenantId, resolveSingleTenantPaths } from './data-paths';
import { declarativePluginEntries } from './plugin-config';
import { PluginLoader } from './plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from './plugin-selection';
// 0.56：派生 token 的现状（根密钥 / 指纹；doctor 从不说「必须配置 token」）。
import {
  effectiveHubToken,
  effectiveNodeTokenAuto,
  effectivePlatformToken,
  loadRootSecret,
  readKnownNodeId,
} from './token-derive';
import { resolveGatewayToken } from './transport-factory';
import { ui } from './ui-style';
import { readPackageVersion } from './version';
// 0.56.1：Web 控制台产物缺失要在 doctor 就能看见（`gateway start` 的硬前置）。
import { DEFAULT_WEB_DIST_DIR } from './web-dist';

export interface DoctorCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 测试注入（CLI 调用只用 DoctorCommandArgs 字段） */
export interface DoctorOptions extends DoctorCommandArgs {
  configPath?: string;
  userConfigPath?: string;
  env?: Record<string, string | undefined>;
  /** 测试注入：直接使用该 RPC 目标（不探测 PID / 建 HTTP） */
  target?: ControlPlaneTarget;
}

type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

interface Check {
  name: string;
  status: CheckStatus;
  message: string;
}

/** 非空字符串 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 目录状态：不存在但父目录可写 → will-create */
function writeTargetStatus(target: string): CheckStatus {
  try {
    if (fs.existsSync(target)) {
      fs.accessSync(target, fs.constants.W_OK);
      return 'ok';
    }
    const parent = path.dirname(target);
    if (fs.existsSync(parent)) {
      fs.accessSync(parent, fs.constants.W_OK);
      return 'ok';
    }
    return 'warn';
  } catch {
    return 'fail';
  }
}

/** 端口是否可用（绑定一次后立即释放） */
function checkPort(host: string, port: number): Promise<'available' | 'in_use' | 'error'> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (result: 'available' | 'in_use' | 'error'): void => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // 忽略
      }
      resolve(result);
    };
    server.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'EADDRINUSE' ? 'in_use' : 'error');
    });
    server.listen({ host, port, exclusive: true }, () => finish('available'));
    const timer = setTimeout(() => finish('error'), 1000);
    (timer as { unref?: () => void }).unref?.();
  });
}

/** 当前配置下会话文件/目录的实际路径（与 session-factory 对齐） */
function sessionStoragePath(config: VesselConfig, tenantRoot: string): string {
  const backend = config.session?.backend ?? 'file';
  if (backend === 'sqlite') {
    return config.session?.storagePath ?? path.join(tenantRoot, 'sessions.db');
  }
  return config.session?.storagePath ?? path.join(tenantRoot, 'sessions');
}

/**
 * 0.56：`tokens` 检查 —— 单一根密钥 + 派生 token 的现状。
 *
 * 用户目标：**一个 token 都不用记**。所以这里绝不再输出「必须配置 token」：
 * - 根密钥在 `<dataDir>/root-secret`（首次启动自动生成，0600；`security.root_secret_env` 可覆盖）；
 * - 每个用途要么 `explicit`（显式配置赢了），要么 `derived`（现算的，指纹可对账）；
 * - **只给指纹，不给值**；值只有 `vessel token show` 在交互式终端里才打印。
 * - 根密钥权限不安全 → `fail` 并给出 `chmod 600` 这种能照做的文案（启动同样会被拒）。
 */
function collectTokenCheck(input: {
  config: VesselConfig;
  env: Record<string, string | undefined>;
  dataDir: string;
}): Check {
  const rootPath = rootSecretPath(input.dataDir);
  const root = loadRootSecret({ ...input, create: false });

  if (!root.ok) {
    if (root.code === 'root_secret_missing') {
      return {
        name: 'tokens',
        status: 'info',
        message:
          `root secret will be created on first start: ${rootPath} ` +
          '(then every token is derived from it; nothing to configure)',
      };
    }
    return {
      name: 'tokens',
      status: 'fail',
      message: `${root.code}: ${root.message}`,
    };
  }

  const nodeId = readKnownNodeId(input.dataDir);
  const rows: string[] = [];
  const push = (label: string, resolution: ReturnType<typeof effectivePlatformToken>): void => {
    if (!resolution.ok) {
      rows.push(`${label}=FAIL(${resolution.code})`);
      return;
    }
    const value = resolution.value;
    if (value.token === undefined) {
      rows.push(`${label}=none`);
      return;
    }
    // 0.56 定稿口径：派生值 = 「远程必须带，回环匿名仍可用」。
    // 显式配置才收紧回环（`tokenConfigured=true`）。这一行就是给运维看的判据。
    const note = value.source === 'derived' ? ' — remote 需带该值，loopback 匿名仍可用' : '';
    rows.push(`${label}=${value.source} fp=${tokenFingerprint(value.token)}${note}`);
  };
  push('platform', effectivePlatformToken(input));
  push('hub', effectiveHubToken(input));
  if (nodeId !== undefined) push(`node:${nodeId}`, effectiveNodeTokenAuto(input));

  const rootOrigin =
    root.state.source === 'env' ? `env ${root.state.envName ?? ''}`.trim() : root.state.path;
  return {
    name: 'tokens',
    status: 'ok',
    message:
      `root ${rootOrigin} fp=${root.state.fingerprint} · ${rows.join(' · ')} ` +
      '("explicit" = 你的配置赢了并收紧回环；"derived" = 由 root 现算，远程仍必须带)',
  };
}

/** 执行 doctor */
export async function doctorCommand(options: DoctorOptions): Promise<DoctorCommandResult> {
  const checks: Check[] = [];
  const env = options.env ?? process.env;
  const version = readPackageVersion();
  checks.push({ name: 'version', status: 'info', message: version });

  const loaded = await loadConfig({
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
    env,
  });
  const { config, validation, tenantId: configTenantId, paths } = loaded;
  const dataDir = resolveDataDir(config, env);
  // 0.49 R1：单 id 以持久化 `<dataDir>/tenant.json` 为准。
  const tenantId = resolveEffectiveTenantId(configTenantId, dataDir);

  checks.push({
    name: 'config',
    status: validation.errors.length > 0 ? 'fail' : validation.warnings.length > 0 ? 'warn' : 'ok',
    message:
      validation.errors.length > 0
        ? validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ')
        : validation.warnings.length > 0
          ? validation.warnings.map((warning) => `${warning.path}: ${warning.message}`).join('; ')
          : `user=${paths.user} project=${paths.project}`,
  });

  checks.push({
    name: 'identity',
    status: 'info',
    message: tenantId,
  });

  const key = resolveEffectiveApiKey(config, env);
  checks.push({
    name: 'provider',
    status: key ? 'ok' : 'fail',
    message: `${config.provider?.name ?? 'openai'} / ${config.provider?.model ?? '<no model>'} / api key ${key ? '<set>' : '<unset>'}`,
  });

  const dataStatus = writeTargetStatus(dataDir);
  // 0.56.1：数据根**从哪来**也要说清 —— 一台机器跑多个实例（`--data-dir`）时，
  // 「我看的是哪个实例」是第一件要确认的事，比路径本身更重要。
  const dataDirSource =
    env.VESSEL_DATA_DIR !== undefined && env.VESSEL_DATA_DIR !== ''
      ? 'env VESSEL_DATA_DIR (or --data-dir)'
      : config.dataDir !== undefined
        ? 'config data_dir'
        : 'default';
  checks.push({
    name: 'data_dir',
    status: dataStatus,
    message: `${dataDir} (source: ${dataDirSource})${
      fs.existsSync(dataDir) ? '' : ' (will be created)'
    }`,
  });

  // 0.56.1：**哪一份用户配置在生效**必须能看到 —— 「我明明写的是空配置」这类
  // 假绿全部来自这里没说清。只显示路径与是否存在，绝不显示内容。
  const userConfigPath = getUserConfigPath();
  const userConfigExplicit =
    (env.VESSEL_USER_CONFIG ?? '').trim() !== '' || options.userConfigPath !== undefined;
  const userConfigExists = fs.existsSync(userConfigPath);
  checks.push({
    name: 'user_config',
    status: userConfigExplicit && !userConfigExists ? 'fail' : 'ok',
    message: userConfigExplicit
      ? `${userConfigPath} (source: --user-config/VESSEL_USER_CONFIG${
          userConfigExists ? '' : '; MISSING — it was given explicitly, so it must exist'
        })`
      : `${userConfigPath} (default${userConfigExists ? '' : '; not created yet'})`,
  });

  const backend = config.session?.backend ?? 'file';
  if (backend === 'memory') {
    checks.push({ name: 'session', status: 'info', message: 'backend=memory (no persistence)' });
  } else {
    // 0.49 T5（C6）：只读根布局；非根布局数据 fail-fast。
    try {
      const tenantPaths = resolveSingleTenantPaths(dataDir, tenantId);
      const storage = sessionStoragePath(config, tenantPaths.root);
      checks.push({
        name: 'session',
        status: writeTargetStatus(storage),
        message: `backend=${backend} path=${storage}${fs.existsSync(storage) ? '' : ' (will be created)'}`,
      });
    } catch (error) {
      checks.push({
        name: 'session',
        status: 'fail',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 插件
  try {
    const loader = new PluginLoader();
    const all = loader.list();
    const declarative = declarativePluginEntries(config);
    const selection = resolvePluginSelection(
      loader,
      config.plugins,
      Boolean(env.VESSEL_DEBUG),
      declarative,
      env,
    );
    warnExternalPluginsOnce(selection.external);
    const enabled = new Set(selection.names);
    const missing =
      config.plugins === undefined
        ? []
        : config.plugins
            .filter((entry) => entry.enabled !== false)
            .map((entry) => entry.name)
            .filter((name) => !all.some((descriptor) => descriptor.name === name));
    checks.push({
      name: 'plugins',
      status: missing.length > 0 ? 'fail' : 'ok',
      message:
        missing.length > 0
          ? `unknown configured plugin(s): ${missing.join(', ')}`
          : `${enabled.size} enabled / ${all.length} discovered`,
    });
  } catch (error) {
    checks.push({
      name: 'plugins',
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // MCP（只看配置形状，不建连）
  const mcpEntries = Object.entries(config.mcpServers ?? {});
  const mcpEnabled = mcpEntries.filter(([, server]) => server.enabled !== false);
  const mcpInvalid = mcpEnabled.filter(([, server]) =>
    server.transport === 'stdio'
      ? nonEmpty(server.command) === undefined
      : nonEmpty(server.url) === undefined,
  );
  checks.push({
    name: 'mcp',
    status: mcpInvalid.length > 0 ? 'fail' : 'info',
    message:
      mcpInvalid.length > 0
        ? `invalid server config: ${mcpInvalid.map(([name]) => name).join(', ')}`
        : `${mcpEnabled.length} enabled / ${mcpEntries.length} configured (connect not tested)`,
  });

  // node 端口（仅在显式配置时检查）
  if (config.node?.port !== undefined && config.node.port !== 0) {
    const host = config.node.hostname ?? '127.0.0.1';
    const status = await checkPort(host, config.node.port);
    checks.push({
      name: 'serve_port',
      status: status === 'available' ? 'ok' : 'warn',
      message:
        status === 'available'
          ? `${host}:${config.node.port} available`
          : status === 'in_use'
            ? `${host}:${config.node.port} already in use`
            : `${host}:${config.node.port} check failed`,
    });
  }

  // 0.55 P0：公开暴露面提醒（**只提示，不改任何运行语义**）。
  // 同机反代下 peer 恒为 127.0.0.1，所以「回环监听 + 完全没有凭据」= 局域网/公网也能进。
  //
  // 0.56：**凭据现在总是存在**（根密钥派生），所以这一段的口径从「你没配 token，
  // 快配一个」改成「已自动派生 / 被显式配置覆盖，指纹 xxx；只有显式配置才会收紧回环」。
  // 派生不算「配置」——这一点直接决定回环匿名是否保留（迁移安全）。
  const tokensCheck = collectTokenCheck({ config, env, dataDir });
  checks.push(tokensCheck);

  const exposure: string[] = [];
  const serveHost = config.node?.hostname ?? '127.0.0.1';
  const serveTokens = Object.keys(config.node?.tokens ?? {}).length > 0;
  const explicitNodeToken = resolveGatewayToken(config, env) !== undefined || serveTokens;
  if (
    isLoopbackHostname(serveHost) &&
    !explicitNodeToken &&
    resolveServeProxySecret(config, env) === undefined
  ) {
    const where =
      config.node?.port !== undefined ? `${serveHost}:${String(config.node.port)}` : serveHost;
    exposure.push(
      `node ${where} 没有显式 token（已自动派生，见 tokens）：同机反代下匿名请求仍会被当成 admin；` +
        '要关掉这条匿名通道，配 node.token_env（或 node.proxy_secret_env）后重启',
    );
  }
  const gatewayHost = config.gateway?.hostname ?? '127.0.0.1';
  const explicitPlatformToken =
    resolvePlatformToken(config, env) !== undefined ||
    resolvePlatformProxySecret(config, env) !== undefined;
  if (isLoopbackHostname(gatewayHost) && !explicitPlatformToken) {
    exposure.push(
      `平台 ${gatewayHost} 没有显式 gateway.token（已自动派生，见 tokens）：` +
        '回环匿名仍可读平台面（node token 已需要凭据）；要收紧就配 gateway.token_env',
    );
  }
  const hubHost = config.hub?.listen?.hostname ?? '127.0.0.1';
  const hubTokenEnvName = config.hub?.tokenEnv;
  const hubToken = hubTokenEnvName !== undefined ? env[hubTokenEnvName] : undefined;
  const hubProxySecretEnvName = config.hub?.proxySecretEnv;
  const hubProxySecret =
    hubProxySecretEnvName !== undefined ? env[hubProxySecretEnvName] : undefined;
  if (
    isLoopbackHostname(hubHost) &&
    nonEmpty(hubToken) === undefined &&
    nonEmpty(hubProxySecret) === undefined
  ) {
    exposure.push(
      `hub ${hubHost} 没有显式 hub.token_env（已自动派生，见 tokens）：` +
        '回环匿名可读目录、可删节点；要收紧就配 hub.token_env',
    );
  }
  checks.push({
    name: 'exposure',
    status: exposure.length > 0 ? 'info' : 'ok',
    message:
      exposure.length > 0
        ? `${exposure.join('; ')}（详见 docs/operations/REVERSE-PROXY.md §8）`
        : 'loopback listeners have an explicit token or proxy secret',
  });

  // --deep：只读查询本地 gateway（连接 / runtime / MCP 实际状态）。
  if (options.deep === true) {
    const targetResult = await resolveControlPlaneTarget({
      config,
      env,
      dataDir,
      ...(options.target !== undefined ? { target: options.target } : {}),
    });
    if (!targetResult.ok) {
      checks.push({
        name: 'attach',
        status: 'info',
        message: `no local gateway (${targetResult.error})`,
      });
    } else {
      const target = targetResult.target;
      try {
        const health = await target.request<unknown>('health.get');
        const record =
          typeof health === 'object' && health !== null && !Array.isArray(health)
            ? (health as Record<string, unknown>)
            : {};
        const node =
          typeof record.node === 'object' && record.node !== null
            ? (record.node as Record<string, unknown>)
            : {};
        checks.push({
          name: 'attach',
          status: 'ok',
          message: `${target.baseUrl} (${target.instance ?? 'remote'})`,
        });
        const status = node.status ?? record.status;
        const provider = record.provider ?? config.provider?.name;
        const model = record.model ?? config.provider?.model;
        checks.push({
          name: 'runtime',
          status: status === 'error' ? 'fail' : 'ok',
          message:
            `status=${String(status ?? 'unknown')} ` +
            `provider=${String(provider ?? '-')} model=${String(model ?? '-')}` +
            (record.current_run_id !== undefined
              ? ` current_run=${String(record.current_run_id)}`
              : ''),
        });

        const mcpConfigured = Object.keys(config.mcpServers ?? {}).filter(
          (name) => config.mcpServers?.[name]?.enabled !== false,
        ).length;
        try {
          const listed = await target.request<unknown>('mcp.list');
          const servers =
            typeof listed === 'object' &&
            listed !== null &&
            Array.isArray((listed as { servers?: unknown }).servers)
              ? ((listed as { servers: unknown[] }).servers as unknown[])
              : [];
          checks.push({
            name: 'mcp_rpc',
            status: servers.length === mcpConfigured ? 'ok' : 'warn',
            message: `${servers.length} server(s) via RPC / ${mcpConfigured} configured`,
          });
        } catch (error) {
          checks.push({
            name: 'mcp_rpc',
            status: mcpConfigured > 0 ? 'warn' : 'info',
            message: `unavailable: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      } catch (error) {
        checks.push({
          name: 'attach',
          status: 'fail',
          message: `${target.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        await target.close().catch(() => undefined);
      }
    }
  }

  // 可选能力开关（信息项）
  const capability = [
    config.agent?.enabled !== false ? 'agent' : null,
    config.durable?.enabled !== false ? 'durable' : null,
    config.evals?.enabled !== false ? 'evals' : null,
    config.feishu?.enabled === true ? 'feishu' : null,
  ].filter((value): value is string => value !== null);
  // 0.56.1：Web 控制台产物是 `gateway start` 的硬前置 —— 在这里先看出来，
  // 别等 start 才失败（新克隆必踩）。只判存在，不触发构建。
  {
    const staticDir = (env.VESSEL_STATIC_DIR ?? '').trim() || DEFAULT_WEB_DIST_DIR;
    const present = fs.existsSync(path.join(staticDir, 'index.html'));
    checks.push({
      name: 'web',
      status: present ? 'ok' : 'fail',
      message: present
        ? staticDir
        : `missing at ${staticDir} — run "bun run build:web" (fresh clone has no assets), ` +
          'or point VESSEL_STATIC_DIR at an existing build',
    });
  }

  checks.push({
    name: 'capabilities',
    status: 'info',
    message: capability.length > 0 ? capability.join(', ') : 'none opt-in',
  });

  // 飞书凭据（启用时）
  if (config.feishu?.enabled === true) {
    const appId = nonEmpty(env.VESSEL_FEISHU_APP_ID) ?? nonEmpty(config.feishu.appId);
    const appSecret =
      nonEmpty(env.VESSEL_FEISHU_APP_SECRET) ??
      nonEmpty(config.feishu.appSecretEnv ? env[config.feishu.appSecretEnv] : undefined) ??
      nonEmpty(config.feishu.appSecret);
    checks.push({
      name: 'feishu_credentials',
      status: appId && appSecret ? 'ok' : 'fail',
      message: `app id ${appId ? '<set>' : '<unset>'}, app secret ${appSecret ? '<set>' : '<unset>'}`,
    });
  }

  const summary = {
    ok: checks.filter((check) => check.status === 'ok').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
  };

  if (options.json) {
    return {
      exitCode: summary.fail > 0 ? 1 : 0,
      stdout: JSON.stringify(
        {
          version,
          data_dir: dataDir,
          checks,
          summary,
        },
        null,
        2,
      ),
      stderr: '',
    };
  }

  const tag: Record<CheckStatus, string> = {
    ok: '[ok]',
    warn: '[warn]',
    fail: '[fail]',
    info: '[info]',
  };
  const styledTag = (status: CheckStatus): string => {
    const label = tag[status].padEnd(7);
    if (status === 'ok') return ui.ok(label);
    if (status === 'warn') return ui.warn(label);
    if (status === 'fail') return ui.err(label);
    return ui.info(label);
  };
  const lines = [ui.title(`Vessel doctor ${version}`)];
  for (const check of checks) {
    lines.push(`${styledTag(check.status)} ${check.name}: ${check.message}`);
  }
  const summaryLine = `${summary.ok} ok, ${summary.warn} warning(s), ${summary.fail} failure(s)`;
  lines.push(
    '',
    summary.fail > 0
      ? ui.err(summaryLine)
      : summary.warn > 0
        ? ui.warn(summaryLine)
        : ui.ok(summaryLine),
  );
  return { exitCode: summary.fail > 0 ? 1 : 0, stdout: lines.join('\n'), stderr: '' };
}
