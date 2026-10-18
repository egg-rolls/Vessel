import { describe, expect, it } from 'bun:test';
import { ClientBackpressure } from '../src/backpressure';

function gate(): ClientBackpressure {
  return new ClientBackpressure({ high: 100, low: 20 });
}

describe('ClientBackpressure', () => {
  it('validates thresholds', () => {
    expect(() => new ClientBackpressure({ high: 0, low: 0 })).toThrow();
    expect(() => new ClientBackpressure({ high: 10, low: -1 })).toThrow();
    expect(() => new ClientBackpressure({ high: 10, low: 10 })).toThrow();
    expect(() => new ClientBackpressure({ high: 10, low: 11 })).toThrow();
  });

  it('sends below the high watermark', () => {
    const bp = gate();
    expect(bp.admit(1, 99)).toBe(true);
    expect(bp.admit(2, 100)).toBe(true);
    expect(bp.pendingGap).toBeNull();
    expect(bp.takeGap(100)).toBeNull();
  });

  it('drops and coalesces a gap above the high watermark', () => {
    const bp = gate();
    expect(bp.admit(1, 101)).toBe(false);
    expect(bp.isDropping).toBe(true);
    expect(bp.pendingGap).toEqual({ from_seq: 1, to_seq: 1 });

    expect(bp.admit(2, 101)).toBe(false);
    expect(bp.admit(3, 500)).toBe(false);
    expect(bp.pendingGap).toEqual({ from_seq: 1, to_seq: 3 });
  });

  it('keeps dropping until inflight falls to the low watermark', () => {
    const bp = gate();
    expect(bp.admit(1, 101)).toBe(false);
    expect(bp.admit(2, 21)).toBe(false);
    expect(bp.pendingGap).toEqual({ from_seq: 1, to_seq: 2 });
    expect(bp.takeGap(21)).toBeNull();

    expect(bp.admit(3, 20)).toBe(true);
    expect(bp.takeGap(20)).toEqual({ from_seq: 1, to_seq: 2 });
    expect(bp.takeGap(20)).toBeNull();
    expect(bp.isDropping).toBe(false);
  });

  it('starts a new gap after recovery', () => {
    const bp = gate();
    expect(bp.admit(1, 200)).toBe(false);
    expect(bp.admit(2, 0)).toBe(true);
    expect(bp.takeGap(0)).toEqual({ from_seq: 1, to_seq: 1 });

    expect(bp.admit(3, 200)).toBe(false);
    expect(bp.pendingGap).toEqual({ from_seq: 3, to_seq: 3 });
  });

  it('does not clear a gap while still above the low watermark', () => {
    const bp = gate();
    expect(bp.admit(5, 200)).toBe(false);
    expect(bp.takeGap(200)).toBeNull();
    expect(bp.pendingGap).toEqual({ from_seq: 5, to_seq: 5 });
  });
});
