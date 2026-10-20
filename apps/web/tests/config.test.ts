import { describe, expect, test } from 'bun:test';
import { filterConfigEntries, flattenConfig } from '../src/state/config';

describe('flattenConfig', () => {
  test('walks nested objects and arrays into path/value rows', () => {
    const entries = flattenConfig({
      session: { backend: 'file' },
      mcp_servers: { fs: { command: 'mcp-fs' } },
      tags: ['a', 'b'],
      enabled: true,
      count: 2,
      nothing: null,
    });
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain('session.backend');
    expect(paths).toContain('mcp_servers.fs.command');
    expect(paths).toContain('tags[0]');
    expect(paths).toContain('tags[1]');
    expect(paths).toContain('enabled');
    expect(entries.find((entry) => entry.path === 'enabled')?.type).toBe('boolean');
    expect(entries.find((entry) => entry.path === 'nothing')?.value).toBe('null');
  });

  test('handles empty input', () => {
    expect(flattenConfig({})).toEqual([]);
  });
});

describe('filterConfigEntries', () => {
  const entries = flattenConfig({ session: { backend: 'file' }, trace: { mode: 'full' } });

  test('matches path or value, case-insensitively', () => {
    expect(filterConfigEntries(entries, 'BACKEND').map((entry) => entry.path)).toEqual([
      'session.backend',
    ]);
    expect(filterConfigEntries(entries, 'full').map((entry) => entry.path)).toEqual(['trace.mode']);
    expect(filterConfigEntries(entries, '')).toHaveLength(entries.length);
  });
});
