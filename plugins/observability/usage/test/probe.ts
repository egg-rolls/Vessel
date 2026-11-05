/**
 * Usage plugin UI probe (CONTRACT-0.45).
 *
 * Asserts the Vite-built `web/` payload, the manifest wiring, and the token
 * rule on sources. Static only: no DOM and no host.
 *
 * Run: bun run plugins/observability/usage/test/probe.ts
 *      (or `bun run probe` inside the plugin directory)
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const pluginRoot = resolve(import.meta.dir, '..');
const webDir = join(pluginRoot, 'web');
const srcDir = join(pluginRoot, 'web-src');

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const MANIFEST = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8')) as {
  vessel?: {
    entry?: string;
    ui?: { dir?: string };
    contributes?: {
      pages?: { id: string; entry: string }[];
      rpc?: { name: string }[];
    };
  };
};

const pages = MANIFEST.vessel?.contributes?.pages ?? [];
const expectedPages = new Map([
  ['usage', 'usage.html'],
  ['logs', 'logs.html'],
  ['leaderboard', 'leaderboard.html'],
]);

check('manifest keeps ui.dir = web', MANIFEST.vessel?.ui?.dir === 'web');
check('manifest keeps the three page entries', pages.length === 3);
for (const [id, entry] of expectedPages) {
  const page = pages.find((item) => item.id === id);
  check(`manifest page ${id} -> ${entry}`, page?.entry === entry);
}
check('manifest keeps child entry', MANIFEST.vessel?.entry === 'src/index.ts');
check(
  'manifest keeps rpc surface',
  (MANIFEST.vessel?.contributes?.rpc ?? [])
    .map((item) => item.name)
    .sort()
    .join(',') === 'leaderboard,logs,summary',
);

// ── built payload ───────────────────────────────────────────────────────────

check('build output exists', await exists(webDir));

for (const [id, file] of expectedPages) {
  const path = join(webDir, file);
  const present = await exists(path);
  check(`built ${file} exists`, present);
  if (!present) continue;

  const html = await readFile(path, 'utf8');
  check(`${file} mounts #root`, html.includes('id="root"'));
  check(`${file} sets data-view="${id}"`, html.includes(`data-view="${id}"`));
  check(
    `${file} loads a built module`,
    /<script[^>]+type="module"[^>]+src="\.\/assets\//.test(html),
  );

  // Every relative asset referenced by the page must exist.
  for (const match of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
    const asset = match[1];
    if (asset === undefined) continue;
    check(`${file} asset ${asset} exists`, await exists(join(webDir, asset)));
  }
}

const assets = (await exists(join(webDir, 'assets'))) ? await readdir(join(webDir, 'assets')) : [];
const jsAssets = assets.filter((name) => extname(name) === '.js');
const cssAssets = assets.filter((name) => extname(name) === '.css');
check('build emits JS assets', jsAssets.length > 0);
check('build emits a CSS asset', cssAssets.length > 0);

const css = (
  await Promise.all(cssAssets.map((name) => readFile(join(webDir, 'assets', name), 'utf8')))
).join('\n');
check('built CSS keeps design tokens', css.includes('--accent:') && css.includes('--content-max:'));
check('built CSS keeps theme utilities', css.includes('.text-title') && css.includes('bg-sunken'));

const js = (
  await Promise.all(jsAssets.map((name) => readFile(join(webDir, 'assets', name), 'utf8')))
).join('\n');
check('bundle keeps the RPC wire type', js.includes('vessel.plugin.rpc'));
check('bundle keeps the refresh message', js.includes('vessel.plugin.refresh'));
check('bundle no longer ships the vanilla UI', !js.includes('data-page="usage"'));

check('legacy app.js removed', !(await exists(join(webDir, 'app.js'))));
check('legacy style.css removed', !(await exists(join(webDir, 'style.css'))));

// ── source rules ────────────────────────────────────────────────────────────

const sourceFiles = (await exists(srcDir))
  ? (await walk(srcDir)).filter((path) => ['.ts', '.tsx', '.css', '.html'].includes(extname(path)))
  : [];
check('web-src has sources', sourceFiles.length >= 8);
check('web-src has no legacy vanilla entry', !sourceFiles.some((path) => path.endsWith('app.js')));
const tsxSources = sourceFiles.filter((path) => path.endsWith('.tsx'));
const uiImports = await Promise.all(
  tsxSources.map(async (path) =>
    (await readFile(path, 'utf8')).includes("'@vessel-agent/plugin-ui'"),
  ),
);
check('web-src imports the shared UI package', uiImports.some(Boolean));
check('no local host bridge', !(await exists(join(srcDir, 'host.tsx'))));
check(
  'host helpers come from the shared package',
  (await readFile(join(srcDir, 'main.tsx'), 'utf8')).includes("from '@vessel-agent/plugin-ui'"),
);

const colorPattern = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\(/;
const offenders: string[] = [];
for (const path of sourceFiles) {
  const text = await readFile(path, 'utf8');
  if (colorPattern.test(text)) offenders.push(path.slice(pluginRoot.length + 1));
}
check('web-src uses tokens, not raw colors', offenders.length === 0, offenders.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
