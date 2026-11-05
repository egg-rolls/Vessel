/**
 * Marketplace probe. No GitHub and no external network: a local Bun server
 * serves fixture indexes and generated `.tgz` archives.
 *
 * Covers CONTRACT-0.44 §5:
 *   valid install, checksum mismatch, size mismatch, path traversal, symlink,
 *   oversize download/extract, existing-id backup + rollback, remove, config
 *   write (existing list / materialize / skip), update, cache TTL, and a full
 *   child-process RPC round trip (hello → activate → search → install →
 *   installed → remove → deactivate).
 *
 * Run: bun run plugins/marketplace/test/probe.ts  (from the repo root)
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parse as parseYaml } from 'yaml';
import { MarketplaceError } from '../src/errors.js';
import {
  type InstallContext,
  installedPlugins,
  installPlugin,
  listInstalled,
  removePlugin,
  updatePlugin,
} from '../src/install.js';
import { parseRegistryIndex } from '../src/registry.js';
import type { MarketplaceSettings } from '../src/settings.js';

// ── assertions ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

async function expectCode(name: string, run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
    check(name, false, `expected ${code}, but the call succeeded`);
  } catch (error) {
    if (error instanceof MarketplaceError) {
      check(name, error.code === code, `expected ${code}, got ${error.code}: ${error.message}`);
    } else {
      check(name, false, `expected ${code}, got ${String(error)}`);
    }
  }
}

// ── tar writer (fixtures only) ──────────────────────────────────────────────

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  for (let index = 0; index < Math.min(length, bytes.length); index += 1) {
    target[offset + index] = bytes[index] ?? 0;
  }
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  writeString(target, offset, length - 1, value.toString(8).padStart(length - 1, '0'));
  target[offset + length - 1] = 0;
}

function tarHeader(path: string, size: number, typeflag: string, mode = 0o644): Uint8Array {
  const header = new Uint8Array(512);
  writeString(header, 0, 100, path);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 1_700_000_000);
  header[156] = typeflag.charCodeAt(0);
  writeString(header, 257, 6, 'ustar');
  header[262] = 0;
  writeString(header, 263, 2, '00');
  stampChecksum(header);
  return header;
}

function stampChecksum(header: Uint8Array): void {
  for (let index = 148; index < 156; index += 1) header[index] = 32;
  let sum = 0;
  for (const byte of header) sum += byte;
  writeString(header, 148, 6, sum.toString(8).padStart(6, '0'));
  header[154] = 0;
  header[155] = 32;
}

interface TarSpec {
  path: string;
  data?: Uint8Array;
  type?: 'file' | 'directory' | 'symlink';
  linkname?: string;
}

function makeTar(specs: TarSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const spec of specs) {
    const type = spec.type ?? (spec.data === undefined ? 'directory' : 'file');
    const data = spec.data ?? new Uint8Array(0);
    const typeflag = type === 'directory' ? '5' : type === 'symlink' ? '2' : '0';
    const header = tarHeader(spec.path, type === 'file' ? data.byteLength : 0, typeflag);
    if (spec.linkname !== undefined) {
      writeString(header, 157, 100, spec.linkname);
      stampChecksum(header);
    }
    chunks.push(header);
    if (type === 'file' && data.byteLength > 0) {
      const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
      padded.set(data);
      chunks.push(padded);
    }
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function makeTgz(specs: TarSpec[]): Uint8Array {
  return gzipSync(makeTar(specs));
}

function packageJson(id: string, version: string, engines = '>=0.33.0 <0.45.0'): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      name: `@probe/${id}`,
      version,
      type: 'module',
      vessel: {
        id,
        name: `Probe ${id}`,
        version,
        engines: { vessel: engines },
        side: 'both',
        entry: 'src/index.ts',
      },
    }),
  );
}

function pluginArchive(id: string, version: string): Uint8Array {
  return makeTgz([
    { path: 'package/package.json', data: packageJson(id, version) },
    {
      path: 'package/src/index.ts',
      data: new TextEncoder().encode('export const probe = true;\n'),
    },
    {
      path: 'package/web/index.html',
      data: new TextEncoder().encode('<!doctype html><title>probe</title>\n'),
    },
  ]);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A deliberately slow asset (4 chunks, 150ms apart) so the probe can prove the
 * job RPC returns before the download finishes.
 */
function streamSlowAsset(): Response {
  const body = valid100;
  const chunkSize = Math.max(1, Math.ceil(body.byteLength / 4));
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let offset = 0; offset < body.byteLength; offset += chunkSize) {
        controller.enqueue(body.subarray(offset, Math.min(body.byteLength, offset + chunkSize)));
        await sleep(150);
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/octet-stream' } });
}

// ── fixture server ──────────────────────────────────────────────────────────

