/**
 * Install / remove / update / list.
 *
 * CONTRACT-0.44 §3 installation flow, in order:
 *   1. registry snapshot (cached, see registry.ts)
 *   2. download the release asset to a temp dir, `<= 50 MiB`
 *   3. byte-for-byte `size` + `sha256` verification
 *   4. safe USTAR extraction (tar.ts: no absolute paths / `..` / links / bombs)
 *   5. `package.json.vessel` id+version+engines verification
 *   6. target `~/.vessel/plugins/<id>` or `<project>/.vessel/plugins/<id>`,
 *      backup existing to `<id>.bak-<ts>`, rollback on any failure
 *   7. `plugins[]` config entry (`enabled: true`); no spawn, the watcher reloads
 *
 * The installer is exported separately from the RPC layer so the probe can
 * inject temp roots and never touch the real `~/.vessel`.
 *
 * @module @vessel-agent/plugin-marketplace/install
 */

import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  type ConfigRemoveResult,
  type ConfigUpdateResult,
  discoverPluginNames,
  removePluginConfig,
  setPluginConfigValue,
  upsertPluginConfig,
} from './config.js';
import { errorCodeOf, MarketplaceError, messageOf } from './errors.js';
import {
  assertSecureUrl,
  findPlugin,
  findVersion,
  isPrereleaseVersion,
  loadRegistry,
  newestVersion,
  type RegistryPlugin,
  type RegistrySnapshot,
  type RegistryVersion,
  summarizePlugin,
} from './registry.js';
import { compareVersionStrings, satisfiesVersionRange } from './semver.js';
import type { InstallScope, MarketplaceSettings } from './settings.js';
import {
  DEFAULT_ARCHIVE_LIMITS,
  extractEntries,
  parseTarEntries,
  stripCommonRoot,
  type TarEntry,
} from './tar.js';

export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export interface InstallLimits {
  maxDownloadBytes: number;
  maxExtractBytes: number;
  maxEntries: number;
}

export const DEFAULT_INSTALL_LIMITS: InstallLimits = {
  maxDownloadBytes: MAX_DOWNLOAD_BYTES,
  maxExtractBytes: DEFAULT_ARCHIVE_LIMITS.maxExtractBytes,
  maxEntries: DEFAULT_ARCHIVE_LIMITS.maxEntries,
};

export interface InstallContext {
  settings: MarketplaceSettings;
  /** Plugin-private dir `<globalDataDir>/plugins/marketplace`. */
  dataDir: string;
  globalDataDir?: string;
  /** `~/.vessel/plugins` (host discovery root; no category level). */
  userPluginsDir: string;
  /**
   * Absolute project root from `settings.project_root` or the host-injected
   * `VESSEL_PLUGIN_HOST_CWD` (Errata E4). Never inferred from cwd.
   */
  projectDir?: string;
  /** `~/.vessel/config.yaml`. */
  configPath: string;
  limits?: Partial<InstallLimits>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  /**
   * Plugin ids enabled by default, used only when materializing an absent
   * `plugins:` list. `null` explicitly skips the write. When omitted, discovery
   * runs and skips if the built-in plugin root is unknown.
   */
  defaultPluginNames?: string[] | null;
}

interface InFlight {
  promise: Promise<unknown>;
}

const inFlight = new Map<string, InFlight>();

async function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) {
    throw new MarketplaceError('busy', `another ${key} operation is in progress`);
  }
  const entry: InFlight = { promise: run() };
  inFlight.set(key, entry);
  try {
    return (await entry.promise) as T;
  } finally {
    inFlight.delete(key);
  }
}

function limitsOf(context: InstallContext): InstallLimits {
  return { ...DEFAULT_INSTALL_LIMITS, ...(context.limits ?? {}) };
}

export function registryCachePath(context: InstallContext): string {
  return join(context.dataDir, 'cache', 'index.json');
}

