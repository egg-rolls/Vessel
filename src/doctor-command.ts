/**
 * `vessel doctor`（0.6.1 P2）：本机配置与运行环境自检。
 *
 * 检查项：provider key / 配置校验 / data_dir 可写 / session 后端路径 /
 * 插件目录与启用项 / MCP server 形状 / serve 端口占用 / 可选能力开关。
 *
 * 不联网、不构造 runtime、不调用 provider；退出码 0 = 无失败项，1 = 有失败项。
 *
 * @module vessel/doctor-command
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  loadConfig,
  resolveEffectiveApiKey,
  type VesselConfig,
} from '../packages/config/src/index';
import type { DoctorCommandArgs } from './cli-args';
import { resolveDataDir, resolveTenantPaths } from './data-paths';
import { declarativePluginEntries } from './plugin-config';
import { PluginLoader } from './plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from './plugin-selection';
import { readPackageVersion } from './version';

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
  const { config, validation, tenantId, paths } = loaded;

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
    name: 'tenant',
    status: 'info',
    message: tenantId,
  });

  const key = resolveEffectiveApiKey(config, env);
  checks.push({
    name: 'provider',
    status: key ? 'ok' : 'fail',
    message: `${config.provider?.name ?? 'openai'} / ${config.provider?.model ?? '<no model>'} / api key ${key ? '<set>' : '<unset>'}`,
  });

  const dataDir = resolveDataDir(config, env);
  const dataStatus = writeTargetStatus(dataDir);
  checks.push({
    name: 'data_dir',
    status: dataStatus,
    message: `${dataDir}${fs.existsSync(dataDir) ? '' : ' (will be created)'}`,
  });

  const tenantPaths = resolveTenantPaths(dataDir, tenantId);
  const backend = config.session?.backend ?? 'file';
  if (backend === 'memory') {
    checks.push({ name: 'session', status: 'info', message: 'backend=memory (no persistence)' });
  } else {
    const storage = sessionStoragePath(config, tenantPaths.root);
    checks.push({
      name: 'session',
      status: writeTargetStatus(storage),
      message: `backend=${backend} path=${storage}${fs.existsSync(storage) ? '' : ' (will be created)'}`,
    });
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

  // serve 端口（仅在显式配置时检查）
  if (config.serve?.port !== undefined && config.serve.port !== 0) {
    const host = config.serve.hostname ?? '127.0.0.1';
    const status = await checkPort(host, config.serve.port);
    checks.push({
      name: 'serve_port',
      status: status === 'available' ? 'ok' : 'warn',
      message:
        status === 'available'
          ? `${host}:${config.serve.port} available`
          : status === 'in_use'
            ? `${host}:${config.serve.port} already in use`
            : `${host}:${config.serve.port} check failed`,
    });
  }

  // 可选能力开关（信息项）
  const capability = [
    config.host?.enabled === true ? 'host' : null,
    config.team?.enabled === true ? 'team' : null,
    config.durable?.enabled === true ? 'durable' : null,
    config.workflow?.enabled === true ? 'workflow' : null,
    config.evals?.enabled === true ? 'evals' : null,
    config.feishu?.enabled === true ? 'feishu' : null,
  ].filter((value): value is string => value !== null);
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
        { version, tenant_id: tenantId, data_dir: dataDir, checks, summary },
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
  const lines = [`Vessel doctor ${version}`];
  for (const check of checks) {
    lines.push(`${tag[check.status].padEnd(7)} ${check.name}: ${check.message}`);
  }
  lines.push('', `${summary.ok} ok, ${summary.warn} warning(s), ${summary.fail} failure(s)`);
  return { exitCode: summary.fail > 0 ? 1 : 0, stdout: lines.join('\n'), stderr: '' };
}
