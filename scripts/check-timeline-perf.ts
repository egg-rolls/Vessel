/**
 * 0.54 A-5 自证：写入侧性能门槛（ADR-105 §11 A-5，plan-054 §1）。
 *
 * 三个数字，全部现场测量：
 *
 * 1. **chunk 发布延迟 P95 ≤ `chunk_flush_ms + 50ms`**（默认 150 → ≤200ms）；
 * 2. **单事件写放大 ≤ 旧链路 1.3×**（按 fsync 次数 / 事件计；非 chunk 路径是 1 fsync/事件，
 *    与旧 `SessionEventLog.append` 同口径；chunk 的 fsync 摊到整块）；
 * 3. **常驻内存增量 ≤ 30 MB**（对照旧 5 万条内存环；本写者只留索引数组，不留记录体）。
 *
 * 用法：`bun run scripts/check-timeline-perf.ts`
 *
 * 注意：**不许**为了延迟“先发布后落盘”（ADR-105 R6）。本脚本只调参数，不碰 I2。
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_FLUSH_MS, type TimelineSyncKind } from '../packages/core/src/timeline/types';
import { TimelineWriter } from '../packages/core/src/timeline/writer';

const NON_CHUNK_EVENTS = 300;
const CHUNK_EVENTS = 600;
const CHUNK_INTERVAL_MS = 2;
const P95_BUDGET_MS = CHUNK_FLUSH_MS + 50;
const AMPLIFICATION_BUDGET = 1.3;
const HEAP_BUDGET_MB = 30;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? Number.NaN;
}

async function main(): Promise<void> {
  const sessionDir = await mkdtemp(join(tmpdir(), 'vessel-timeline-perf-'));
  console.log('0.54 A-5 perf: publish latency / write amplification / resident memory');
  console.log(`session-dir: ${sessionDir}`);
  console.log(
    `chunk_flush_ms=${CHUNK_FLUSH_MS} p95_budget_ms=${P95_BUDGET_MS} amplification_budget=${AMPLIFICATION_BUDGET}x heap_budget_mb=${HEAP_BUDGET_MB}`,
  );

  const syncs: Record<string, number> = {};
  const sentAt = new Map<number, number>();
  const latencies: number[] = [];
  // 先强制 GC 再取基线：不把脚本自己（600 个 promise / 延迟数组）的瞬时分配算进写者。
  const gc = (Bun as unknown as { gc?: (force?: boolean) => void }).gc;
  gc?.(true);
  const before = process.memoryUsage();

  const writer = await TimelineWriter.open({
    sessionId: 'perf-fixture',
    sessionDir,
    publish: (record) => {
      if (record.type !== 'llm.stream.chunk') return;
      const id = (record.data as { index?: number }).index;
      if (typeof id !== 'number') return;
      const start = sentAt.get(id);
      if (start === undefined) return;
      latencies.push(performance.now() - start);
    },
    beforeSync: (kind: TimelineSyncKind) => {
      syncs[kind] = (syncs[kind] ?? 0) + 1;
    },
  });

  for (let index = 0; index < NON_CHUNK_EVENTS; index += 1) {
    await writer.append({
      run_id: 'run-1',
      type: 'tool.call.completed',
      ts: index,
      data: { index, result: 'ok' },
    });
  }

  const chunkAppends: Array<Promise<unknown>> = [];
  for (let index = 0; index < CHUNK_EVENTS; index += 1) {
    sentAt.set(index, performance.now());
    chunkAppends.push(
      writer.append({
        run_id: 'run-1',
        type: 'llm.stream.chunk',
        ts: NON_CHUNK_EVENTS + index,
        data: { index, delta: `delta-${index}` },
      }),
    );
    await delay(CHUNK_INTERVAL_MS);
  }
  await Promise.all(chunkAppends);
  await writer.flush();

  gc?.(true);
  const after = process.memoryUsage();
  const heads = writer.heads();
  const blockFiles = (await readdir(join(sessionDir, 'wal.blocks'))).filter((name) =>
    name.endsWith('.wblk'),
  );
  await writer.close();

  const p95 = percentile(latencies, 0.95);
  const nonChunkSyncs = syncs.wal ?? 0;
  const chunkSyncs = (syncs.block ?? 0) + (syncs.manifest ?? 0);
  const perNonChunkEvent = nonChunkSyncs / NON_CHUNK_EVENTS;
  const perAllEvent = (nonChunkSyncs + chunkSyncs) / (NON_CHUNK_EVENTS + CHUNK_EVENTS);
  const heapDeltaMb = (after.heapUsed - before.heapUsed) / (1024 * 1024);
  const rssDeltaMb = (after.rss - before.rss) / (1024 * 1024);

  console.log('');
  console.log(
    `latency_ms p50=${percentile(latencies, 0.5).toFixed(1)} p95=${p95.toFixed(1)} max=${Math.max(...latencies).toFixed(1)} samples=${latencies.length}`,
  );
  console.log(
    `fsyncs wal=${nonChunkSyncs} block=${syncs.block ?? 0} manifest=${syncs.manifest ?? 0} total=${nonChunkSyncs + chunkSyncs}`,
  );
  console.log(
    `amplification non_chunk_per_event=${perNonChunkEvent.toFixed(2)} all_per_event=${perAllEvent.toFixed(2)}`,
  );
  console.log(
    `memory_mb heap_delta=${heapDeltaMb.toFixed(2)} rss_delta=${rssDeltaMb.toFixed(2)} blocks=${blockFiles.length} wal_head=${heads.wal_head} tainted=${heads.tainted}`,
  );

  assertTrue(
    'A-5 chunk 发布延迟 P95',
    p95 <= P95_BUDGET_MS,
    `p95=${p95.toFixed(1)}ms budget=${P95_BUDGET_MS}ms`,
  );
  assertTrue(
    'A-5 非 chunk 写放大',
    perNonChunkEvent <= AMPLIFICATION_BUDGET,
    `fsync/event=${perNonChunkEvent.toFixed(2)} budget=${AMPLIFICATION_BUDGET}x (old SessionEventLog=1.00x)`,
  );
  assertTrue(
    'A-5 常驻内存增量',
    heapDeltaMb <= HEAP_BUDGET_MB,
    `heap_delta=${heapDeltaMb.toFixed(2)}MB budget=${HEAP_BUDGET_MB}MB`,
  );
  assertTrue(
    'A-5 全部事件可枚举',
    heads.wal_head === NON_CHUNK_EVENTS + CHUNK_EVENTS,
    `wal_head=${heads.wal_head}`,
  );

  await rm(sessionDir, { recursive: true, force: true });
  console.log('');
  console.log(
    `RESULT: ${failureCount === 0 ? 'PASS' : 'FAIL'} (checks=${checkCount} failed=${failureCount})`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

await main();