function snapshot(context: InstallContext, force = false): Promise<RegistrySnapshot> {
  return loadRegistry({
    settings: context.settings,
    cachePath: registryCachePath(context),
    ...(context.fetchImpl !== undefined ? { fetchImpl: context.fetchImpl } : {}),
    ...(context.now !== undefined ? { now: context.now } : {}),
    ...(context.ttlMs !== undefined ? { ttlMs: context.ttlMs } : {}),
    force,
  });
}

function registryMeta(snapshotValue: RegistrySnapshot): Record<string, unknown> {
  return {
    url: snapshotValue.url,
    trusted: snapshotValue.trusted,
    stale: snapshotValue.stale,
    fetched_at: snapshotValue.fetchedAt,
    ...(snapshotValue.index.updated_at !== undefined
      ? { updated_at: snapshotValue.index.updated_at }
      : {}),
  };
}

function parseOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new MarketplaceError('invalid_params', `${field} must be a string`, { rpcCode: -32602 });
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

// ── queries ─────────────────────────────────────────────────────────────────

export interface SearchParams {
  query?: string;
  category?: string;
}

export async function searchPlugins(
  context: InstallContext,
  params: SearchParams,
): Promise<Record<string, unknown>> {
  const query = parseOptionalText(params.query, 'query');
  const category = parseOptionalText(params.category, 'category');
  const registry = await snapshot(context);

  const needle = query?.toLowerCase();
  const items = registry.index.plugins
    .filter((plugin) => {
      if (category !== undefined) {
        if ((plugin.category ?? '').toLowerCase() !== category.toLowerCase()) return false;
      }
      if (needle === undefined) return true;
      const haystack = [
        plugin.id,
        plugin.name,
        plugin.summary ?? '',
        plugin.description ?? '',
        plugin.category ?? '',
        ...(plugin.tags ?? []),
      ]
        .join('\n')
        .toLowerCase();
      return haystack.includes(needle);
    })
    .map((plugin) => summarizePlugin(plugin))
    .sort((left, right) => left.name.localeCompare(right.name));

  const categories = [
    ...new Set(registry.index.plugins.map((plugin) => plugin.category).filter(Boolean)),
  ].sort();

  return { registry: registryMeta(registry), items, total: items.length, categories };
}

export async function pluginDetail(
  context: InstallContext,
  id: string,
): Promise<Record<string, unknown>> {
  assertPluginId(id);
  const registry = await snapshot(context);
  const plugin = findPlugin(registry.index, id);
  if (plugin === undefined) {
    throw new MarketplaceError('plugin_not_found', `plugin "${id}" is not in the registry`);
  }
  return {
    registry: registryMeta(registry),
    plugin: { ...plugin, versions: plugin.versions.map((version) => ({ ...version })) },
  };
}

/**
 * Read one existing install target's version (used by update to decide whether
 * a newer version exists). The target path is derived from the id; this is not
 * a directory scan.
 */
async function readInstalledVersion(dir: string): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const pkg = raw as Record<string, unknown>;
    const vessel =
      typeof pkg.vessel === 'object' && pkg.vessel !== null && !Array.isArray(pkg.vessel)
        ? (pkg.vessel as Record<string, unknown>)
        : undefined;
    if (typeof vessel?.version === 'string' && vessel.version !== '') return vessel.version;
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registry-only update check for the ids the host pushed in `vessel.catalog`.
 * Never reads plugin directories. `update_available` needs the installed
 * version, which is part of the catalog, so the caller derives it from
 * `latest`; the field stays optional here for forward compatibility.
 */
export async function pluginUpdates(
  context: InstallContext,
  ids: readonly string[],
): Promise<Record<string, unknown>> {
  let registry: RegistrySnapshot | undefined;
  let registryError: string | undefined;
  try {
    registry = await snapshot(context);
  } catch (error) {
    registryError = messageOf(error);
  }
  const unique = [...new Set(ids)];
  const items = unique.map((id) => {
    if (registry === undefined) return { id };
    const plugin = findPlugin(registry.index, id);
    if (plugin === undefined) return { id };
    const newest = newestVersion(plugin, context.settings.allowPrerelease);
    return newest === undefined ? { id } : { id, latest: newest.version };
  });
  return {
    ...(registry !== undefined ? { registry: registryMeta(registry) } : {}),
    ...(registryError !== undefined ? { registry_error: registryError } : {}),
    items,
  };
}

