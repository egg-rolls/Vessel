import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEvent } from '../src/index';
import { FileTraceRecorder, MemoryEventStream } from '../src/index';

const roots: string[] = [];

function tempDir(): string {
  const dir = join(process.env.TEMP ?? '/tmp', `vessel-trace-${randomUUID()}`);
  roots.push(dir);
  return dir;
}

async function readEvents(path: string): Promise<RunEvent[]> {
  const text = await readFile(path, 'utf8');
  const events: RunEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // 损坏行跳过（与读取端语义一致）
    }
  }
  return events;
}

function event(
  runId: string,
  type: string,
  data: Record<string, unknown> = {},
  seq?: number,
): RunEvent {
  return {
    type,
    run_id: runId,
    data,
    ts: 1000 + (seq ?? 0),
    ...(seq !== undefined ? { seq } : {}),
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timeout');
}

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('FileTraceRecorder (0.5 E5/E6)', () => {
  it('writes one JSONL per run with monotonic seq and tenant_id', async () => {
    const dir = tempDir();
    const recorder = new FileTraceRecorder({ dir, tenantId: 'acme' });

    recorder.append(event('r1', 'run.started'));
    recorder.append(event('r1', 'llm.response', {}, 10));
    recorder.append(event('r1', 'run.completed'));
    recorder.append(event('r2', 'run.started'));
    await recorder.flush();
    await recorder.close();

    const r1 = await readEvents(join(dir, 'r1.jsonl'));
    expect(r1.map((e) => e.seq)).toEqual([1, 10, 11]);
    expect(r1.every((e) => e.tenant_id === 'acme')).toBe(true);

    const r2 = await readEvents(join(dir, 'r2.jsonl'));
    expect(r2.map((e) => e.seq)).toEqual([1]);
  });

  it('preserves per-run append order', async () => {
    const dir = tempDir();
    const recorder = new FileTraceRecorder({ dir });
    for (let i = 0; i < 50; i += 1) {
      recorder.append(event('r1', 'tool.call.started', { i }));
    }
    await recorder.flush();

    const events = await readEvents(join(dir, 'r1.jsonl'));
    expect(events.map((e) => (e.data as { i: number }).i)).toEqual(
      Array.from({ length: 50 }, (_, i) => i),
    );
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('continues seq across recorder restarts for the same run', async () => {
    const dir = tempDir();
    const first = new FileTraceRecorder({ dir });
    first.append(event('r1', 'run.started'));
    first.append(event('r1', 'llm.request'));
    await first.close();

    const second = new FileTraceRecorder({ dir });
    second.append(event('r1', 'llm.response'));
    await second.close();

    const events = await readEvents(join(dir, 'r1.jsonl'));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('skips corrupt tail lines when seeding seq', async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'r1.jsonl'),
      `${JSON.stringify({ type: 'run.started', run_id: 'r1', data: {}, ts: 1, seq: 7 })}\n{broken`,
      'utf8',
    );

    const recorder = new FileTraceRecorder({ dir });
    recorder.append(event('r1', 'run.completed'));
    await recorder.close();

    const events = await readEvents(join(dir, 'r1.jsonl'));
    expect(events.at(-1)?.seq).toBe(8);
  });

  it('applies the redactor before writing', async () => {
    const dir = tempDir();
    const recorder = new FileTraceRecorder({ dir });
    recorder.append(event('r1', 'llm.request', { api_key: 'secret', nested: { token: 'x' } }));
    await recorder.close();

    const written = (await readEvents(join(dir, 'r1.jsonl')))[0];
    if (!written) throw new Error('missing event');
    const data = written.data as Record<string, unknown>;
    expect(data.api_key).toBe('***');
    expect((data.nested as Record<string, unknown>).token).toBe('***');
  });

  it('metadata level keeps only the frozen whitelist and truncates error/reason', async () => {
    const dir = tempDir();
    const recorder = new FileTraceRecorder({ dir, level: 'metadata' });
    recorder.append(
      event('r1', 'run.failed', {
        status: 'failed',
        tool_name: 'bash',
        duration_ms: 5,
        message_count: 3,
        messages: [{ role: 'user', content: 'secret' }],
        input: 'secret',
        error: 'e'.repeat(600),
        reason: 'r'.repeat(300),
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3,
          total_cost: 0.5,
          extra: 'x',
        },
      }),
    );
    await recorder.close();

    const written = (await readEvents(join(dir, 'r1.jsonl')))[0];
    if (!written) throw new Error('missing event');
    const data = written.data as Record<string, unknown>;
    expect(data).toEqual({
      status: 'failed',
      tool_name: 'bash',
      duration_ms: 5,
      message_count: 3,
      error: 'e'.repeat(500),
      reason: 'r'.repeat(200),
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, total_cost: 0.5 },
    });
    expect(data.messages).toBeUndefined();
    expect(data.input).toBeUndefined();
  });

  it('off level writes nothing', async () => {
    const dir = tempDir();
    const recorder = new FileTraceRecorder({ dir, level: 'off' });
    recorder.append(event('r1', 'run.started'));
    await recorder.close();

    await expect(readdir(dir)).rejects.toBeDefined();
  });

  it('auto-flushes on terminal events', async () => {
    const dir = tempDir();
    const events = new MemoryEventStream();
    const recorder = new FileTraceRecorder({ dir, events });

    events.publish(event('r1', 'run.started'));
    events.publish(event('r1', 'run.completed'));

    await waitFor(async () => {
      try {
        return (await readEvents(join(dir, 'r1.jsonl'))).length === 2;
      } catch {
        return false;
      }
    });
    await recorder.close();
  });

  it('reports write failures as trace.write.failed without throwing', async () => {
    const dir = tempDir();
    await mkdir(dir, { recursive: true });
    const blocker = join(dir, 'not-a-dir');
    await writeFile(blocker, 'x', 'utf8');
    const events = new MemoryEventStream();
    const recorder = new FileTraceRecorder({ dir: join(blocker, 'events'), events });

    expect(() => recorder.append(event('r1', 'run.started'))).not.toThrow();
    await recorder.flush();
    await recorder.close();

    expect(recorder.stats().failed).toBeGreaterThan(0);
    expect(events.getHistory().some((e) => e.type === 'trace.write.failed')).toBe(true);
  });

  it('drops overflowed events and writes a trace.overflow marker on flush', async () => {
    const dir = tempDir();
    const events = new MemoryEventStream();
    const recorder = new FileTraceRecorder({ dir, events, maxPendingEvents: 1 });

    recorder.append(event('r1', 'run.started'));
    recorder.append(event('r1', 'llm.request'));
    recorder.append(event('r1', 'llm.response'));
    await recorder.flush();

    expect(recorder.stats().dropped).toBe(2);
    const failure = events.getHistory().find((e) => e.type === 'trace.write.failed');
    const failureData = failure?.data as { reason?: string } | undefined;
    expect(failureData?.reason).toBe('queue_overflow');

    const written = await readEvents(join(dir, 'r1.jsonl'));
    const marker = written.find((e) => e.type === 'trace.overflow');
    expect(marker?.data).toEqual({ dropped: 2 });
    expect(written.filter((e) => e.type !== 'trace.overflow')).toHaveLength(1);
    await recorder.close();
  });
});

