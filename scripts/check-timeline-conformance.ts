/**
 * 0.54 A-1 自证：timeline 写入侧「逐条相等」。
 *
 * 这不是另一把尺子：期望集合**只**由 `scripts/timeline-reference.ts` 给出
 * （会话事件日志 ∪ run trace，按 `(run_id,type,ts)` + 逐键最大重数合并）。本脚本只做两件事：
 *
 * 1. 把同一批**原始 payload** 喂给 `TimelineWriter`（A 阶段新链路只写不读）；
 * 2. 把写回来的 timeline 用 `refEventFromRaw()` 归一化，调用 `multisetDiff()` 比较。
 *
 * 喂料规则（与参考提取器逐条对齐，避免“用尺子自己的选择喂自己”的循环论证：
 * 参考侧仍独立读磁盘并独立合并）：
 *
 * - 同一个 `(run_id,type,ts)` 桶，取条数多的一侧的**原始行**（相等取会话日志）；
 * - `run_id` 缺失的会话日志行按空串写入（读回时 `refEventFromRaw` 归一回 `null`）；
 * - `trace.*` / `replay.*` / `session.deleted` 两边同样排除（ADR-105 §8.1 规则 ④）；
 * - 原生 chunk 在两份旧源里实测为 0；chunk 覆盖由本脚本末尾的**合成会话**验证。
 *
 * 判据（缺一不合格）：
 *
 * ```
 * missing === 0
 * extra.filter(e => !isTimelineOnlyType(e.type)).length === 0
 * ```
 *
 * 用法：
 *   bun run scripts/check-timeline-conformance.ts
 *   bun run scripts/check-timeline-conformance.ts --data-dir C:/Users/Lirui/.vessel/data
 *   bun run scripts/check-timeline-conformance.ts --sessions <sid>[,<sid>]
 *   bun run scripts/check-timeline-conformance.ts --keep      # 保留临时 timeline 目录
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isChunkEventType, isExcludedEventType } from '../packages/core/src/timeline/types';
import { readTimelineEvents } from '../packages/core/src/timeline/wal';
import { TimelineWriter } from '../packages/core/src/timeline/writer';
import {
  DEFAULT_DATA_DIR,
  isTimelineOnlyType,
  loadSessionReference,
  multisetDiff,
  type RefEvent,
  refEventFromRaw,
  resolveDataDir,
  TIMELINE_ONLY_EVENT_TYPES,
} from './timeline-reference';

const SAMPLE_COUNT = 4;
const MAX_FIXTURE_EVENTS = 800;

let checkCount = 0;
let failureCount = 0;

function pass(name: string, detail = ''): void {
  checkCount += 1;
  console.log(`[PASS] ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string): void {
  checkCount += 1;
  failureCount += 1;
  console.log(`[FAIL] ${name} — ${detail}`);
}

function assertTrue(name: string, condition: boolean, detail = ''): void {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  assertTrue(name, actual === expected, `actual=${String(actual)} expected=${String(expected)}`);
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

interface Args {
  dataDir?: string;
  sessions: string[];
  workDir?: string;
  keep: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { sessions: [], keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--data-dir') {
      args.dataDir = argv[index + 1];
      index += 1;
    } else if (arg === '--sessions') {
      args.sessions = (argv[index + 1] ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      index += 1;
    } else if (arg === '--work-dir') {
      args.workDir = argv[index + 1];
      index += 1;
    } else if (arg === '--keep') {
      args.keep = true;
    }
  }
  return args;
}

async function readRows(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const rows: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // 尺子同样跳过坏行（只描述可解析事实）。
    }
  }
  return rows;
}

interface SessionScan {
  sid: string;
  logRows: number;
  runIds: string[];
  runsWithTrace: number;
}

async function scanSession(dataDir: string, sid: string): Promise<SessionScan> {
  const rows = await readRows(join(dataDir, 'sessions', encodeURIComponent(sid), 'events.ndjson'));
  const sawRun = new Set<string>();
  const runIds: string[] = [];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const runId = record.run_id;
    if (typeof runId !== 'string' || runId.length === 0 || sawRun.has(runId)) continue;
    sawRun.add(runId);
    runIds.push(runId);
  }
  let runsWithTrace = 0;
  for (const runId of runIds) {
    if (existsSync(join(dataDir, 'events', `${encodeURIComponent(runId)}.jsonl`))) {
      runsWithTrace += 1;
    }
  }
  return { sid, logRows: rows.length, runIds, runsWithTrace };
}

async function scanAllSessions(dataDir: string): Promise<SessionScan[]> {
  const entries = await readdir(join(dataDir, 'sessions'), { withFileTypes: true }).catch(
    () => undefined,
  );
  if (entries === undefined) return [];
  const scans: SessionScan[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sid = decodeURIComponent(entry.name);
    const scan = await scanSession(dataDir, sid);
    if (scan.logRows > 0) scans.push(scan);
  }
  return scans;
}

/** 只挑 trace 齐全、规模适中的会话，按规模升序（跑得快且差异可信）。 */
function pickSamples(scans: readonly SessionScan[]): SessionScan[] {
  const complete = scans.filter(
    (scan) => scan.runIds.length > 0 && scan.runsWithTrace === scan.runIds.length,
  );
  const small = complete
    .filter((scan) => scan.logRows <= MAX_FIXTURE_EVENTS)
    .sort((a, b) => a.logRows - b.logRows || compareText(a.sid, b.sid));
  const picked = small.slice(0, SAMPLE_COUNT);
  if (picked.length >= 3) return picked;
  const chosen = new Set(picked.map((scan) => scan.sid));
  const rest = complete
    .filter((scan) => !chosen.has(scan.sid))
    .sort((a, b) => a.logRows - b.logRows || compareText(a.sid, b.sid));
  for (const scan of rest) {
    if (picked.length >= SAMPLE_COUNT) break;
    picked.push(scan);
  }
  return picked;
}

