/**
 * 0.54 A-3 自证：索引可重建、可损坏、且永不成为事实源（ADR-105 §5）。
 *
 * 四条断言：
 *
 * 1. 删掉整个 `timeline.idx/` → 重建 → 同一查询结果逐条相等；
 * 2. `rebuild` 两次 → 索引文件**字节相同**（确定性，无时间戳/哈希顺序抖动）；
 * 3. 把 `run.idx` / `type.idx` 写成假区间 → 读结果不变（逐条校验后回退全扫），
 *    并发 `timeline.index_mismatch`；
 * 4. 正常读取不触发 mismatch（证明索引确实被使用，而不是永远全扫）。
 *
 * 用法：`bun run scripts/check-timeline-index.ts`
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rebuildIndexFiles,
  TimelineIndexReader,
  writeIndexSnapshot,
} from '../packages/core/src/timeline/index';
import { TimelineWriter } from '../packages/core/src/timeline/writer';

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

const RUN_IDS = ['run-A', 'run-B', 'run-C'];
const TYPE_IDS = ['type-a', 'type-b', 'type-c'];

interface QuerySnapshot {
  runs: Record<string, string>;
  types: Record<string, string>;
}

function takeSnapshot(reader: TimelineIndexReader): QuerySnapshot {
  const runs: Record<string, string> = {};
  const types: Record<string, string> = {};
  for (const runId of RUN_IDS) {
    runs[runId] = reader
      .readByRun(runId)
      .map((record) => `${record.seq}:${record.type}`)
      .join(',');
  }
  for (const type of TYPE_IDS) {
    types[type] = reader
      .readByType(type)
      .map((record) => `${record.seq}:${record.run_id}`)
      .join(',');
  }
  return { runs, types };
}

function sameSnapshot(name: string, a: QuerySnapshot, b: QuerySnapshot): void {
  for (const runId of RUN_IDS) {
    assertEqual(`${name} run=${runId}`, b.runs[runId], a.runs[runId]);
  }
  for (const type of TYPE_IDS) {
    assertEqual(`${name} type=${type}`, b.types[type], a.types[type]);
  }
}

interface IndexBytes {
  session: Buffer;
  run: Buffer;
  type: Buffer;
}

async function indexBytes(sessionDir: string): Promise<IndexBytes> {
  return {
    session: await readFile(join(sessionDir, 'timeline.idx', 'session.idx')),
    run: await readFile(join(sessionDir, 'timeline.idx', 'run.idx')),
    type: await readFile(join(sessionDir, 'timeline.idx', 'type.idx')),
  };
}

function sameBytes(name: string, a: IndexBytes, b: IndexBytes): void {
  for (const key of ['session', 'run', 'type'] as const) {
    assertTrue(
      `${name} ${key}.idx 字节相同`,
      Buffer.compare(a[key], b[key]) === 0,
      `bytes=${a[key].length}`,
    );
  }
}

async function main(): Promise<void> {
  const sessionDir = await mkdtemp(join(tmpdir(), 'vessel-timeline-index-'));
  console.log('0.54 A-3 index: rebuildable / tamper-proof / deterministic');
  console.log(`session-dir: ${sessionDir}`);

  const writer = await TimelineWriter.open({
    sessionId: 'index-fixture',
    sessionDir,
    chunkFlushMs: 20,
  });
  await writer.appendMany([
    { run_id: 'run-A', type: 'type-a', ts: 1, data: { n: 1 } },
    { run_id: 'run-A', type: 'type-a', ts: 2, data: { n: 2 } },
    { run_id: 'run-A', type: 'type-b', ts: 3, data: { n: 3 } },
    { run_id: 'run-B', type: 'type-b', ts: 4, data: { n: 4 } },
    { run_id: 'run-B', type: 'type-c', ts: 5, data: { n: 5 } },
    { run_id: 'run-C', type: 'type-a', ts: 6, data: { n: 6 } },
  ]);
  await writer.append({ run_id: 'run-A', type: 'llm.stream.chunk', ts: 7, data: { d: 'x' } });
  await writer.append({ run_id: 'run-C', type: 'type-c', ts: 8, data: { n: 8 } });
  // 归档后再查询：证明「timeline ∪ WAL」的读法在 timeline_head 前进后仍逐条相同。
  const archive = await writer.archive();
  assertTrue('归档成功', archive.ok);
  assertEqual(
    '归档后 timeline_head == wal_head',
    writer.heads().timeline_head,
    writer.heads().wal_head,
  );
  await writer.flush();
  await writer.close();

  let mismatches = 0;
  const reader1 = await TimelineIndexReader.open(sessionDir, {
    onMismatch: () => {
      mismatches += 1;
    },
  });
  const snapshot1 = takeSnapshot(reader1);
  assertEqual('正常读取不触发 mismatch', mismatches, 0);
  assertTrue(
    '索引确实含三类条目',
    reader1.currentSnapshot().runs.size === 3 && reader1.currentSnapshot().types.size > 0,
    `runs=${reader1.currentSnapshot().runs.size} types=${reader1.currentSnapshot().types.size}`,
  );
  const bytesBefore = await indexBytes(sessionDir);

  await rm(join(sessionDir, 'timeline.idx'), { recursive: true, force: true });
  const reader2 = await TimelineIndexReader.open(sessionDir);
  const snapshot2 = takeSnapshot(reader2);
  sameSnapshot('删索引重建后', snapshot1, snapshot2);
  const bytesRebuilt = await indexBytes(sessionDir);
  sameBytes('删索引重建后', bytesBefore, bytesRebuilt);

  await rebuildIndexFiles(sessionDir);
  const bytesAgain = await indexBytes(sessionDir);
  sameBytes('rebuild 两次', bytesRebuilt, bytesAgain);

  // 篡改 run.idx：把 run-A 的区间扩大到 run-B 的 seq（3 → 5）。
  const tamperedSnapshot = reader2.currentSnapshot();
  const runARanges = tamperedSnapshot.runs.get('run-A') ?? [];
  const firstRange = runARanges[0];
  if (firstRange !== undefined) firstRange.end_seq = 5;
  await writeIndexSnapshot(sessionDir, tamperedSnapshot);
  let runMismatches = 0;
  const reader3 = await TimelineIndexReader.open(sessionDir, {
    onMismatch: () => {
      runMismatches += 1;
    },
  });
  const runAfterTamper = reader3.readByRun('run-A');
  const expectedRunA = snapshot1.runs['run-A'];
  assertEqual(
    '篡改 run.idx 后读结果不变',
    runAfterTamper.map((record) => `${record.seq}:${record.type}`).join(','),
    expectedRunA,
  );
  assertTrue('篡改 run.idx 触发 index_mismatch', runMismatches > 0, `count=${runMismatches}`);

  // 篡改 type.idx：把 type-a 的 seq 列表塞进一条 type-b 的 seq。
  const typeTampered = reader3.currentSnapshot();
  const typeASeqs = typeTampered.types.get('type-a') ?? [];
  typeASeqs.push(3);
  await writeIndexSnapshot(sessionDir, typeTampered);
  let typeMismatches = 0;
  const reader4 = await TimelineIndexReader.open(sessionDir, {
    onMismatch: () => {
      typeMismatches += 1;
    },
  });
  assertEqual(
    '篡改 type.idx 后读结果不变',
    reader4
      .readByType('type-a')
      .map((record) => `${record.seq}:${record.run_id}`)
      .join(','),
    snapshot1.types['type-a'],
  );
  assertTrue('篡改 type.idx 触发 index_mismatch', typeMismatches > 0, `count=${typeMismatches}`);

  await rm(sessionDir, { recursive: true, force: true });
  console.log('');
  console.log(
    `RESULT: ${failureCount === 0 ? 'PASS' : 'FAIL'} (checks=${checkCount} failed=${failureCount})`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

await main();
