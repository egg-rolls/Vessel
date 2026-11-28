/**
 * `vessel doctor`（0.6.1 P2）：本机配置与运行环境自检。
 *
 * 检查项：provider key / 配置校验 / data_dir 可写 / session 后端路径 /
 * 插件目录与启用项 / MCP server 形状 / serve 端口占用 / 可选能力开关。
 * q-ax-config②：舰队专项（env 卫生 / stale lock / 端口归属 / peer token / node 健康），
 * 见 doctor-fleet.ts；全部严格限本舰队 dataDir。
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
  ModelRefError,
  readMigrationReport,
  resolveEffectiveApiKey,
  resolveModelRef,
  resolvePlatformProxySecret,
  resolvePlatformToken,
  resolveServeProxySecret,
  rootSecretPath,
  synthesizeLegacyRegistry,
  tokenFingerprint,
  type VesselConfig,
} from '../../../packages/config/src/index';
import { isLoopbackHostname } from '../../../packages/serve/src/index';
import {
  resolveDataDir,
  resolveEffectiveTenantId,
  resolveSingleTenantPaths,
} from '../../data/data-paths';
import { loadNodeRegistry } from '../../gateway/node-registry';
import { resolveGatewayToken } from '../../gateway/transport-factory';
// 0.56.1：Web 控制台产物缺失要在 doctor 就能看见（`gateway start` 的硬前置）。
// 0.57：产物「落后于源码」同理 —— 它是「界面一直是旧的」最常见的真实原因。
import {
  DEFAULT_WEB_DIST_DIR,
  explicitWebDistDir,
  inspectWebDist,
  webDistStaleLine,
} from '../../gateway/web-dist';
// 0.56：派生 token 的现状（根密钥 / 指纹；doctor 从不说「必须配置 token」）。
import {
  effectiveHubToken,
  effectiveNodeTokenAuto,
  effectivePlatformToken,
  loadRootSecret,
  readKnownNodeId,
} from '../../node/token-derive';
import { assertUniqueFeishuAppIds, type FeishuTenantConfig } from '../../plugin/feishu-wiring';
import { declarativePluginEntries } from '../../plugin/plugin-config';
import { PluginLoader } from '../../plugin/plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from '../../plugin/plugin-selection';
import { guardListenerInheritance } from '../../shared/socket-inherit-guard.js';
import { readPackageVersion } from '../../shared/version';
import type { DoctorCommandArgs } from '../args';
import { type ControlPlaneTarget, resolveControlPlaneTarget } from '../control-plane-target';
import { ui } from '../output';
// q-ax-config②：舰队专项体检（env 卫生 / stale lock / 端口归属 / peer token / node 健康）。
import { collectFleetChecks } from './doctor-fleet';

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
    server.listen({ host, port, exclusive: true }, () => {
      // R-5 根治：探针绑定窗口内并发的 spawn 也不继承（win32；POSIX no-op）。
      guardListenerInheritance(port, server);
      finish('available');
    });
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
    // q-ax-config②：env_hygiene 需要对比 user 层 data_dir 与 env 覆盖。
    captureLayers: true,
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

  // q-ax-config②：舰队专项体检（严格限本舰队 dataDir；只读）。
  checks.push(
    ...(await collectFleetChecks({
      config,
      env,
      dataDir,
      ...(loaded.layers !== undefined ? { layers: loaded.layers } : {}),
      checkPort,
    })),
  );

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
        // model 读远端节点自报的 capabilities.model；本地 config 只作兜底
        // （health 响应没有顶层 model，旧写法显示的其实是本地配置）。
        const capabilities =
          typeof node.capabilities === 'object' && node.capabilities !== null
            ? (node.capabilities as Record<string, unknown>)
            : {};
        const model = capabilities.model ?? config.provider?.model;
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
  // 0.57：再加一条「产物落后于源码」——gateway 只在**启动时**自动重建，之后源码
  // 再变就没有任何人会重建，也不会有任何提示。这里是用户能主动看到它的地方。
  {
    const explicitDir = explicitWebDistDir(config, env);
    const staticDir = explicitDir ?? DEFAULT_WEB_DIST_DIR;
    const status = await inspectWebDist(
      explicitDir !== undefined ? { staticDir: explicitDir } : {},
    );
    const staleLine = webDistStaleLine(status);
    checks.push({
      name: 'web',
      status: status.exists ? (staleLine !== null ? 'warn' : 'ok') : 'fail',
      message: status.exists
        ? (staleLine ?? staticDir)
        : `missing at ${staticDir} — run "bun run build:web" (fresh clone has no assets), ` +
          'or set gateway.web_dist / VESSEL_STATIC_DIR to an existing build',
    });
  }

  // model-registry 两面重构 §7.5：迁移完成 / 悬空 pin / 疑似旧 ref / dangling 凭证。
  {
    const report = await readMigrationReport(dataDir);
    const modelsRaw = config.models as Record<string, unknown> | undefined;
    if (modelsRaw?.vendors !== undefined || modelsRaw?.aliases !== undefined) {
      checks.push({
        name: 'model_migration',
        status: 'fail',
        message:
          'models.vendors/aliases still present (project layer is not auto-migrated); ' +
          'migrate to models.credentials + models.entries (two-face design §7)',
      });
    } else if (report !== undefined) {
      const problems = [
        ...report.needsReRecord.map((id) => `credential "${id}" needs re-recording`),
        ...report.pinsFailed.map((file) => `pin rewrite failed: ${file}`),
        ...report.errors,
      ];
      checks.push({
        name: 'model_migration',
        status: problems.length > 0 ? 'warn' : 'info',
        message:
          problems.length > 0
            ? problems.join('; ')
            : `migrated at ${report.migratedAt} (${report.entriesCreated.length} entries, ` +
              `${report.credentialsSplit.length} credential splits, ${report.droppedAliases.length} dropped aliases, ` +
              `${report.pinsRewritten.length} pins rewritten)`,
      });
    } else {
      checks.push({ name: 'model_migration', status: 'ok', message: 'no migration pending' });
    }

    // 悬空 pin / 疑似旧 ref（只读交叉检查 agent store；不修改）。
    const snapshot = synthesizeLegacyRegistry(config);
    // 严格面（legacyPresent=false）：未命中即 ModelRefError，用于悬空判定。
    const strictSnapshot = synthesizeLegacyRegistry(config, false);
    const registered = new Set([
      ...Object.keys(snapshot.entries),
      ...Object.keys(snapshot.aliases),
    ]);
    const dangling: string[] = [];
    const suspected: string[] = [];
    const agentsDir = path.join(dataDir, 'agents');
    let agentFiles: string[] = [];
    try {
      agentFiles = fs.readdirSync(agentsDir).filter((name) => name.endsWith('.json'));
    } catch {
      // 无 agent store
    }
    for (const name of agentFiles) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(agentsDir, name), 'utf-8')) as {
          version?: unknown;
          members?: Array<{ id?: unknown; model?: unknown }>;
        };
        if (parsed.version !== 5 || !Array.isArray(parsed.members)) continue;
        for (const member of parsed.members) {
          const pin = typeof member.model === 'string' ? member.model : undefined;
          if (pin === undefined || pin === '' || registered.has(pin)) continue;
          const id = typeof member.id === 'string' ? member.id : '(unknown)';
          // 疑似旧 vid/wire ref（首段不是 legacy 保留前缀）：落入 legacy 透传会把整串当 wire 名。
          if (/^[a-z0-9][a-z0-9-]*\//.test(pin) && !pin.startsWith('legacy:')) {
            suspected.push(`${name}:${id}=${pin}`);
          } else {
            try {
              resolveModelRef(strictSnapshot, pin);
            } catch (error) {
              if (error instanceof ModelRefError) dangling.push(`${name}:${id}=${pin}`);
            }
          }
        }
      } catch {
        // 损坏快照由 agent store 自身报错，这里不重复
      }
    }
    if (dangling.length > 0 || suspected.length > 0) {
      checks.push({
        name: 'model_pins',
        status: 'warn',
        message: [
          ...dangling.map((p) => `unregistered pin ${p}`),
          ...suspected.map((p) => `suspected old vendor ref ${p} (rewrite to an entry key/alias)`),
        ].join('; '),
      });
    } else {
      checks.push({ name: 'model_pins', status: 'ok', message: 'all explicit pins registered' });
    }

    // dangling 凭证：注册条目引用但无库值且无 env 值（解析期 fail-fast 提示录值）。
    const credentials = config.models?.credentials ?? {};
    let envelopeIds = new Set<string>();
    try {
      const envelope = JSON.parse(
        fs.readFileSync(path.join(dataDir, 'credentials.json'), 'utf-8'),
      ) as { entries?: Record<string, unknown> };
      envelopeIds = new Set(Object.keys(envelope.entries ?? {}));
    } catch {
      // 无库 / 损坏：全部按缺值处理
    }
    const missing = Object.entries(credentials)
      .filter(([id, cred]) => {
        const referenced = Object.values(config.models?.entries ?? {}).some(
          (entry) => entry.credential === id,
        );
        if (!referenced) return false;
        const envSet = cred.apiKeyEnv !== undefined && nonEmpty(env[cred.apiKeyEnv]) !== undefined;
        return !envelopeIds.has(id) && !envSet;
      })
      .map(([id]) => id);
    if (missing.length > 0) {
      checks.push({
        name: 'model_credentials',
        status: 'warn',
        message: `referenced credentials without a value: ${missing.join(', ')} (record via "vessel model credential-set")`,
      });
    } else {
      checks.push({
        name: 'model_credentials',
        status: 'ok',
        message: 'referenced credentials have values',
      });
    }
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

  // P1-A7：同 app_id 多 feishu 实例检查（防 WS 长连接随机分消息「时灵时不灵」）。
  // 离线扫描本舰队 registry 各节点 config（隐式节点用本地 config）；重复 → fail（已掩码）。
  {
    const feishuEntries: FeishuTenantConfig[] = [];
    const registry = await loadNodeRegistry(dataDir).catch(() => undefined);
    if (registry?.kind === 'ready') {
      for (const node of registry.registry.nodes) {
        if (node.config_path === undefined) {
          feishuEntries.push({ tenantId: node.node_id ?? node.name, config });
          continue;
        }
        try {
          const nodeLoaded = await loadConfig({
            configPath: node.config_path,
            env: { ...env, VESSEL_DATA_DIR: node.data_dir },
          });
          feishuEntries.push({ tenantId: node.node_id ?? node.name, config: nodeLoaded.config });
        } catch {
          // 节点 config 不可读：doctor 尽力而为，跳过（不在此报节点加载错）。
        }
      }
    } else {
      feishuEntries.push({ tenantId, config });
    }
    if (feishuEntries.some((entry) => entry.config.feishu?.enabled === true)) {
      let status: 'ok' | 'fail' = 'ok';
      let message = 'no duplicate feishu app_id across local fleet configs';
      try {
        assertUniqueFeishuAppIds(feishuEntries);
      } catch (error) {
        status = 'fail';
        message = error instanceof Error ? error.message : String(error);
      }
      checks.push({ name: 'feishu_unique_app_id', status, message });
    }
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
