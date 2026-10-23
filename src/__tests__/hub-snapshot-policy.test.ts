import { describe, expect, it } from 'bun:test';
import { createHubSnapshotPolicy } from '../hub/snapshot-policy';

describe('hub snapshot policy', () => {
  it('drops stale revisions within the same incarnation', () => {
    const policy = createHubSnapshotPolicy({ incarnation: 'inc-1', revision: 5 });
    expect(policy.accept('inc-1', 5)).toBe(false);
    expect(policy.accept('inc-1', 4)).toBe(false);
    expect(policy.accept('inc-1', 6)).toBe(true);
    expect(policy.lastRevision()).toBe(6);
  });

  it('accepts the next snapshot unconditionally after an incarnation change', () => {
    const policy = createHubSnapshotPolicy({ incarnation: 'inc-1', revision: 9 });
    policy.observeHello('inc-2');
    // revision 回绕：新代际下 0 也必须接受。
    expect(policy.accept('inc-2', 0)).toBe(true);
    expect(policy.currentIncarnation()).toBe('inc-2');
    expect(policy.lastRevision()).toBe(0);
    expect(policy.accept('inc-2', 0)).toBe(false);
    expect(policy.accept('inc-2', 1)).toBe(true);
  });

  it('ignores an empty incarnation when deciding staleness', () => {
    const policy = createHubSnapshotPolicy({ incarnation: 'inc-1', revision: 2 });
    expect(policy.accept('', 1)).toBe(false);
    expect(policy.currentIncarnation()).toBe('inc-1');
    expect(policy.accept('', 3)).toBe(true);
  });

  it('treats a missing seed incarnation as unknown', () => {
    const policy = createHubSnapshotPolicy();
    expect(policy.lastRevision()).toBe(-1);
    expect(policy.accept('inc-1', 0)).toBe(true);
  });
});
