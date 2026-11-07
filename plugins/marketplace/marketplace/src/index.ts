/**
 * Marketplace plugin — child-process entry and protocol runtime.
 *
 * Wire format (CONTRACT-0.43 §3): newline-delimited JSON-RPC 2.0 on stdout.
 * stderr is diagnostics only. Methods:
 * - `plugin.hello`      -> `{protocol: 1, ok: true}`
 * - `plugin.activate`   -> `{ok: true}` (settings parsed; registry may be unset)
 * - `plugin.event`      -> `{ok: true}` (cache is time-based, no per-event work)
 * - `plugin.rpc`        -> search / detail / install / remove / update / updates /
 *                          job / jobs / set-enabled / configure
 * - `plugin.deactivate` -> `{ok: true}`, then exit
 * - `ping`              -> `pong`
 *
 * RPC method names are bare (`search`); the host adds `plugin.marketplace.`.
 * Results are DTOs directly (CONTRACT-0.43 §3.2.1), never `{result: ...}`.
 *
 * @module @vessel-agent/plugin-marketplace
 */

import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setPluginEnabled } from './config.js';
import { MarketplaceError, messageOf } from './errors.js';
import {
  assertPluginId,
  configureRegistry,
  defaultConfigPath,
  defaultNamesFor,
  defaultUserPluginsDir,
  type InstallContext,
  installPlugin,
  pluginDetail,
  pluginUpdates,
  removePlugin,
  searchPlugins,
  updatePlugin,
} from './install.js';
import { createJob, getJob, jobDto, listJobs, runJob } from './jobs.js';
import { assertSecureUrl } from './registry.js';
import { DEFAULT_REGISTRY_URL, parseSettings } from './settings.js';

const PROTOCOL_VERSION = 1;

let context: InstallContext | undefined;
let activated = false;
let exitScheduled = false;

function log(message: string): void {
  process.stderr.write(`[marketplace] ${message}\n`);
}

