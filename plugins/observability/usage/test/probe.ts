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
import { dirname, extname, join, resolve } from 'node:path';
import {
  buildRecords,
  buildRunSummaries,
  completedUsages,
  cutoffFor,
  daysCutoff,
  type LogsResult,
  listLogs,
  repriceRuns,
  resolveLogsRange,
  summarizeRuns,
} from '../src/aggregate.js';
import type { RawEvent, Settings } from '../src/store.js';
import {
  DEFAULT_LIMITS,
  EventStore,
  type IndexSources,
  readSessionSources,
  readUsageIndex,
  sourceSignature,
  USAGE_EVENT_TYPES,
  USAGE_INDEX_VERSION,
  usageIndexPath,
  writeUsageIndex,
} from '../src/store.js';
import { WorkerQueryClient } from '../src/worker-client.js';
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
const sharedSource = await readFile(join(srcDir, 'shared.tsx'), 'utf8');
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
  'both views render the one shared coverage notice',
  sharedSource.includes('export function CoverageNotice') &&
    sharedSource.includes('logs.truncated.files') &&
    sharedSource.includes('logs.truncated.partial') &&
    usageSource.includes('CoverageNotice') &&
    logsSource.includes('CoverageNotice'),
);
check(
  'no view keeps a private copy of the truncation copy',
  !usageSource.includes('logs.truncated') && !logsSource.includes('logs.truncated'),
);
check(
  'the usage page shows coverage for the selected range',
  usageSource.includes('summary.source'),
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
  await mkdir(join(root, 'sessions'), { recursive: true });
  return root;
}

/** The one log file a session owns: root/sessions/(sessionId)/events.ndjson. */
function sessionFile(dir: string, name: string): string {
  return join(dir, 'sessions', name, 'events.ndjson');
}

