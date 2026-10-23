import { describe, expect, test } from 'bun:test';
import {
  normalizeStatus,
  STATUS_META,
  statusLabel,
  statusMeta,
} from '../src/components/StatusChip';

describe('StatusChip', () => {
  test('maps waiting_permission to the waiting chip', () => {
    expect(normalizeStatus('waiting_permission')).toBe('waiting');
    expect(statusLabel('waiting_permission')).toBe('等待确认');
    expect(statusMeta('waiting_permission')).toEqual(STATUS_META.waiting);
  });

  test('keeps known statuses and their labels unchanged', () => {
    expect(normalizeStatus('running')).toBe('running');
    expect(statusLabel('running')).toBe('运行中');
    expect(normalizeStatus('completed')).toBe('completed');
    expect(statusLabel('completed')).toBe('已完成');
  });

  test('still falls back to pending for unknown values', () => {
    expect(normalizeStatus('mystery')).toBe('pending');
    expect(statusLabel('mystery')).toBe('mystery');
    expect(normalizeStatus(undefined)).toBe('pending');
  });
});