const assets = new Map<string, Uint8Array>();
const indexes = new Map<string, string>();
const indexHits = new Map<string, number>();

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/asset/slow.tgz') return streamSlowAsset();
    const asset = assets.get(url.pathname);
    if (asset !== undefined) {
      return new Response(asset, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(asset.byteLength),
        },
      });
    }
    const index = indexes.get(url.pathname);
    if (index !== undefined) {
      indexHits.set(url.pathname, (indexHits.get(url.pathname) ?? 0) + 1);
      return new Response(index, { headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;

function registerAsset(name: string, body: Uint8Array): string {
  const path = `/asset/${name}`;
  assets.set(path, body);
  return `${base}${path}`;
}

interface VersionSpec {
  version: string;
  body: Uint8Array | null;
  assetName?: string;
  assetPath?: string;
  sha256?: string;
  size?: number;
  omitSha?: boolean;
  engines?: string;
}

interface PluginSpec {
  id: string;
  name?: string;
  category?: string;
  latest: string;
  versions: VersionSpec[];
}

function buildIndex(plugins: PluginSpec[]): string {
  const body = {
    schema: 1,
    updated_at: '2026-11-05T00:00:00Z',
    plugins: plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name ?? `Probe ${plugin.id}`,
      summary: `Fixture ${plugin.id}`,
      category: plugin.category ?? 'probe',
      tags: ['probe'],
      repo: 'https://github.com/example/probe',
      latest: plugin.latest,
      versions: plugin.versions.map((version) => {
        const url =
          version.assetPath ??
          (version.assetName !== undefined
            ? registerAsset(version.assetName, version.body ?? new Uint8Array(0))
            : `${base}/asset/${plugin.id}-${version.version}.tgz`);
        const bytes = version.body ?? new Uint8Array(0);
        return {
          version: version.version,
          engines: { vessel: version.engines ?? '>=0.33.0 <0.45.0' },
          asset: {
            url,
            ...(version.omitSha === true ? {} : { sha256: version.sha256 ?? sha256(bytes) }),
            size: version.size ?? bytes.byteLength,
          },
          permissions: { fs: ['data-dir'], net: [], events: ['llm.response'] },
          contributes: { pages: ['probe'], rpc: ['summary'] },
          published_at: '2026-11-05T00:00:00Z',
        };
      }),
    })),
  };
  return JSON.stringify(body, null, 2);
}

const valid100 = pluginArchive('probe-plugin', '1.0.0');
const valid110 = pluginArchive('probe-plugin', '1.1.0');
const mismatch = makeTgz([
  { path: 'package/package.json', data: packageJson('other-plugin', '1.0.0') },
  { path: 'package/src/index.ts', data: new TextEncoder().encode('export {};\n') },
]);
const traversal = makeTgz([
  { path: 'package/package.json', data: packageJson('probe-unsafe', '1.0.0') },
  { path: '../../evil.txt', data: new TextEncoder().encode('escaped') },
]);
const symlink = makeTgz([
  { path: 'package/package.json', data: packageJson('probe-symlink', '1.0.0') },
  { path: 'package/link', type: 'symlink', linkname: '/etc/passwd' },
]);
const oversizeExtract = makeTgz([
  { path: 'package/package.json', data: packageJson('probe-oversize', '1.0.0') },
  ...Array.from({ length: 20 }, (_, index) => ({
    path: `package/big-${index}.bin`,
    data: new Uint8Array(256).fill(index + 1),
  })),
]);
const bigBody = new Uint8Array(4096);
for (let index = 0; index < bigBody.length; index += 1) bigBody[index] = (index * 31) % 256;

indexes.set(
  '/index.json',
  buildIndex([
    {
      id: 'probe-plugin',
      latest: '1.1.0',
      versions: [
        { version: '1.0.0', body: valid100, assetName: 'probe-1.0.0.tgz' },
        { version: '1.1.0', body: valid110, assetName: 'probe-1.1.0.tgz' },
      ],
    },
  ]),
);
indexes.set(
  '/index-cache.json',
  buildIndex([
    {
      id: 'probe-plugin',
      latest: '1.1.0',
      versions: [
        { version: '1.0.0', body: valid100, assetName: 'cache-1.0.0.tgz' },
        { version: '1.1.0', body: valid110, assetName: 'cache-1.1.0.tgz' },
      ],
    },
  ]),
);
indexes.set(
  '/index-badsha.json',
  buildIndex([
    {
      id: 'probe-plugin',
      latest: '1.0.0',
      versions: [
        {
          version: '1.0.0',
          body: valid100,
          sha256: 'f'.repeat(64),
          assetPath: registerAsset('badsha.tgz', valid100),
        },
      ],
    },
  ]),
);
indexes.set(
  '/index-badsize.json',
  buildIndex([
    {
      id: 'probe-plugin',
      latest: '1.0.0',
      versions: [
        {
          version: '1.0.0',
          body: valid100,
          size: valid100.byteLength + 1,
          assetName: 'badsize.tgz',
        },
      ],
    },
  ]),
);
indexes.set(
  '/index-nosha.json',
  buildIndex([
    {
      id: 'probe-plugin',
      latest: '1.0.0',
      versions: [{ version: '1.0.0', body: valid100, omitSha: true, assetName: 'nosha.tgz' }],
    },
  ]),
);
indexes.set(
  '/index-traversal.json',
  buildIndex([
    {
      id: 'probe-unsafe',
      latest: '1.0.0',
      versions: [{ version: '1.0.0', body: traversal, assetName: 'traversal.tgz' }],
    },
  ]),
);
indexes.set(
  '/index-symlink.json',
  buildIndex([
    {
      id: 'probe-symlink',
      latest: '1.0.0',
      versions: [{ version: '1.0.0', body: symlink, assetName: 'symlink.tgz' }],
    },
  ]),
);
indexes.set(
  '/index-oversize.json',
  buildIndex([
    {
      id: 'probe-oversize',
      latest: '1.0.0',
      versions: [{ version: '1.0.0', body: oversizeExtract, assetName: 'oversize.tgz' }],
    },
  ]),
);
indexes.set(
  '/index-big.json',
  buildIndex([
    {
      id: 'probe-big',
      latest: '1.0.0',
      versions: [{ version: '1.0.0', body: bigBody, assetName: 'big.tgz' }],
    },
  ]),
);
indexes.set(
  '/index-slow.json',
  buildIndex([
    {
      id: 'probe-plugin',
      latest: '1.0.0',
      versions: [{ version: '1.0.0', body: valid100, assetPath: `${base}/asset/slow.tgz` }],
    },
  ]),
);
indexes.set(
  '/index-mismatch.json',
  buildIndex([
    {
      id: 'probe-plugin',
      latest: '1.0.0',
      versions: [{ version: '1.0.0', body: mismatch, assetName: 'mismatch.tgz' }],
    },
  ]),
);