// ── target selection ────────────────────────────────────────────────────────

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function assertPluginId(id: string): void {
  if (!PLUGIN_ID_RE.test(id)) {
    throw new MarketplaceError('invalid_params', `invalid plugin id "${id}"`, { rpcCode: -32602 });
  }
}

export interface InstallTarget {
  dir: string;
  scope: InstallScope;
  root: string;
}

export function resolveInstallTarget(
  context: InstallContext,
  id: string,
  scope: InstallScope = context.settings.installScope,
): InstallTarget {
  assertPluginId(id);
  if (scope === 'project') {
    // Errata E4: settings.project_root or the host's VESSEL_PLUGIN_HOST_CWD
    // only. Never guess from cwd: the child cwd is the plugin package dir.
    if (context.projectDir === undefined || context.projectDir.trim() === '') {
      throw new MarketplaceError(
        'install_failed',
        'project installs require project_root in settings or VESSEL_PLUGIN_HOST_CWD ' +
          'from the host; use install_scope: user to install under ~/.vessel/plugins',
      );
    }
    if (!isAbsolute(context.projectDir)) {
      throw new MarketplaceError(
        'install_failed',
        `project_root must be an absolute path, got "${context.projectDir}"`,
      );
    }
    const root = join(context.projectDir, '.vessel', 'plugins');
    return { dir: join(root, id), scope, root };
  }
  return { dir: join(context.userPluginsDir, id), scope, root: context.userPluginsDir };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return false;
    throw error;
  }
}

/** Existing target, preferring the configured scope, then the other scope. */
async function findInstalledTarget(
  context: InstallContext,
  id: string,
): Promise<InstallTarget | undefined> {
  const preferred = resolveInstallTarget(context, id);
  if (await pathExists(preferred.dir)) return preferred;
  const otherScope: InstallScope = preferred.scope === 'user' ? 'project' : 'user';
  const other = resolveInstallTarget(context, id, otherScope);
  return (await pathExists(other.dir)) ? other : undefined;
}

// ── download + verify ───────────────────────────────────────────────────────

interface DownloadedAsset {
  path: string;
  size: number;
  sha256: string;
}