interface RawRef {
  raw: Record<string, unknown>;
  ref: RefEvent;
}

/** 把原始行折成 `(raw, ref)`；形状不合约/排除类型都不进喂料。 */
function foldRows(rows: readonly unknown[]): RawRef[] {
  const out: RawRef[] = [];
  for (const row of rows) {
    const ref = refEventFromRaw(row);
    if (ref === undefined) continue;
    if (isExcludedEventType(ref.type)) continue;
    out.push({ raw: row as Record<string, unknown>, ref });
  }
  return out;
}

function bucketKey(event: RefEvent): string {
  return `${event.run_id ?? ''}|${event.type}|${event.ts}`;
}

function bucketize(rows: readonly RawRef[]): Map<string, RawRef[]> {
  const map = new Map<string, RawRef[]>();
  for (const row of rows) {
    const key = bucketKey(row.ref);
    const list = map.get(key);
    if (list === undefined) map.set(key, [row]);
    else list.push(row);
  }
  return map;
}

/**
 * 喂料：逐桶取条数多的一侧（相等取会话日志），与参考提取器的权威侧选择逐条一致。
 *
 * 参考侧仍然独立读磁盘；这里只是选择“哪些原始 payload 代表这个逻辑事件”。
 */
function mergeFeed(logRows: readonly RawRef[], traceRows: readonly RawRef[]): RawRef[] {
  const fromLog = bucketize(logRows);
  const fromTrace = bucketize(traceRows);
  const keys = new Set<string>([...fromLog.keys(), ...fromTrace.keys()]);
  const feed: RawRef[] = [];
  for (const key of [...keys].sort()) {
    const logBucket = fromLog.get(key) ?? [];
    const traceBucket = fromTrace.get(key) ?? [];
    const authority = logBucket.length >= traceBucket.length ? logBucket : traceBucket;
    feed.push(...authority);
  }
  return feed.sort((a, b) => {
    const runA = a.ref.run_id ?? '';
    const runB = b.ref.run_id ?? '';
    if (runA !== runB) return compareText(runA, runB);
    if (a.ref.type !== b.ref.type) return compareText(a.ref.type, b.ref.type);
    if (a.ref.ts !== b.ref.ts) return a.ref.ts - b.ref.ts;
    return compareText(a.ref.payload_digest, b.ref.payload_digest);
  });
}

function renderDiff(events: readonly RefEvent[], limit = 5): string {
  return events
    .slice(0, limit)
    .map((event) => `${event.run_id ?? '-'}|${event.type}|${event.ts}|${event.payload_digest}`)
    .join(' ; ');
}

