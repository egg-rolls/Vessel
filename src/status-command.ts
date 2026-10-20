/**
 * `vessel status [--json]`（0.14 DECISION-025 §1.5）。
 *
 * 一屏输出本地配置、运行中的 gateway 实例与控制面 attach 状态。
 * 只读：不 bootstrap、不获取 tenant 写锁、不输出任何密钥。
 *
 * @module vessel/status-command
 */

import { loadConfig, type VesselConfig } from '../packages/config/src/index';
import { formatConfigErrors } from './config-error-format';
import {
  type ControlPlaneTarget,
  type ControlPlaneTargetOptions,
  resolveControlPlaneTarget,
} from './control-plane-target';
import { resolveDataDir } from './data-paths';
import { type GatewayPidEntry, listGatewayPidStates } from './gateway/pid';
import { gatewayBaseUrl } from './gateway/reload';
import { t } from './i18n';
import { ui } from './ui-style';
import { readPackageVersion } from './version';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface StatusCommandOptions extends ControlPlaneTargetOptions {
  json?: boolean;
  now?: () => number;
  version?: string;
}

interface InstanceView {
  instance: string;
  running: boolean;
  pid?: number;
  host?: string;
  port?: number;
  url?: string;
  started_at?: string;
  uptime_seconds?: number;
  version?: string;
  node_id?: string;
  pid_file: string;
  stale?: boolean;
  reason?: string;
}

interface AttachView {
  kind: 'local' | 'remote';
  url: string;
  instance?: string;
  node_id?: string;
  tenant_id?: string;
  status?: string;
  clients?: number;
  latest_seq?: number;
  current_run_id?: string;
  current_session_id?: string;
  queue?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function pickNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function instanceView(
  entry: GatewayPidEntry,
  config: VesselConfig,
  now: () => number,
): InstanceView {
  const state = entry.state;
  if (state.kind === 'running') {
    const record = state.record;
    return {
      instance: entry.instance,
      running: true,
      pid: record.pid,
      host: record.host,
      port: record.port,
      url: gatewayBaseUrl(record, config.serve?.tls !== undefined),
      started_at: record.started_at,
      uptime_seconds: Math.max(0, Math.floor((now() - Date.parse(record.started_at)) / 1000)),
      version: record.version,
      ...(record.node_id !== undefined ? { node_id: record.node_id } : {}),
      pid_file: entry.path,
    };
  }
  return {
    instance: entry.instance,
    running: false,
    pid_file: entry.path,
    ...(state.kind === 'stale'
      ? { stale: true, pid: state.record.pid, reason: state.reason }
      : state.kind === 'invalid'
        ? { reason: state.reason }
        : {}),
  };
}

function attachView(
  target: ControlPlaneTarget,
  health: Record<string, unknown> | undefined,
): AttachView {
  const node = isRecord(health?.node) ? health.node : undefined;
  const runtime = isRecord(health?.runtime) ? health.runtime : undefined;
  const queue = runtime?.queue ?? health?.queue;
  return {
    kind: target.kind,
    url: target.baseUrl,
    ...(target.instance !== undefined ? { instance: target.instance } : {}),
    ...(pickString(node, 'node_id') !== undefined ? { node_id: pickString(node, 'node_id') } : {}),
    ...(pickString(health, 'tenant_id') !== undefined
      ? { tenant_id: pickString(health, 'tenant_id') }
      : {}),
    ...(pickString(node, 'status') !== undefined ? { status: pickString(node, 'status') } : {}),
    ...(pickNumber(health, 'clients') !== undefined
      ? { clients: pickNumber(health, 'clients') }
      : {}),
    ...(pickNumber(health, 'latest_seq') !== undefined
      ? { latest_seq: pickNumber(health, 'latest_seq') }
      : {}),
    ...(pickString(node, 'current_run_id') !== undefined
      ? { current_run_id: pickString(node, 'current_run_id') }
      : {}),
    ...(pickString(node, 'current_session_id') !== undefined
      ? { current_session_id: pickString(node, 'current_session_id') }
      : {}),
    ...(queue !== undefined ? { queue } : {}),
  };
}

/**
 * `vessel status`：人类输出走暗金样式，`--json` 纯 JSON（无 ANSI）。
 */
export async function statusCommand(options: StatusCommandOptions = {}): Promise<CommandResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const json = options.json === true;

  let config: VesselConfig;
  let tenantId: string;
  let validationErrors: Array<{ path: string; message: string }> = [];
  let configPaths: { user: string; project: string } = { user: '', project: '' };

