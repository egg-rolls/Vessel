import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MemoryEventStream, MemoryPluginHost, type RunnableAgent } from '@vessel-agent/core';
import {
  findLatestReport,
  reportExitCode,
  reportFileName,
  reportTimestamp,
} from '../src/report.js';
import { runEvalSuite } from '../src/runner.js';
import type { EvalReport } from '../src/types.js';
import { makeTempWorkspace, writeSuite } from './fixtures/helpers.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function runtimeFor(testCaseId: string): RunnableAgent {
  return {
    events: new MemoryEventStream(),
    pluginHost: new MemoryPluginHost(),
    async run() {
      if (testCaseId === 'error') throw new Error('boom');
      return testCaseId === 'pass' ? 'hello' : 'bye';
    },
    dispose() {
      // no-op
    },
  };
}

describe('reports', () => {
  it('computes counts, writes a report and finds the latest', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());
    const file = await writeSuite(
      workspace.suites,
      'mixed',
      `
name: mixed
cases:
  - id: pass
    input: pass
    expect:
      - type: output_contains
        value: hello
  - id: fail
    input: fail
    expect:
      - type: output_contains
        value: hello
  - id: error
    input: error
    expect:
      - type: no_error
`,
    );

    const first = await runEvalSuite(file, {
      outDir: workspace.out,
      timestamp: 'one',
      now: () => 1000,
      createRuntime: async ({ testCase }) => runtimeFor(testCase.id),
    });
    expect(first.total).toBe(3);
    expect(first.passed).toBe(1);
    expect(first.failed).toBe(1);
    expect(first.errors).toBe(1);
    expect(first.skipped).toBe(0);
    expect(reportExitCode(first)).toBe(1);

    const second = await runEvalSuite(file, {
      outDir: workspace.out,
      timestamp: 'two',
      now: () => 2000,
      createRuntime: async ({ testCase }) => runtimeFor(testCase.id),
    });
    expect(second.finished_at).toBe(2000);

    const reportPath = path.join(workspace.out, reportFileName('mixed', 'one'));
    const parsed = JSON.parse(await fs.readFile(reportPath, 'utf8')) as EvalReport;
    expect(parsed.passed).toBe(1);

    const latest = await findLatestReport(workspace.out, 'mixed');
    expect(latest?.finished_at).toBe(2000);
  });

  it('returns exit code 0 when everything passes or is skipped', () => {
    const report: EvalReport = {
      suite: 'x',
      network: false,
      started_at: 0,
      finished_at: 1,
      duration_ms: 1,
      total: 2,
      passed: 1,
      failed: 0,
      errors: 0,
      skipped: 1,
      cases: [],
    };
    expect(reportExitCode(report)).toBe(0);
  });

  it('formats a filesystem-safe timestamp', () => {
    expect(reportTimestamp(new Date('2026-10-18T10:03:58.123Z'))).toBe('20261018T100358123Z');
  });

  it('ignores corrupt and unrelated reports', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());
    await fs.mkdir(workspace.out, { recursive: true });
    await fs.writeFile(path.join(workspace.out, 'bad.json'), '{oops', 'utf8');
    await fs.writeFile(
      path.join(workspace.out, 'other.json'),
      JSON.stringify({ suite: 'other', finished_at: 5 }),
      'utf8',
    );
    expect(await findLatestReport(workspace.out, 'missing')).toBeNull();
  });
});
