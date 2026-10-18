import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEvent } from '../src/index';
import { MemoryEventStream, MetricsCollector, rebuildMetrics } from '../src/index';

const roots: string[] = [];

function tempDir(): string {
  const dir = join(process.env.TEMP ?? '/tmp', `vessel-rebuild-${randomUUID()}`);
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

const EVENTS: RunEvent[] = [
  { type: 'run.started', run_id: 'r1', data: {}, ts: 100 },
  {
    type: 'llm.response',
    run_id: 'r1',
    data: { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ts: 110,
  },
  { type: 'tool.call.started', run_id: 'r1', data: { tool_name: 'bash' }, ts: 120 },
  { type: 'tool.call.failed', run_id: 'r1', data: { tool_name: 'bash' }, ts: 130 },
  { type: 'run.completed', run_id: 'r1', data: { duration_ms: 40 }, ts: 140 },
  { type: 'run.started', run_id: 'r2', data: {}, ts: 200 },
  { type: 'run.cancelled', run_id: 'r2', data: { duration_ms: 10 }, ts: 210 },
  { type: 'run.started', run_id: 'r3', data: {}, ts: 300 },
  { type: 'run.failed', run_id: 'r3', data: { duration_ms: 20 }, ts: 310 },
];

describe('rebuildMetrics (0.5 E8)', () => {
  it('matches the live collector for the same event sequence', async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'r1.jsonl'),
      EVENTS.filter((e) => e.run_id === 'r1')
        .map(line)
        .join(''),
      'utf8',
    );
    await writeFile(
      join(dir, 'r2.jsonl'),
      EVENTS.filter((e) => e.run_id === 'r2')
        .map(line)
        .join(''),
      'utf8',
    );
    await writeFile(
      join(dir, 'r3.jsonl'),
      line(EVENTS[7] as RunEvent) + line(EVENTS[8] as RunEvent),
      'utf8',
    );

    const stream = new MemoryEventStream();
    const collector = new MetricsCollector(stream);
    for (const event of EVENTS) stream.publish(event);

    expect(await rebuildMetrics(dir)).toEqual(collector.snapshot());
    expect((await rebuildMetrics(dir)).updated_at).toBe(310);
    collector.dispose();
  });

  it('skips corrupt lines and tolerates metadata-level events', async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'r1.jsonl'),
      `${line({ type: 'run.started', run_id: 'r1', data: {}, ts: 1 })}not json\n${line({
        type: 'run.completed',
        run_id: 'r1',
        data: { duration_ms: 5 },
        ts: 2,
      })}`,
      'utf8',
    );

    const snapshot = await rebuildMetrics(dir);
    expect(snapshot.runs).toEqual({ started: 1, completed: 1, failed: 0, cancelled: 0 });
    expect(snapshot.updated_at).toBe(2);
  });

  it('returns an all-zero snapshot for a missing directory', async () => {
    const snapshot = await rebuildMetrics(join(tempDir(), 'missing'));
    expect(snapshot).toEqual({
      runs: { started: 0, completed: 0, failed: 0, cancelled: 0 },
      tool_calls: { total: 0, failed: 0 },
      llm: { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      duration_ms: { total: 0, max: 0, avg: 0 },
      updated_at: 0,
    });
  });
});