  if (options.config !== undefined) {
    config = options.config;
    tenantId = options.tenantId ?? 'default';
  } else {
    const configResult = await loadConfig({
      env,
      ...(options.tenantId != null ? { tenantId: options.tenantId } : {}),
    });
    config = configResult.config;
    tenantId = configResult.tenantId;
    validationErrors = configResult.validation.errors;
    configPaths = configResult.paths;
  }
  if (validationErrors.length > 0) {
    const errors = validationErrors.map(({ path, message }) => ({ path, message }));
    return {
      exitCode: 1,
      stdout: json ? JSON.stringify({ errors }) : '',
      stderr: formatConfigErrors(validationErrors, { paths: configPaths }),
    };
  }

  const dataDir = options.dataDir ?? resolveDataDir(config, env);
  const entries = await listGatewayPidStates(dataDir, {
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.runCommand !== undefined ? { runCommand: options.runCommand } : {}),
  });

  const targetResult = await resolveControlPlaneTarget({
    ...options,
    config,
    dataDir,
    env,
    tenantId,
  });
  const explicitConnect =
    (options.connectUrl !== null && options.connectUrl !== undefined) ||
    (env.VESSEL_CONNECT ?? '').trim() !== '';

  let attach: AttachView | undefined;
  let attachError: string | undefined;
  if (targetResult.ok) {
    try {
      const health = await targetResult.target.request<unknown>('health.get', {
        tenant_id: tenantId,
      });
      attach = attachView(targetResult.target, isRecord(health) ? health : undefined);
    } catch (error) {
      attachError = error instanceof Error ? error.message : String(error);
    } finally {
      await targetResult.target.close().catch(() => undefined);
    }
  } else if (explicitConnect) {
    return { exitCode: 1, stdout: '', stderr: targetResult.error };
  }

  const instances = entries.map((entry) => instanceView(entry, config, now));
  const running = entries.some((entry) => entry.state.kind === 'running');
  const payload = {
    as_of: new Date(now()).toISOString(),
    version: options.version ?? readPackageVersion(),
    tenant_id: tenantId,
    data_dir: dataDir,
    provider: {
      ...(config.provider?.name !== undefined ? { name: config.provider.name } : {}),
      ...(config.provider?.model !== undefined ? { model: config.provider.model } : {}),
    },
    instances,
    attach: attach ?? null,
    ...(attachError !== undefined ? { attach_error: attachError } : {}),
    queue: attach?.queue ?? null,
  };

  const exitCode =
    (explicitConnect && attach === undefined) || (running && attachError !== undefined) ? 1 : 0;

  if (json) {
    return { exitCode, stdout: JSON.stringify(payload, null, 2), stderr: '' };
  }

  const lines: string[] = [];
  lines.push(ui.title(t('status.title')));
  lines.push(ui.rule(48));
  lines.push(ui.kv(t('status.version'), payload.version, 12));
  lines.push(ui.kv(t('status.tenant'), tenantId, 12));
  lines.push(ui.kv(t('status.dataDir'), dataDir, 12));
  const provider =
    config.provider?.name !== undefined
      ? `${config.provider.name}${config.provider.model !== undefined ? ` / ${config.provider.model}` : ''}`
      : '-';
  lines.push(ui.kv(t('status.provider'), provider, 12));

  if (attach !== undefined) {
    lines.push(
      ui.kv(
        t('status.attach'),
        `${attach.url}${attach.instance !== undefined ? ` (${attach.instance})` : ''}`,
        12,
      ),
    );
    if (attach.queue !== undefined) {
      lines.push(ui.kv(t('status.queue'), JSON.stringify(attach.queue), 12));
    }
  } else if (attachError !== undefined) {
    lines.push(ui.kv(t('status.attach'), ui.err(attachError), 12));
  } else {
    lines.push(ui.kv(t('status.attach'), t('status.notAttached'), 12));
  }

  lines.push('');
  lines.push(ui.section(t('status.instances')));
  if (instances.length === 0) {
    lines.push(`  ${ui.dim(t('status.noInstances'))}`);
  } else {
    for (const instance of instances) {
      const value = instance.running
        ? `${ui.ok(t('gateway.running'))}  pid ${instance.pid}  ${instance.url ?? ''}`
        : instance.stale === true
          ? ui.warn(`${t('gateway.notRunning')} (stale: ${instance.reason ?? ''})`)
          : t('gateway.notRunning');
      lines.push(ui.kv(instance.instance, value.trimEnd(), 12));
      lines.push(`  ${ui.dim(instance.pid_file)}`);
    }
  }
  return { exitCode, stdout: lines.join('\n'), stderr: '' };
}