describe('FileTraceRecorder hardening (0.10 R2-14)', () => {
  it('does not persist llm.stream.chunk by default, only on opt-in', async () => {
    const dir = tempDir();
    const recorder = new FileTraceRecorder({ dir });
    recorder.append(event('r1', 'run.started'));
    recorder.append(event('r1', 'llm.stream.chunk', { chunk: { type: 'text_delta', delta: 'x' } }));
    recorder.append(event('r1', 'run.completed'));
    await recorder.flush();
    await recorder.close();

    const defaults = await readEvents(join(dir, 'r1.jsonl'));
    expect(defaults.map((e) => e.type)).toEqual(['run.started', 'run.completed']);

    const optedDir = tempDir();
    const opted = new FileTraceRecorder({ dir: optedDir, includeStreamChunks: true });
    opted.append(event('r2', 'llm.stream.chunk', { chunk: { type: 'text_delta', delta: 'x' } }));
    await opted.flush();
    await opted.close();

    const included = await readEvents(join(optedDir, 'r2.jsonl'));
    expect(included.map((e) => e.type)).toEqual(['llm.stream.chunk']);
  });

  it('creates trace files owner-only (mode 600 on POSIX)', async () => {
    if (process.platform === 'win32') return; // Windows 不受 mode 约束；由 POSIX CI 覆盖
    const dir = tempDir();
    const recorder = new FileTraceRecorder({ dir });
    recorder.append(event('r1', 'run.started'));
    await recorder.flush();
    await recorder.close();

    const info = await stat(join(dir, 'r1.jsonl'));
    expect(info.mode & 0o777).toBe(0o600);
  });
});