async function runRealFixture(dataDir: string, workDir: string, scan: SessionScan): Promise<void> {
  const logRows = foldRows(
    await readRows(join(dataDir, 'sessions', encodeURIComponent(scan.sid), 'events.ndjson')),
  );
  const traceRows: RawRef[] = [];
  for (const runId of scan.runIds) {
    const rows = await readRows(join(dataDir, 'events', `${encodeURIComponent(runId)}.jsonl`));
    traceRows.push(...foldRows(rows));
  }
  const feed = mergeFeed(logRows, traceRows);

  const referenceRaw = await loadSessionReference(scan.sid, { dataDir });
  const excluded = referenceRaw.filter((event) => isExcludedEventType(event.type)).length;
  const reference = referenceRaw.filter((event) => !isExcludedEventType(event.type));

  const sessionDir = join(workDir, encodeURIComponent(scan.sid));
  const writer = await TimelineWriter.open({
    sessionId: scan.sid,
    sessionDir,
    chunkFlushMs: 50,
  });
  try {
    await writer.appendMany(
      feed.map((row) => ({
        run_id: row.ref.run_id ?? '',
        type: row.ref.type,
        ts: row.ref.ts,
        data: row.raw.data,
      })),
    );
    await writer.flush();
  } finally {
    await writer.close();
  }

  const records = await readTimelineEvents(sessionDir);
  const mine: RefEvent[] = [];
  for (const record of records) {
    const event = refEventFromRaw(record);
    if (event !== undefined) mine.push(event);
  }
  const diff = multisetDiff(reference, mine);
  const chunkExtra = diff.extra.filter((event) => isTimelineOnlyType(event.type));
  const nonChunkExtra = diff.extra.filter((event) => !isTimelineOnlyType(event.type));
  const coverage = `${scan.runsWithTrace}/${scan.runIds.length}`;

  console.log('');
  console.log(
    `session=${scan.sid} session_log_rows=${scan.logRows} events=${reference.length} runs=${scan.runIds.length} trace_coverage=${coverage}`,
  );
  console.log(
    `  fed=${feed.length} written=${records.length} excluded=${excluded} missing=${diff.missing.length} extra=${diff.extra.length} chunk_extra=${chunkExtra.length}`,
  );

  assertTrue(
    `A-1 ${scan.sid} trace 齐全`,
    scan.runsWithTrace === scan.runIds.length,
    `coverage=${coverage}`,
  );
  assertEqual(`A-1 ${scan.sid} 喂料条数 == 参考条数`, feed.length, reference.length);
  assertEqual(`A-1 ${scan.sid} missing`, diff.missing.length, 0);
  assertEqual(`A-1 ${scan.sid} 非 chunk extra`, nonChunkExtra.length, 0);
  if (diff.missing.length > 0) console.log(`  missing[0..5]: ${renderDiff(diff.missing)}`);
  if (nonChunkExtra.length > 0) console.log(`  extra[0..5]: ${renderDiff(nonChunkExtra)}`);
}