// ── contexts ────────────────────────────────────────────────────────────────

const tempRoot = await mkdtemp(join(tmpdir(), 'vessel-marketplace-probe-'));

function contextFor(
  name: string,
  overrides: {
    registryPath?: string;
    configPath?: string;
    defaultPluginNames?: string[] | null;
    installScope?: 'user' | 'project';
    /** Simulates the host resolving settings.project_root / HOST_CWD. */
    projectRoot?: string;
    /** Omit `defaultPluginNames` so the installer runs real discovery. */
    discovery?: boolean;
    limits?: InstallContext['limits'];
  } = {},
): InstallContext {
  const root = join(tempRoot, name);
  const settings: MarketplaceSettings = {
    registryUrl: `${base}${overrides.registryPath ?? '/index.json'}`,
    installScope: overrides.installScope ?? 'user',
    allowPrerelease: false,
    vesselVersion: '0.33.0',
    ...(overrides.projectRoot !== undefined ? { projectRoot: overrides.projectRoot } : {}),
  };
  return {
    settings,
    dataDir: join(root, 'data', 'plugins', 'marketplace'),
    userPluginsDir: join(root, 'user-plugins'),
    ...(overrides.projectRoot !== undefined ? { projectDir: overrides.projectRoot } : {}),
    configPath: overrides.configPath ?? join(root, 'config.yaml'),
    ...(overrides.limits !== undefined ? { limits: overrides.limits } : {}),
    ...(overrides.discovery === true
      ? {}
      : overrides.defaultPluginNames !== undefined
        ? { defaultPluginNames: overrides.defaultPluginNames }
        : { defaultPluginNames: ['base-plugin'] }),
  };
}

/** A source plugin in the mandatory `plugins/<category>/<name>/` layout. */
async function writeSourcePlugin(
  repo: string,
  category: string,
  name: string,
  id: string,
): Promise<void> {
  const dir = join(repo, 'plugins', category, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `@probe/${name}`,
      version: '0.1.0',
      vessel: {
        id,
        name: `Probe ${id}`,
        version: '0.1.0',
        engines: { vessel: '>=0.33.0 <0.45.0' },
        entry: 'src/index.ts',
      },
    }),
    'utf-8',
  );
}

async function readConfig(context: InstallContext): Promise<Record<string, unknown>> {
  const raw: unknown = parseYaml(await readFile(context.configPath, 'utf-8'));
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
}

async function configNames(context: InstallContext): Promise<string[]> {
  const config = await readConfig(context);
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  return plugins
    .map((entry) =>
      typeof entry === 'object' && entry !== null && 'name' in entry
        ? String((entry as Record<string, unknown>).name)
        : '',
    )
    .filter(Boolean);
}

