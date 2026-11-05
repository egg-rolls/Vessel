/**
 * `~/.vessel/config.yaml` edits and plugin-name discovery.
 *
 * The host's `plugins:` list is a switch: once it exists, in-process plugins
 * not listed are not loaded (`src/plugin-selection.ts`). Therefore the
 * marketplace never creates a one-entry list out of an absent one unless it can
 * also enumerate the plugins that were enabled by default. When it cannot, it
 * skips the config write and reports why: the just-installed child plugin is
 * enabled by default anyway, and writing a partial list would silently disable
 * `basic-tools` and friends.
 *
 * YAML round-tripping uses the declared `yaml` dependency. Comments in the
 * user config are not preserved (the host's own helpers behave the same way).
 *
 * @module @vessel-agent/plugin-marketplace/config
 */

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { errorCodeOf, MarketplaceError, messageOf } from './errors.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the config root; a missing file is `{}`, a malformed file is an error. */
export async function readConfigRoot(configPath: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return {};
    throw new MarketplaceError(
      'config_write_failed',
      `could not read config.yaml (${errorCodeOf(error) ?? messageOf(error)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    // Never echo config content: it may contain credentials.
    throw new MarketplaceError('config_write_failed', 'config.yaml is not valid YAML');
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) {
    throw new MarketplaceError('config_write_failed', 'config.yaml must contain a YAML object');
  }
  return parsed;
}

/** Atomic write; on Windows a locked target falls back to a direct write. */
export async function writeConfigRoot(
  configPath: string,
  root: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const body = stringifyYaml(root, { lineWidth: 0 });
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, body, { encoding: 'utf-8', mode: 0o600 });
  try {
    await rename(tmp, configPath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    try {
      await writeFile(configPath, body, { encoding: 'utf-8', mode: 0o600 });
    } catch {
      throw new MarketplaceError(
        'config_write_failed',
        `could not write config.yaml (${errorCodeOf(error) ?? 'write_failed'})`,
      );
    }
  }
}

export interface ConfigUpdateResult {
  status: 'updated' | 'created' | 'skipped';
  /** Plugin names now present in the materialized list (only on create/update). */
  entries: string[];
  /** Why the write was skipped. */
  reason?: string;
}

export interface UpsertConfigOptions {
  configPath: string;
  name: string;
  /**
   * Names enabled by default that must be materialized when `plugins:` is
   * absent. `null` means discovery failed; the caller then skips the write.
   */
  defaultNames?: string[] | null;
}

/**
 * Ensure `plugins[].name === name` with `enabled: true`.
 *
 * - Existing list: touch only that entry (preserve config/settings).
 * - Absent list + `defaultNames`: materialize the full default set, so no
 *   plugin that was implicitly enabled becomes disabled.
 * - Absent list + no discovery: skip and report, because a partial list is
 *   worse than no list.
 */
export async function upsertPluginConfig(
  options: UpsertConfigOptions,
): Promise<ConfigUpdateResult> {
  const root = await readConfigRoot(options.configPath);
  const raw = root.plugins;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    throw new MarketplaceError('config_write_failed', 'config.yaml plugins must be an array');
  }

  if (Array.isArray(raw)) {
    const entries = raw.map((entry) => (isRecord(entry) ? { ...entry } : entry));
    const index = entries.findIndex((entry) => isRecord(entry) && entry.name === options.name);
    if (index >= 0) {
      entries[index] = { ...(entries[index] as Record<string, unknown>), enabled: true };
    } else {
      entries.push({ name: options.name, enabled: true });
    }
    root.plugins = entries;
    await writeConfigRoot(options.configPath, root);
    return { status: 'updated', entries: namesOf(entries) };
  }

  if (options.defaultNames === undefined || options.defaultNames === null) {
    return {
      status: 'skipped',
      entries: [],
      reason:
        'plugins: is absent and the default plugin set could not be enumerated; ' +
        'left untouched so other plugins stay enabled',
    };
  }

  const names = new Set(options.defaultNames);
  names.add(options.name);
  const entries = [...names].sort().map((name) => ({ name, enabled: true }));
  root.plugins = entries;
  await writeConfigRoot(options.configPath, root);
  return { status: 'created', entries: namesOf(entries) };
}

export interface SetPluginConfigOptions {
  configPath: string;
  name: string;
  key: string;
  value: unknown;
  /** Same materialization rule as install when `plugins:` is absent. */
  defaultNames?: string[] | null;
}

/**
 * Set one key under `plugins[].config` for `name`, preserving every other
 * entry and top-level setting (E10: the marketplace's own `registry_url`).
 * Atomic like {@link upsertPluginConfig}; `defaultNames` materializes the list
 * when it does not exist yet, so no default plugin becomes disabled.
 */
export async function setPluginConfigValue(
  options: SetPluginConfigOptions,
): Promise<{ status: 'updated' | 'created'; entries: string[] }> {
  const root = await readConfigRoot(options.configPath);
  const raw = root.plugins;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    throw new MarketplaceError('config_write_failed', 'config.yaml plugins must be an array');
  }

  if (Array.isArray(raw)) {
    const entries = raw.map((entry) => (isRecord(entry) ? { ...entry } : entry));
    const index = entries.findIndex((entry) => isRecord(entry) && entry.name === options.name);
    if (index >= 0) {
      const entry = entries[index] as Record<string, unknown>;
      const config = isRecord(entry.config) ? { ...entry.config } : {};
      config[options.key] = options.value;
      entries[index] = { ...entry, enabled: true, config };
    } else {
      entries.push({
        name: options.name,
        enabled: true,
        config: { [options.key]: options.value },
      });
    }
    root.plugins = entries;
    await writeConfigRoot(options.configPath, root);
    return { status: 'updated', entries: namesOf(entries) };
  }

  if (options.defaultNames === undefined || options.defaultNames === null) {
    throw new MarketplaceError(
      'config_write_failed',
      'plugins: is absent and the default plugin set could not be enumerated; ' +
        'refusing to write a partial list',
    );
  }
  const names = new Set(options.defaultNames);
  names.add(options.name);
  const entries = [...names]
    .sort()
    .map((name) =>
      name === options.name
        ? { name, enabled: true, config: { [options.key]: options.value } }
        : { name, enabled: true },
    );
  root.plugins = entries;
  await writeConfigRoot(options.configPath, root);
  return { status: 'created', entries: namesOf(entries) };
}

function namesOf(entries: unknown[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
  }
  return names;
}

export interface ConfigRemoveResult {
  status: 'removed' | 'absent' | 'skipped';
  entries: string[];
}

/** Remove a plugin entry; an empty list is deleted so defaults are restored. */
export async function removePluginConfig(
  configPath: string,
  name: string,
): Promise<ConfigRemoveResult> {
  const root = await readConfigRoot(configPath);
  const raw = root.plugins;
  if (raw === undefined || raw === null) return { status: 'skipped', entries: [] };
  if (!Array.isArray(raw)) {
    throw new MarketplaceError('config_write_failed', 'config.yaml plugins must be an array');
  }

  const entries = raw.filter((entry) => !(isRecord(entry) && entry.name === name));
  if (entries.length === raw.length) return { status: 'absent', entries: namesOf(raw) };

  if (entries.length === 0) delete root.plugins;
  else root.plugins = entries;
  await writeConfigRoot(configPath, root);
  return { status: 'removed', entries: namesOf(entries) };
}

// ── plugin-name discovery (only used when materializing `plugins:`) ──────────

interface PackageName {
  name: string;
  isChild: boolean;
}

async function readPackageNames(dir: string): Promise<PackageName | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'));
    if (!isRecord(raw)) return null;
    const vessel = isRecord(raw.vessel) ? raw.vessel : undefined;
    if (vessel !== undefined && typeof vessel.id === 'string' && vessel.id !== '') {
      return { name: vessel.id, isChild: true };
    }
    if (typeof raw.name !== 'string' || raw.name === '') return null;
    return { name: raw.name.replace(/^@[^/]+\//, ''), isChild: false };
  } catch {
    return null;
  }
}

/**
 * Scan one plugin root. Layouts mirror the loader: flat `<name>/package.json`
 * and category `<category>/<name>/package.json`.
 */
export async function scanPluginRoot(root: string): Promise<string[]> {
  let children: string[];
  try {
    children = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const child of children) {
    const direct = await readPackageNames(join(root, child));
    if (direct !== null) {
      names.push(direct.name);
      continue;
    }
    let nested: string[];
    try {
      nested = (await readdir(join(root, child), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of nested) {
      const packageName = await readPackageNames(join(root, child, name));
      if (packageName !== null) names.push(packageName.name);
    }
  }
  return names;
}

export interface PluginDiscoveryInput {
  userPluginsDir: string;
  /** Installed project plugins: `<hostCwd>/.vessel/plugins`. */
  projectPluginsDir?: string;
  /**
   * Host project cwd. Source plugins live at `<hostCwd>/plugins/**` in the
   * mandatory `plugins/<category>/<name>/` layout (CONTRACT-0.44 §3).
   */
  hostCwd?: string;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Enumerate the plugins enabled by default. Returns `null` when the built-in
 * plugin root cannot be determined: the caller must then skip the config write
 * (CONTRACT-0.44 §3 step 7) rather than materialize a one-entry list that would
 * disable every default plugin.
 *
 * Sources, in order: `<hostCwd>/plugins` (authoritative when present), an
 * inferred repository root (legacy layouts), user plugins, project plugins.
 */
export async function discoverPluginNames(input: PluginDiscoveryInput): Promise<string[] | null> {
  const builtInRoots: string[] = [];
  if (input.hostCwd !== undefined) {
    const hostPlugins = join(input.hostCwd, 'plugins');
    if (await isDirectory(hostPlugins)) builtInRoots.push(hostPlugins);
  }
  const inferred = inferBuiltInPluginsRoot();
  if (inferred !== null && !builtInRoots.includes(inferred)) builtInRoots.push(inferred);
  if (builtInRoots.length === 0) return null;

  const roots = [...builtInRoots, input.userPluginsDir];
  if (input.projectPluginsDir !== undefined) roots.push(input.projectPluginsDir);

  const names = new Set<string>();
  for (const root of roots) {
    for (const name of await scanPluginRoot(root)) names.add(name);
  }
  return [...names];
}

/**
 * `plugins/<category>/<name>/src/config.ts` → `plugins/`. Returns `null` when
 * this module is not part of a repository checkout (e.g. installed under
 * `~/.vessel/plugins/marketplace`), which is exactly when built-in names cannot
 * be discovered.
 */
export function inferBuiltInPluginsRoot(moduleUrl: string = import.meta.url): string | null {
  const packageDir = dirname(dirname(fileURLToPath(moduleUrl)));
  const pluginsRoot = dirname(packageDir);
  return basename(pluginsRoot) === 'plugins' ? pluginsRoot : null;
}
