/**
 * 压力路径 A：时间线**块写入 + crc32**（原生 vs 表驱动）。
 *
 * 造持续 100 MB/分钟级的 chunk 写入（一个 run 一个可追加块，块按 `blockKB` 封），每封一块
 * 算一次整块 crc32；结束时再用 `readAllBlocks` 把每块**重算一遍**（读侧那条 crc32）。
 *
 * 用法：
 *   bun scripts/crash-hunt/stress-a-blocks.ts [--seconds 300] [--block-kb 160]
 *
 * 隔离：数据只落在 `%TEMP%/crash-hunt/a-<impl>`，不碰 `~/.vessel`、不监听任何端口。
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32ActiveImplementation, readAllBlocks } from '../../packages/core/src/timeline/wal';
import { TimelineWriter } from '../../packages/core/src/timeline/writer';
import { rssMb, sampleLine, startSampler } from './_sampler';

function argValue(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const seconds = argValue('--seconds', 300);
const blockKB = argValue('--block-kb', 160);
const impl = crc32ActiveImplementation();
const verifyOnlyIndex = process.argv.indexOf('--verify-dir');
/** `--verify-dir <dir>`：只跑「读侧整块重算 crc32」，不写。同一份数据可以 A/B 两次。 */
const verifyOnlyDir = verifyOnlyIndex === -1 ? undefined : process.argv[verifyOnlyIndex + 1];
const sessionDir = verifyOnlyDir ?? join(tmpdir(), 'crash-hunt', `a-${impl}`);

const PAYLOAD_BYTES = 4 * 1024;
const payload = 'x'.repeat(PAYLOAD_BYTES);
/** 在飞窗口：块攒满才 fsync，串行 await 等于每条都等一次空闲封块。 */
const WINDOW = 128;

function percentileOf(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
}

/**
 * `--verify-dir <dir>`：只压**读侧**（每块整块重算 crc32），不写。
 *
 * 为什么单独留这一条：写侧每块的 crc 成本被「空闲封块 100ms」淹没，看不出来；
 * 读侧是「一份数据、一条 crc」，同一份目录 A/B 两次就能量出原生与表驱动的差。
 */
if (verifyOnlyDir !== undefined) {
  console.log('# path: A-verify (read-side whole-block crc32 only)');
  console.log(
    `# crc32 impl: ${impl} (VESSEL_CRC32_NATIVE=${process.env.VESSEL_CRC32_NATIVE ?? '<unset>'})`,
  );
  console.log(`# dir: ${sessionDir}`);
  const startedVerify = Date.now();
  const verifyBlocks = await readAllBlocks(sessionDir);
  const verifyElapsed = Date.now() - startedVerify;
  const badVerify = verifyBlocks.filter(
    (block) => block.decode.invalid.length > 0 || block.decode.torn,
  );
  let totalBytes = 0;
  for (const block of verifyBlocks) totalBytes += block.entry.bytes;
  const sizes = verifyBlocks.map((block) => block.entry.bytes);
  console.log(
    `# verify: ${verifyBlocks.length} blocks / ${(totalBytes / 1048576).toFixed(1)}MB ` +
      `in ${(verifyElapsed / 1000).toFixed(2)}s (bad=${badVerify.length})`,
  );
  console.log(
    `# block size p50=${(percentileOf(sizes, 0.5) / 1024).toFixed(0)}KB ` +
      `p99=${(percentileOf(sizes, 0.99) / 1024).toFixed(0)}KB`,
  );
  console.log(`# per block: ${(verifyElapsed / Math.max(1, verifyBlocks.length)).toFixed(2)}ms`);
  console.log(sampleLine(verifyElapsed, { phase: 'verify', impl }));
  console.log(badVerify.length === 0 ? '# RESULT: ok' : '# RESULT: FAILED');
  process.exit(badVerify.length === 0 ? 0 : 1);
}

await rm(sessionDir, { recursive: true, force: true });
await mkdir(sessionDir, { recursive: true });

console.log('# path: A (timeline block write + crc32)');
console.log(
  `# crc32 impl: ${impl} (VESSEL_CRC32_NATIVE=${process.env.VESSEL_CRC32_NATIVE ?? '<unset>'}, win32 缺省=table)`,
);
console.log(
  `# duration: ${seconds}s, block <= ${blockKB}KB, payload ${PAYLOAD_BYTES}B, window ${WINDOW}`,
);

