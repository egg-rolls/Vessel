#!/usr/bin/env bun

/**
 * trace 落盘冒烟检查（0.5）。
 *
 * 在临时 `VESSEL_DATA_DIR` 中跑一次 mock headless run，断言：
 *   - `<data>/tenants/<id>/events/<run_id>.jsonl` 存在；
 *   - 每行是 JSON；落盘事件带 seq 且严格递增；
 *   - 含 run.started / run.completed，tenant_id 正确；
 *   - 假 API Key 不出现在 trace；无 trace.overflow；
 *   - `readTraceEvents` 能回读、跳过损坏行，默认 limit 生效。
 *
 * 用法：bun run scripts/check-trace.ts
 * 退出码：0 = 通过；1 = 失败。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunEvent, readTraceEvents } from '../packages/core/src/index';

const TENANT = 'govtrace';
const SECRET = 'sk-test-secret-do-not-log';

async function listJsonl(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listJsonl(full)));
    else if (entry.name.endsWith('.jsonl')) files.push(full);
  }
  return files;
}

function cleanEnv(home: string, dataDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('VESSEL_')) continue;
    if (key === 'HOME' || key === 'USERPROFILE') continue;
    env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.VESSEL_MOCK = '1';
  env.VESSEL_DATA_DIR = dataDir;
  env.VESSEL_PROVIDER_API_KEY = SECRET;
  return env;
}

function isSorted(events: RunEvent[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    const prev = events[index - 1];
    const current = events[index];
    if (prev === undefined || current === undefined) return false;
    const prevKey = prev.seq ?? prev.ts;
    const currentKey = current.seq ?? current.ts;
    if (currentKey < prevKey) return false;
  }
  return true;
}

export async function checkTrace(root: string): Promise<string[]> {
  const issues: string[] = [];
  const base = await mkdtemp(join(tmpdir(), 'vessel-trace-'));
  const home = join(base, 'home');
  const project = join(base, 'project');
  const dataDir = join(base, 'data');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  try {
    const proc = Bun.spawn({
      cmd: [process.execPath, join(root, 'src/cli.ts'), '--run', 'hello', '--tenant', TENANT],
      cwd: project,
      env: cleanEnv(home, dataDir),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return [`mock run failed (exit ${exitCode}): ${stdout}\n${stderr}`];
    }

    const traceRoot = join(dataDir, 'tenants', TENANT, 'events');
    let files: string[] = [];
    try {
      files = await listJsonl(traceRoot);
    } catch {
      return [`trace directory missing: ${traceRoot}`];
    }
    if (files.length === 0) return [`no trace jsonl under ${traceRoot}`];

    const events: RunEvent[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (text.includes(SECRET)) issues.push(`trace contains secret: ${file}`);
      if (text.includes('trace.overflow')) issues.push(`trace overflow marker: ${file}`);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          issues.push(`invalid JSON line in ${file}`);
          continue;
        }
        const event = parsed as RunEvent;
        if (typeof event.type !== 'string' || typeof event.ts !== 'number') {
          issues.push(`invalid RunEvent shape in ${file}`);
          continue;
        }
        events.push(event);
      }
    }

    if (events.length === 0) issues.push('trace has no events');
    if (!events.some((event) => event.type === 'run.started')) {
      issues.push('trace missing run.started');
    }
    if (!events.some((event) => event.type === 'run.completed')) {
      issues.push('trace missing run.completed');
    }
    for (const event of events) {
      if (event.tenant_id !== TENANT) {
        issues.push(
          `event ${event.type} tenant_id=${String(event.tenant_id)} (expected ${TENANT})`,
        );
        break;
      }
    }
    const byRun = new Map<string, RunEvent[]>();
    for (const event of events) {
      const list = byRun.get(event.run_id) ?? [];
      list.push(event);
      byRun.set(event.run_id, list);
    }
    for (const [runId, list] of byRun) {
      let lastSeq = -1;
      for (const event of list) {
        if (typeof event.seq !== 'number') {
          issues.push(`persisted event ${event.type} missing seq (run ${runId})`);
          break;
        }
        if (event.seq <= lastSeq) {
          issues.push(
            `seq not strictly increasing in run ${runId} at ${event.type}: ${event.seq} <= ${lastSeq}`,
          );
          break;
        }
        lastSeq = event.seq;
      }
    }

    try {
      const read = await readTraceEvents(traceRoot, { limit: 50 });
      if (read.length > 50) issues.push(`readTraceEvents ignored limit: ${read.length}`);
      if (!isSorted(read)) issues.push('readTraceEvents result is not sorted by (seq ?? ts)');
    } catch (error) {
      issues.push(`readTraceEvents failed: ${String(error)}`);
    }

    const firstFile = files[0];
    if (firstFile !== undefined) {
      await writeFile(firstFile, `${await readFile(firstFile, 'utf8')}\nnot-json\n`, 'utf8');
      try {
        const read = await readTraceEvents(traceRoot, { limit: 50 });
        if (read.length === 0) issues.push('readTraceEvents returned nothing after corrupted line');
      } catch (error) {
        issues.push(`readTraceEvents threw on corrupted line: ${String(error)}`);
      }
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }

  return issues;
}

async function main(): Promise<void> {
  const issues = await checkTrace(process.cwd());
  if (issues.length === 0) {
    console.log('trace check passed');
    return;
  }

  console.error(`trace check failed: ${issues.length} issue(s)`);
  for (const issue of issues) console.error(`  ${issue}`);
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
