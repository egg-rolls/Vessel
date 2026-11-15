/**
 * 0.54 A-3 自证：写失败必须落盘成「可声明的洞」，重启后仍可见。
 *
 * 判据（ADR-105 §3 I3 补充条款 / §7 A5）：
 *
 * 1. 模拟 WAL fsync 失败 → `append` 抛 `timeline_write_failed`；
 * 2. **重启后** `holes` 必含该区间、`tainted === true`、`wal_head` 覆盖该 seq；
 * 3. 失败 seq 不被复用：下一次 append 拿到 +1；
 * 4. 失败的事件**不能**同时以可读记录存在（半写行回滚）；
 * 5. `published_head` 跨重启不下降；
 * 6. chunk 块 fsync 失败同样落洞（块整段作废）。
 *
 * 用法：`bun run scripts/check-timeline-holes.ts`
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function covers(holes: ReadonlyArray<{ from_seq: number; to_seq: number }>, seq: number): boolean {
  return holes.some((hole) => seq >= hole.from_seq && seq <= hole.to_seq);
}

/** 场景一：非 chunk 的 WAL fsync 失败。 */
async function walFailure(workDir: string): Promise<void> {
  const sessionDir = join(workDir, 'wal-failure');
  let walSyncs = 0;
  const writer = await TimelineWriter.open({
    sessionId: 'wal-failure',
    sessionDir,
    beforeSync: (kind) => {
      if (kind !== 'wal') return;
      walSyncs += 1;
      if (walSyncs === 2) throw new Error('injected_wal_fsync_failure');
    },
  });
  await writer.append({ run_id: 'r1', type: 'a', ts: 1, data: { ok: true } });
  let threw = false;
  try {
    await writer.append({ run_id: 'r1', type: 'b', ts: 2, data: { lost: true } });
  } catch (error) {
    threw = /timeline_write_failed/.test(String(error));
  }
  const before = writer.heads();
  const publishedBefore = writer.publishedHead();
  await writer.close();

  assertTrue('I3 wal fsync 失败必须抛 timeline_write_failed', threw);
  assertTrue('I3 失败区间已登记成洞', covers(before.holes, 2), JSON.stringify(before.holes));
  assertEqual('I3 tainted', before.tainted, true);
  assertEqual('I3 wal_head 覆盖失败 seq', before.wal_head, 2);
  assertEqual('I3 timeline_head 不动', before.timeline_head, 0);

  const reopened = await TimelineWriter.open({ sessionId: 'wal-failure', sessionDir });
  const after = reopened.heads();
  const readable = (await reopened.readAll()).map((record) => record.seq);
  assertTrue('I3 重启后洞仍在', covers(after.holes, 2), JSON.stringify(after.holes));
  assertEqual('I3 重启后 tainted', after.tainted, true);
  assertEqual('I3 重启后 wal_head', after.wal_head, 2);
  assertEqual('I3 失败事件不可读（半写行已回滚）', readable.join(','), '1');
  assertTrue(
    'A5 published_head 跨重启不下降',
    reopened.publishedHead() >= publishedBefore,
    `before=${publishedBefore} after=${reopened.publishedHead()}`,
  );
  const next = await reopened.append({ run_id: 'r1', type: 'c', ts: 3, data: {} });
  assertEqual('I1 失败 seq 不复用', next.seq, 3);
  await reopened.close();
}

/** 场景二：chunk 块 fsync 失败；整段 chunk 必须作废并落洞。 */
async function chunkFailure(workDir: string): Promise<void> {
  const sessionDir = join(workDir, 'chunk-failure');
  const writer = await TimelineWriter.open({
    sessionId: 'chunk-failure',
    sessionDir,
    chunkFlushMs: 20,
    beforeSync: (kind) => {
      if (kind === 'block') throw new Error('injected_block_fsync_failure');
    },
  });
  const append = writer.append({
    run_id: 'r1',
    type: 'llm.stream.chunk',
    ts: 1,
    data: { delta: 'x' },
  });
  let threw = false;
  try {
    await append;
  } catch (error) {
    threw = /timeline_write_failed/.test(String(error));
  }
  const before = writer.heads();
  await writer.close();

  assertTrue('I3 chunk 块 fsync 失败必须拒绝 append', threw);
  assertTrue('I3 chunk 失败区间已登记成洞', covers(before.holes, 1), JSON.stringify(before.holes));
  assertEqual('I3 chunk tainted', before.tainted, true);
  assertEqual('I3 chunk wal_head 覆盖失败 seq', before.wal_head, 1);

  const reopened = await TimelineWriter.open({ sessionId: 'chunk-failure', sessionDir });
  const after = reopened.heads();
  const readable = (await reopened.readAll()).map((record) => record.seq);
  assertTrue('I3 chunk 重启后洞仍在', covers(after.holes, 1), JSON.stringify(after.holes));
  assertEqual('I3 chunk 失败事件不可读', readable.join(','), '');
  await reopened.close();
}

/**
 * 场景三：归档 manifest 无法落盘（磁盘满）。
 *
 * 归档失败**不写洞**（数据没丢，只是没搬进主段），但必须：`timelineHead` 不动、
 * `walHead` 照常、`tainted`、回调一次、重启后仍是这个状态（段文件里的半成品已回滚）。
 */
async function archiveFailure(workDir: string): Promise<void> {
  const sessionDir = join(workDir, 'archive-failure');
  let manifestSyncs = 0;
  const callbacks: string[] = [];
  const writer = await TimelineWriter.open({
    sessionId: 'archive-failure',
    sessionDir,
    beforeSync: (kind) => {
      if (kind !== 'manifest') return;
      manifestSyncs += 1;
      // 4 次归档尝试都失败；第 5 次是失败后写 tainted 行，必须成功（否则重启无法自证污点）。
      if (manifestSyncs <= 4) throw new Error('injected_archive_fsync_failure');
    },
    onArchiveFailed: (info) => callbacks.push(JSON.stringify(info)),
  });
  await writer.appendMany([
    { run_id: 'r1', type: 'a', ts: 1, data: {} },
    { run_id: 'r1', type: 'b', ts: 2, data: {} },
  ]);
  const result = await writer.archive();
  const before = writer.heads();
  await writer.close();

  assertEqual('I3 归档失败返回 ok=false', result.ok, false);
  assertEqual('I3 归档失败 timeline_head 不动', before.timeline_head, 0);
  assertEqual('I3 归档失败 wal_head 照常', before.wal_head, 2);
  assertEqual('I3 归档失败不写洞', before.holes.length, 0);
  assertEqual('I3 归档失败 tainted', before.tainted, true);
  assertEqual('I3 归档失败回调一次', callbacks.length, 1);

  const reopened = await TimelineWriter.open({ sessionId: 'archive-failure', sessionDir });
  const after = reopened.heads();
  const readable = (await reopened.readAll()).map((record) => record.seq);
  assertEqual('I3 归档失败重启后 timeline_head 仍不动', after.timeline_head, 0);
  assertEqual('I3 归档失败重启后 tainted', after.tainted, true);
  assertEqual('I3 归档失败数据仍可读', readable.join(','), '1,2');
  await reopened.close();
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'vessel-timeline-holes-'));
  console.log('0.54 A-3 holes: fsync failure must be declarable after restart');
  console.log(`work-dir: ${workDir}`);
  await walFailure(workDir);
  await chunkFailure(workDir);
  await archiveFailure(workDir);
  await rm(workDir, { recursive: true, force: true });
  console.log('');
  console.log(
    `RESULT: ${failureCount === 0 ? 'PASS' : 'FAIL'} (checks=${checkCount} failed=${failureCount})`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

await main();