const writer = await TimelineWriter.open({
  sessionId: 'stress-a',
  sessionDir,
  blockMaxBytes: blockKB * 1024,
  chunkFlushMs: 100,
});

const rssAtStart = rssMb();
const startedAt = Date.now();
const deadline = startedAt + seconds * 1000;
let writtenBytes = 0;
let seq = 0;
/** 只留最近一段的延迟：5 分钟全留会自己变成内存压力，读数就不可信了。 */
let latencies: number[] = [];
let failed = false;

const stopSampler = startSampler(() => ({ impl, phase: 'write', n: seq }));

try {
  let inflight: Array<Promise<void>> = [];
  while (Date.now() < deadline && !failed) {
    const at = performance.now();
    const index = seq;
    inflight.push(
      writer
        .append({
          run_id: 'run-stress-a',
          type: 'llm.stream.chunk',
          ts: Date.now(),
          data: { chunk: { type: 'text_delta', text: payload, index } },
        })
        .then(
          () => {
            latencies.push(performance.now() - at);
          },
          (error: unknown) => {
            failed = true;
            console.log(`# append rejected at seq=${index}: ${String(error)}`);
          },
        ),
    );
    writtenBytes += PAYLOAD_BYTES + 96;
    seq += 1;
    if (inflight.length >= WINDOW) {
      await Promise.all(inflight);
      inflight = [];
      if (latencies.length > 200_000) latencies = latencies.slice(-50_000);
    }
  }
  await Promise.all(inflight);
} catch (error) {
  failed = true;
  console.log(
    `# append threw at seq=${seq}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
stopSampler();

const writeMs = Date.now() - startedAt;
const rssAfterWrite = rssMb();
await writer.close();

console.log(
  `# write: ${seq} records, ${(writtenBytes / 1048576).toFixed(1)}MB in ${(writeMs / 1000).toFixed(0)}s ` +
    `(${(writtenBytes / 1048576 / (writeMs / 1000)).toFixed(2)} MB/s)`,
);
console.log(
  `# append latency p50=${percentileOf(latencies, 0.5).toFixed(2)}ms ` +
    `p95=${percentileOf(latencies, 0.95).toFixed(2)}ms ` +
    `p99=${percentileOf(latencies, 0.99).toFixed(2)}ms max=${percentileOf(latencies, 1).toFixed(2)}ms ` +
    `(n=${latencies.length})`,
);
console.log(`# rss: start=${rssAtStart.toFixed(1)}MB afterWrite=${rssAfterWrite.toFixed(1)}MB`);

// ── 读侧：每块整块重算 crc32（范围读/校验那条路） ────────────────────────
const verifyStartedAt = Date.now();
const blocks = await readAllBlocks(sessionDir);
// `readAllBlocks` 对**每一块**都重算一次整块 crc32（`crc32: crc32Hex(buffer)`），
// 所以这一趟就是读侧那条 crc32 的压力；坏帧 / 撕裂尾帧算失败。
const badBlocks = blocks.filter((block) => block.decode.invalid.length > 0 || block.decode.torn);
const verifyMs = Date.now() - verifyStartedAt;
let blockBytes = 0;
for (const block of blocks) blockBytes += block.entry.bytes;
const blockSizes = blocks.map((block) => block.entry.bytes);
console.log(
  `# verify: ${blocks.length} blocks / ${(blockBytes / 1048576).toFixed(1)}MB in ${(verifyMs / 1000).toFixed(2)}s ` +
    `(bad=${badBlocks.length})`,
);
console.log(
  `# block size p50=${(percentileOf(blockSizes, 0.5) / 1024).toFixed(0)}KB ` +
    `p99=${(percentileOf(blockSizes, 0.99) / 1024).toFixed(0)}KB`,
);
console.log(sampleLine(Date.now() - startedAt, { phase: 'done', impl }));

const ok = !failed && badBlocks.length === 0 && seq > 0;
console.log(ok ? '# RESULT: ok' : '# RESULT: FAILED');
process.exit(ok ? 0 : 1);