async function downloadAsset(
  context: InstallContext,
  version: RegistryVersion,
  directory: string,
  progress?: (phase: 'downloading' | 'verifying', done: number, total: number) => void,
): Promise<DownloadedAsset> {
  const limits = limitsOf(context);
  const asset = version.asset;
  assertSecureUrl(asset.url, `asset.url for ${version.version}`);

  const init: RequestInit & { proxy?: string } = {
    headers: { accept: 'application/octet-stream', 'user-agent': 'vessel-marketplace/0.1' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  };
  if (context.settings.proxy !== undefined) init.proxy = context.settings.proxy;

  const fetchImpl = context.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(asset.url, init);
  } catch (error) {
    throw new MarketplaceError(
      'registry_fetch_failed',
      `could not download ${version.version}: ${messageOf(error)}`,
    );
  }
  if (!response.ok) {
    throw new MarketplaceError(
      'registry_fetch_failed',
      `asset download returned HTTP ${response.status}`,
    );
  }
  if (response.url) assertSecureUrl(response.url, 'asset redirect');

  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limits.maxDownloadBytes) {
    throw new MarketplaceError(
      'asset_too_large',
      `asset is larger than ${limits.maxDownloadBytes} bytes`,
    );
  }

  const chunks: Uint8Array[] = [];
  const hash = createHash('sha256');
  let total = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limits.maxDownloadBytes) {
          await reader.cancel().catch(() => {});
          throw new MarketplaceError(
            'asset_too_large',
            `asset is larger than ${limits.maxDownloadBytes} bytes`,
          );
        }
        hash.update(value);
        chunks.push(value);
        progress?.('downloading', total, asset.size);
      }
    } finally {
      reader.releaseLock();
    }
  }

  progress?.('verifying', total, asset.size);
  if (total !== asset.size) {
    throw new MarketplaceError(
      'size_mismatch',
      `asset size mismatch: expected ${asset.size}, received ${total}`,
      { data: { expected: asset.size, actual: total } },
    );
  }
  const digest = hash.digest('hex').toLowerCase();
  if (digest !== asset.sha256.toLowerCase()) {
    throw new MarketplaceError(
      'checksum_mismatch',
      'asset sha256 does not match the registry index',
      { data: { expected: asset.sha256, actual: digest } },
    );
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const path = join(directory, `${sanitizeFileName(version.version)}.tgz`);
  await writeFile(path, output, { mode: 0o600 });
  return { path, size: total, sha256: digest };
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function gunzipArchive(compressed: Uint8Array, limits: InstallLimits): Uint8Array {
  let tarBytes: Uint8Array;
  try {
    tarBytes = gunzipSync(compressed, { maxOutputLength: limits.maxExtractBytes + 1 });
  } catch (error) {
    const code = errorCodeOf(error);
    const message = messageOf(error);
    if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength/i.test(message)) {
      throw new MarketplaceError(
        'archive_too_large',
        `archive expands beyond ${limits.maxExtractBytes} bytes`,
      );
    }
    throw new MarketplaceError('archive_invalid', 'asset is not a valid gzip stream');
  }
  if (tarBytes.byteLength > limits.maxExtractBytes) {
    throw new MarketplaceError(
      'archive_too_large',
      `archive expands beyond ${limits.maxExtractBytes} bytes`,
    );
  }
  return tarBytes;
}

// ── manifest verification ───────────────────────────────────────────────────

export interface VesselManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  engines?: { vessel?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readVesselManifest(
  directory: string,
  registryId: string,
  registryVersion: string,
  vesselVersion: string | undefined,
): Promise<{ manifest: VesselManifest; warnings: string[] }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(directory, 'package.json'), 'utf-8'));
  } catch {
    throw new MarketplaceError('manifest_invalid', 'package.json is missing or not valid JSON');
  }
  if (!isRecord(raw)) {
    throw new MarketplaceError('manifest_invalid', 'package.json must be an object');
  }
  const vessel = raw.vessel;
  if (!isRecord(vessel)) {
    throw new MarketplaceError('manifest_invalid', 'package.json has no vessel manifest');
  }
  const id = vessel.id;
  const name = vessel.name;
  const version = vessel.version;
  const entry = vessel.entry;
  if (typeof id !== 'string' || id === '') {
    throw new MarketplaceError('manifest_invalid', 'vessel.id is required');
  }
  if (typeof name !== 'string' || name === '') {
    throw new MarketplaceError('manifest_invalid', 'vessel.name is required');
  }
  if (typeof version !== 'string' || version === '') {
    throw new MarketplaceError('manifest_invalid', 'vessel.version is required');
  }
  if (typeof entry !== 'string' || entry === '') {
    throw new MarketplaceError('manifest_invalid', 'vessel.entry is required');
  }

  if (id !== registryId) {
    throw new MarketplaceError(
      'manifest_mismatch',
      `manifest id "${id}" does not match registry id "${registryId}"`,
    );
  }
  if (version !== registryVersion) {
    throw new MarketplaceError(
      'manifest_mismatch',
      `manifest version "${version}" does not match registry version "${registryVersion}"`,
    );
  }

  const base = resolve(directory);
  const entryPath = resolve(base, entry);
  const rel = relative(base, entryPath);
  if (isAbsolute(entry) || rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new MarketplaceError('manifest_invalid', 'vessel.entry must stay inside the plugin');
  }
  if (!(await pathExists(entryPath))) {
    throw new MarketplaceError('manifest_invalid', `vessel.entry "${entry}" does not exist`);
  }

  const warnings: string[] = [];
  let engines: { vessel?: string } | undefined;
  if (isRecord(vessel.engines)) {
    const range = vessel.engines.vessel;
    if (typeof range === 'string') {
      engines = { vessel: range };
      if (vesselVersion !== undefined) {
        if (!satisfiesVersionRange(vesselVersion, range)) {
          throw new MarketplaceError(
            'version_incompatible',
            `plugin requires vessel ${range}, current ${vesselVersion}`,
          );
        }
      } else {
        // The loader resolves the running Vessel version; until the host
        // supplies one, record that install-time verification was skipped.
        warnings.push('engines_unverified');
      }
    }
  }

  return { manifest: { id, name, version, entry, ...(engines ? { engines } : {}) }, warnings };
}

