import { describe, expect, it } from 'bun:test';
import { LruSet } from '../src/dedupe.js';

describe('LruSet', () => {
  it('detects duplicates before adding', () => {
    const set = new LruSet(10);
    expect(set.seen('a')).toBe(false);
    expect(set.seen('a')).toBe(true);
  });

  it('evicts the oldest entry beyond the limit', () => {
    const set = new LruSet(2);
    set.seen('a');
    set.seen('b');
    set.seen('c');
    expect(set.size).toBe(2);
    expect(set.seen('a')).toBe(false);
    expect(set.seen('c')).toBe(true);
  });

  it('clears', () => {
    const set = new LruSet(2);
    set.seen('a');
    set.clear();
    expect(set.size).toBe(0);
  });
});