async function runSyntheticChunks(workDir: string): Promise<void> {
  const sessionDir = join(workDir, 'synthetic-chunks');
  const published: number[] = [];
  const writer = await TimelineWriter.open({
    sessionId: 'synthetic-chunks',
    sessionDir,
    chunkFlushMs: 25,
    publish: (record) => {
      published.push(record.seq);
    },
  });
  const inputs: Array<{ run_id: string; type: string; ts: number; data: unknown }> = [];
  const chunkTypes = ['llm.stream.chunk', 'sub.agent.llm.stream.chunk'];
  for (let index = 0; index < 240; index += 1) {
    if (index % 20 === 0) {
      inputs.push({
        run_id: 'run-1',
        type: 'tool.call.started',
        ts: index,
        data: { index, kind: 'fact' },
      });
    }
    inputs.push({
      run_id: 'run-1',
      type: chunkTypes[index % chunkTypes.length] ?? 'llm.stream.chunk',
      ts: index + 0.25,
      data: { index, delta: `chunk-${index}` },
    });
  }
  // 同时覆盖「超大 data 外置」：blob 必须先落盘、读回要逐字还原（ADR-105 §4）。
  inputs.push({
    run_id: 'run-1',
    type: 'tool.call.completed',
    ts: 10_000,
    data: { output: 'x'.repeat(1024 * 1024 + 32) },
  });
  try {
    const written = await writer.appendMany(inputs);
    await writer.flush();
    assertEqual('A-1 synthetic appendMany 返回条数', written.length, inputs.length);
  } finally {
    await writer.close();
  }

  const records = await readTimelineEvents(sessionDir);
  const expected = inputs
    .map((input) =>
      refEventFromRaw({ run_id: input.run_id, type: input.type, ts: input.ts, data: input.data }),
    )
    .filter((event): event is RefEvent => event !== undefined);
  const actual = records
    .map((record) => refEventFromRaw(record))
    .filter((event): event is RefEvent => event !== undefined);
  const diff = multisetDiff(expected, actual);

  const seqs = records.map((record) => record.seq);
  const strictlyIncreasing = seqs.every((seq, index) => seq === index + 1);
  const publishedMonotonic = published.every(
    (seq, index) => index === 0 || seq > (published[index - 1] ?? 0),
  );
  const chunkRecords = records.filter((record) => isChunkEventType(record.type));
  const chunkTypeSet = new Set(chunkRecords.map((record) => record.type));

  console.log('');
  console.log(
    `synthetic: events=${records.length} chunks=${chunkRecords.length} chunk_types=${[...chunkTypeSet].sort().join(',')}`,
  );

  assertEqual('A-1 synthetic missing', diff.missing.length, 0);
  assertEqual('A-1 synthetic extra', diff.extra.length, 0);
  assertTrue(
    'A-6 synthetic seq 严格升序且无空洞',
    strictlyIncreasing,
    `first=${seqs[0]} last=${seqs[seqs.length - 1]}`,
  );
  assertTrue('I2 synthetic publish 严格升序', publishedMonotonic, `published=${published.length}`);
  assertEqual('chunk 类型恰好两种', chunkTypeSet.size, 2);
  assertTrue(
    'chunk 类型 == 尺子白名单',
    [...chunkTypeSet].every((type) => isTimelineOnlyType(type)),
    [...chunkTypeSet].join(','),
  );

  // 白名单必须**恰好**两条：多一条、或写成“包含”都不合格。
  assertEqual('TIMELINE_ONLY_EVENT_TYPES 条数', TIMELINE_ONLY_EVENT_TYPES.length, 2);
  assertTrue(
    '白名单逐条 == 两条 chunk 形态',
    TIMELINE_ONLY_EVENT_TYPES.every(
      (gap) => gap.type === 'llm.stream.chunk' || gap.type === '*.llm.stream.chunk',
    ),
  );
  assertTrue(
    '核心 isChunkEventType 与尺子同口径',
    isChunkEventType('llm.stream.chunk') &&
      isChunkEventType('sub.agent.llm.stream.chunk') &&
      !isChunkEventType('llm.stream.chunk.extra'),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = resolveDataDir(args.dataDir);
  const workDir = args.workDir ?? (await mkdtemp(join(tmpdir(), 'vessel-timeline-conformance-')));
  console.log('0.54 A-1 conformance: timeline writer vs session-log+run-trace ruler');
  console.log(`data-dir: ${dataDir}  (default: ${DEFAULT_DATA_DIR})`);
  console.log(`work-dir: ${workDir}`);

  let scans: SessionScan[];
  if (args.sessions.length > 0) {
    scans = [];
    for (const sid of args.sessions) scans.push(await scanSession(dataDir, sid));
  } else {
    const all = await scanAllSessions(dataDir);
    console.log(`scanned sessions: ${all.length}`);
    scans = pickSamples(all);
  }
  if (scans.length === 0) {
    fail('fixtures', 'no fully trace-covered session found; pass --sessions explicitly');
  } else {
    console.log(`fixtures: ${scans.map((scan) => scan.sid).join(', ')}`);
    for (const scan of scans) {
      if (scan.logRows === 0) {
        fail(`fixture ${scan.sid}`, 'events.ndjson missing/empty');
        continue;
      }
      await runRealFixture(dataDir, workDir, scan);
    }
  }

  await runSyntheticChunks(workDir);

  if (!args.keep) {
    await rm(workDir, { recursive: true, force: true });
  } else {
    console.log(`kept work-dir: ${workDir}`);
  }

  console.log('');
  console.log(
    `RESULT: ${failureCount === 0 ? 'PASS' : 'FAIL'} (checks=${checkCount} failed=${failureCount})`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

await main();
