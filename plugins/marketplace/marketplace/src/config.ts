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

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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

/**
 * Plugin roots whose default-enabled entries can be enumerated:
 * - built-in plugins, when this module runs from a repository checkout;
 * - user `~/.vessel/plugins`;
 * - project `.vessel/plugins`, when the host/probe supplied a project root.
 */
export async function discoverPluginNames(input: {
  userPluginsDir: string;
  projectPluginsDir?: string;
}): Promise<string[]> {
  const roots = [input.userPluginsDir];
  if (input.projectPluginsDir !== undefined) roots.push(input.projectPluginsDir);
  const builtIn = inferBuiltInPluginsRoot();
  if (builtIn !== null) roots.unshift(builtIn);

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
