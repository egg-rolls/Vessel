/**
 * Usage plugin UI probe (CONTRACT-0.45).
 *
 * Asserts the Vite-built `web/` payload, the manifest wiring, and the token
 * rule on sources. Static only: no DOM and no host.
 *
 * Run: bun run plugins/observability/usage/test/probe.ts
 *      (or `bun run probe` inside the plugin directory)
 */

import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { buildRecords } from '../src/aggregate.js';
import type { RawEvent, Settings } from '../src/store.js';
import { DEFAULT_LIMITS, EventStore, USAGE_EVENT_TYPES } from '../src/store.js';
import { translator } from '../web-src/i18n';

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
    activationEvents?: string[];
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
]);

check('manifest keeps ui.dir = web', MANIFEST.vessel?.ui?.dir === 'web');
check('manifest keeps the two page entries', pages.length === 2);
check(
  'leaderboard is no longer a page activation',
  !(MANIFEST.vessel?.activationEvents ?? []).includes('onPage:leaderboard'),
);
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
    `${file} loads a classic script before </body>`,
    /<script src="\.\/assets\/[^"]+"><\/script><\/body>/.test(html),
  );
  check(
    `${file} has no module script or crossorigin`,
    !html.includes('type="module"') && !html.includes('crossorigin'),
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
const esmSyntax =
  /(^|[\n;])\s*(?:import|export)\s*[{*(]/.test(js) ||
  /(^|[^\w$.])import\s*\(/.test(js) ||
  /\bimport\.meta\b/.test(js);
check('bundle is classic-script safe (no ESM syntax)', !esmSyntax);

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

// ── layout / language ───────────────────────────────────────────────────────

const appSource = await readFile(join(srcDir, 'App.tsx'), 'utf8');
const usageSource = await readFile(join(srcDir, 'UsageView.tsx'), 'utf8');
const logsSource = await readFile(join(srcDir, 'LogsView.tsx'), 'utf8');
check('App renders no cross-page tab nav', !/\bPAGES\b|<nav\b/.test(appSource));
check('leaderboard view removed', !(await exists(join(srcDir, 'LeaderboardView.tsx'))));
check(
  'leaderboard page artifact removed',
  !(await exists(join(srcDir, 'leaderboard.html'))) &&
    !(await exists(join(webDir, 'leaderboard.html'))),
);
check('usage view queries the leaderboard RPC', usageSource.includes("'leaderboard'"));
check('usage view renders the merged model table', usageSource.includes('ModelTable'));
check(
  'tables have no Section wrapper',
  !/<Section\b/.test(usageSource) && !/<Section\b/.test(logsSource),
);
check(
  'tables use the TableFrame',
  usageSource.includes('TableFrame') && logsSource.includes('TableFrame'),
);

const en = translator('en');
const zh = translator('zh-CN');
check('en usage description', en('usage.description') === 'Token usage, cache hits and cost.');
check('zh usage description', zh('usage.description') === 'Token 用量、缓存命中与成本概览。');
check(
  'en logs description',
  en('logs.description') === 'Per-request usage and latency, newest first.',
);
check('zh logs description', zh('logs.description') === '按时间查看每次请求的用量与延迟。');
check('en by-model heading', en('usage.byModel') === 'By model');
check('zh by-model heading', zh('usage.byModel') === '按模型');
check(
  'page titles follow the host language',
  en('usage.title') === 'Usage' && zh('usage.title') === '用量',
);
check('unknown languages fall back to English', translator('fr')('usage.title') === 'Usage');

const cjkPattern = /[一-鿿]/;
const componentTexts = await Promise.all(tsxSources.map(async (path) => readFile(path, 'utf8')));
check(
  'components contain no hardcoded Chinese',
  !componentTexts.some((text) => cjkPattern.test(text)),
);

// ── model attribution ───────────────────────────────────────────────────────

/**
 * Fixtures mirror what the trace actually stores: `llm.request` is persisted as
 * the broadcast summary (`summarizeLlmRequest`), which drops `messages` and
 * spreads the rest of `data` verbatim. So `data.model` is the only place the
 * model can come from — the Self Card only ever exists inside the assembled
 * system prompt, never as a message and never in an event.
 */
const MODEL = 'volcengine/deepseek-flash';
const NO_PRICES: Settings = { prices: {} };
const BASE_TS = Date.UTC(2026, 0, 15, 9, 0, 0);

let rawLine = 0;

function rawEvent(
  type: string,
  runId: string,
  ts: number,
  data: Record<string, unknown>,
): RawEvent {
  rawLine += 1;
  return {
    type,
    ts,
    run_id: runId,
    line: rawLine,
    data: { run_id: runId, session_id: 'sess-1', ...data },
  };
}

/** One `llm.request` and the `llm.response` that answers it. */
function exchange(runId: string, request: Record<string, unknown>): RawEvent[] {
  return [
    rawEvent('llm.request', runId, BASE_TS, request),
    rawEvent('llm.response', runId, BASE_TS + 1_400, {
      usage: { prompt_tokens: 1_200, completion_tokens: 240 },
    }),
  ];
}

function modelOf(events: RawEvent[], settings: Settings = NO_PRICES): string | undefined {
  return buildRecords(events, settings)[0]?.model;
}

// 1. The shape the trace really writes: `model` present, `messages` gone.
const newTrace = modelOf(exchange('run-new', { model: MODEL, message_count: 4, tools: [] }));
check('llm.request: model comes from data.model', newTrace === MODEL, newTrace);

// 2. No `model` and no configured default: `unknown`, never a guess.
const bare = modelOf(exchange('run-bare', { message_count: 2 }));
check('no data.model and no default_model: unknown', bare === 'unknown', bare);

// 3. The model a request actually used must not be relabelled by a setting.
const withDefault: Settings = { prices: {}, default_model: 'configured/default' };
const newTraceWithDefault = modelOf(exchange('run-new-default', { model: MODEL }), withDefault);
check(
  'data.model outranks settings.default_model',
  newTraceWithDefault === MODEL,
  newTraceWithDefault,
);

// 4. Only `default_model` left: use it instead of `unknown`.
const bareWithDefault = modelOf(exchange('run-bare-default', { message_count: 2 }), withDefault);
check(
  'settings.default_model is the fallback before unknown',
  bareWithDefault === 'configured/default',
  bareWithDefault,
);

// 5. A failed run before any response reuses the pending request's model.
const failedRun = buildRecords(
  [
    rawEvent('llm.request', 'run-failed', BASE_TS, { model: MODEL, message_count: 3 }),
    rawEvent('run.failed', 'run-failed', BASE_TS + 800, { error: 'provider exploded' }),
  ],
  NO_PRICES,
);
check(
  'run.failed reuses the pending llm.request model',
  failedRun[0]?.model === MODEL,
  failedRun[0]?.model,
);

// 6. Regression guard for the removed Self Card scrape: even when a payload
//    smuggles `messages` through, a `model:` line in them is not attributed
//    (the parse could never fire on a real trace anyway, and it was a guess).
const smuggled = modelOf(
  exchange('run-smuggled', {
    messages: [{ role: 'system', content: '[Self Card]\nrole: main\nmodel: claude-sonnet-4-5' }],
  }),
);
check('readable Self Card is no longer parsed', smuggled === 'unknown', smuggled);

// ── incremental reader ──────────────────────────────────────────────────────

/**
 * The reader keeps one byte cursor per trace file and only reads what was
 * appended past the last complete line. These fixtures drive every branch of
 * that cursor: append, half-written line, truncate, delete, byte budget, and
 * repeated calls. Limits are injected so the budget paths stay cheap.
 */

const scratch = await mkdtemp(join(tmpdir(), 'usage-tailread-'));
const FIXTURE_MTIME = Date.UTC(2026, 0, 15, 9, 0, 0);

let fixtureTs = BASE_TS;

/** One trace line; `pad` inflates it so the byte budgets can be exercised. */
function traceLine(type: string, runId: string, pad = 0): string {
  fixtureTs += 1_000;
  const data: Record<string, unknown> = { run_id: runId, session_id: 'sess-1' };
  if (pad > 0) data.pad = 'x'.repeat(pad);
  return `${JSON.stringify({ type, ts: fixtureTs, run_id: runId, data })}\n`;
}

async function traceDir(name: string): Promise<string> {
  const root = join(scratch, name);
  await mkdir(join(root, 'events'), { recursive: true });
  return root;
}

function idsOf(events: RawEvent[]): string[] {
  return events.map((event) => `${event.run_id}:${event.seq ?? event.line}`);
}

// 1. Append: one new line adds one event, and nothing is parsed twice.
{
  const dir = await traceDir('append');
  const file = join(dir, 'events', 'run-a.jsonl');
  const head = traceLine('llm.request', 'run-a') + traceLine('llm.response', 'run-a');
  await writeFile(file, head);

  const store = new EventStore();
  const cold = await store.loadEvents(dir);
  check(
    'cold read parses every line in the file',
    cold.events.length === 2,
    String(cold.events.length),
  );
  check(
    'cold read bills the whole file',
    cold.bytes_read === Buffer.byteLength(head),
    `${cold.bytes_read} vs ${Buffer.byteLength(head)}`,
  );

  const warm = await store.loadEvents(dir);
  check('an unchanged file re-reads zero bytes', warm.bytes_read === 0, String(warm.bytes_read));

  const appended = traceLine('llm.response', 'run-a');
  await appendFile(file, appended);
  const tail = await store.loadEvents(dir);
  check(
    'an appended line adds exactly one event',
    tail.events.length === 3,
    String(tail.events.length),
  );
  check(
    'an appended line costs only its own bytes',
    tail.bytes_read === Buffer.byteLength(appended),
    `${tail.bytes_read} vs ${Buffer.byteLength(appended)}`,
  );
  const ids = idsOf(tail.events);
  check('no line is parsed twice', new Set(ids).size === ids.length, ids.join(','));
}

// 2. Half-written line: not parsed, not lost.
{
  const dir = await traceDir('partial');
  const file = join(dir, 'events', 'run-b.jsonl');
  const complete = traceLine('llm.response', 'run-b');
  const torn = traceLine('llm.response', 'run-b');
  const cut = Math.floor(torn.length / 2);
  await writeFile(file, complete + torn.slice(0, cut));

  const store = new EventStore();
  const half = await store.loadEvents(dir);
  check('a half-written line is not parsed', half.events.length === 1, String(half.events.length));
  check('a half-written line is not truncation', half.truncated === false);

  await appendFile(file, torn.slice(cut));
  const healed = await store.loadEvents(dir);
  check(
    'the completed line is parsed once',
    healed.events.length === 2,
    String(healed.events.length),
  );
  check(
    'the completed line keeps its line number',
    healed.events[1]?.line === 2,
    String(healed.events[1]?.line),
  );
}

// 3. Truncate/rotate: the offset is dropped and the file is read from the top.
{
  const dir = await traceDir('truncate');
  const file = join(dir, 'events', 'run-c.jsonl');
  await writeFile(
    file,
    traceLine('llm.response', 'run-c') +
      traceLine('llm.response', 'run-c') +
      traceLine('llm.response', 'run-c'),
  );
  const store = new EventStore();
  const before = await store.loadEvents(dir);

  const replaced = traceLine('llm.response', 'run-c');
  await writeFile(file, replaced);
  const after = await store.loadEvents(dir);
  check(
    'a shrunk file is re-read from scratch',
    before.events.length === 3 && after.events.length === 1,
    `${before.events.length} -> ${after.events.length}`,
  );
  check(
    'the re-read bills the replacement size',
    after.bytes_read === Buffer.byteLength(replaced),
    `${after.bytes_read} vs ${Buffer.byteLength(replaced)}`,
  );
}

// 4. Deleted file (trace pruning): cache entry dropped, no error.
{
  const dir = await traceDir('delete');
  const file = join(dir, 'events', 'run-d.jsonl');
  await writeFile(file, traceLine('llm.response', 'run-d'));
  const store = new EventStore();
  const before = await store.loadEvents(dir);

  await rm(file);
  const after = await store.loadEvents(dir);
  check(
    'a pruned trace file disappears from the result',
    before.events.length === 1 && after.events.length === 0 && after.files_total === 0,
    `${before.events.length} -> ${after.events.length}, total ${after.files_total}`,
  );
  check('a pruned trace file is not an error', after.truncated === false && after.bytes_read === 0);
}

// 5. Byte budget: newest files only, unchanged cached files cost nothing.
{
  const dir = await traceDir('budget');
  const eventsDir = join(dir, 'events');
  const names = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'];
  let fileBytes = 0;
  for (const [index, name] of names.entries()) {
    const body = traceLine('llm.response', name, 120) + traceLine('llm.response', name, 120);
    fileBytes = Buffer.byteLength(body);
    const path = join(eventsDir, `${name}.jsonl`);
    await writeFile(path, body);
    // Distinct mtimes so "newest first" is deterministic (run-5 is newest).
    await utimes(path, new Date(FIXTURE_MTIME), new Date(FIXTURE_MTIME + index * 1_000));
  }

  const store = new EventStore({
    ...DEFAULT_LIMITS,
    maxBytesPerCall: Math.floor(fileBytes * 2.5),
    maxBytesPerFile: fileBytes + 16,
  });
  const first = await store.loadEvents(dir);
  check(
    'the byte budget stops the call and flags truncation',
    first.truncated === true && first.files_covered === 2,
    `covered ${first.files_covered}/${first.files_total}, truncated=${first.truncated}`,
  );
  check(
    'the budget is spent on the newest files',
    first.events.length === 4 && first.events.every((event) => event.run_id >= 'run-4'),
    first.events.map((event) => event.run_id).join(','),
  );

  const second = await store.loadEvents(dir);
  check(
    'cached unchanged files cost no bytes on the next call',
    second.bytes_read === 0 && second.events.length === first.events.length,
    `bytes ${second.bytes_read}, events ${second.events.length}`,
  );
}

// 6. Idempotency, plus non-usage event types staying out of the cache.
{
  const dir = await traceDir('idempotent');
  const file = join(dir, 'events', 'run-f.jsonl');
  await writeFile(file, traceLine('llm.request', 'run-f') + traceLine('llm.response', 'run-f', 64));
  await appendFile(file, traceLine('llm.response', 'run-f'));
  await utimes(
    join(dir, 'events', 'run-f.jsonl'),
    new Date(FIXTURE_MTIME),
    new Date(FIXTURE_MTIME),
  );

  const store = new EventStore();
  const first = await store.loadEvents(dir);
  const second = await store.loadEvents(dir);
  const same =
    JSON.stringify(first.events) === JSON.stringify(second.events) &&
    first.truncated === second.truncated &&
    first.files_covered === second.files_covered &&
    first.files_total === second.files_total;
  check('two calls on an unchanged directory agree', same);
  check('the second call reads zero bytes', second.bytes_read === 0, String(second.bytes_read));

  await appendFile(file, traceLine('context.changed', 'run-f', 2_000));
  const filtered = await store.loadEvents(dir);
  check(
    'non-usage event types add bytes but no events',
    filtered.bytes_read > 0 &&
      filtered.events.length === first.events.length &&
      filtered.events.every((event) => USAGE_EVENT_TYPES.has(event.type)),
    `${filtered.bytes_read} bytes, ${filtered.events.length} events`,
  );
}

// 7. Oversized file: only its newest bytes are read, and appends stay incremental.
{
  const dir = await traceDir('oversized');
  const file = join(dir, 'events', 'run-g.jsonl');
  const body: string[] = [];
  for (let index = 0; index < 40; index += 1) body.push(traceLine('llm.response', 'run-g', 200));
  const text = body.join('');
  await writeFile(file, text);
  const size = Buffer.byteLength(text);

  const store = new EventStore({ ...DEFAULT_LIMITS, maxBytesPerFile: 1_024 });
  const tail = await store.loadEvents(dir);
  check(
    'an oversized file is read from its newest bytes only',
    tail.bytes_read <= 1_025 && tail.bytes_read < size,
    `${tail.bytes_read} of ${size}`,
  );
  check('an oversized file is reported as truncated', tail.truncated === true);

  const appended = traceLine('llm.response', 'run-g');
  await appendFile(file, appended);
  const grown = await store.loadEvents(dir);
  check(
    'appends to an oversized file stay incremental',
    grown.bytes_read === Buffer.byteLength(appended) &&
      grown.events.length === tail.events.length + 1,
    `${grown.bytes_read} vs ${Buffer.byteLength(appended)}, ${tail.events.length} -> ${grown.events.length}`,
  );
}

await rm(scratch, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
