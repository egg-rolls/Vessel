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
import { buildRecords, daysCutoff } from '../src/aggregate.js';
import type { RawEvent, Settings } from '../src/store.js';
import { DEFAULT_LIMITS, EventStore, USAGE_EVENT_TYPES } from '../src/store.js';
import { I18N, translator } from '../web-src/i18n';

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
check(
  'logs view renders both truncation notices',
  logsSource.includes('logs.truncated.files') && logsSource.includes('logs.truncated.partial'),
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

// The reader reports two kinds of incompleteness; the page has a sentence for
// each, and both must name the real coverage instead of reading like a total.
check(
  'run-file truncation copy states the real coverage',
  en('logs.truncated.files', { files: 47, total: 175 }).includes('47 of 175') &&
    zh('logs.truncated.files', { files: 47, total: 175 }).includes('47/175'),
  en('logs.truncated.files', { files: 47, total: 175 }),
);
check(
  'partial-read copy counts the affected run files',
  en('logs.truncated.partial', { files: 2 }).includes('2 run file') &&
    zh('logs.truncated.partial', { files: 2 }).includes('2 个运行文件'),
  en('logs.truncated.partial', { files: 2 }),
);
check('the old single truncation copy is gone', !Object.keys(I18N.en).includes('logs.truncated'));

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

// ── day window: the read window follows `days` ──────────────────────────────

/**
 * A trace file's mtime is its last append, i.e. the end of the run, so the
 * reader can answer "is this file inside the selected range" from `stat` alone
 * and only then confirm per event with `ts >= cutoff`. These fixtures pin both
 * numbers: mtime a known distance from "today", events inside that span, so a
 * fixture is only in the window when it is *meant* to be.
 */
const NOW = Date.now();

/** Local midnight, `offsetDays` away from today (walks DST the same way `daysCutoff`). */
function dayStart(offsetDays: number): number {
  const date = new Date(NOW);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date.getTime();
}

/** One trace line with an explicit `ts` (`traceLine` owns its own clock). */
function lineAt(type: string, runId: string, ts: number, pad = 0): string {
  const data: Record<string, unknown> = { run_id: runId, session_id: 'sess-1' };
  if (type === 'llm.request') data.model = MODEL;
  else data.usage = { prompt_tokens: 1_000, completion_tokens: 100 };
  if (pad > 0) data.pad = 'x'.repeat(pad);
  return `${JSON.stringify({ type, ts, run_id: runId, data })}\n`;
}

async function writeTrace(dir: string, name: string, text: string, mtime: number): Promise<number> {
  const path = join(dir, 'events', `${name}.jsonl`);
  await writeFile(path, text);
  await utimes(path, new Date(mtime), new Date(mtime));
  return Buffer.byteLength(text);
}

/** `loadEvents` with the same cutoff `index.ts` passes for a `days` value. */
function loadDays(store: EventStore, dir: string, days?: number) {
  return store.loadEvents(dir, days === undefined ? {} : { cutoff: daysCutoff(NOW, days) });
}

function runIds(events: RawEvent[]): string[] {
  return [...new Set(events.map((event) => event.run_id))].sort();
}

// 8. Only in-window files are opened, and only in-window events come back.
{
  const dir = await traceDir('day-window');
  const oldTs = dayStart(-10) + 3_600_000;
  const midTs = dayStart(-3) + 3_600_000;
  const newTs = dayStart(0) + 60_000;
  await writeTrace(
    dir,
    'run-old',
    lineAt('llm.request', 'run-old', oldTs) + lineAt('llm.response', 'run-old', oldTs + 1_400),
    oldTs + 2_000,
  );
  await writeTrace(
    dir,
    'run-mid',
    lineAt('llm.request', 'run-mid', midTs) + lineAt('llm.response', 'run-mid', midTs + 1_400),
    midTs + 2_000,
  );
  const todayBody =
    lineAt('llm.request', 'run-today', newTs) + lineAt('llm.response', 'run-today', newTs + 1_400);
  await writeTrace(dir, 'run-today', todayBody, newTs + 2_000);

  const store = new EventStore();
  const day1 = await loadDays(store, dir, 1);
  check(
    'days=1 opens only the trace files of today',
    day1.files_in_window === 1 && day1.files_covered === 1,
    `in window ${day1.files_in_window}, covered ${day1.files_covered}`,
  );
  check(
    'days=1 still reports the whole directory as files_total',
    day1.files_total === 3,
    String(day1.files_total),
  );
  check(
    "days=1 returns only today's events",
    day1.events.length === 2 && day1.events.every((event) => event.ts >= dayStart(0)),
    `${day1.events.length} events: ${runIds(day1.events).join(',')}`,
  );
  check(
    'a file outside the range is not reported as truncation',
    day1.files_truncated === false && day1.partial_files === 0 && day1.truncated === false,
    `files_truncated=${day1.files_truncated}, partial=${day1.partial_files}`,
  );

  const day7 = await loadDays(store, dir, 7);
  check(
    'days=7 widens the window to the last week',
    day7.files_in_window === 2 && day7.files_covered === 2,
    `in window ${day7.files_in_window}, covered ${day7.files_covered}`,
  );
  check(
    'days=7 events are all inside the window',
    day7.events.every((event) => event.ts >= dayStart(-6)) &&
      runIds(day7.events).join(',') === 'run-mid,run-today',
    runIds(day7.events).join(','),
  );

  const day30 = await loadDays(store, dir, 30);
  check(
    'days=30 covers every run of the fixture',
    day30.files_in_window === 3 && day30.files_covered === 3 && day30.events.length === 6,
    `in window ${day30.files_in_window}, events ${day30.events.length}`,
  );

  const allTime = await store.loadEvents(dir);
  check(
    'no days means the whole directory (files_in_window = files_total)',
    allTime.files_total === 3 &&
      allTime.files_in_window === 3 &&
      allTime.files_covered === 3 &&
      allTime.truncated === false,
    `window ${allTime.files_in_window}, covered ${allTime.files_covered}`,
  );
}

// 9. Switching days must not re-read the files that stay cached.
{
  const dir = await traceDir('day-switch');
  const oldTs = dayStart(-20) + 3_600_000;
  const midTs = dayStart(-3) + 3_600_000;
  const newTs = dayStart(0) + 60_000;
  const oldBytes = await writeTrace(
    dir,
    'run-old',
    lineAt('llm.request', 'run-old', oldTs) + lineAt('llm.response', 'run-old', oldTs + 1_400),
    oldTs + 2_000,
  );
  await writeTrace(
    dir,
    'run-mid',
    lineAt('llm.request', 'run-mid', midTs) + lineAt('llm.response', 'run-mid', midTs + 1_400),
    midTs + 2_000,
  );
  await writeTrace(
    dir,
    'run-today',
    lineAt('llm.request', 'run-today', newTs) + lineAt('llm.response', 'run-today', newTs + 1_400),
    newTs + 2_000,
  );

  const store = new EventStore();
  const seven = await loadDays(store, dir, 7);
  check('a days=7 read is a real read', seven.bytes_read > 0 && seven.files_covered === 2);

  const thirty = await loadDays(store, dir, 30);
  check(
    '7 -> 30 reads only the file that newly entered the window',
    thirty.bytes_read === oldBytes && thirty.files_covered === 3,
    `${thirty.bytes_read} vs ${oldBytes}`,
  );

  const back = await loadDays(store, dir, 7);
  check('30 -> 7 re-reads zero bytes', back.bytes_read === 0, String(back.bytes_read));
  check(
    'switching days back is idempotent',
    JSON.stringify(back.events) === JSON.stringify(seven.events) &&
      back.files_covered === seven.files_covered &&
      back.files_in_window === seven.files_in_window,
    `events ${back.events.length} vs ${seven.events.length}`,
  );

  const fresh = new EventStore();
  const firstRead = await loadDays(fresh, dir, 7);
  check(
    'a days=7 read after switching equals a first read at days=7',
    JSON.stringify(firstRead.events) === JSON.stringify(seven.events) &&
      firstRead.files_covered === seven.files_covered &&
      firstRead.files_in_window === seven.files_in_window,
  );
}

// 10. Cross-day run: an in-window answer keeps its pre-window request (model +
//     duration), while a run that ends before the window contributes nothing.
{
  const dir = await traceDir('cross-day');
  const requestTs = dayStart(-1) + 3_600_000;
  const responseTs = dayStart(0) + 600_000;
  const doneTs = dayStart(-2) + 3_600_000;
  // A second run: its pre-window request is still unanswered when the run is
  // resumed inside the window, so it must *not* be carried (the newer request
  // owns the answer).
  const staleTs = dayStart(-1) + 7_200_000;
  const freshTs = dayStart(0) + 900_000;
  await writeTrace(
    dir,
    'run-cross',
    lineAt('llm.request', 'run-cross', requestTs) +
      lineAt('llm.response', 'run-cross', responseTs) +
      lineAt('llm.request', 'run-before', doneTs) +
      lineAt('llm.response', 'run-before', doneTs + 1_400) +
      lineAt('llm.request', 'run-restart', staleTs) +
      lineAt('llm.request', 'run-restart', freshTs) +
      lineAt('llm.response', 'run-restart', freshTs + 1_400),
    responseTs + 2_000,
  );

  const store = new EventStore();
  const cutoff = daysCutoff(NOW, 1);
  const windowed = await loadDays(store, dir, 1);
  const early = windowed.events.filter((event) => event.ts < cutoff);
  check(
    'events before the window are dropped',
    !windowed.events.some((event) => event.run_id === 'run-before'),
    runIds(windowed.events).join(','),
  );
  check(
    'the only pre-window event kept is the pending request of an in-window answer',
    early.length === 1 && early[0]?.type === 'llm.request' && early[0]?.run_id === 'run-cross',
    early.map((event) => `${event.run_id}:${event.type}`).join(','),
  );

  const records = buildRecords(windowed.events, NO_PRICES);
  const cross = records.find((record) => record.run_id === 'run-cross');
  const restart = records.find((record) => record.run_id === 'run-restart');
  check(
    'the cross-day run keeps its model and duration',
    records.length === 2 && cross?.model === MODEL && cross?.duration_ms === responseTs - requestTs,
    JSON.stringify(records.map((record) => [record.run_id, record.model, record.duration_ms])),
  );
  check(
    'a superseded pre-window request is not carried into the window',
    restart?.model === MODEL && restart?.duration_ms === 1_400,
    JSON.stringify([restart?.model, restart?.duration_ms]),
  );
  check(
    'every record produced is inside the window',
    records.every((record) => record.ts >= cutoff),
  );
}

// 11. A day window that does not fit the byte budget is still a real truncation.
{
  const dir = await traceDir('window-budget');
  let fileBytes = 0;
  for (const [index, name] of ['run-w1', 'run-w2', 'run-w3'].entries()) {
    const ts = dayStart(0) + 60_000 + index * 1_000;
    const body =
      lineAt('llm.response', name, ts, 120) + lineAt('llm.response', name, ts + 500, 120);
    fileBytes = await writeTrace(dir, name, body, ts + 1_000);
  }

  const store = new EventStore({
    ...DEFAULT_LIMITS,
    maxBytesPerCall: Math.floor(fileBytes * 2.5),
    maxBytesPerFile: fileBytes + 16,
  });
  const over = await loadDays(store, dir, 1);
  check(
    'an over-budget day window sets files_truncated',
    over.files_truncated === true && over.truncated === true && over.files_in_window === 3,
    `files_truncated=${over.files_truncated}, in window ${over.files_in_window}`,
  );
  check(
    'an over-budget day window keeps the newest runs only',
    over.files_covered === 2 &&
      over.events.length === 4 &&
      over.events.every((event) => event.run_id !== 'run-w1'),
    `covered ${over.files_covered}: ${runIds(over.events).join(',')}`,
  );
  check(
    'an over-budget day window is not a partial read',
    over.partial_files === 0,
    String(over.partial_files),
  );
}

// 12. An oversized in-window file is reported through partial_files, not
//     files_truncated: the run is counted, its oldest requests are not.
{
  const dir = await traceDir('window-partial');
  const lines: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    lines.push(lineAt('llm.response', 'run-big', dayStart(0) + 60_000 + index * 1_000, 200));
  }
  const ts = dayStart(0) + 120_000;
  await writeTrace(dir, 'run-big', lines.join(''), ts);

  const store = new EventStore({ ...DEFAULT_LIMITS, maxBytesPerFile: 1_024 });
  const tail = await loadDays(store, dir, 1);
  check(
    'an oversized in-window file counts as a partial file',
    tail.partial_files === 1 && tail.files_truncated === false && tail.truncated === true,
    `partial=${tail.partial_files}, files_truncated=${tail.files_truncated}`,
  );
  check(
    'a partially read file still yields its newest in-window events',
    tail.events.length > 0 && tail.events.every((event) => event.ts >= daysCutoff(NOW, 1)),
    String(tail.events.length),
  );
}

await rm(scratch, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
