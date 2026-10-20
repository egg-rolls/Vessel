import { describe, expect, it } from 'bun:test';
import { checkTrace } from '../check-trace';

describe('check-trace', () => {
  it('writes a readable, ordered and redacted trace for a mock run', async () => {
    expect(await checkTrace(process.cwd())).toEqual([]);
  });
});