// ── filesystem helpers ──────────────────────────────────────────────────────

async function uniqueSibling(parent: string, base: string): Promise<string> {
  let candidate = join(parent, base);
  let counter = 1;
  while (await pathExists(candidate)) {
    counter += 1;
    candidate = join(parent, `${base}-${counter}`);
  }
  return candidate;
}

/** Rename, falling back to copy+delete across filesystems (EXDEV). */
async function moveDir(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if (errorCodeOf(error) !== 'EXDEV') throw error;
    await cp(source, destination, { recursive: true, errorOnExist: true });
    await rm(source, { recursive: true, force: true });
  }
}

async function verifyStaging(
  context: InstallContext,
  pluginId: string,
  version: RegistryVersion,
  staging: string,
): Promise<string[]> {
  const verified = await readVesselManifest(
    staging,
    pluginId,
    version.version,
    context.settings.vesselVersion,
  );
  return verified.warnings;
}

// ── install ─────────────────────────────────────────────────────────────────

/** Progress events consumed by the job poller. */
export interface InstallProgress {
  phase: 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'installing' | 'configuring';
  bytesDone?: number;
  bytesTotal?: number;
}

export type ProgressReporter = (progress: InstallProgress) => void;

export interface InstallParams {
  id: string;
  version?: string;
  /** Overrides `settings.install_scope` (used by update to stay in place). */
  scope?: InstallScope;
  /** Background-job progress sink (CONTRACT-0.44 §3 async install). */
  onProgress?: ProgressReporter;
}

export interface InstallResult {
  id: string;
  version: string;
  scope: InstallScope;
  path: string;
  config: ConfigUpdateResult;
  warnings: string[];
}

export async function defaultNamesFor(context: InstallContext): Promise<string[] | null> {
  if (context.defaultPluginNames !== undefined) return context.defaultPluginNames;
  // `context.projectDir` is the host-provided cwd (Errata E4). Source plugins
  // live at `<hostCwd>/plugins/**`; installed project plugins at
  // `<hostCwd>/.vessel/plugins`. `null` means "cannot enumerate" → skip write.
  return discoverPluginNames({
    userPluginsDir: context.userPluginsDir,
    ...(context.projectDir !== undefined
      ? {
          hostCwd: context.projectDir,
          projectPluginsDir: join(context.projectDir, '.vessel', 'plugins'),
        }
      : {}),
  });
}

function selectVersion(
  plugin: RegistryPlugin,
  requested: string | undefined,
  allowPrerelease: boolean,
): RegistryVersion {
  if (requested !== undefined) {
    const found = findVersion(plugin, requested);
    if (found === undefined) {
      throw new MarketplaceError(
        'version_not_found',
        `version "${requested}" is not published for ${plugin.id}`,
      );
    }
    if (isPrereleaseVersion(found.version) && !allowPrerelease) {
      throw new MarketplaceError(
        'prerelease_not_allowed',
        `version "${found.version}" is a prerelease; enable allow_prerelease`,
      );
    }
    return found;
  }
  const newest = newestVersion(plugin, allowPrerelease);
  if (newest === undefined) {
    throw new MarketplaceError('version_not_found', `no installable version for ${plugin.id}`);
  }
  return newest;
}

