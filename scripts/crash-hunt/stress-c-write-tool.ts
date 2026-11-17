/**
 * 压力路径 C：**`write` 工具的大量文件创建**（0.56 新工具，create/overwrite/append 三条落盘路）。
 *
 * 为什么单独压它：`create` 走「同目录临时文件 + fsync + `link()` 落位」，`append` 走
 * `O_APPEND + fsync`。这是 0.56 新进的原生文件系统面（`link()` 在 Windows 上是
 * `CreateHardLinkW`，不是 POSIX 的 `link(2)`），所以它和 crc32 一样属于「新引入的原生调用」。
 *
 * 用法：
 *   bun scripts/crash-hunt/stress-c-write-tool.ts [--seconds 300] [--batch 32] [--kb 8]
 *
 * 隔离：全部落在 `%TEMP%/crash-hunt/c`，不碰工作区、不碰 `~/.vessel`。
 */

import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext, ToolDefinition } from '../../packages/core/src/types/tool';
import { createBasicTools } from '../../plugins/tools/basic-tools/src/index';
import { rssMb, sampleLine, startSampler } from './_sampler';

function argValue(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const seconds = argValue('--seconds', 300);
const batch = argValue('--batch', 32);
const kb = argValue('--kb', 8);

const workDir = join(tmpdir(), 'crash-hunt', 'c');
await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });

const tools = createBasicTools({});
const found = tools.find((tool) => tool.name === 'write');
if (found === undefined) {
  console.log('# RESULT: FAILED (write tool not found)');
  process.exit(1);
}
const writeTool: ToolDefinition = found;

/**
 * 最小 ctx：`write` 只用 `cwd` 解析相对路径，`session_id` 决定超大回执落到哪个
 * tool-output 目录（这里不给 session，回执也远小于裁剪阈值）。
 */
const ctx = {
  run_id: 'run-stress-c',
  messages: [],
  events: {},
  cwd: workDir,
} as unknown as ToolContext;

const content = 'y'.repeat(kb * 1024);
const stats = { created: 0, overwritten: 0, appended: 0, errors: 0 };
const errorSamples: string[] = [];

console.log('# path: C (write tool: create / overwrite / append)');
console.log(`# dir: ${workDir} batch=${batch} content=${kb}KB duration=${seconds}s`);

async function runOne(round: number): Promise<void> {
  const path = join(workDir, `f-${round}.txt`);
  try {
    await writeTool.handler({ path, content, mode: 'create' }, ctx);
    stats.created += 1;
    await writeTool.handler({ path, content, mode: 'overwrite' }, ctx);
    stats.overwritten += 1;
    await writeTool.handler({ path, content, mode: 'append' }, ctx);
    stats.appended += 1;
    await stat(path);
  } catch (error) {
    stats.errors += 1;
    if (errorSamples.length < 3) {
      errorSamples.push(error instanceof Error ? error.message : String(error));
    }
  }
}

const rssAtStart = rssMb();
const startedAt = Date.now();
const deadline = startedAt + seconds * 1000;
let round = 0;

const stopSampler = startSampler(() => ({
  files: stats.created,
  err: stats.errors,
  phase: 'write',
}));

while (Date.now() < deadline) {
  const wave: Array<Promise<void>> = [];
  for (let index = 0; index < batch; index += 1) {
    wave.push(runOne(round));
    round += 1;
  }
  await Promise.all(wave);
  // 每 2000 个文件换一个子目录，避免单目录条目爆炸（那是文件系统本身的上限，不是被测路径）
  if (round % 2000 < batch) {
    await mkdir(join(workDir, `bucket-${Math.floor(round / 2000)}`), { recursive: true });
  }
}
stopSampler();

const elapsedMs = Date.now() - startedAt;
console.log(
  `# tool calls: create=${stats.created} overwrite=${stats.overwritten} append=${stats.appended} ` +
    `errors=${stats.errors} in ${(elapsedMs / 1000).toFixed(0)}s ` +
    `(${((3 * stats.created) / (elapsedMs / 1000)).toFixed(0)} calls/s)`,
);
for (const sample of errorSamples) console.log(`# error sample: ${sample}`);
console.log(`# rss: start=${rssAtStart.toFixed(1)}MB end=${rssMb().toFixed(1)}MB`);
console.log(sampleLine(elapsedMs, { phase: 'done', files: stats.created }));

const ok = stats.errors === 0 && stats.created > 0;
console.log(ok ? '# RESULT: ok' : '# RESULT: FAILED');
process.exit(ok ? 0 : 1);