async function noTempDirs(context: InstallContext): Promise<boolean> {
  try {
    const entries = await readdir(context.dataDir);
    return entries.every((name) => !name.startsWith('tmp-'));
  } catch {
    return true;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// ── registry schema unit checks ─────────────────────────────────────────────

const goodIndex: unknown = JSON.parse(indexes.get('/index.json') ?? '{}');
check(
  'registry: valid index parses',
  (() => {
    try {
      parseRegistryIndex(goodIndex);
      return true;
    } catch {
      return false;
    }
  })(),
);
for (const [name, mutate] of [
  ['registry: wrong schema rejected', (copy: Record<string, unknown>) => ({ ...copy, schema: 2 })],
  [
    'registry: duplicate id rejected',
    (copy: Record<string, unknown>) => {
      const plugins = copy.plugins as unknown[];
      return { ...copy, plugins: [...plugins, plugins[0]] };
    },
  ],
  [
    'registry: missing sha256 rejected',
    (copy: Record<string, unknown>) => {
      const deep = JSON.parse(JSON.stringify(copy));
      delete deep.plugins[0].versions[0].asset.sha256;
      return deep;
    },
  ],
  [
    'registry: non-ascending versions rejected',
    (copy: Record<string, unknown>) => {
      const deep = JSON.parse(JSON.stringify(copy));
      deep.plugins[0].versions.reverse();
      return deep;
    },
  ],
] as const) {
  const mutated = mutate(JSON.parse(JSON.stringify(goodIndex)) as Record<string, unknown>);
  let errorCode = '';
  try {
    parseRegistryIndex(mutated);
  } catch (error) {
    errorCode = error instanceof MarketplaceError ? error.code : 'unknown';
  }
  check(name, errorCode === 'registry_invalid', `got ${errorCode || 'success'}`);
}

// ── install failures ────────────────────────────────────────────────────────

{
  const context = contextFor('checksum', { registryPath: '/index-badsha.json' });
  await expectCode(
    'checksum mismatch refused',
    () => installPlugin(context, { id: 'probe-plugin', version: '1.0.0' }),
    'checksum_mismatch',
  );
  check(
    'checksum mismatch leaves no target',
    !(await exists(join(context.userPluginsDir, 'probe-plugin', 'package.json'))),
  );
  check('checksum mismatch cleans temp dirs', await noTempDirs(context));
}
{
  const context = contextFor('size', { registryPath: '/index-badsize.json' });
  await expectCode(
    'size mismatch refused',
    () => installPlugin(context, { id: 'probe-plugin', version: '1.0.0' }),
    'size_mismatch',
  );
  check('size mismatch cleans temp dirs', await noTempDirs(context));
}
{
  const context = contextFor('traversal', { registryPath: '/index-traversal.json' });
  await expectCode(
    'path traversal refused',
    () => installPlugin(context, { id: 'probe-unsafe', version: '1.0.0' }),
    'archive_unsafe',
  );
  check(
    'path traversal writes nothing outside',
    !(await exists(join(tempRoot, 'evil.txt'))) &&
      !(await exists(join(context.userPluginsDir, 'probe-unsafe'))),
  );
}
{
  const context = contextFor('symlink', { registryPath: '/index-symlink.json' });
  await expectCode(
    'symlink entry refused',
    () => installPlugin(context, { id: 'probe-symlink', version: '1.0.0' }),
    'archive_unsafe',
  );
}
{
  const context = contextFor('oversize-extract', {
    registryPath: '/index-oversize.json',
    limits: { maxExtractBytes: 1024 },
  });
  await expectCode(
    'oversize extraction refused',
    () => installPlugin(context, { id: 'probe-oversize', version: '1.0.0' }),
    'archive_too_large',
  );
}
{
  const context = contextFor('oversize-download', {
    registryPath: '/index-big.json',
    limits: { maxDownloadBytes: 1024 },
  });
  await expectCode(
    'oversize download refused',
    () => installPlugin(context, { id: 'probe-big', version: '1.0.0' }),
    'asset_too_large',
  );
}
{
  const context = contextFor('mismatch', { registryPath: '/index-mismatch.json' });
  await expectCode(
    'manifest id mismatch refused',
    () => installPlugin(context, { id: 'probe-plugin', version: '1.0.0' }),
    'manifest_mismatch',
  );
}

// ── install success + config ────────────────────────────────────────────────

{
  const context = contextFor('valid');
  const result = await installPlugin(context, { id: 'probe-plugin', version: '1.0.0' });
  const installedJson: unknown = JSON.parse(
    await readFile(join(context.userPluginsDir, 'probe-plugin', 'package.json'), 'utf-8'),
  );
  const vessel = (installedJson as { vessel?: { id?: string; version?: string } }).vessel;
  check(
    'valid install: id/version on disk',
    vessel?.id === 'probe-plugin' && vessel?.version === '1.0.0',
  );
  check('valid install: result target scope', result.scope === 'user');
  check('valid install: config updated', (await configNames(context)).includes('probe-plugin'));
  check(
    'valid install: existing config entry preserved',
    (await configNames(context)).includes('base-plugin'),
  );
  check('valid install: no temp dirs', await noTempDirs(context));
  check(
    'valid install: registry cached',
    await exists(join(context.dataDir, 'cache', 'index.json')),
  );
  check(
    'valid install: no engines warning with vessel_version',
    !result.warnings.includes('engines_unverified'),
  );
}
{
  const projectRoot = join(tempRoot, 'project-scope', 'project');
  const context = contextFor('project-scope', {
    installScope: 'project',
    projectRoot,
  });
  const result = await installPlugin(context, { id: 'probe-plugin', version: '1.0.0' });
  check('project scope: result reports project', result.scope === 'project');
  check(
    'project scope: installs under <project>/.vessel/plugins',
    await exists(join(projectRoot, '.vessel', 'plugins', 'probe-plugin', 'package.json')),
  );
  const listed = await listInstalled(context);
  check(
    'project scope: listing reports project',
    listed.find((entry) => entry.id === 'probe-plugin')?.scope === 'project',
  );
}
{
  const context = contextFor('project-no-root', { installScope: 'project' });
  await expectCode(
    'project scope: missing project root refused',
    () => installPlugin(context, { id: 'probe-plugin', version: '1.0.0' }),
    'install_failed',
  );
  check(
    'project scope: missing root installs nothing',
    !(await exists(join(context.userPluginsDir, 'probe-plugin'))),
  );
}
{
  const context = contextFor('engines-mismatch');
  const previous = context.settings.vesselVersion;
  context.settings.vesselVersion = '0.99.0';
  await expectCode(
    'engines: incompatible vessel refused',
    () => installPlugin(context, { id: 'probe-plugin', version: '1.0.0' }),
    'version_incompatible',
  );
  context.settings.vesselVersion = previous;
}
{
  const context = contextFor('materialize', { defaultPluginNames: ['base-plugin'] });
  const result = await installPlugin(context, { id: 'probe-plugin', version: '1.0.0' });
  check('config: absent list materialized', result.config.status === 'created');
  const names = await configNames(context);
  check(
    'config: materialized list keeps defaults',
    names.includes('base-plugin') && names.includes('probe-plugin'),
    names.join(','),
  );
}
{
  const context = contextFor('skip', { defaultPluginNames: null });
  const result = await installPlugin(context, { id: 'probe-plugin', version: '1.0.0' });
  check('config: absent list skipped when defaults unknown', result.config.status === 'skipped');
  check('config: skip leaves no config file', !(await exists(context.configPath)));
  check(
    'config: skipped install still lands on disk',
    await exists(join(context.userPluginsDir, 'probe-plugin', 'package.json')),
  );
}
{
  const fakeRepo = join(tempRoot, 'discovery-known', 'fake-repo');
  await writeSourcePlugin(fakeRepo, 'demo', 'builtin-tool', 'builtin-tool');
  const context = contextFor('discovery-known', {
    projectRoot: fakeRepo,
    discovery: true,
  });
  const result = await installPlugin(context, { id: 'probe-plugin', version: '1.0.0' });
  check('discovery: known host root creates config', result.config.status === 'created');
  const names = await configNames(context);
  check(
    'discovery: materializes host plugin defaults',
    names.includes('builtin-tool') && names.includes('probe-plugin'),
    names.join(','),
  );
}
{
  const context = contextFor('discovery-unknown', { discovery: true });
  const result = await installPlugin(context, { id: 'probe-plugin', version: '1.0.0' });
  check('discovery: unknown root skips config', result.config.status === 'skipped');
  check(
    'discovery: unknown root still installs',
    await exists(join(context.userPluginsDir, 'probe-plugin', 'package.json')),
  );
  check('discovery: unknown root leaves no config', !(await exists(context.configPath)));
}

// ── backup / rollback ───────────────────────────────────────────────────────

{
  const context = contextFor('backup-ok');
  const target = join(context.userPluginsDir, 'probe-plugin');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'package.json'), packageJson('probe-plugin', '0.0.1'));

  await installPlugin(context, { id: 'probe-plugin', version: '1.1.0' });
  const raw: unknown = JSON.parse(await readFile(join(target, 'package.json'), 'utf-8'));
  const version = (raw as { vessel?: { version?: string } }).vessel?.version;
  const siblings = await readdir(context.userPluginsDir);
  check('backup: existing install replaced', version === '1.1.0');
  check(
    'backup: backup removed after success',
    siblings.every((name) => !name.includes('.bak-')),
  );
}
{
  const context = contextFor('backup-rollback');
  const target = join(context.userPluginsDir, 'probe-plugin');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'package.json'), packageJson('probe-plugin', '0.0.1'));

  const blocker = join(tempRoot, 'backup-rollback', 'blocked');
  await mkdir(join(tempRoot, 'backup-rollback'), { recursive: true });
  await writeFile(blocker, 'not a directory');
  const broken = { ...context, configPath: join(blocker, 'config.yaml') };

  await expectCode(
    'rollback: config failure reported',
    () => installPlugin(broken, { id: 'probe-plugin', version: '1.0.0' }),
    'config_write_failed',
  );
  const raw: unknown = JSON.parse(await readFile(join(target, 'package.json'), 'utf-8'));
  const version = (raw as { vessel?: { version?: string } }).vessel?.version;
  const siblings = await readdir(context.userPluginsDir);
  check('rollback: old version restored', version === '0.0.1', `got ${version}`);
  check(
    'rollback: no backup left behind',
    siblings.every((name) => !name.includes('.bak-')),
  );
}

