import { describe, expect, it } from 'bun:test';
import { checkConfigSources } from '../check-config-sources';

describe('check-config-sources', () => {
  it('passes the priority matrix, _env states and project secret rejection', async () => {
    expect(await checkConfigSources(process.cwd())).toEqual([]);
  });
});
