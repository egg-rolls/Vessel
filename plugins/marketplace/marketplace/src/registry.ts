/**
 * Static registry index: fetch, validate, cache and query.
 *
 * CONTRACT-0.44 §1-§2: the registry is a plain `index.json` served by GitHub
 * Pages / raw. There is no GitHub API call here; search is client-side over the
 * already-fetched index, which keeps the 60 req/hr API limit out of the loop.
 *
 * Cache: `<pluginDataDir>/cache/index.json`, TTL 10 minutes. A network failure
 * falls back to a stale cache for the same URL; an empty cache becomes an RPC
 * error so the page can render its error state.
 *
 * @module @vessel-agent/plugin-marketplace/registry
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorCodeOf, MarketplaceError, messageOf } from './errors.js';
import { compareVersionStrings, isFullSemver, parseVersionRange } from './semver.js';
import { DEFAULT_REGISTRY_URL, type MarketplaceSettings } from './settings.js';

export const REGISTRY_SCHEMA = 1;
export const REGISTRY_CACHE_TTL_MS = 10 * 60 * 1000;
export const MAX_INDEX_BYTES = 5 * 1024 * 1024;

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface RegistryAsset {
  url: string;
  sha256: string;
  size: number;
}

export interface RegistryPermissions {
  fs?: string[];
  net?: string[];
  process?: boolean;
  secrets?: boolean;
  events?: string[];
  [key: string]: unknown;
}

export interface RegistryVersion {
  version: string;
  engines?: { vessel?: string; [key: string]: unknown };
  asset: RegistryAsset;
  permissions?: RegistryPermissions;
  contributes?: Record<string, unknown>;
  published_at?: string;
}

export interface RegistryPlugin {
  id: string;
  name: string;
  summary?: string;
  description?: string;
  category?: string;
  tags?: string[];
  repo?: string;
  homepage?: string;
  latest: string;
  versions: RegistryVersion[];
}

export interface RegistryIndex {
  schema: number;
  updated_at?: string;
  plugins: RegistryPlugin[];
}

export interface RegistrySnapshot {
  index: RegistryIndex;
  url: string;
  /** Whether the user registry differs from the default trusted one. */
  trusted: boolean;
  fetchedAt: number;
  stale: boolean;
}

interface CacheFile {
  url: string;
  fetched_at: number;
  index: RegistryIndex;
}

export interface RegistryOptions {
  cachePath: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  proxy?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidIndex(message: string): MarketplaceError {
  return new MarketplaceError('registry_invalid', `registry index is invalid: ${message}`);
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalidIndex(`${key} must be a string`);
  return value;
}

/** Repo/homepage links are rendered as anchors: only http(s) is acceptable. */
function optionalHttpUrl(raw: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(raw, key);
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidIndex(`${key} must be an http(s) URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidIndex(`${key} must be an http(s) URL`);
  }
  return value;
}

function optionalStringArray(raw: Record<string, unknown>, key: string): string[] | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalidIndex(`${key} must be an array of strings`);
  }
  return value as string[];
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * HTTPS is mandatory; loopback HTTP is allowed only so the local fixture
 * (CONTRACT-0.44 §5) can run without TLS.
 */
export function assertSecureUrl(raw: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MarketplaceError('registry_url_insecure', `${field} is not a valid URL`);
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url;
  throw new MarketplaceError(
    'registry_url_insecure',
    `${field} must use https:// (localhost fixtures may use http://)`,
  );
}

function parseAsset(raw: unknown, field: string): RegistryAsset {
  if (!isRecord(raw)) throw invalidIndex(`${field} must be an object`);
  const url = optionalString(raw, 'url');
  if (!url) throw invalidIndex(`${field}.url is required`);
  assertSecureUrl(url, `${field}.url`);
  const sha256 = optionalString(raw, 'sha256');
  if (!sha256) throw invalidIndex(`${field}.sha256 is required; unsigned entries are refused`);
  if (!SHA256_RE.test(sha256.toLowerCase())) {
    throw invalidIndex(`${field}.sha256 must be 64 hex characters`);
  }
  const size = raw.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw invalidIndex(`${field}.size must be a positive integer`);
  }
  return { url, sha256: sha256.toLowerCase(), size };
}