// ── remove ──────────────────────────────────────────────────────────────────

{
  const context = contextFor('remove');
  await mkdir(join(tempRoot, 'remove'), { recursive: true });
  await writeFile(context.configPath, 'plugins:\n  - name: keep\n    enabled: true\n', 'utf-8');
  await installPlugin(context, { id: 'probe-plugin', version: '1.0.0' });
  const removed = await removePlugin(context, 'probe-plugin');
  check('remove: reports removed', removed.removed === true);
  check(
    'remove: directory deleted',
    !(await exists(join(context.userPluginsDir, 'probe-plugin', 'package.json'))),
  );
  const names = await configNames(context);
  check('remove: config entry deleted', !names.includes('probe-plugin'), names.join(','));
  check('remove: other entries preserved', names.includes('keep'), names.join(','));
  check(
    'remove: watcher reload warning present',
    removed.warnings.includes('deactivation_deferred_to_watcher'),
  );
}

// ── update ──────────────────────────────────────────────────────────────────

{
  const context = contextFor('update');
  await installPlugin(context, { id: 'probe-plugin', version: '1.0.0' });
  const updated = await updatePlugin(context, 'probe-plugin');
  check('update: newer version installed', updated.updated === true && updated.to === '1.1.0');
  const raw: unknown = JSON.parse(
    await readFile(join(context.userPluginsDir, 'probe-plugin', 'package.json'), 'utf-8'),
  );
  const version = (raw as { vessel?: { version?: string } }).vessel?.version;
  check('update: disk version is 1.1.0', version === '1.1.0');
  const again = await updatePlugin(context, 'probe-plugin');
  check('update: idempotent when current', again.updated === false);
  const listed = await listInstalled(context);
  const item = listed.find((entry) => entry.id === 'probe-plugin');
  check('installed: lists the plugin', item?.version === '1.1.0' && item?.scope === 'user');
}

// ── cache TTL ───────────────────────────────────────────────────────────────

{
  const context = contextFor('cache', { registryPath: '/index-cache.json' });
  const before = indexHits.get('/index-cache.json') ?? 0;
  const first = await installedPlugins(context);
  const second = await installedPlugins(context);
  const afterCached = indexHits.get('/index-cache.json') ?? 0;
  check('cache: second call uses the cache', afterCached - before === 1);
  check('cache: no installed items yet', Array.isArray(first.items) && first.items.length === 0);
  check('cache: registry metadata returned', typeof second.registry === 'object');
  await installedPlugins(context, { force: true });
  check(
    'cache: force bypasses the cache',
    (indexHits.get('/index-cache.json') ?? 0) - before === 2,
  );
}

// ── tabbed page entry ───────────────────────────────────────────────────────

{
  const packageDir = join(import.meta.dir, '..');
  const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf-8')) as {
    vessel: {
      activationEvents: string[];
      contributes: { pages: Array<Record<string, unknown>>; rpc: Array<{ name: string }> };
    };
  };
  const pages = pkg.vessel.contributes.pages;
  const page = pages[0];
  check('manifest: one page contribution', Array.isArray(pages) && pages.length === 1);
  check(
    'manifest: page is the tabbed entry',
    page?.id === 'marketplace' &&
      page.title === 'Plugins' &&
      page.titleKey === 'nav.domain.plugins' &&
      page.nav === 'integrations' &&
      page.entry === 'index.html',
    JSON.stringify(page),
  );
  check(
    'manifest: activation is only onPage:marketplace',
    JSON.stringify(pkg.vessel.activationEvents) === JSON.stringify(['onPage:marketplace']),
  );
  check(
    'manifest: rpc surface unchanged',
    JSON.stringify(pkg.vessel.contributes.rpc.map((entry) => entry.name)) ===
      JSON.stringify([
        'search',
        'detail',
        'install',
        'remove',
        'update',
        'installed',
        'job',
        'jobs',
      ]),
  );

  const webDir = join(packageDir, 'web');
  const html = await readFile(join(webDir, 'index.html'), 'utf-8');
  check(
    'page: index.html has three tabs',
    ['browse', 'installed', 'updates'].every((tab) => html.includes(`data-tab="${tab}"`)),
  );
  check(
    'page: index.html has three panels',
    ['browse', 'installed', 'updates'].every((tab) => html.includes(`data-panel="${tab}"`)),
  );
  check('page: tabs are client-side, no nested iframe', !html.includes('<iframe'));
  check(
    'page: old standalone pages removed',
    !(await exists(join(webDir, 'browse.html'))) &&
      !(await exists(join(webDir, 'installed.html'))) &&
      !(await exists(join(webDir, 'updates.html'))),
  );

  const js = await readFile(join(webDir, 'app.js'), 'utf-8');
  // Methods the tabbed page actually drives; `jobs` is exercised via child RPC.
  for (const method of ['search', 'detail', 'install', 'remove', 'update', 'installed', 'job']) {
    check(`page: app.js calls rpc ${method}`, js.includes(`rpc('${method}'`));
  }
  check(
    'page: language comes from ?lang',
    js.includes("get('lang')") && js.includes("'zh-CN'") && js.includes("'en'"),
  );
}