async function installLocked(
  context: InstallContext,
  params: InstallParams,
): Promise<InstallResult> {
  const progress = params.onProgress;
  progress?.({ phase: 'resolving' });
  const registry = await snapshot(context);
  const plugin = findPlugin(registry.index, params.id);
  if (plugin === undefined) {
    throw new MarketplaceError('plugin_not_found', `plugin "${params.id}" is not in the registry`);
  }
  const version = selectVersion(plugin, params.version, context.settings.allowPrerelease);
  const target = resolveInstallTarget(context, params.id, params.scope);
  const limits = limitsOf(context);

  await mkdir(context.dataDir, { recursive: true, mode: 0o700 });
  const temporaryDir = await mkdtemp(join(context.dataDir, 'tmp-'));
  try {
    progress?.({ phase: 'downloading', bytesDone: 0, bytesTotal: version.asset.size });
    const downloaded = await downloadAsset(context, version, temporaryDir, (phase, done, total) => {
      progress?.({ phase, bytesDone: done, bytesTotal: total });
    });
    progress?.({ phase: 'extracting', bytesDone: downloaded.size, bytesTotal: version.asset.size });
    const compressed = new Uint8Array(await readFile(downloaded.path));
    const tarBytes = gunzipArchive(compressed, limits);
    const entries: TarEntry[] = stripCommonRoot(parseTarEntries(tarBytes, limits));
    const staging = join(temporaryDir, 'staging');
    await extractEntries(entries, staging);
    // Manifest id/version/engines verification is part of extraction validation.
    const warnings = await verifyStaging(context, plugin.id, version, staging);

    progress?.({ phase: 'installing', bytesDone: downloaded.size, bytesTotal: version.asset.size });
    await mkdir(target.root, { recursive: true, mode: 0o700 });
    let backup: string | undefined;
    if (await pathExists(target.dir)) {
      const stamp = (context.now ?? Date.now)();
      backup = await uniqueSibling(target.root, `${params.id}.bak-${stamp}`);
      await rename(target.dir, backup);
    }

    try {
      await moveDir(staging, target.dir);
    } catch (error) {
      if (backup !== undefined) await rename(backup, target.dir).catch(() => {});
      throw new MarketplaceError(
        'install_failed',
        `could not place the plugin directory (${errorCodeOf(error) ?? messageOf(error)})`,
      );
    }

    progress?.({
      phase: 'configuring',
      bytesDone: downloaded.size,
      bytesTotal: version.asset.size,
    });
    let config: ConfigUpdateResult;
    try {
      config = await upsertPluginConfig({
        configPath: context.configPath,
        name: params.id,
        defaultNames: await defaultNamesFor(context),
      });
    } catch (error) {
      await rm(target.dir, { recursive: true, force: true }).catch(() => {});
      if (backup !== undefined) await rename(backup, target.dir).catch(() => {});
      throw error instanceof MarketplaceError
        ? error
        : new MarketplaceError('config_write_failed', messageOf(error));
    }

    const allWarnings = [...warnings];
    if (backup !== undefined) {
      try {
        await rm(backup, { recursive: true, force: true });
      } catch {
        allWarnings.push('backup_cleanup_failed');
      }
    }
    return {
      id: params.id,
      version: version.version,
      scope: target.scope,
      path: target.dir,
      config,
      warnings: allWarnings,
    };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function installPlugin(
  context: InstallContext,
  params: InstallParams,
): Promise<InstallResult> {
  assertPluginId(params.id);
  return withLock(params.id, () => installLocked(context, params));
}

// ── remove ──────────────────────────────────────────────────────────────────

export interface RemoveResult {
  id: string;
  removed: boolean;
  path: string;
  scope: InstallScope;
  config: ConfigRemoveResult;
  warnings: string[];
}

export async function removePlugin(context: InstallContext, id: string): Promise<RemoveResult> {
  assertPluginId(id);
  return withLock(id, async () => {
    const target = await findInstalledTarget(context, id);
    if (target === undefined) {
      // Built-ins live in the host's plugin roots, never under the install
      // roots this RPC manages; the catalog marks them readonly for the UI.
      throw new MarketplaceError('not_installed', `plugin "${id}" is not installed`);
    }

    const stamp = (context.now ?? Date.now)();
    const backup = await uniqueSibling(target.root, `${id}.removing-${stamp}`);
    await rename(target.dir, backup);

    let config: ConfigRemoveResult;
    try {
      config = await removePluginConfig(context.configPath, id);
    } catch (error) {
      await rename(backup, target.dir).catch(() => {});
      throw error instanceof MarketplaceError
        ? error
        : new MarketplaceError('remove_failed', messageOf(error));
    }

    try {
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      await rename(backup, target.dir).catch(() => {});
      await upsertPluginConfig({
        configPath: context.configPath,
        name: id,
        defaultNames: context.defaultPluginNames,
      }).catch(() => {});
      throw new MarketplaceError(
        'remove_failed',
        `could not delete the plugin directory (${errorCodeOf(error) ?? messageOf(error)})`,
      );
    }

    return {
      id,
      removed: true,
      path: target.dir,
      scope: target.scope,
      config,
      warnings: ['deactivation_deferred_to_watcher'],
    };
  });
}

// ── update ──────────────────────────────────────────────────────────────────

export interface UpdateResult {
  id: string;
  updated: boolean;
  from: string;
  to: string;
  install?: InstallResult;
}

export interface UpdateOptions {
  onProgress?: ProgressReporter;
}

export async function updatePlugin(
  context: InstallContext,
  id: string,
  options: UpdateOptions = {},
): Promise<UpdateResult> {
  assertPluginId(id);
  options.onProgress?.({ phase: 'resolving' });
  return withLock(id, async () => {
    const target = await findInstalledTarget(context, id);
    const installedVersion =
      target !== undefined ? await readInstalledVersion(target.dir) : undefined;
    if (target === undefined || installedVersion === undefined) {
      throw new MarketplaceError('not_installed', `plugin "${id}" is not installed`);
    }
    const registry = await snapshot(context);
    const plugin = findPlugin(registry.index, id);
    if (plugin === undefined) {
      throw new MarketplaceError('plugin_not_found', `plugin "${id}" is not in the registry`);
    }
    const newest = newestVersion(plugin, context.settings.allowPrerelease);
    if (newest === undefined) {
      throw new MarketplaceError('version_not_found', `no installable version for ${id}`);
    }
    if (compareVersionStrings(newest.version, installedVersion) <= 0) {
      return { id, updated: false, from: installedVersion, to: installedVersion };
    }

    const install = await installLocked(context, {
      id,
      version: newest.version,
      scope: target.scope,
      ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    });
    return { id, updated: true, from: installedVersion, to: install.version, install };
  });
}

// ── configure (E10) ─────────────────────────────────────────────────────────

/** The plugin's own id in `config.yaml plugins[]`. */
const MARKETPLACE_PLUGIN_ID = 'marketplace';

/**
 * Persist the marketplace's `registry_url` under `plugins[].config` and adopt
 * it in memory so the next RPC uses the new registry. The caller validates
 * the URL (https, loopback http allowed); this only edits the config.
 */
export async function configureRegistry(
  context: InstallContext,
  registryUrl: string,
): Promise<{ status: 'updated' | 'created'; entries: string[] }> {
  const result = await setPluginConfigValue({
    configPath: context.configPath,
    name: MARKETPLACE_PLUGIN_ID,
    key: 'registry_url',
    value: registryUrl,
    defaultNames: await defaultNamesFor(context),
  });
  context.settings.registryUrl = registryUrl;
  return result;
}

// ── defaults ────────────────────────────────────────────────────────────────

export function defaultUserPluginsDir(): string {
  return join(homedir(), '.vessel', 'plugins');
}

export function defaultConfigPath(): string {
  return join(homedir(), '.vessel', 'config.yaml');
}