function send(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): MarketplaceError {
  return new MarketplaceError('invalid_params', message, { rpcCode: -32602 });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} is required`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/** Search filters treat an empty or blank string as "not provided". */
function optionalSearchText(value: unknown, field: string): string | undefined {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return optionalString(value, field);
}

function scheduleExit(): void {
  if (exitScheduled) return;
  exitScheduled = true;
  setTimeout(() => process.exit(0), 20);
}

function resolveGlobalDataDir(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  const pluginDataDir = process.env.VESSEL_PLUGIN_DATA_DIR;
  if (typeof pluginDataDir !== 'string' || pluginDataDir.length === 0) return undefined;
  // VESSEL_PLUGIN_DATA_DIR = <globalDataDir>/plugins/<id>
  return dirname(dirname(pluginDataDir));
}

function pluginDataDirOf(globalDataDir: string | undefined): string {
  const fromEnv = process.env.VESSEL_PLUGIN_DATA_DIR;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  if (globalDataDir !== undefined) return join(globalDataDir, 'plugins', 'marketplace');
  return join(process.cwd(), '.vessel', 'plugins', 'marketplace');
}

function settingsFromParams(params: Record<string, unknown>): unknown {
  if (params.settings !== undefined) return params.settings;
  const raw = process.env.VESSEL_PLUGIN_CONFIG;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function activate(params: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseSettings(settingsFromParams(params));
  for (const warning of parsed.warnings) log(`settings: ${warning}`);

  const globalDataDir = resolveGlobalDataDir(params.dataDir);
  const pluginDataDir = pluginDataDirOf(globalDataDir);
  const userPluginsDir = defaultUserPluginsDir();
  // Errata E4: settings.project_root, then activate.params.hostCwd, then the
  // host-injected env. No guessing from process.cwd(): the child cwd is the
  // plugin package dir.
  const hostCwdParam = optionalString(params.hostCwd, 'hostCwd');
  const hostCwdEnv = process.env.VESSEL_PLUGIN_HOST_CWD;
  const projectDir =
    parsed.settings.projectRoot ??
    hostCwdParam ??
    (typeof hostCwdEnv === 'string' && hostCwdEnv.trim() !== '' ? hostCwdEnv.trim() : undefined);

  context = {
    settings: parsed.settings,
    dataDir: pluginDataDir,
    ...(globalDataDir !== undefined ? { globalDataDir } : {}),
    userPluginsDir,
    ...(projectDir !== undefined ? { projectDir } : {}),
    configPath: defaultConfigPath(),
  };
  activated = true;
  log(
    `activated; registry=${
      parsed.settings.registryUrl ?? '(unset)'
    } scope=${parsed.settings.installScope} project=${projectDir ?? '(unknown)'}`,
  );
  return { ok: true };
}

function requireContext(): InstallContext {
  if (!activated || context === undefined) {
    throw new MarketplaceError('plugin_not_activated', 'plugin is not activated');
  }
  return context;
}

/** Notify the host so it can forward `vessel.plugin.refresh` to this page. */
function announce(): void {
  send({ jsonrpc: '2.0', method: 'plugin.ready' });
}

async function handleRpc(params: unknown): Promise<unknown> {
  if (!isRecord(params)) throw invalid('params must be an object');
  const name = params.name;
  if (typeof name !== 'string' || name === '') throw invalid('params.name is required');
  const args = isRecord(params.params) ? params.params : {};
  const ctx = requireContext();

  switch (name) {
    case 'search': {
      const query = optionalSearchText(args.query, 'query');
      const category = optionalSearchText(args.category, 'category');
      return searchPlugins(ctx, {
        ...(query !== undefined ? { query } : {}),
        ...(category !== undefined ? { category } : {}),
      });
    }
    case 'detail':
      return pluginDetail(ctx, requireString(args.id, 'id'));
    case 'install': {
      const id = requireString(args.id, 'id');
      assertPluginId(id);
      const version = optionalString(args.version, 'version');
      const job = createJob('install', id, version);
      runJob(
        job,
        (report) =>
          installPlugin(ctx, {
            id,
            ...(version !== undefined ? { version } : {}),
            onProgress: report,
          }),
        { onDone: announce },
      );
      return { job_id: job.jobId };
    }
    case 'remove': {
      const result = await removePlugin(ctx, requireString(args.id, 'id'));
      announce();
      return result;
    }
    case 'update': {
      const id = requireString(args.id, 'id');
      assertPluginId(id);
      const job = createJob('update', id);
      runJob(job, (report) => updatePlugin(ctx, id, { onProgress: report }), {
        onDone: announce,
      });
      return { job_id: job.jobId };
    }
    case 'job': {
      const jobId = requireString(args.job_id, 'job_id');
      const job = getJob(jobId);
      if (job === undefined) {
        throw new MarketplaceError('job_not_found', `job "${jobId}" is unknown or expired`);
      }
      return jobDto(job);
    }
    case 'jobs':
      return { items: listJobs().map(jobDto), ttl_hours: 24 };
    case 'updates': {
      // Registry-only lookup for the ids the host pushed via `vessel.catalog`.
      // Installed versions come from the catalog, so this never scans disk.
      const rawIds = args.ids;
      if (
        !Array.isArray(rawIds) ||
        rawIds.some((id) => typeof id !== 'string' || id.trim() === '')
      ) {
        throw invalid('ids must be an array of plugin ids');
      }
      return pluginUpdates(ctx, rawIds as string[]);
    }
    case 'set-enabled': {
      // DECISION-045: the switch lives in config.yaml; the host watcher
      // reloads plugins. No runtime toggle and no host RPC.
      const id = requireString(args.id, 'id');
      assertPluginId(id);
      if (typeof args.enabled !== 'boolean') throw invalid('enabled must be a boolean');
      const result = await setPluginEnabled({
        configPath: ctx.configPath,
        name: id,
        enabled: args.enabled,
        defaultNames: await defaultNamesFor(ctx),
      });
      return { ok: true, id, enabled: result.enabled };
    }
    case 'configure': {
      // E10: persist the marketplace's own registry_url; https only, with
      // loopback http allowed for local fixtures (same rule as loading).
      const url = assertSecureUrl(
        requireString(args.registry_url, 'registry_url'),
        'registry_url',
      ).toString();
      await configureRegistry(ctx, url);
      return { ok: true, registry_url: url };
    }
    default:
      throw new MarketplaceError('invalid_params', `unknown rpc "${name}"`, { rpcCode: -32601 });
  }
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'plugin.hello': {
      const protocol = isRecord(params) ? params.protocol : undefined;
      if (protocol !== PROTOCOL_VERSION) {
        return {
          protocol: PROTOCOL_VERSION,
          ok: false,
          error: { code: 'plugin_protocol_mismatch' },
        };
      }
      return { protocol: PROTOCOL_VERSION, ok: true };
    }
    case 'plugin.activate': {
      if (!isRecord(params)) throw invalid('params must be an object');
      return activate(params);
    }
    case 'plugin.event':
      // Events are fire-and-forget; the registry cache is TTL-based.
      return { ok: true };
    case 'plugin.deactivate':
      activated = false;
      context = undefined;
      return { ok: true };
    case 'plugin.rpc':
      return handleRpc(params);
    case 'ping':
      return 'pong';
    default:
      throw new MarketplaceError('invalid_params', `Method not found: ${method}`, {
        rpcCode: -32601,
      });
  }
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof MarketplaceError) {
    return {
      code: error.rpcCode,
      message: error.message,
      ...(error.data !== undefined || error.code !== 'invalid_params'
        ? { data: { code: error.code, ...(error.data ?? {}) } }
        : {}),
    };
  }
  return { code: -32603, message: 'internal error' };
}

async function handleLine(line: string): Promise<void> {
  if (exitScheduled) return;
  const trimmed = line.trim();
  if (trimmed === '') return;

  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    log('dropped a non-JSON stdin line');
    return;
  }
  if (!isRecord(message) || typeof message.method !== 'string') return;

  const method = message.method;
  const id = message.id;
  const isRequest = typeof id === 'string' || typeof id === 'number';

  if (method === 'ping' && !isRequest) {
    send({ jsonrpc: '2.0', method: 'pong' });
    return;
  }

  try {
    const result = await dispatch(method, message.params);
    if (isRequest) send({ jsonrpc: '2.0', id, result });
    if (method === 'plugin.deactivate') scheduleExit();
  } catch (error) {
    log(`${method} failed: ${messageOf(error)}`);
    if (isRequest) send({ jsonrpc: '2.0', id, error: errorPayload(error) });
  }
}

function main(): void {
  log(`starting (default registry ${DEFAULT_REGISTRY_URL})`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue: Promise<void> = Promise.resolve();
  rl.on('line', (line) => {
    queue = queue.then(() => handleLine(line));
  });
  rl.on('close', () => {
    void queue.then(() => scheduleExit());
  });

  const stop = (): void => {
    activated = false;
    context = undefined;
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
