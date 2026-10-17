import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT_COMPAT_SYMBOLS, runSmoke, SMOKE_TARGETS } from '../smoke-subpaths';

describe('subpath smoke', () => {
  it('passes on the current workspace', async () => {
    const result = await runSmoke(process.cwd());
    expect(result.failures).toEqual([]);
    expect(result.checked.length).toBeGreaterThanOrEqual(9);
  });

  it('covers every exports key', async () => {
    const manifest = JSON.parse(
      await readFile(join(process.cwd(), 'packages/core/package.json'), 'utf8'),
    ) as { exports?: Record<string, unknown> };

    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual(Object.keys(SMOKE_TARGETS).sort());
  });

  it('keeps the 0.1 root compatibility symbols', () => {
    for (const symbol of ROOT_COMPAT_SYMBOLS) {
      expect(SMOKE_TARGETS['.']).toContain(symbol);
    }
  });
});
