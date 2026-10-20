import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryPluginHost } from '@vessel-agent/core';
import { EvalsError } from '../src/errors.js';
import { createEvalsPlugin } from '../src/plugin.js';
import { makeTempWorkspace, writeSuite } from './fixtures/helpers.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const SOURCE = `
name: plugin
cases:
  - id: a
    input: hi
    mock:
      responses:
        - content: hi
    expect:
      - type: output_contains
        value: hi
`;

describe('createEvalsPlugin', () => {
  it('installs no tools and runs suites', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());
    const file = await writeSuite(workspace.suites, 'plugin', SOURCE);

    const plugin = createEvalsPlugin({ outDir: workspace.out });
    const host = new MemoryPluginHost();
    plugin.install(host);
    expect(host.listTools()).toEqual([]);

    const report = await plugin.runSuite(file, { timestamp: 'p1' });
    expect(report.passed).toBe(1);
    expect((await plugin.getLatest('plugin'))?.passed).toBe(1);
  });

  it('reports disabled evals', async () => {
    const workspace = await makeTempWorkspace();
    cleanups.push(() => workspace.cleanup());
    const file = await writeSuite(workspace.suites, 'plugin', SOURCE);

    const plugin = createEvalsPlugin({ outDir: workspace.out, enabled: false });
    await expect(plugin.runSuite(file, { timestamp: 'p2' })).rejects.toBeInstanceOf(EvalsError);
  });
});
