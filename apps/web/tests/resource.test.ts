import { describe, expect, test } from 'bun:test';
import {
  beginLoad,
  errorCodeOf,
  fail,
  initialResourceState,
  isCurrentGeneration,
  type ResourceState,
  resourceData,
  shouldPoll,
  succeed,
} from '../src/state/useResource';

describe('ResourceState transitions', () => {
  test('idle → loading has no data', () => {
    expect(beginLoad(initialResourceState)).toEqual({ status: 'loading' });
  });

  test('refreshing keeps previous data without flicker', () => {
    const success = succeed(['a'], 100);
    expect(beginLoad(success)).toEqual({ status: 'loading', data: ['a'] });
  });

  test('success records data and updatedAt', () => {
    expect(succeed({ value: 1 }, 42)).toEqual({
      status: 'success',
      data: { value: 1 },
      updatedAt: 42,
    });
  });

  test('error keeps old data and timestamp', () => {
    const success = succeed(['a'], 100);
    expect(fail(success, 'boom')).toEqual({
      status: 'error',
      error: 'boom',
      data: ['a'],
      updatedAt: 100,
    });
    expect(fail({ status: 'loading', data: ['b'] }, 'boom')).toEqual({
      status: 'error',
      error: 'boom',
      data: ['b'],
    });
  });

  test('error with no prior data has no data key', () => {
    expect(fail(initialResourceState, 'boom')).toEqual({ status: 'error', error: 'boom' });
  });

  test('error preserves the gateway code for forbidden/not_found branches', () => {
    expect(
      fail(initialResourceState, {
        message: 'Cross-tenant access is not allowed',
        code: 'forbidden',
      }),
    ).toEqual({
      status: 'error',
      error: 'Cross-tenant access is not allowed',
      code: 'forbidden',
    });
    // 旧调用形态（纯字符串）不产生 code。
    expect(fail(initialResourceState, 'boom')).not.toHaveProperty('code');
  });

  test('errorCodeOf reads Error.code and the WS "code: message" form', () => {
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'forbidden' }))).toBe('forbidden');
    expect(errorCodeOf(new Error('method_not_allowed: nope'))).toBe('method_not_allowed');
    expect(errorCodeOf(new Error('plain failure'))).toBeUndefined();
  });

  test('resourceData reads success, loading, error and idle', () => {
    expect(resourceData(succeed(1, 1) as ResourceState<number>)).toBe(1);
    expect(resourceData<number>({ status: 'loading', data: 2 })).toBe(2);
    expect(resourceData<number>({ status: 'error', error: 'x', data: 3 })).toBe(3);
    expect(resourceData<number>({ status: 'idle' })).toBeUndefined();
  });
});

describe('generation guard', () => {
  test('only the latest generation may apply', () => {
    expect(isCurrentGeneration(3, 3)).toBe(true);
    expect(isCurrentGeneration(2, 3)).toBe(false);
  });
});

describe('shouldPoll', () => {
  test('requires a positive interval', () => {
    expect(shouldPoll(undefined, true)).toBe(false);
    expect(shouldPoll(0, true)).toBe(false);
    expect(shouldPoll(1000, true)).toBe(true);
  });

  test('pauses while the page is hidden when requested', () => {
    expect(shouldPoll(1000, true, 'hidden')).toBe(false);
    expect(shouldPoll(1000, false, 'hidden')).toBe(true);
    expect(shouldPoll(1000, true, 'visible')).toBe(true);
  });
});
