import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import { EvalsError } from '../src/errors.js';
import { findLatestReport } from '../src/report.js';
import { runEvalSuite } from '../src/runner.js';
import { makeTempWorkspace, writeSuite } from './fixtures/helpers.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const SOURCE = `
name: tenant-suite
cases:
  - id: basic
    input: hello
    mock:
      responses:
        - content: hello
    expect:
      - type: output_contains
        value: hello
      - type: no_error
`;

async function setup(source = SOURCE): Promise<{ out: string; file: string }> {
  const workspace = await makeTempWorkspace();
  cleanups.push(() => workspace.cleanup());
  const file = await writeSuite(workspace.suites, 'tenant-suite', source);
  return { out: workspace.out, file };
}

describe('evals tenant scope', () => {
  it('writes tenant_id to the report and emits started/completed', async () => {
    const { out, file } = await setup();
    const events = new MemoryEventStream();
    const collected: RunEvent[] = [];
    events.subscribe((event) => {
      collected.push(event);
    });

    const report = await runEvalSuite(file, {
      outDir: out,
      tenantId: 'acme',
      events,
      timestamp: 't-tenant',
    });

    expect(report.tenant_id).toBe('acme');
    expect(collected.map((event) => event.type)).toEqual([
      'eval.run.started',
      'eval.run.completed',
    ]);
    for (const event of collected) expect(event.tenant_id).toBe('acme');
    const completed = collected[1]?.data as Record<string, unknown>;
    expect(completed).toMatchObject({ total: 1, passed: 1, failed: 0, errors: 0, skipped: 0 });
  });

  it('keeps report lookup isolated between tenant output dirs', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());
    const file = await writeSuite(workspace.suites, 'tenant-suite', SOURCE);
    const outA = `${workspace.out}/tenant_a`;
    const outB = `${workspace.out}/tenant_b`;

    await runEvalSuite(file, { outDir: outA, tenantId: 'tenant_a', timestamp: 't-a' });
    const latestA = await findLatestReport(outA, 'tenant-suite');
    const latestB = await findLatestReport(outB, 'tenant-suite');

    expect(latestA?.tenant_id).toBe('tenant_a');
    expect(latestB).toBeNull();
  });

  it('keeps 0.4 behavior when tenantId and events are omitted', async () => {
    const { out, file } = await setup();
    const report = await runEvalSuite(file, { outDir: out, timestamp: 't-plain' });
    expect('tenant_id' in report).toBe(false);
  });

  it('does not emit started when the suite fails to load', async () => {
    const { out, file } = await setup('name: broken\ncases: []\n');
    const events = new MemoryEventStream();
    const collected: RunEvent[] = [];
    events.subscribe((event) => {
      collected.push(event);
    });
    await expect(
      runEvalSuite(file, { outDir: out, tenantId: 'acme', events }),
    ).rejects.toBeInstanceOf(EvalsError);
    expect(collected).toEqual([]);
  });

  it('rejects an invalid tenant id', async () => {
    const { out, file } = await setup();
    await expect(runEvalSuite(file, { outDir: out, tenantId: 'Bad Tenant' })).rejects.toMatchObject(
      { code: 'eval_invalid' },
    );
  });
});