// ── child RPC end-to-end ────────────────────────────────────────────────────

interface ChildMessage {
  id?: unknown;
  result?: unknown;
  error?: { message?: string; data?: { code?: string } };
  method?: string;
}

type PipedSubprocess = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

class ChildClient {
  readonly proc: PipedSubprocess;
  readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private buffer = '';
  private nextId = 1;
  stderr = '';

  constructor(proc: PipedSubprocess) {
    this.proc = proc;
    void this.pumpStdout();
    void this.pumpStderr();
  }

  private async pumpStdout(): Promise<void> {
    const stdout = this.proc.stdout;
    if (stdout === undefined || stdout === null) return;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line !== '') this.handle(line);
        newline = this.buffer.indexOf('\n');
      }
    }
  }

  private async pumpStderr(): Promise<void> {
    const stderr = this.proc.stderr;
    if (stderr === undefined || stderr === null) return;
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.stderr += decoder.decode(value, { stream: true });
    }
  }

  private handle(line: string): void {
    let message: ChildMessage;
    try {
      message = JSON.parse(line) as ChildMessage;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const entry = this.pending.get(message.id);
    if (entry === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined) {
      entry.reject(new Error(message.error.message ?? message.error.data?.code ?? 'child error'));
    } else {
      entry.resolve(message.result);
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`child request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      void this.proc.stdin.flush();
    });
  }

  async close(): Promise<void> {
    await this.request('plugin.deactivate', {}).catch(() => {});
    const timer = setTimeout(() => this.proc.kill(), 3000);
    await this.proc.exited;
    clearTimeout(timer);
  }
}

interface JobView {
  job_id?: string;
  status?: string;
  phase?: string;
  bytes_done?: number;
  bytes_total?: number;
  error?: { code?: string; message?: string };
  result?: { updated?: boolean; to?: string; from?: string; version?: string; scope?: string };
}

async function pollJob(
  client: ChildClient,
  jobId: string,
  timeoutMs = 30000,
): Promise<JobView & { phases: Set<string> }> {
  const started = Date.now();
  const phases = new Set<string>();
  let last: JobView | undefined;
  while (Date.now() - started < timeoutMs) {
    last = (await client.request('plugin.rpc', {
      name: 'job',
      params: { job_id: jobId },
    })) as JobView;
    if (typeof last.phase === 'string') phases.add(last.phase);
    if (last.status === 'done' || last.status === 'failed') return { ...last, phases };
    await sleep(50);
  }
  throw new Error(`job ${jobId} did not finish: ${JSON.stringify(last)}`);
}

async function startInstall(client: ChildClient, params: Record<string, unknown>): Promise<string> {
  const started = (await client.request('plugin.rpc', {
    name: 'install',
    params,
  })) as { job_id?: string };
  if (typeof started.job_id !== 'string') throw new Error('install did not return a job_id');
  return started.job_id;
}

async function installAndWait(
  client: ChildClient,
  params: Record<string, unknown>,
): Promise<JobView> {
  const jobId = await startInstall(client, params);
  const job = await pollJob(client, jobId);
  if (job.status !== 'done') throw new Error(`install failed: ${JSON.stringify(job.error)}`);
  return job;
}

async function removePluginVia(client: ChildClient, id: string): Promise<void> {
  await client.request('plugin.rpc', { name: 'remove', params: { id } });
}

{
  const home = join(tempRoot, 'home');
  const pluginDataDir = join(home, '.vessel', 'data', 'plugins', 'marketplace');
  const repoRoot = join(home, 'fake-repo');
  await mkdir(home, { recursive: true });
  await writeSourcePlugin(repoRoot, 'demo', 'builtin-tool', 'builtin-tool');
  const entry = join(import.meta.dir, '..', 'src', 'index.ts');
  const proc: PipedSubprocess = Bun.spawn([process.execPath, entry], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      VESSEL_PLUGIN_ID: 'marketplace',
      VESSEL_PLUGIN_PROTOCOL: '1',
      VESSEL_PLUGIN_DATA_DIR: pluginDataDir,
      VESSEL_PLUGIN_CONFIG: '{}',
      VESSEL_PLUGIN_HOST_CWD: repoRoot,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const client = new ChildClient(proc);
  try {
    const hello = (await client.request('plugin.hello', {
      protocol: 1,
      modId: 'marketplace',
      version: '0.1.0',
    })) as {
      ok?: boolean;
      protocol?: number;
    };
    check('child: hello ok', hello.ok === true && hello.protocol === 1);

    const activated = (await client.request('plugin.activate', {
      settings: {
        registry_url: `${base}/index.json`,
        vessel_version: '0.33.0',
        install_scope: 'user',
      },
      dataDir: join(home, '.vessel', 'data'),
      events: ['plugin.changed'],
    })) as { ok?: boolean };
    check('child: activate ok', activated.ok === true);

    const search = (await client.request('plugin.rpc', { name: 'search', params: {} })) as {
      items?: Array<{ id?: string; latest?: string }>;
    };
    check(
      'child: search returns the fixture',
      Array.isArray(search.items) &&
        search.items.some((item) => item.id === 'probe-plugin' && item.latest === '1.1.0'),
    );

    const installStarted = performance.now();
    const installJobId = await startInstall(client, { id: 'probe-plugin', version: '1.0.0' });
    const installReturnMs = performance.now() - installStarted;
    check(
      'child: install returns a job immediately',
      installReturnMs < 1000,
      `${installReturnMs.toFixed(0)}ms`,
    );
    const installJob = await pollJob(client, installJobId);
    check('child: install job done', installJob.status === 'done' && installJob.phase === 'done');
    check(
      'child: job reports download bytes',
      installJob.bytes_total === valid100.byteLength &&
        installJob.bytes_done === valid100.byteLength,
      `${installJob.bytes_done}/${installJob.bytes_total}`,
    );
    check(
      'child: install wrote the temp home',
      await exists(join(home, '.vessel', 'plugins', 'probe-plugin', 'package.json')),
    );
    const configRaw: unknown = parseYaml(
      await readFile(join(home, '.vessel', 'config.yaml'), 'utf-8'),
    );
    const entries = Array.isArray((configRaw as { plugins?: unknown }).plugins)
      ? (configRaw as { plugins: Array<{ name?: string }> }).plugins
      : [];
    check(
      'child: config entry written',
      entries.some((entryValue) => entryValue.name === 'probe-plugin'),
    );
    check(
      'child: default plugin list materialized from hostCwd',
      entries.some((entryValue) => entryValue.name === 'builtin-tool'),
      entries.map((entryValue) => entryValue.name).join(','),
    );

    const installed = (await client.request('plugin.rpc', { name: 'installed', params: {} })) as {
      items?: Array<{ id?: string; version?: string; update_available?: boolean }>;
    };
    const item = installed.items?.find((entryValue) => entryValue.id === 'probe-plugin');
    check(
      'child: installed reports update',
      item?.version === '1.0.0' && item?.update_available === true,
    );

    const updateStarted = (await client.request('plugin.rpc', {
      name: 'update',
      params: { id: 'probe-plugin' },
    })) as { job_id?: string };
    check('child: update returns a job', typeof updateStarted.job_id === 'string');
    const updateJob = await pollJob(client, String(updateStarted.job_id));
    check(
      'child: update job done',
      updateJob.status === 'done' &&
        updateJob.result?.updated === true &&
        updateJob.result?.to === '1.1.0',
    );

    const jobs = (await client.request('plugin.rpc', { name: 'jobs', params: {} })) as {
      items?: Array<{ job_id?: string; status?: string }>;
    };
    check(
      'child: jobs lists recent jobs',
      (jobs.items ?? []).some(
        (entryValue) => entryValue.job_id === installJobId && entryValue.status === 'done',
      ) &&
        (jobs.items ?? []).some(
          (entryValue) =>
            entryValue.job_id === updateStarted.job_id && entryValue.status === 'done',
        ),
    );
    const unknownJob = await client
      .request('plugin.rpc', { name: 'job', params: { job_id: 'missing-job' } })
      .then(() => 'success')
      .catch((error: Error) => error.message);
    check('child: unknown job rejected', unknownJob !== 'success');

    const removed = (await client.request('plugin.rpc', {
      name: 'remove',
      params: { id: 'probe-plugin' },
    })) as {
      removed?: boolean;
    };
    check('child: remove RPC', removed.removed === true);
    check(
      'child: remove deleted the directory',
      !(await exists(join(home, '.vessel', 'plugins', 'probe-plugin'))),
    );

    const detail = (await client.request('plugin.rpc', {
      name: 'detail',
      params: { id: 'probe-plugin' },
    })) as {
      plugin?: { id?: string };
    };
    check('child: detail RPC', detail.plugin?.id === 'probe-plugin');

    // Errata E4 order: settings.project_root > activate.params.hostCwd > env.
    const paramRoot = join(home, 'param-cwd');
    await client.request('plugin.activate', {
      settings: {
        registry_url: `${base}/index.json`,
        vessel_version: '0.33.0',
        install_scope: 'project',
      },
      hostCwd: paramRoot,
      dataDir: join(home, '.vessel', 'data'),
      events: ['plugin.changed'],
    });
    const paramJob = await installAndWait(client, { id: 'probe-plugin', version: '1.0.0' });
    check('child: project job reports project scope', paramJob.result?.scope === 'project');
    check(
      'child: activate.params.hostCwd used',
      await exists(join(paramRoot, '.vessel', 'plugins', 'probe-plugin', 'package.json')),
    );
    check(
      'child: params.hostCwd is not the env cwd',
      !(await exists(join(repoRoot, '.vessel', 'plugins', 'probe-plugin'))),
    );
    await removePluginVia(client, 'probe-plugin');

    // Without project_root/hostCwd, the env fallback is used.
    await client.request('plugin.activate', {
      settings: {
        registry_url: `${base}/index.json`,
        vessel_version: '0.33.0',
        install_scope: 'project',
      },
      dataDir: join(home, '.vessel', 'data'),
      events: ['plugin.changed'],
    });
    await installAndWait(client, { id: 'probe-plugin', version: '1.0.0' });
    check(
      'child: VESSEL_PLUGIN_HOST_CWD fallback used',
      await exists(join(repoRoot, '.vessel', 'plugins', 'probe-plugin', 'package.json')),
    );
    await removePluginVia(client, 'probe-plugin');

    // settings.project_root wins over both host values.
    const settingsRoot = join(home, 'settings-root');
    await client.request('plugin.activate', {
      settings: {
        registry_url: `${base}/index.json`,
        vessel_version: '0.33.0',
        install_scope: 'project',
        project_root: settingsRoot,
      },
      hostCwd: paramRoot,
      dataDir: join(home, '.vessel', 'data'),
      events: ['plugin.changed'],
    });
    await installAndWait(client, { id: 'probe-plugin', version: '1.0.0' });
    check(
      'child: settings.project_root wins over host values',
      await exists(join(settingsRoot, '.vessel', 'plugins', 'probe-plugin', 'package.json')),
    );
    check(
      'child: settings root is not the host cwd',
      !(await exists(join(repoRoot, '.vessel', 'plugins', 'probe-plugin'))),
    );
    await removePluginVia(client, 'probe-plugin');

    // No root at all (fresh HOME): project install must fail, while a user
    // install must still land and skip the config write (CONTRACT-0.44 §3).
    const homeNoRoot = join(tempRoot, 'home-no-root');
    const dataNoRoot = join(homeNoRoot, '.vessel', 'data', 'plugins', 'marketplace');
    await mkdir(homeNoRoot, { recursive: true });
    const procNoCwd = Bun.spawn([process.execPath, entry], {
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        HOME: homeNoRoot,
        USERPROFILE: homeNoRoot,
        VESSEL_PLUGIN_ID: 'marketplace',
        VESSEL_PLUGIN_PROTOCOL: '1',
        VESSEL_PLUGIN_DATA_DIR: dataNoRoot,
        VESSEL_PLUGIN_CONFIG: '{}',
        VESSEL_PLUGIN_HOST_CWD: '',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const clientNoCwd = new ChildClient(procNoCwd);
    try {
      await clientNoCwd.request('plugin.hello', { protocol: 1 });
      await clientNoCwd.request('plugin.activate', {
        settings: {
          registry_url: `${base}/index.json`,
          vessel_version: '0.33.0',
          install_scope: 'project',
        },
        dataDir: join(homeNoRoot, '.vessel', 'data'),
        events: ['plugin.changed'],
      });
      const noRootJobId = await startInstall(clientNoCwd, {
        id: 'probe-plugin',
        version: '1.0.0',
      });
      const noRootJob = await pollJob(clientNoCwd, noRootJobId);
      check(
        'child: project scope without root fails clearly',
        noRootJob.status === 'failed' && /project_root/.test(noRootJob.error?.message ?? ''),
        JSON.stringify(noRootJob.error),
      );
      check(
        'child: no-root project install writes nothing',
        !(await exists(join(homeNoRoot, '.vessel', 'plugins', 'probe-plugin'))),
      );

      await clientNoCwd.request('plugin.activate', {
        settings: {
          registry_url: `${base}/index.json`,
          vessel_version: '0.33.0',
          install_scope: 'user',
        },
        dataDir: join(homeNoRoot, '.vessel', 'data'),
        events: ['plugin.changed'],
      });
      const skipJob = await installAndWait(clientNoCwd, {
        id: 'probe-plugin',
        version: '1.0.0',
      });
      check('child: unknown root install succeeds', skipJob.status === 'done');
      check(
        'child: unknown root installs to the user dir',
        await exists(join(homeNoRoot, '.vessel', 'plugins', 'probe-plugin', 'package.json')),
      );
      check(
        'child: unknown root skips config.yaml',
        !(await exists(join(homeNoRoot, '.vessel', 'config.yaml'))),
      );
    } finally {
      await clientNoCwd.close();
    }

    // Slow asset: the job returns immediately while the download is still open.
    await client.request('plugin.activate', {
      settings: {
        registry_url: `${base}/index-slow.json`,
        vessel_version: '0.33.0',
        install_scope: 'user',
      },
      dataDir: join(home, '.vessel', 'data'),
      events: ['plugin.changed'],
    });
    const slowStarted = performance.now();
    const slowJobId = await startInstall(client, { id: 'probe-plugin', version: '1.0.0' });
    const slowReturnMs = performance.now() - slowStarted;
    const slowJob = await pollJob(client, slowJobId);
    const slowTotalMs = performance.now() - slowStarted;
    check(
      'child: slow install returns immediately',
      slowReturnMs < 1000,
      `${slowReturnMs.toFixed(0)}ms`,
    );
    check('child: slow download job done', slowJob.status === 'done');
    check(
      'child: slow job was still downloading when polled',
      slowJob.phases.has('downloading') && slowTotalMs >= 300,
      `${slowTotalMs.toFixed(0)}ms`,
    );
    await removePluginVia(client, 'probe-plugin');

    // A failed job must expose its error code through the poller.
    await client.request('plugin.activate', {
      settings: {
        registry_url: `${base}/index-badsha.json`,
        vessel_version: '0.33.0',
        install_scope: 'user',
      },
      dataDir: join(home, '.vessel', 'data'),
      events: ['plugin.changed'],
    });
    const failJobId = await startInstall(client, { id: 'probe-plugin', version: '1.0.0' });
    const failJob = await pollJob(client, failJobId);
    check(
      'child: failed job reports checksum_mismatch',
      failJob.status === 'failed' &&
        failJob.phase === 'failed' &&
        failJob.error?.code === 'checksum_mismatch',
      JSON.stringify(failJob.error),
    );
    check(
      'child: failed job writes nothing',
      !(await exists(join(home, '.vessel', 'plugins', 'probe-plugin'))),
    );

    const bad = await client
      .request('plugin.rpc', { name: 'nope', params: {} })
      .then(() => 'success')
      .catch((error: Error) => error.message);
    check('child: unknown rpc rejected', bad !== 'success');
  } finally {
    await client.close();
  }
}

// ── cleanup + summary ───────────────────────────────────────────────────────

server.stop(true);
await rm(tempRoot, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('failures:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