/** Write one session log, creating its directory. */
async function writeSession(dir: string, name: string, text: string): Promise<string> {
  const path = sessionFile(dir, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

function idsOf(events: RawEvent[]): string[] {
  return events.map((event) => `${event.run_id}:${event.seq ?? event.line}`);
}

// 1. Append: one new line adds one event, and nothing is parsed twice.
{
  const dir = await traceDir('append');
  const file = sessionFile(dir, 'session-a');
  const head = traceLine('llm.request', 'run-a') + traceLine('llm.response', 'run-a');
  await writeSession(dir, 'session-a', head);

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
  const file = sessionFile(dir, 'session-b');
  const complete = traceLine('llm.response', 'run-b');
  const torn = traceLine('llm.response', 'run-b');
  const cut = Math.floor(torn.length / 2);
  await writeSession(dir, 'session-b', complete + torn.slice(0, cut));

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
  const file = sessionFile(dir, 'session-c');
  await writeSession(
    dir,
    'session-c',
    traceLine('llm.response', 'run-c') +
      traceLine('llm.response', 'run-c') +
      traceLine('llm.response', 'run-c'),
  );
  const store = new EventStore();
  const before = await store.loadEvents(dir);

  const replaced = traceLine('llm.response', 'run-c');
  await writeSession(dir, 'session-c', replaced);
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
  const file = sessionFile(dir, 'session-d');
  await writeSession(dir, 'session-d', traceLine('llm.response', 'run-d'));
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
  const names = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'];
  let fileBytes = 0;
  for (const [index, name] of names.entries()) {
    const body = traceLine('llm.response', name, 120) + traceLine('llm.response', name, 120);
    fileBytes = Buffer.byteLength(body);
    const path = await writeSession(dir, name, body);
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
  const file = sessionFile(dir, 'session-f');
  await writeSession(
    dir,
    'session-f',
    traceLine('llm.request', 'run-f') + traceLine('llm.response', 'run-f', 64),
  );
  await appendFile(file, traceLine('llm.response', 'run-f'));
  await utimes(
    file,
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
  const file = sessionFile(dir, 'session-g');
  const body: string[] = [];
  for (let index = 0; index < 40; index += 1) body.push(traceLine('llm.response', 'run-g', 200));
  const text = body.join('');
  await writeSession(dir, 'session-g', text);
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
  const path = await writeSession(dir, name, text);
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
    lineAt('llm.request', 'run-today', newTs) +
    lineAt('llm.response', 'run-today', newTs + 1_400);
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
    'days=1 returns only today\'s events',
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
  check(
    '30 -> 7 re-reads zero bytes',
    back.bytes_read === 0,
    String(back.bytes_read),
  );
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
    // Both budgets are tightened: this test is about running out *inside* a
    // selected range, where `maxBytesPerWindowCall` would otherwise win.
    maxBytesPerCall: Math.floor(fileBytes * 2.5),
    maxBytesPerWindowCall: Math.floor(fileBytes * 2.5),
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

// 13. A selected range gets the larger window budget; "all time" keeps the small
//     one. `same directory, same limits` — only the presence of a window differs.
{
  const dir = await traceDir('window-budget-scale');
  let fileBytes = 0;
  for (const [index, name] of ['run-b1', 'run-b2', 'run-b3'].entries()) {
    const ts = dayStart(0) + 60_000 + index * 1_000;
    const body =
      lineAt('llm.response', name, ts, 120) + lineAt('llm.response', name, ts + 500, 120);
    fileBytes = await writeTrace(dir, name, body, ts + 1_000);
  }

  const store = new EventStore({
    ...DEFAULT_LIMITS,
    // One file per call when no window is selected...
    maxBytesPerCall: fileBytes + 8,
    // ...and the whole three-file range when one is.
    maxBytesPerWindowCall: fileBytes * 3 + 32,
    maxBytesPerFile: fileBytes + 16,
  });

  const allTime = await store.loadEvents(dir);
  check(
    'without days the small per-call budget still applies',
    allTime.files_covered === 1 && allTime.files_truncated === true,
    `covered ${allTime.files_covered}, files_truncated=${allTime.files_truncated}`,
  );

  const windowed = await loadDays(store, dir, 1);
  check(
    'a selected range uses the larger window budget',
    windowed.files_covered === 3 &&
      windowed.files_in_window === 3 &&
      windowed.files_truncated === false,
    `covered ${windowed.files_covered}/${windowed.files_in_window}, files_truncated=${windowed.files_truncated}`,
  );
  check(
    'the window budget is actually spent, not sampled',
    windowed.events.length === 6,
    String(windowed.events.length),
  );
}

// 14. Retention must clear the read budget: reading a window completely and then
//     evicting half of it would make "complete" an illusion (the next render
//     re-reads, or the numbers come out short).
{
  const dir = await traceDir('window-retention');
  let fileBytes = 0;
  let windowBytes = 0;
  for (const [index, name] of ['run-r1', 'run-r2', 'run-r3', 'run-r4'].entries()) {
    const ts = dayStart(0) + 60_000 + index * 1_000;
    const body =
      lineAt('llm.response', name, ts, 400) + lineAt('llm.response', name, ts + 500, 400);
    fileBytes = await writeTrace(dir, name, body, ts + 1_000);
    windowBytes += fileBytes;
  }

  const base = {
    ...DEFAULT_LIMITS,
    maxBytesPerCall: windowBytes,
    maxBytesPerWindowCall: windowBytes,
    maxBytesPerFile: fileBytes + 16,
    maxRetainedBytesPerFile: fileBytes * 2,
    maxCachedFiles: 64,
  };

  const roomy = new EventStore({ ...base, maxRetainedBytesTotal: windowBytes + 32 });
  const complete = await loadDays(roomy, dir, 1);
  check(
    'retention above the window keeps the range complete',
    complete.files_truncated === false &&
      complete.partial_files === 0 &&
      complete.events.length === 8,
    `files_truncated=${complete.files_truncated}, partial=${complete.partial_files}, events=${complete.events.length}`,
  );

  const tight = new EventStore({ ...base, maxRetainedBytesTotal: Math.floor(windowBytes / 2) });
  const squeezed = await loadDays(tight, dir, 1);
  check(
    'retention below the window loses part of the range',
    squeezed.files_truncated === true ||
      squeezed.partial_files > 0 ||
      squeezed.events.length < complete.events.length,
    `files_truncated=${squeezed.files_truncated}, partial=${squeezed.partial_files}, events=${squeezed.events.length}`,
  );

  check(
    'the shipped memory cap is finite and reported as partial reads',
    Number.isFinite(DEFAULT_LIMITS.maxRetainedBytesTotal) &&
      DEFAULT_LIMITS.maxRetainedBytesTotal >= 64 * 1024 * 1024 &&
      Number.isFinite(DEFAULT_LIMITS.maxRetainedBytesPerFile),
    `${DEFAULT_LIMITS.maxRetainedBytesTotal} / ${DEFAULT_LIMITS.maxRetainedBytesPerFile}`,
  );
  check(
    'the shipped I/O gates are off: the reader runs in a worker, so nothing truncates',
    DEFAULT_LIMITS.maxBytesPerCall === Number.POSITIVE_INFINITY &&
      DEFAULT_LIMITS.maxBytesPerWindowCall === Number.POSITIVE_INFINITY &&
      DEFAULT_LIMITS.maxBytesPerFile === Number.POSITIVE_INFINITY &&
      DEFAULT_LIMITS.maxFilesPerCall === Number.POSITIVE_INFINITY,
    `${DEFAULT_LIMITS.maxBytesPerCall}, ${DEFAULT_LIMITS.maxFilesPerCall}`,
  );
}

// ── logs range: days / since / until, and range + cursor ────────────────────

/**
 * `logs` is a *paged view of a range*, so the two features have to compose: the
 * range decides which records exist for this query, the cursor walks them
 * newest-first. These fixtures pin the boundaries (`since` inclusive, `until`
 * exclusive), the mutual exclusion of the two range syntaxes, and paging inside
 * a range without repeats or gaps.
 */

/** One request/response pair at `ts`; the resulting record carries `ts + 1_400`. */
function pairAt(runId: string, ts: number): RawEvent[] {
  return [
    rawEvent('llm.request', runId, ts, { model: MODEL }),
    rawEvent('llm.response', runId, ts + 1_400, {
      usage: { prompt_tokens: 1_000, completion_tokens: 100 },
    }),
  ];
}

const TODAY_TS = dayStart(0) + 60_000;
const YDAY_TS = dayStart(-1) + 60_000;
const OLD_TS = dayStart(-9) + 60_000;
const rangeRecords = buildRecords(
  [
    ...pairAt('run-today', TODAY_TS),
    ...pairAt('run-yday', YDAY_TS),
    ...pairAt('run-old', OLD_TS),
  ],
  NO_PRICES,
);

// 15. The `days` range is the same instant summary/leaderboard use.
{
  const cutoff = cutoffFor(NOW, 1);
  check(
    'logs and summary resolve days through one function',
    cutoff !== undefined &&
      cutoff === daysCutoff(NOW, 1) &&
      cutoffFor(NOW, undefined) === undefined,
    String(cutoff),
  );
  const day1 = listLogs(rangeRecords, { limit: 50, since: cutoff });
  check(
    'days=1 shows only today\'s records',
    day1.items.length === 1 && day1.items[0]?.run_id === 'run-today',
    day1.items.map((item) => item.run_id).join(','),
  );
  const day7 = listLogs(rangeRecords, { limit: 50, since: cutoffFor(NOW, 7) });
  check(
    'days=7 widens to yesterday and today, never the 9-day-old run',
    day7.items.length === 2 &&
      day7.items.every((item) => item.run_id !== 'run-old') &&
      day7.items.every((item) => item.ts >= (cutoffFor(NOW, 7) ?? 0)),
    day7.items.map((item) => item.run_id).join(','),
  );
}

// 16. since inclusive / until exclusive, and the two syntaxes never mix.
{
  const bound = TODAY_TS + 1_400;
  const inclusive = listLogs(rangeRecords, { limit: 50, since: bound, until: bound + 1 });
  check(
    'since is inclusive (a record exactly at the bound is in)',
    inclusive.items.length === 1 && inclusive.items[0]?.ts === bound,
    String(inclusive.items.length),
  );
  const nextRange = listLogs(rangeRecords, { limit: 50, since: bound + 1 });
  check(
    'an adjacent range does not repeat the boundary record',
    nextRange.items.length === 0,
    nextRange.items.map((item) => item.run_id).join(','),
  );
  const exclusive = listLogs(rangeRecords, { limit: 50, until: bound });
  check(
    'until is exclusive (a record exactly at the bound is out)',
    exclusive.items.every((item) => item.ts !== bound) && exclusive.items.length === 2,
    exclusive.items.map((item) => item.ts).join(','),
  );

  const conflict = resolveLogsRange({ days: 7, since: bound }, NOW);
  check(
    'days together with since/until is rejected',
    conflict.ok === false && conflict.code === 'range_conflict',
    JSON.stringify(conflict),
  );
  const inverted = resolveLogsRange({ since: bound, until: bound }, NOW);
  check(
    'an empty or inverted interval is rejected',
    inverted.ok === false && inverted.code === 'range_inverted',
    JSON.stringify(inverted),
  );
  const custom = resolveLogsRange({ since: bound, until: bound + 10 }, NOW);
  check(
    'a custom interval bounds the reader on its start only',
    custom.ok === true && custom.cutoff === bound && custom.until === bound + 10,
    JSON.stringify(custom),
  );
  const untilOnly = resolveLogsRange({ until: bound }, NOW);
  check(
    'until alone leaves the reader unbounded below',
    untilOnly.ok === true && untilOnly.cutoff === undefined && untilOnly.until === bound,
    JSON.stringify(untilOnly),
  );
  const days = resolveLogsRange({ days: 7 }, NOW);
  check(
    'a days range resolves to the shared cutoff on both levels',
    days.ok === true && days.cutoff === cutoffFor(NOW, 7) && days.since === days.cutoff,
    JSON.stringify(days),
  );
}

// 17. Range + cursor: every page is a window of the range, so paging cannot repeat
//     a row, skip one, or step outside.
{
  const start = dayStart(-1);
  const end = dayStart(0);
  const events: RawEvent[] = [];
  for (let index = 0; index < 6; index += 1) {
    events.push(...pairAt(`run-page${index}`, start + 600_000 + index * 600_000));
  }
  // Three records outside the interval (before it) that must never surface.
  events.push(...pairAt('run-before', start - 7_200_000));
  const paged = buildRecords(events, NO_PRICES);
  const inRange = paged
    .filter((record) => record.ts >= start && record.ts < end)
    .sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id));
  check('the paging fixture has 6 in-range records', inRange.length === 6, String(inRange.length));

  const seen: string[] = [];
  let cursor: LogsResult['next_cursor'] = null;
  let pages = 0;
  let allInRange = true;
  for (;;) {
    const page = listLogs(paged, {
      limit: 2,
      since: start,
      until: end,
      ...(cursor !== null ? { before_ts: cursor.before_ts, before_id: cursor.before_id } : {}),
    });
    pages += 1;
    for (const item of page.items) {
      seen.push(item.id);
      if (item.ts < start || item.ts >= end) allInRange = false;
    }
    cursor = page.next_cursor;
    if (cursor === null) break;
    if (pages > 10) break;
  }
  check('paging inside a range stays inside the range', allInRange);
  check(
    'paging collects every in-range record exactly once',
    seen.length === inRange.length && new Set(seen).size === seen.length,
    `${seen.length} rows vs ${inRange.length}, uniq ${new Set(seen).size}`,
  );
  check(
    'paging returns them newest first',
    seen.join(',') === inRange.map((record) => record.id).join(','),
    seen.join(','),
  );
  check('the last page reports no cursor', pages === 3 && cursor === null, String(pages));

  const exactlyFull = listLogs(paged, { limit: 6, since: start, until: end });
  check(
    'a page that exactly exhausts the range reports no cursor',
    exactlyFull.items.length === 6 && exactlyFull.next_cursor === null,
    String(exactlyFull.next_cursor === null),
  );
  const oneLeft = listLogs(paged, { limit: 5, since: start, until: end });
  check(
    'a page with a row left over reports a cursor',
    oneLeft.items.length === 5 && oneLeft.next_cursor !== null,
  );
}

// 18. `until` reorders the visit so a historical interval reaches its own runs
//     instead of spending the budget on today's files.
{
  const dir = await traceDir('range-until');
  const twentyDays = dayStart(-20) + 3_600_000;
  const fiveDays = dayStart(-5) + 3_600_000;
  const today = dayStart(0) + 3_600_000;
  await writeTrace(
    dir,
    'run-20d',
    lineAt('llm.request', 'run-20d', twentyDays) +
      lineAt('llm.response', 'run-20d', twentyDays + 1_400),
    twentyDays + 2_000,
  );
  const fiveBytes = await writeTrace(
    dir,
    'run-5d',
    lineAt('llm.request', 'run-5d', fiveDays) +
      lineAt('llm.response', 'run-5d', fiveDays + 1_400),
    fiveDays + 2_000,
  );
  await writeTrace(
    dir,
    'run-now',
    lineAt('llm.request', 'run-now', today) + lineAt('llm.response', 'run-now', today + 1_400),
    today + 2_000,
  );

  const oneFile = new EventStore({
    ...DEFAULT_LIMITS,
    maxBytesPerCall: fiveBytes + 8,
    maxBytesPerWindowCall: fiveBytes + 8,
    maxBytesPerFile: fiveBytes + 16,
  });
  const until = dayStart(-4);
  const nearest = await oneFile.loadEvents(dir, { until });
  check(
    'a budget for one file is spent on the file nearest the range end',
    nearest.files_covered === 1 && nearest.events.every((event) => event.run_id === 'run-5d'),
    `covered ${nearest.files_covered}: ${runIds(nearest.events).join(',')}`,
  );

  const roomy = new EventStore({
    ...DEFAULT_LIMITS,
    maxBytesPerCall: 64,
    maxBytesPerWindowCall: fiveBytes * 4,
    maxBytesPerFile: fiveBytes + 16,
  });
  const allThree = await roomy.loadEvents(dir, { until });
  check(
    'an until-only range gets the window budget',
    allThree.files_covered === 2 &&
      allThree.files_in_window === 2 &&
      allThree.files_truncated === false,
    `covered ${allThree.files_covered}/${allThree.files_in_window}`,
  );
  check(
    'the run that starts after the range is not read at all',
    allThree.events.every((event) => event.run_id !== 'run-now'),
    runIds(allThree.events).join(','),
  );
  const unbounded = await roomy.loadEvents(dir);
  check(
    'without any bound the small per-call budget still applies',
    unbounded.files_covered === 0 && unbounded.files_truncated === true,
    `covered ${unbounded.files_covered}`,
  );
}

// 19. Source-level wiring: one resolver, one cutoff, both controls present.
{
  const indexSource = await readFile(join(pluginRoot, 'src', 'index.ts'), 'utf8');
  check(
    'logs resolves its range through the shared resolver',
    indexSource.includes('resolveLogsRange') && indexSource.includes('cutoffFor'),
  );
  check(
    'logs hands the resolved cutoff to the reader',
    indexSource.includes('cutoff: range.cutoff') && indexSource.includes('until: range.until'),
  );
  check(
    'logs view sends either days or a custom interval',
    logsSource.includes('rangeParams(') &&
      logsSource.includes('params.since') &&
      logsSource.includes('params.until'),
  );
  check(
    'logs view offers the whole preset set (today included)',
    sharedSource.includes("id: '1'") && sharedSource.includes("id: '0'"),
  );
  check(
    'logs view shows the applied range and how much is loaded',
    logsSource.includes('StateLine') &&
      logsSource.includes('logs.state.loaded') &&
      logsSource.includes('logs.state.more'),
  );
}

// ── first-line peek: an authoritative "this run is after the range" ─────────

/**
 * A file written after `until` still has to be considered — unless its own first
 * line proves the run starts after the range. That proof is a real read of real
 * bytes (not a guess), so it may drop the file outright and save the budget; any
 * file whose first line cannot be judged is kept.
 */

// 20. `firstTs >= until` drops the file before it costs any bytes.
{
  const dir = await traceDir('peek-after');
  const inside = dayStart(-10) + 3_600_000;
  const before = dayStart(-3) + 3_600_000;
  const after = dayStart(0) + 3_600_000;
  const insideBytes = await writeTrace(
    dir,
    'run-inside',
    lineAt('llm.request', 'run-inside', inside) +
      lineAt('llm.response', 'run-inside', inside + 1_400),
    inside + 2_000,
  );
  const beforeBytes = await writeTrace(
    dir,
    'run-after-a',
    lineAt('llm.request', 'run-after-a', before) +
      lineAt('llm.response', 'run-after-a', before + 1_400),
    before + 2_000,
  );
  const afterBytes = await writeTrace(
    dir,
    'run-after-b',
    lineAt('llm.request', 'run-after-b', after) +
      lineAt('llm.response', 'run-after-b', after + 1_400),
    after + 2_000,
  );

  const until = dayStart(-5);
  const store = new EventStore({ ...DEFAULT_LIMITS, maxBytesPerFile: insideBytes + 16 });
  const result = await store.loadEvents(dir, { until });
  check(
    'a run that starts after the range is not in the file window at all',
    result.files_in_window === 1 && result.files_covered === 1,
    `in window ${result.files_in_window}, covered ${result.files_covered}`,
  );
  check(
    'the dropped file costs the budget nothing',
    result.bytes_read === insideBytes && result.bytes_read < insideBytes + beforeBytes + afterBytes,
    `${result.bytes_read} vs inside ${insideBytes}, other two ${beforeBytes + afterBytes}`,
  );
  check(
    'only the run before the range is returned',
    runIds(result.events).join(',') === 'run-inside',
    runIds(result.events).join(','),
  );

  // A second call must not peek again: the first-line cache is keyed by
  // (path, size, mtime), and an append-only trace file never changes its head.
  const peeksAfterFirst = store.firstLinePeeks;
  const again = await store.loadEvents(dir, { until });
  check(
    'a repeated range query does not peek the same files again',
    peeksAfterFirst === 2 && store.firstLinePeeks === peeksAfterFirst && again.bytes_read === 0,
    `peeks ${peeksAfterFirst} -> ${store.firstLinePeeks}, bytes ${again.bytes_read}`,
  );
}

// 21. `firstTs < until` keeps the file: a run that straddles the bound.
{
  const dir = await traceDir('peek-straddle');
  const starts = dayStart(-8) + 3_600_000;
  const ends = dayStart(0) + 3_600_000;
  await writeTrace(
    dir,
    'run-straddle',
    lineAt('llm.request', 'run-straddle', starts) +
      lineAt('llm.response', 'run-straddle', ends),
    ends + 2_000,
  );

  const until = dayStart(-5);
  const store = new EventStore();
  const result = await store.loadEvents(dir, { until });
  check(
    'a run that starts before the range end is kept',
    result.files_in_window === 1 && result.files_covered === 1,
    `in window ${result.files_in_window}`,
  );
  check(
    'the straddling run still yields its in-range events',
    result.events.length > 0 && runIds(result.events).join(',') === 'run-straddle',
    runIds(result.events).join(','),
  );
}

// 22. No judgement is a "keep": empty, unparsable and over-long first lines all
//     degrade to the old behaviour instead of dropping data.
{
  const dir = await traceDir('peek-unknown');
  const after = dayStart(0) + 3_600_000;

  // Empty file (no lines at all).
  const empty = await writeSession(dir, 'sess-empty', '');
  await utimes(empty, new Date(after), new Date(after));

  // First line is not JSON.
  const torn = sessionFile(dir, 'sess-torn');
  await writeSession(dir, 'sess-torn', `not json at all\n${lineAt('llm.response', 'run-torn', after)}`);
  await utimes(torn, new Date(after), new Date(after));

  // First line carries no usable ts.
  const noTs = sessionFile(dir, 'sess-nots');
  const noTsBody = `${JSON.stringify({ type: 'run.start', run_id: 'run-nots' })}\n`;
  await writeSession(dir, 'sess-nots', noTsBody);
  await utimes(noTs, new Date(after), new Date(after));

  // First line is longer than the peek window (one oversized line).
  const long = sessionFile(dir, 'sess-long');
  const longBody = `${JSON.stringify({ pad: 'x'.repeat(20_000), ts: after })}\n`;
  await writeSession(dir, 'sess-long', longBody);
  await utimes(long, new Date(after), new Date(after));

  // A late run that *is* judgeable, to prove the unjudgeable ones were kept by
  // their own verdict and not by a blanket rule.
  const normal = sessionFile(dir, 'sess-normal');
  await writeSession(dir, 'sess-normal', lineAt('llm.response', 'run-normal', after + 60_000));
  await utimes(normal, new Date(after), new Date(after));

  const until = dayStart(-5);
  const store = new EventStore();
  const result = await store.loadEvents(dir, { until });
  check(
    'an unjudgeable first line keeps the file (no data is dropped)',
    result.files_in_window === 4,
    `in window ${result.files_in_window} of 5 (run-normal is judgeable and late)`,
  );
  check(
    'the unjudgeable files are still covered',
    result.files_covered === 4 && result.files_truncated === false,
    `covered ${result.files_covered}, truncated ${result.files_truncated}`,
  );
  check(
    'the judgeable late run is the one that was dropped',
    result.files_in_window === result.files_covered &&
      !runIds(result.events).includes('run-normal'),
    runIds(result.events).join(','),
  );
}

// 23. The first-line cache is keyed by size/mtime: a file that changed is
//     re-peeked, so "authoritative" stays true after an append.
{
  const dir = await traceDir('peek-cache');
  const start = dayStart(-8) + 3_600_000;
  const file = sessionFile(dir, 'sess-grow');
  const first = lineAt('llm.request', 'run-grow', start);
  await writeSession(dir, 'sess-grow', first);
  // A run that started 8 days ago and is *still growing*: its mtime is recent
  // (after `until`), its first event is not — the case only a peek can judge.
  const grownOnce = dayStart(0) + 3_600_000;
  await utimes(file, new Date(grownOnce), new Date(grownOnce));

  const until = dayStart(-5);
  const store = new EventStore();
  const kept = await store.loadEvents(dir, { until });
  check(
    'a straddling file is peeked once and kept',
    kept.files_in_window === 1 && store.firstLinePeeks === 1,
    `in window ${kept.files_in_window}, peeks ${store.firstLinePeeks}`,
  );

  await appendFile(file, lineAt('llm.response', 'run-grow', grownOnce + 60_000));
  const grown = await store.loadEvents(dir, { until });
  check(
    'an appended file is re-peeked exactly once',
    store.firstLinePeeks === 2 && grown.files_in_window === 1,
    `peeks ${store.firstLinePeeks}, in window ${grown.files_in_window}`,
  );
}

// 24. Shipped defaults: Logs opens on the last 7 days ("all time" still one click
//     away), and the peek is not a heuristic — it reads the file's own first line.
{
  check(
    'the logs page opens on the last 7 days by default',
    logsSource.includes("const DEFAULT_RANGE: RangeValue = '7'") &&
      logsSource.includes('range: DEFAULT_RANGE'),
  );
  check(
    'all time is still offered as a preset',
    sharedSource.includes("id: '0'") && sharedSource.includes("id: '1'"),
  );
  const storeSource = await readFile(join(pluginRoot, 'src', 'store.ts'), 'utf8');
  check(
    'the peek is documented as an authoritative read, not a heuristic',
    storeSource.includes('**not** a heuristic') && storeSource.includes('dropAfterUntil'),
  );
  check(
    'the peek reads the head of the file only',
    storeSource.includes('FIRST_LINE_BYTES'),
  );
}

// 25. The first-line cache is not tied to the event-cache file cap: sizing it by
//     `maxCachedFiles` made every lookup evict the entry the next one needed
//     (measurably 466 peeks per call instead of 0 on the real directory).
{
  const dir = await traceDir('peek-cache-size');
  const starts = dayStart(-8);
  for (const [index, name] of ['run-s1', 'run-s2', 'run-s3', 'run-s4'].entries()) {
    // Recent mtime (after `until`), old first event: exactly the peek's job.
    await writeTrace(
      dir,
      name,
      lineAt('llm.request', name, starts + index * 1_000),
      dayStart(0) + 3_600_000,
    );
  }

  const until = dayStart(-5);
  const store = new EventStore({ ...DEFAULT_LIMITS, maxCachedFiles: 2 });
  await store.loadEvents(dir, { until });
  const first = store.firstLinePeeks;
  await store.loadEvents(dir, { until });
  check(
    'the peek cache is not bounded by the event-cache file cap',
    first === 4 && store.firstLinePeeks === 4,
    `peeks ${first} -> ${store.firstLinePeeks}`,
  );
}

// ── pairing, failed runs, persistent index ──────────────────────────────────

/**
 * Usage is folded from one place: the `llm.request` <-> `llm.response` pairing
 * (`buildRecords`). `run.completed.usage` is a run-level total that a retried run
 * would make us count twice, so it is only ever used to *check* the pairing.
 * These fixtures pin that, plus the two things the old trace reader got wrong for
 * Logs: a failed run must stay visible, and the persistent index must be a cache
 * that can always be rebuilt from the session logs.
 */

/** A session log line, as the host writes it (envelope + data). */
function sessionEvent(
  type: string,
  runId: string,
  ts: number,
  data: Record<string, unknown> = {},
  sessionId = 'session-x',
): string {
  return `${JSON.stringify({
    v: 1,
    session_id: sessionId,
    run_id: runId,
    seq: 0,
    ts,
    type,
    data: { run_id: runId, session_id: sessionId, ...data },
  })}\n`;
}

const USAGE_1 = { prompt_tokens: 1_000, completion_tokens: 100, cache_read_input_tokens: 400 };

// 26. Two attempts in one run: the pairing counts both, `run.completed` nothing.
{
  const usage = { usage: { prompt_tokens: 1_000, completion_tokens: 100, cache_read_input_tokens: 400 } };
  const events = buildRecords(
    [
      // attempt 1 (paired)
      rawEvent('llm.request', 'run-retry', BASE_TS, { model: MODEL }),
      rawEvent('llm.response', 'run-retry', BASE_TS + 1_400, usage),
      // attempt 2 (paired) — a retry, not a duplicate
      rawEvent('llm.request', 'run-retry', BASE_TS + 5_000, { model: MODEL, attempt: 2 }),
      rawEvent('llm.response', 'run-retry', BASE_TS + 6_400, usage),
    ],
    NO_PRICES,
  );
  check('two attempts produce two request records', events.length === 2, String(events.length));

  const runs = repriceRuns(buildRunSummaries(events), NO_PRICES);
  check(
    'the run sums its attempts once',
    runs.length === 1 && runs[0]?.requests === 2 && runs[0]?.prompt_tokens === 2_000,
    JSON.stringify(runs.map((run) => [run.requests, run.prompt_tokens])),
  );

  // `run.completed.usage` for the same run: used for validation only.
  const completed = completedUsages([
    rawEvent('run.completed', 'run-retry', BASE_TS + 9_000, {
      usage: { prompt_tokens: 2_000, completion_tokens: 200, cache_read_input_tokens: 800 },
      duration_ms: 9_000,
      iterations: 2,
    }),
  ]);
  const reference = completed.get('run-retry');
  check(
    'run.completed.usage is available as a pairing check, not as a total',
    reference?.prompt_tokens === 2_000 && reference?.completion_tokens === 200,
    JSON.stringify(reference),
  );
  check(
    'paired totals match run.completed.usage',
    runs[0]?.prompt_tokens === reference?.prompt_tokens &&
      runs[0]?.completion_tokens === reference?.completion_tokens &&
      runs[0]?.cache_read_input_tokens === reference?.cache_read_input_tokens,
    JSON.stringify([runs[0]?.prompt_tokens, runs[0]?.completion_tokens, runs[0]?.cache_read_input_tokens]),
  );
}

// 27. A failed run has no usage, but it is a row in Logs and a `failed_runs`
//     count in Summary — never a silent disappearance.
{
  const records = buildRecords(
    [
      ...pairAt('run-ok', BASE_TS),
      rawEvent('llm.request', 'run-broken', BASE_TS + 1_000, { model: MODEL }),
      rawEvent('run.failed', 'run-broken', BASE_TS + 2_000, { error: 'provider exploded' }),
    ],
    NO_PRICES,
  );
  check('a failed run becomes a record', records.length === 2, String(records.length));
  const failedRow = records.find((record) => record.status === 'failed');
  check(
    'the failed record has no counters',
    failedRow !== undefined &&
      failedRow.prompt_tokens === undefined &&
      failedRow.completion_tokens === undefined,
    JSON.stringify(failedRow),
  );

  const page = listLogs(records, { limit: 10 });
  check(
    'the failed run is visible in Logs',
    page.items.length === 2 && page.items.some((item) => item.status === 'failed'),
    page.items.map((item) => item.status).join(','),
  );
  const failedOnly = listLogs(records, { limit: 10, status: 'failed' });
  check(
    'the status filter can isolate the failed run',
    failedOnly.items.length === 1 && failedOnly.items[0]?.run_id === 'run-broken',
    failedOnly.items.map((item) => item.run_id).join(','),
  );

  const summary = summarizeRuns(repriceRuns(buildRunSummaries(records), NO_PRICES), BASE_TS);
  check(
    'a failed run adds to failed_runs but not to requests',
    summary.totals.requests === 1 && summary.totals.failed_runs === 1,
    JSON.stringify(summary.totals),
  );
  check(
    'a failed run contributes no tokens',
    summary.totals.prompt_tokens === 1_000,
    String(summary.totals.prompt_tokens),
  );
}

/** The fingerprint comparison `index.ts` makes, spelled once (shared helper). */
function sourceSignatureOf(sources: IndexSources | undefined): string {
  return sources === undefined ? 'none' : sourceSignature(sources);
}

// 28. The index is a cache: written, read back, invalidated by version or
//     corruption, and rebuilt (so a deleted session disappears) from the logs.
{
  const dir = await traceDir('usage-index');
  await writeSession(
    dir,
    'session-a',
    sessionEvent('llm.request', 'run-a', BASE_TS, { model: MODEL }) +
      sessionEvent('llm.response', 'run-a', BASE_TS + 1_400, { usage: USAGE_1 }),
  );
  await writeSession(
    dir,
    'session-b',
    sessionEvent('llm.request', 'run-b', BASE_TS + 60_000, { model: MODEL }) +
      sessionEvent('llm.response', 'run-b', BASE_TS + 61_400, { usage: USAGE_1 }),
  );

  const build = async () => {
    const store = new EventStore();
    const loaded = await store.loadEvents(dir);
    const runs = repriceRuns(buildRunSummaries(buildRecords(loaded.events, NO_PRICES)), NO_PRICES);
    const sources = await readSessionSources(dir);
    return { loaded, runs, sources };
  };

  const first = await build();
  check(
    'the index build covers every session',
    first.loaded.files_covered === 2 && first.runs.length === 2 && first.sources.files === 2,
    `${first.loaded.files_covered} sessions, ${first.runs.length} runs`,
  );
  await writeUsageIndex(dir, first.runs, first.sources);

  const readBack = await readUsageIndex(dir);
  check(
    'the index reads back with its version, header and run rows',
    readBack !== undefined &&
      readBack.header.v === USAGE_INDEX_VERSION &&
      readBack.header.generated_at > 0 &&
      readBack.header.sources.files === 2 &&
      readBack.runs.length === 2,
    JSON.stringify(readBack?.header),
  );
  check(
    'index rows keep the run totals',
    readBack?.runs.every((run) => run.requests === 1 && run.prompt_tokens === 1_000) === true,
  );
  check(
    'a stored index is only trusted when the session fingerprint matches',
    sourceSignatureOf(readBack?.header.sources) === sourceSignatureOf(await readSessionSources(dir)),
    `${sourceSignatureOf(readBack?.header.sources)} vs ${sourceSignatureOf(await readSessionSources(dir))}`,
  );

  // Version bump: the reader must treat the file as absent, not as data.
  const path = usageIndexPath(dir);
  const original = await readFile(path, 'utf8');
  const bumped = original.replace('"v":1', `"v":${USAGE_INDEX_VERSION + 1}`);
  await writeFile(path, bumped);
  check('a different format version is not an index', (await readUsageIndex(dir)) === undefined);

  // Corruption: one torn line invalidates the whole file (a torn file is torn).
  const torn = original.split('\n');
  torn[1] = '{"v":1,"kind":"run",';
  await writeFile(path, torn.join('\n'));
  check('a corrupt index line is not an index', (await readUsageIndex(dir)) === undefined);

  // A deleted session changes the fingerprint, so the index is not trusted…
  await writeUsageIndex(dir, first.runs, first.sources);
  await rm(join(dir, 'sessions', 'session-b'), { recursive: true, force: true });
  const afterDelete = await readSessionSources(dir);
  check(
    'a deleted session changes the fingerprint (so the index is stale)',
    sourceSignatureOf(afterDelete) !== sourceSignatureOf(first.sources) && afterDelete.files === 1,
    `${sourceSignatureOf(afterDelete)} vs ${sourceSignatureOf(first.sources)}`,
  );
  // …and a rebuild from the logs drops its runs: the index is never the truth.
  const rebuilt = await build();
  await writeUsageIndex(dir, rebuilt.runs, rebuilt.sources);
  const afterRebuild = await readUsageIndex(dir);
  check(
    'a rebuild drops the deleted session runs',
    rebuilt.runs.length === 1 &&
      rebuilt.runs[0]?.run_id === 'run-a' &&
      afterRebuild?.runs.length === 1,
    rebuilt.runs.map((run) => run.run_id).join(','),
  );
}

// 29. A session log spans days: the file-level mtime is only a sieve, the event
//     filter (and the first-line peek) is what keeps a range correct.
{
  const dir = await traceDir('cross-day-session');
  const yesterday = dayStart(-1) + 3_600_000;
  const today = dayStart(0) + 3_600_000;
  await writeSession(
    dir,
    'session-long',
    sessionEvent('llm.request', 'run-yday', yesterday, { model: MODEL }) +
      sessionEvent('llm.response', 'run-yday', yesterday + 1_400, { usage: USAGE_1 }) +
      sessionEvent('llm.request', 'run-today', today, { model: MODEL }) +
      sessionEvent('llm.response', 'run-today', today + 1_400, { usage: USAGE_1 }),
  );
  const file = sessionFile(dir, 'session-long');
  await utimes(file, new Date(today + 2_000), new Date(today + 2_000));

  const store = new EventStore();
  const day1 = await loadDays(store, dir, 1);
  check(
    'one session file, but only today is in the day window',
    day1.files_in_window === 1 && day1.events.length === 2 && day1.files_truncated === false,
    `${day1.files_in_window} files, ${day1.events.length} events`,
  );
  check(
    'the older run in the same session is filtered by event ts',
    runIds(day1.events).join(',') === 'run-today',
    runIds(day1.events).join(','),
  );

  // `until` on a session whose first event is before the bound: kept (the peek
  // says "this session starts before the range end"), and the range clamp then
  // happens per record in `listLogs` — the reader itself only needs a lower bound.
  const store2 = new EventStore();
  const until = dayStart(0);
  const bounded = await store2.loadEvents(dir, { until });
  check(
    'a session that straddles the range end is kept',
    bounded.files_in_window === 1 && bounded.files_truncated === false,
    `${bounded.files_in_window} files, truncated ${bounded.files_truncated}`,
  );
  const boundedRecords = buildRecords(bounded.events, NO_PRICES);
  const boundedPage = listLogs(boundedRecords, { limit: 10, until });
  check(
    'the range clamp happens on records, not on the file',
    boundedPage.items.length === 1 && boundedPage.items[0]?.run_id === 'run-yday',
    boundedPage.items.map((item) => item.run_id).join(','),
  );
}

// ── worker: off the event loop, and the fallback when there is none ─────────

/**
 * The reader + aggregation runs in a worker thread (worker.ts) so a few hundred
 * milliseconds of NDJSON parsing cannot freeze the thread that answers the
 * plugin's protocol. The same QueryRuntime code is the fallback for embedders
 * that cannot spawn a worker, so both paths must produce identical numbers; these
 * fixtures drive the real worker, a worker-less environment, the request queue
 * and the idle teardown.
 */
{
  const dir = await traceDir('worker');
  const base = dayStart(-2) + 3_600_000;
  await writeSession(
    dir,
    'session-w',
    sessionEvent('llm.request', 'run-w1', base, { model: MODEL }) +
      sessionEvent('llm.response', 'run-w1', base + 1_400, { usage: USAGE_1 }) +
      sessionEvent('llm.request', 'run-w2', base + 60_000, { model: MODEL }) +
      sessionEvent('llm.response', 'run-w2', base + 61_400, { usage: USAGE_1 }),
  );
  const init = { dataDir: dir, settings: NO_PRICES };

  // A worker that cannot start must not break the plugin: same answer, flagged.
  const broken = new WorkerQueryClient({
    spawn: () => {
      throw new Error('worker_threads unavailable in this host');
    },
  });
  const fromFallback = await broken.query({ kind: 'logs', params: { limit: 10 } }, init);
  check(
    'a worker that cannot start falls back to the main-thread path',
    fromFallback.worker === false &&
      fromFallback.outcome.result.kind === 'logs' &&
      fromFallback.outcome.result.dto.items.length === 2,
    JSON.stringify([fromFallback.worker, fromFallback.outcome.result.kind]),
  );
  const fallbackAgain = await broken.query({ kind: 'summary', now: NOW }, init);
  check(
    'the fallback keeps answering (it is a supported path, not an error state)',
    fallbackAgain.worker === false &&
      fallbackAgain.outcome.result.kind === 'summary' &&
      fallbackAgain.outcome.result.dto.totals.requests === 2,
    JSON.stringify(fallbackAgain.outcome.result.kind),
  );
  check('a broken worker factory leaves usingWorker false', broken.usingWorker === false);

  // The real thing.
  const client = new WorkerQueryClient();
  const first = await client.query({ kind: 'logs', params: { limit: 10 } }, init);
  check(
    'the real worker answers the query',
    first.worker === true &&
      first.outcome.result.kind === 'logs' &&
      first.outcome.result.dto.items.length === 2,
    JSON.stringify([first.worker, first.outcome.result.kind]),
  );
  check(
    'the answer carries the metrics the page needs',
    typeof first.outcome.source.duration_ms === 'number' && first.outcome.source.worker === undefined,
    JSON.stringify(first.outcome.source),
  );
  check('usingWorker reports the live thread', client.usingWorker === true);

  const second = await client.query({ kind: 'logs', params: { limit: 10 } }, init);
  check(
    'the second query is answered from the worker cache (zero event bytes)',
    second.worker === true && second.outcome.source.bytes_read === 0,
    String(second.outcome.source.bytes_read),
  );

  // Concurrency: three ranges at once. They queue, and every answer must be
  // scoped to its own range (no cache or result bleed between them).
  const cutoff3 = base + 30_000;
  const [all, recent, window] = await Promise.all([
    client.query({ kind: 'logs', params: { limit: 10 } }, init),
    client.query(
      { kind: 'logs', params: { limit: 10, since: cutoff3 }, cutoff: cutoff3 },
      init,
    ),
    client.query(
      {
        kind: 'logs',
        params: { limit: 10, since: base, until: cutoff3 },
        cutoff: base,
        until: cutoff3,
      },
      init,
    ),
  ]);
  const runIdsOfAnswer = (answer: typeof all): string[] => {
    if (answer.outcome.result.kind !== 'logs') return [];
    return answer.outcome.result.dto.items.map((item) => item.run_id).sort();
  };
  check(
    'three concurrent ranges all answer from the worker',
    all.worker && recent.worker && window.worker,
    JSON.stringify([all.worker, recent.worker, window.worker]),
  );
  check(
    'each concurrent range keeps its own rows',
    runIdsOfAnswer(all).join(',') === 'run-w1,run-w2' &&
      runIdsOfAnswer(recent).join(',') === 'run-w2' &&
      runIdsOfAnswer(window).join(',') === 'run-w1',
    JSON.stringify([runIdsOfAnswer(all), runIdsOfAnswer(recent), runIdsOfAnswer(window)]),
  );

  // Idle teardown must be invisible to the next request.
  await client.terminate();
  check('terminate drops the thread', client.usingWorker === false);
  const afterTerminate = await client.query({ kind: 'summary', now: NOW }, init);
  check(
    'a query after the thread is gone still answers',
    afterTerminate.outcome.result.kind === 'summary' &&
      afterTerminate.outcome.result.dto.totals.requests === 2,
    JSON.stringify(afterTerminate.outcome.result.kind),
  );
  await client.terminate();

  // The worker is only wired up once, in the plugin entry.
  const entrySource = await readFile(join(pluginRoot, 'src', 'index.ts'), 'utf8');
  const workerSource = await readFile(join(pluginRoot, 'src', 'worker.ts'), 'utf8');
  check(
    'the worker entry owns the runtime',
    workerSource.includes('new QueryRuntime()') &&
      workerSource.includes("kind: 'query'") &&
      workerSource.includes('parentPort'),
  );
  check(
    'the plugin entry routes every RPC through the worker client',
    entrySource.includes('WorkerQueryClient') &&
      entrySource.includes('queries.query(') &&
      !entrySource.includes('new EventStore('),
  );
  check(
    'the answer says whether a worker produced it',
    entrySource.includes('worker: answer.worker'),
  );
}

await rm(scratch, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
