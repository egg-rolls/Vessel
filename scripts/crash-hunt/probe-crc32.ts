/**
 * 探针：Bun 的 `node:zlib` crc32 在 Windows 上到底可不可信 / 会不会崩。
 *
 * 三问（对应 wal.ts 的 `nativeCrc32` 缝）：
 * 1. 结果对不对：与表驱动逐位相同？**分包视图（byteOffset ≠ 0）也对吗？**
 *    这一条最要紧 —— 块缓冲是 `Buffer.concat` / `subarray` 出来的，
 *    原生实现若忽略 byteOffset，块 crc 会算错一块「末尾之外」的字节。
 * 2. 空输入 / 1 字节 / 奇数长度会不会炸。
 * 3. 高频大缓冲调用会不会把进程打死（1e4 次 × 159KB + GC 压力）。
 *
 * 跑法：`bun scripts/crash-hunt/probe-crc32.ts`
 * 退出码：0 = 原生与表驱动逐位一致且压测没崩；1 = 发现不一致。
 */

import { crc32Final, crc32State, crc32Update } from '../../packages/core/src/timeline/wal';

const zlib = require('node:zlib') as { crc32?: (data: Uint8Array, value?: number) => number };

function tableCrc(bytes: Uint8Array): string {
  return crc32Final(crc32Update(crc32State(), bytes));
}

function nativeCrc(bytes: Uint8Array): string | undefined {
  if (typeof zlib.crc32 !== 'function') return undefined;
  return ((zlib.crc32(bytes) >>> 0) as number).toString(16).padStart(8, '0');
}

const platform = `${process.platform}/${process.arch} bun ${Bun.version}`;
console.log(`# platform: ${platform}`);
console.log(`# zlib.crc32 present: ${typeof zlib.crc32 === 'function'}`);

let failures = 0;
function check(label: string, bytes: Uint8Array): void {
  const table = tableCrc(bytes);
  const native = nativeCrc(bytes);
  if (native === undefined) {
    console.log(`${label.padEnd(28)} table=${table} native=<absent>`);
    return;
  }
  const ok = native === table;
  if (!ok) failures += 1;
  console.log(`${label.padEnd(28)} table=${table} native=${native} ${ok ? 'OK' : 'MISMATCH'}`);
}

// ── 1. 基本形状 ──────────────────────────────────────────────────────────
check('empty', new Uint8Array(0));
check('one byte 0x00', new Uint8Array([0x00]));
check('one byte 0xff', new Uint8Array([0xff]));
check('hello', new TextEncoder().encode('hello'));
check('ndjson line', new TextEncoder().encode('{"v":1,"seq":1,"type":"run.started"}\n'));

// ── 2. 分包视图（byteOffset ≠ 0）—— 最可疑的一条 ─────────────────────────
const backing = new Uint8Array(1024);
for (let index = 0; index < backing.length; index += 1) backing[index] = (index * 37 + 11) & 0xff;
const slice = backing.subarray(512, 768);
check('subarray(512,768)', slice);
const buf = Buffer.from(backing);
const bufSlice = buf.subarray(100, 200);
check('Buffer.subarray(100,200)', bufSlice);
const view = new Uint8Array(backing.buffer, 256, 128);
check('Uint8Array(buffer,256,128)', view);

// 逐位相同的判据：把 slice 拷成独立缓冲再算，两者必须一致
const copy = new Uint8Array(slice);
check('slice copied', copy);
if (nativeCrc(slice) !== nativeCrc(copy)) {
  failures += 1;
  console.log('MISMATCH: 原生 crc32 对 subarray 与拷贝的结果不同（byteOffset 没被尊重）');
}

// ── 3. 压力：159 KB 级块 × 1e4 ────────────────────────────────────────────
const BLOCK = 159 * 1024;
const blockBytes = new Uint8Array(BLOCK);
for (let index = 0; index < BLOCK; index += 1) blockBytes[index] = (index * 131 + 7) & 0xff;
const expected = tableCrc(blockBytes);
const iterations = 10_000;
const started = performance.now();
let worst = 0;
for (let index = 0; index < iterations; index += 1) {
  const at = performance.now();
  const got = nativeCrc(blockBytes);
  const cost = performance.now() - at;
  if (cost > worst) worst = cost;
  if (got !== expected) {
    failures += 1;
    console.log(`MISMATCH at iteration ${index}: native=${got} expected=${expected}`);
    break;
  }
  if (index % 1000 === 0 && index > 0) {
    const usage = process.memoryUsage();
    console.log(
      `# iter=${index} rss=${(usage.rss / 1048576).toFixed(1)}MB heap=${(usage.heapUsed / 1048576).toFixed(1)}MB`,
    );
  }
}
const elapsed = performance.now() - started;
console.log(
  `# native stress: ${iterations} x ${(BLOCK / 1024).toFixed(0)}KB in ${elapsed.toFixed(0)}ms ` +
    `(${(iterations / (elapsed / 1000)).toFixed(0)}/s, worst ${worst.toFixed(2)}ms)`,
);

// 表驱动同规模（对比代价，慢得多）
const tableStarted = performance.now();
const tableRounds = 100;
for (let index = 0; index < tableRounds; index += 1) {
  if (tableCrc(blockBytes) !== expected) {
    failures += 1;
    console.log('MISMATCH: 表驱动自身不一致（不该发生）');
    break;
  }
}
const tableElapsed = performance.now() - tableStarted;
console.log(
  `# table stress: ${tableRounds} x ${(BLOCK / 1024).toFixed(0)}KB in ${tableElapsed.toFixed(0)}ms ` +
    `(${(tableElapsed / tableRounds).toFixed(2)}ms/block)`,
);
console.log(`# native per block: ${(elapsed / iterations).toFixed(3)}ms`);

console.log(failures === 0 ? '# RESULT: all equal' : `# RESULT: ${failures} mismatch(es)`);
process.exit(failures === 0 ? 0 : 1);
