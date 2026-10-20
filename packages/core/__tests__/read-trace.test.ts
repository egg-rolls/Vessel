import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEvent } from '../src/index';
import { readTraceEvents } from '../src/index';

const roots: string[] = [];

function tempDir(): string {
  const dir = join(process.env.TEMP ?? '/tmp', `vessel-read-${randomUUID()}`);
  roots.push(dir);
  return dir;
}

function line(event: RunEvent): string {
  return `${JSON.stringify(event)}\n`;
}

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function seed(dir: string, runId: string, events: RunEvent[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${runId}.jsonl`), events.map(line).join(''), 'utf8');
}

const R1: RunEvent[] = [
  { type: 'run.started', run_id: 'r1', data: { i: 1 }, ts: 100, seq: 1 },
  { type: 'llm.request', run_id: 'r1', data: { i: 2 }, ts: 110, seq: 2 },
  { type: 'llm.response', run_id: 'r1', data: { i: 3 }, ts: 120, seq: 3 },
  { type: 'run.completed', run_id: 'r1', data: { i: 4 }, ts: 130, seq: 4 },
];
const R2: RunEvent[] = [
  { type: 'run.started', run_id: 'r2', data: {}, ts: 105, seq: 1 },
  { type: 'tool.call.started', run_id: 'r2', data: {}, ts: 115, seq: 2 },
];

describe('readTraceEvents (0.5 A-3 §10.3)', () => {
  it('reads a single run and sorts by seq', async () => {
    const dir = tempDir();
    await seed(dir, 'r1', R1);
    await seed(dir, 'r2', R2);

    const events = await readTraceEvents(dir, { run_id: 'r1' });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('filters by since_seq, since_ts, types, and type_prefix', async () => {
    const dir = tempDir();
    await seed(dir, 'r1', R1);

    expect((await readTraceEvents(dir, { run_id: 'r1', since_seq: 2 })).map((e) => e.seq)).toEqual([
      3, 4,
    ]);
    expect((await readTraceEvents(dir, { run_id: 'r1', since_ts: 120 })).map((e) => e.seq)).toEqual(
      [3, 4],
    );
    expect(
      (await readTraceEvents(dir, { run_id: 'r1', types: ['llm.request', 'run.completed'] })).map(
        (e) => e.type,
      ),
    ).toEqual(['llm.request', 'run.completed']);
    expect(
      (await readTraceEvents(dir, { run_id: 'r1', type_prefix: 'llm.' })).map((e) => e.type),
    ).toEqual(['llm.request', 'llm.response']);
  });

  it('rejects types + type_prefix together', async () => {
    const dir = tempDir();
    await seed(dir, 'r1', R1);
    await expect(
      readTraceEvents(dir, { types: ['run.started'], type_prefix: 'run.' }),
    ).rejects.toThrow(/invalid_params/);
  });

  it('defaults to 50 and caps at 500', async () => {
    const dir = tempDir();
    const many: RunEvent[] = Array.from({ length: 60 }, (_, i) => ({
      type: 'tool.call.started',
      run_id: 'r1',
      data: { i },
      ts: i,
      seq: i + 1,
    }));
    await seed(dir, 'r1', many);

    expect(await readTraceEvents(dir, { run_id: 'r1' })).toHaveLength(50);
    expect(await readTraceEvents(dir, { run_id: 'r1', limit: 2 })).toHaveLength(2);

    const huge = Array.from({ length: 600 }, (_, i) => ({
      type: 'tool.call.started',
      run_id: 'r1',
      data: { i },
      ts: i,
      seq: i + 1,
    }));
    await seed(dir, 'r1', huge);
    expect(await readTraceEvents(dir, { run_id: 'r1', limit: 1000 })).toHaveLength(500);
  });

  it('skips corrupt lines and sorts across runs by (seq ?? ts)', async () => {
    const dir = tempDir();
    await seed(dir, 'r1', R1);
    await seed(dir, 'r2', R2);
    await appendFile(join(dir, 'r1.jsonl'), 'garbage\n', 'utf8');

    const events = await readTraceEvents(dir, { limit: 500 });
    expect(events.map((e) => e.run_id)).toEqual(['r1', 'r2', 'r1', 'r2', 'r1', 'r1']);
  });
});