function parseVersion(raw: unknown, field: string): RegistryVersion {
  if (!isRecord(raw)) throw invalidIndex(`${field} must be an object`);
  const version = optionalString(raw, 'version');
  if (!version || !isFullSemver(version)) {
    throw invalidIndex(`${field}.version must be a full semver (x.y.z)`);
  }

  let engines: RegistryVersion['engines'];
  if (raw.engines !== undefined && raw.engines !== null) {
    if (!isRecord(raw.engines)) throw invalidIndex(`${field}.engines must be an object`);
    const vessel = optionalString(raw.engines, 'vessel');
    if (vessel !== undefined && parseVersionRange(vessel) === null) {
      throw invalidIndex(`${field}.engines.vessel is not a supported range`);
    }
    engines = { ...raw.engines, ...(vessel !== undefined ? { vessel } : {}) };
  }

  let permissions: RegistryPermissions | undefined;
  if (raw.permissions !== undefined && raw.permissions !== null) {
    if (!isRecord(raw.permissions)) throw invalidIndex(`${field}.permissions must be an object`);
    permissions = raw.permissions as RegistryPermissions;
  }

  let contributes: Record<string, unknown> | undefined;
  if (raw.contributes !== undefined && raw.contributes !== null) {
    if (!isRecord(raw.contributes)) throw invalidIndex(`${field}.contributes must be an object`);
    contributes = raw.contributes;
  }

  const publishedAt = optionalString(raw, 'published_at');
  return {
    version,
    ...(engines !== undefined ? { engines } : {}),
    asset: parseAsset(raw.asset, `${field}.asset`),
    ...(permissions !== undefined ? { permissions } : {}),
    ...(contributes !== undefined ? { contributes } : {}),
    ...(publishedAt !== undefined ? { published_at: publishedAt } : {}),
  };
}

function parsePlugin(raw: unknown, field: string): RegistryPlugin {
  if (!isRecord(raw)) throw invalidIndex(`${field} must be an object`);
  const id = optionalString(raw, 'id');
  if (!id || !PLUGIN_ID_RE.test(id)) throw invalidIndex(`${field}.id is invalid`);
  const name = optionalString(raw, 'name');
  if (!name || name.trim() === '') throw invalidIndex(`${field}.name is required`);
  const latest = optionalString(raw, 'latest');
  if (!latest || !isFullSemver(latest)) throw invalidIndex(`${field}.latest must be a semver`);

  if (!Array.isArray(raw.versions) || raw.versions.length === 0) {
    throw invalidIndex(`${field}.versions must be a non-empty array`);
  }
  const versions = raw.versions.map((entry, index) =>
    parseVersion(entry, `${field}.versions[${index}]`),
  );
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const entry of versions) {
    if (seen.has(entry.version)) {
      throw invalidIndex(`${field} has duplicate version ${entry.version}`);
    }
    seen.add(entry.version);
    if (previous !== undefined && compareVersionStrings(previous, entry.version) >= 0) {
      throw invalidIndex(`${field}.versions must be unique and ascending`);
    }
    previous = entry.version;
  }
  if (!seen.has(latest)) throw invalidIndex(`${field}.latest "${latest}" is not in versions`);

  const summary = optionalString(raw, 'summary');
  const description = optionalString(raw, 'description');
  const category = optionalString(raw, 'category');
  const repo = optionalHttpUrl(raw, 'repo');
  const homepage = optionalHttpUrl(raw, 'homepage');
  const tags = optionalStringArray(raw, 'tags');
  return {
    id,
    name,
    latest,
    versions,
    ...(summary !== undefined ? { summary } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(homepage !== undefined ? { homepage } : {}),
  };
}

