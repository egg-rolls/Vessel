import { afterEach, describe, expect, it } from 'bun:test';
import { EvalsError } from '../src/errors.js';
import { runEvalSuite } from '../src/runner.js';
import { fakeProvider, makeTempWorkspace, writeSuite } from './fixtures/helpers.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const SOURCE = `
name: network
cases:
  - id: a
    input: hi
    expect:
      - type: output_contains
        value: net
`;

describe('network gate', () => {
  it('rejects a providerFactory without allowNetwork', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());
    const file = await writeSuite(workspace.suites, 'network', SOURCE);

    try {
      await runEvalSuite(file, {
        outDir: workspace.out,
        providerFactory: () => fakeProvider('net'),
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EvalsError);
      expect((error as EvalsError).code).toBe('eval_network_required');
    }
  });

  it('runs when allowNetwork is explicit and marks report.network', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());
    const file = await writeSuite(workspace.suites, 'network', SOURCE);

    const report = await runEvalSuite(file, {
      outDir: workspace.out,
      timestamp: 'net',
      allowNetwork: true,
      providerFactory: () => fakeProvider('net'),
    });
    expect(report.network).toBe(true);
    expect(report.passed).toBe(1);
  });

  it('rejects disabled evals', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());
    const file = await writeSuite(workspace.suites, 'network', SOURCE);
    await expect(
      runEvalSuite(file, { outDir: workspace.out, enabled: false }),
    ).rejects.toBeInstanceOf(EvalsError);
  });
});
