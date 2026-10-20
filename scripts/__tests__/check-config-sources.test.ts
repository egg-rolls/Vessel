import { describe, expect, it } from 'bun:test';
import { checkConfigSources } from '../check-config-sources';

describe('check-config-sources', () => {
  // Spawns the CLI and walks the config matrix; under a full-suite load this
  // exceeds Bun's 5s default on Windows.
  it('passes the priority matrix, _env states and project secret rejection', async () => {
    expect(await checkConfigSources(process.cwd())).toEqual([]);
  }, 20_000);
});