/** Validate an untrusted index.json. Throws `registry_invalid` (fail closed). */
export function parseRegistryIndex(raw: unknown): RegistryIndex {
  if (!isRecord(raw)) throw invalidIndex('root must be an object');
  if (raw.schema !== REGISTRY_SCHEMA) {
    throw invalidIndex(`unsupported schema ${String(raw.schema)} (expected ${REGISTRY_SCHEMA})`);
  }
  if (!Array.isArray(raw.plugins)) throw invalidIndex('plugins must be an array');

  const plugins = raw.plugins.map((entry, index) => parsePlugin(entry, `plugins[${index}]`));
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) throw invalidIndex(`duplicate plugin id "${plugin.id}"`);
    ids.add(plugin.id);
  }

  const updatedAt = optionalString(raw, 'updated_at');
  return {
    schema: REGISTRY_SCHEMA,
    plugins,
    ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
  };
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MarketplaceError('registry_fetch_failed', 'registry index is too large');
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new MarketplaceError('registry_fetch_failed', 'registry index is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function buildRequest(proxy: string | undefined): RequestInit {
  const init: RequestInit & { proxy?: string } = {
    headers: { accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  };
  if (proxy !== undefined) init.proxy = proxy;
  return init;
}

async function readCache(cachePath: string, url: string): Promise<CacheFile | null> {
  try {
    const content = await readFile(cachePath, 'utf-8');
    const raw: unknown = JSON.parse(content);
    if (!isRecord(raw) || raw.url !== url || typeof raw.fetched_at !== 'number') return null;
    const index = parseRegistryIndex(raw.index);
    return { url, fetched_at: raw.fetched_at, index };
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, cache: CacheFile): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  const body = JSON.stringify(cache);
  const tmp = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, body, { encoding: 'utf-8', mode: 0o600 });
  try {
    await rename(tmp, cachePath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    try {
      await writeFile(cachePath, body, { encoding: 'utf-8', mode: 0o600 });
    } catch {
      throw new MarketplaceError(
        'registry_fetch_failed',
        `could not write registry cache (${errorCodeOf(error) ?? 'write_failed'})`,
      );
    }
  }
}

async function fetchIndex(
  url: string,
  options: RegistryOptions,
  force: boolean,
): Promise<{ index: RegistryIndex; fetchedAt: number }> {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? REGISTRY_CACHE_TTL_MS;
  const cached = await readCache(options.cachePath, url);
  if (!force && cached !== null && now() - cached.fetched_at <= ttl) {
    return { index: cached.index, fetchedAt: cached.fetched_at };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, buildRequest(options.proxy));
  } catch (error) {
    if (cached !== null) return { index: cached.index, fetchedAt: cached.fetched_at };
    throw new MarketplaceError(
      'registry_fetch_failed',
      `could not fetch registry: ${messageOf(error)}`,
    );
  }

  if (!response.ok) {
    if (cached !== null) return { index: cached.index, fetchedAt: cached.fetched_at };
    throw new MarketplaceError(
      'registry_fetch_failed',
      `registry returned HTTP ${response.status}`,
    );
  }
  if (response.url) assertSecureUrl(response.url, 'registry redirect');

  let parsed: unknown;
  try {
    const bytes = await readCapped(response, MAX_INDEX_BYTES);
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof MarketplaceError && cached !== null) {
      return { index: cached.index, fetchedAt: cached.fetched_at };
    }
    if (cached !== null) return { index: cached.index, fetchedAt: cached.fetched_at };
    throw new MarketplaceError(
      'registry_fetch_failed',
      `could not read registry: ${messageOf(error)}`,
    );
  }

  const index = parseRegistryIndex(parsed);
  const fetchedAt = now();
  // The cache is an optimization: a read-only data dir must not block installs.
  await writeCache(options.cachePath, { url, fetched_at: fetchedAt, index }).catch(() => {});
  return { index, fetchedAt };
}

export interface LoadRegistryOptions {
  settings: MarketplaceSettings;
  cachePath: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  /** Bypass the TTL cache (used by "check for updates"). */
  force?: boolean;
}

/** Fetch or read the cached index for the configured `registry_url`. */
export async function loadRegistry(options: LoadRegistryOptions): Promise<RegistrySnapshot> {
  const url = options.settings.registryUrl;
  if (url === undefined) {
    throw new MarketplaceError(
      'registry_url_missing',
      'registry_url is not configured; set it in config.yaml plugins[].config',
    );
  }
  const secure = assertSecureUrl(url, 'registry_url');
  const registryUrl = secure.toString();
  const registryOptions: RegistryOptions = {
    cachePath: options.cachePath,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.settings.proxy !== undefined ? { proxy: options.settings.proxy } : {}),
  };
  const { index, fetchedAt } = await fetchIndex(
    registryUrl,
    registryOptions,
    options.force === true,
  );
  const ttl = options.ttlMs ?? REGISTRY_CACHE_TTL_MS;
  return {
    index,
    url: registryUrl,
    trusted: normalizeRegistryUrl(registryUrl) === normalizeRegistryUrl(DEFAULT_REGISTRY_URL),
    fetchedAt,
    stale: (options.now ?? Date.now)() - fetchedAt > ttl,
  };
}

function normalizeRegistryUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

export function findPlugin(index: RegistryIndex, id: string): RegistryPlugin | undefined {
  return index.plugins.find((plugin) => plugin.id === id);
}

export function findVersion(plugin: RegistryPlugin, version: string): RegistryVersion | undefined {
  return plugin.versions.find((entry) => entry.version === version);
}

/** Newest version allowed by `allow_prerelease`, or undefined. */
export function newestVersion(
  plugin: RegistryPlugin,
  allowPrerelease: boolean,
): RegistryVersion | undefined {
  for (let index = plugin.versions.length - 1; index >= 0; index -= 1) {
    const entry = plugin.versions[index];
    if (entry === undefined) continue;
    if (allowPrerelease || !entry.version.includes('-')) return entry;
  }
  return undefined;
}

export function isPrereleaseVersion(version: string): boolean {
  return version.includes('-');
}

/** Display metadata for a registry plugin (no asset URLs in list results). */
export function summarizePlugin(
  plugin: RegistryPlugin,
): Omit<RegistryPlugin, 'versions'> & { versions_count: number } {
  const { versions, ...rest } = plugin;
  return { ...rest, versions_count: versions.length };
}
