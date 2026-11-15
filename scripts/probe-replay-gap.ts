#!/usr/bin/env bun
/**
 * probe-replay-gap.ts — offline repro of "after refresh, this run's events drop to N".
 *
 * No gates, no writes to the default data dir, no network. Reads one session dir only:
 *   <base>/<session_id>/events.ndjson   (on-disk event log = single source of truth)
 *   <base>/<session_id>/index.json      (derived_upto_seq = last seq covered by the projection)
 *
 * Models exactly the data sources the web frontend actually uses:
 *   1) persisted side: sessions.get.messages = a MESSAGE PROJECTION derived from events with
 *      seq <= derived_upto_seq. It never reads events.ndjson itself; mid-run derived_upto_seq
 *      is frozen at the run start (first turn = 4).
 *   2) replay side: events.subscribe{since:0} over the in-process ring (structure + chunks that
 *      are never persisted). Default 'restart' mode models "gateway restarted / ring evicted"
 *      = empty ring. '--window' mode uses the REAL packages/serve/src/replay-budget.ts budget
 *      function over a source that may be chunk-saturated / prefix-evicted, then checks whether
 *      run.started is still inside the replay window.
 *   3) disk-backfill side: sessions.events(since_seq=derived_upto_seq) reads events.ndjson
 *      directly — proving these events ARE on disk and ARE retrievable via RPC, only the web
 *      never calls it.
 *
 * Output: should-be N / actual M / which seqs are lost, and asserts lost subset-of disk-recoverable.
 *
 * Usage:
 *   bun run scripts/probe-replay-gap.ts
 *   bun run scripts/probe-replay-gap.ts --session <id>
 *   bun run scripts/probe-replay-gap.ts --dir <session_dir>
 *   bun run scripts/probe-replay-gap.ts --window --drop-prefix 1 --chunks-per-structure 7
 *   bun run scripts/probe-replay-gap.ts --selftest
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  isStructureEvent,
  replayBudgetUnitsOf,
  selectReplayBudgetWindow,
} from '../packages/serve/src/replay-budget.ts';

interface DiskEvent {
  seq: number;
  type: string;
  ts?: number;
  data?: unknown;
  run_id?: string;
}

interface IndexInfo {
  derived_upto_seq?: number;
  status?: string;
  event_count?: number;
}

interface Argv {
  base: string;
  session?: string;
  dir?: string;
  window: boolean;
  dropPrefix: number;
  chunksPerStructure: number;
  selftest: boolean;
  json: boolean;
}

// bun is the Windows build: it cannot stat /mnt/c WSL paths. Use the Windows path form.
// Override with --base or the VESSEL_SESSIONS_DIR env var if your data dir differs.
const DEFAULT_BASE =
  process.env.VESSEL_SESSIONS_DIR ?? 'C:/Users/Lirui/.vessel/data/sessions';

function toInt(v: string | undefined): number {
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n)) throw new Error('not an integer: ' + String(v));
  return n;
}

function parseArgs(argv: string[]): Argv {
  const out: Argv = {
    base: DEFAULT_BASE,
    window: false,
    dropPrefix: 0,
    chunksPerStructure: 7,
    selftest: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--base':
        i += 1;
        out.base = argv[i] ?? out.base;
        break;
      case '--session':
        i += 1;
        out.session = argv[i];
        break;
      case '--dir':
        i += 1;
        out.dir = argv[i];
        break;
      case '--window':
        out.window = true;
        break;
      case '--drop-prefix':
        i += 1;
        out.dropPrefix = toInt(argv[i]);
        break;
      case '--chunks-per-structure':
        i += 1;
        out.chunksPerStructure = toInt(argv[i]);
        break;
      case '--selftest':
        out.selftest = true;
        break;
      case '--json':
        out.json = true;
        break;
      default:
        break;
    }
  }
  return out;
}

function readEvents(dir: string): DiskEvent[] {
  const file = join(dir, 'events.ndjson');
  const text = readFileSync(file, 'utf8');
  const rows: DiskEvent[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const j = JSON.parse(t) as DiskEvent;
      if (typeof j.seq === 'number' && typeof j.type === 'string') rows.push(j);
    } catch {
      // skip corrupt / truncated lines
    }
  }
  rows.sort((a, b) => a.seq - b.seq);
  return rows;
}

function readIndex(dir: string): IndexInfo {
  const file = join(dir, 'index.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as IndexInfo;
  } catch {
    return {};
  }
}

function pickDefaultSession(base: string): string | undefined {
  if (!existsSync(base)) return undefined;
  const names = readdirSync(base);
  let best: { id: string; mtime: number; running: boolean } | undefined;
  for (const id of names) {
    const d = join(base, id);
    const ev = join(d, 'events.ndjson');
    if (!existsSync(ev)) continue;
    try {
      if (!statSync(d).isDirectory()) continue;
      const idx = readIndex(d);
      const mtime = statSync(ev).mtimeMs;
      const running = idx.status === 'running';
      if (best === undefined || (running && !best.running) || (running === best.running && mtime > best.mtime)) {
        best = { id, mtime, running };
      }
    } catch {
      // ignore
    }
  }
  return best === undefined ? undefined : best.id;
}

interface RingCoverage {
  coveredSeqs: Set<number>;
  hasRunStart: boolean;
  keptEvents: number;
  droppedEvents: number;
  droppedStructureEvents: number;
  floorTruncated: boolean;
}

function ringCoverage(rows: DiskEvent[], args: Argv): RingCoverage {
  const kept = rows.slice(args.dropPrefix);
  const source: { type: string; bytes: number; realSeq: number }[] = [];
  for (const r of kept) {
    for (let c = 0; c < args.chunksPerStructure; c += 1) {
      source.push({ type: 'llm.stream.chunk', bytes: 200, realSeq: -1 });
    }
    source.push({ type: r.type, bytes: JSON.stringify(r).length, realSeq: r.seq });
  }
  const units = replayBudgetUnitsOf(source.map((s) => ({ type: s.type, bytes: s.bytes })));
  const sel = selectReplayBudgetWindow(units);
  const coveredSeqs = new Set<number>();
  let hasRunStart = false;
  if (sel.startIndex >= 0) {
    for (let i = sel.startIndex; i < source.length; i += 1) {
      const s = source[i];
      if (s === undefined || s.realSeq < 0) continue;
      coveredSeqs.add(s.realSeq);
      if (s.type === 'run.started') hasRunStart = true;
    }
  }
  return {
    coveredSeqs,
    hasRunStart,
    keptEvents: sel.keptEvents,
    droppedEvents: sel.droppedEvents,
    droppedStructureEvents: sel.droppedStructureEvents,
    floorTruncated: sel.floorTruncated,
  };
}

interface Analysis {
  session: string;
  status: string;
  diskSeqFirst: number;
  diskSeqLast: number;
  diskCount: number;
  derivedUpto: number;
  runStartSeq: number;
  runCount: number;
  shouldBe: number;
  actual: number;
  lostSeqs: number[];
  lostStructure: number;
  diskRecoverableCount: number;
  lostIsSubsetOfDisk: boolean;
  projectionCount: number;
  ringCount: number;
  diskTypeCounts: Record<string, number>;
  ring?: RingCoverage;
}

function analyze(session: string, rows: DiskEvent[], index: IndexInfo, args: Argv): Analysis {
  const first = rows.length > 0 ? (rows[0] as DiskEvent).seq : 0;
  const D = typeof index.derived_upto_seq === 'number' ? index.derived_upto_seq : 0;
  let runStart = first;
  for (const r of rows) if (r.type === 'run.started') runStart = r.seq;

  const ring = args.window ? ringCoverage(rows, args) : undefined;

  const recoverable = new Set<number>();
  let projectionCount = 0;
  for (const r of rows) {
    if (r.seq <= D) {
      recoverable.add(r.seq);
      projectionCount += 1;
    }
  }
  if (ring) for (const s of ring.coveredSeqs) recoverable.add(s);

  const lostSeqs: number[] = [];
  let lostStructure = 0;
  for (const r of rows) {
    if (!recoverable.has(r.seq)) {
      lostSeqs.push(r.seq);
      if (isStructureEvent(r.type)) lostStructure += 1;
    }
  }

  const diskRecoverable = rows.filter((r) => r.seq > D).map((r) => r.seq);
  const diskSet = new Set(diskRecoverable);
  const lostIsSubsetOfDisk = lostSeqs.every((s) => diskSet.has(s));

  const diskTypeCounts: Record<string, number> = {};
  for (const r of rows) diskTypeCounts[r.type] = (diskTypeCounts[r.type] ?? 0) + 1;

  return {
    session,
    status: typeof index.status === 'string' ? index.status : '?',
    diskSeqFirst: first,
    diskSeqLast: rows.length > 0 ? (rows[rows.length - 1] as DiskEvent).seq : 0,
    diskCount: rows.length,
    derivedUpto: D,
    runStartSeq: runStart,
    runCount: rows.filter((r) => r.seq >= runStart).length,
    shouldBe: rows.length,
    actual: rows.filter((r) => recoverable.has(r.seq)).length,
    lostSeqs,
    lostStructure,
    diskRecoverableCount: diskRecoverable.length,
    lostIsSubsetOfDisk,
    projectionCount,
    ringCount: ring ? ring.coveredSeqs.size : 0,
    diskTypeCounts,
    ring,
  };
}

function sample(seqs: number[], max: number): string {
  if (seqs.length <= max) return JSON.stringify(seqs);
  return JSON.stringify(seqs.slice(0, max)) + ' ... (+' + (seqs.length - max) + ')';
}

function printReport(a: Analysis, args: Argv): void {
  const mode = args.window
    ? 'window(dropPrefix=' + args.dropPrefix + ', chunks/structure=' + args.chunksPerStructure + ')'
    : 'restart(empty ring)';
  const lines: string[] = [];
  lines.push('==================== probe-replay-gap ====================');
  lines.push('session        : ' + a.session);
  lines.push('status         : ' + a.status);
  lines.push('disk events    : seq ' + a.diskSeqFirst + '..' + a.diskSeqLast + '  (' + a.diskCount + ' events)');
  lines.push('derived_upto   : ' + String(a.derivedUpto) + '   (projection covered up to this seq = what message side can rebuild)');
  lines.push('run.started@   : ' + String(a.runStartSeq) + '   (this run start; run events ' + a.runCount + ')');
  lines.push('frontend mode  : ' + mode);
  lines.push('----------------------------------------------------------');
  lines.push('should-be N    : ' + String(a.shouldBe) + '   (all session events on disk)');
  lines.push('actual   M     : ' + String(a.actual) + '   (rebuildable: projection ' + a.projectionCount + (args.window ? ' + ring ' + a.ringCount : ' + ring 0 (empty)') + ')');
  lines.push('lost     K     : ' + String(a.lostSeqs.length) + '   seq = ' + sample(a.lostSeqs, 12));
  lines.push('  structure    : ' + a.lostStructure + ' lost (run.* / tool.* / session.* / ask.* / limit.* / error ...)');
  lines.push('  disk-backfill: ' + a.diskRecoverableCount + ' recoverable via sessions.events(since_seq=' + a.derivedUpto + ')');
  lines.push('lost subset disk: ' + (a.lostIsSubsetOfDisk ? 'YES  => data is on disk, lost only in the pipe' : 'NO   => disk also missing, check write side'));
  const typeList = Object.keys(a.diskTypeCounts)
    .sort()
    .map((t) => t + '=' + a.diskTypeCounts[t])
    .join(', ');
  lines.push('disk types     : ' + typeList);
  if (a.ring) {
    lines.push('----------------------------------------------------------');
    lines.push('ring window    : kept=' + a.ring.keptEvents + ' dropped=' + a.ring.droppedEvents + ' droppedStructure=' + a.ring.droppedStructureEvents + ' floorTruncated=' + a.ring.floorTruncated);
    lines.push('  run.started   : ' + (a.ring.hasRunStart ? 'inside window: YES' : 'inside window: NO  => client grouping loses the run start'));
  }
  lines.push('==========================================================');
  console.log(lines.join('\n'));
  if (args.json) console.log(JSON.stringify(a));
}

function selftest(): boolean {
  const rows: DiskEvent[] = [];
  const head = ['session.created', 'run.started', 'message.injected', 'user.message'];
  for (let i = 0; i < head.length; i += 1) rows.push({ seq: i + 1, type: head[i] as string });
  const runTypes = [
    'prompt.system_context', 'llm.request', 'llm.stream.summary', 'llm.response',
    'tool.call.started', 'tool.call.completed', 'llm.request', 'llm.response',
    'tool.call.started', 'tool.call.completed', 'run.completed',
  ];
  for (let i = 0; i < runTypes.length; i += 1) rows.push({ seq: 5 + i, type: runTypes[i] as string });

  const args: Argv = { base: '', window: false, dropPrefix: 0, chunksPerStructure: 7, selftest: false, json: false };
  const a = analyze('selftest', rows, { derived_upto_seq: 4, status: 'running' }, args);
  const pass =
    a.shouldBe === 15 &&
    a.actual === 4 &&
    a.lostSeqs.length === 11 &&
    a.lostSeqs[0] === 5 &&
    a.lostSeqs[a.lostSeqs.length - 1] === 15 &&
    a.lostIsSubsetOfDisk === true &&
    a.diskRecoverableCount === 11;
  console.log('[selftest] restart: should=' + a.shouldBe + ' actual=' + a.actual + ' lost=' + a.lostSeqs.length + ' backfill=' + a.diskRecoverableCount + ' -> ' + (pass ? 'PASS' : 'FAIL'));

  const wArgs: Argv = { base: '', window: true, dropPrefix: 2, chunksPerStructure: 200, selftest: false, json: false };
  const w = analyze('selftest-window', rows, { derived_upto_seq: 4, status: 'running' }, wArgs);
  const wPass = w.ring !== undefined && w.ring.hasRunStart === false;
  console.log('[selftest] window : run.started-in-window=' + String(w.ring === undefined ? '?' : w.ring.hasRunStart) + ' droppedStructure=' + String(w.ring === undefined ? '?' : w.ring.droppedStructureEvents) + ' lost=' + w.lostSeqs.length + ' -> ' + (wPass ? 'PASS' : 'FAIL'));

  return pass && wPass;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) {
    process.exit(selftest() ? 0 : 1);
  }
  let dir = args.dir;
  let session = args.session ?? '';
  if (dir === undefined) {
    const id = args.session ?? pickDefaultSession(args.base);
    if (id === undefined) {
      console.error('no session dir found (--base=' + args.base + ')');
      process.exit(2);
    }
    session = id;
    dir = join(args.base, id);
  } else {
    session = session === '' ? dir : session;
  }
  if (!existsSync(join(dir, 'events.ndjson'))) {
    console.error('session has no events.ndjson: ' + dir);
    process.exit(2);
  }
  const rows = readEvents(dir);
  const index = readIndex(dir);
  const a = analyze(session, rows, index, args);
  printReport(a, args);
  process.exit(a.lostSeqs.length > 0 ? 1 : 0);
}

main();
