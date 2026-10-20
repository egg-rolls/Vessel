import { describe, expect, test } from 'bun:test';
import {
  errorLevelOf,
  errorMetaOf,
  formatErrorMeta,
  isEventVisible,
  resolveErrorLevel,
} from '../src/state/error-visibility';

describe('resolveErrorLevel', () => {
  test('reads camelCase and snake_case from config.get or unwrapped config', () => {
    expect(resolveErrorLevel({ config: { ui: { errorLevel: 'all' } } })).toBe('all');
    expect(resolveErrorLevel({ ui: { errorLevel: 'all' } })).toBe('all');
    expect(resolveErrorLevel({ config: { ui: { error_level: 'all' } } })).toBe('all');
  });

  test('defaults to user for missing or invalid values', () => {
    expect(resolveErrorLevel(null)).toBe('user');
    expect(resolveErrorLevel({})).toBe('user');
    expect(resolveErrorLevel({ config: { ui: { errorLevel: 'debug' } } })).toBe('user');
    expect(resolveErrorLevel({ config: { ui: { errorLevel: true } } })).toBe('user');
  });
});

describe('error level classification', () => {
  test('maps event namespaces to run / tool / permission / internal', () => {
    expect(errorLevelOf('run.failed')).toBe('run');
    expect(errorLevelOf('tool.call.failed')).toBe('tool');
    expect(errorLevelOf('tool.permission.expired')).toBe('tool');
    expect(errorLevelOf('permission.respond.failed')).toBe('permission');
    expect(errorLevelOf('ask.respond.failed')).toBe('permission');
    expect(errorLevelOf('guardrail.blocked')).toBe('tool');
    expect(errorLevelOf('hook.error')).toBe('internal');
    expect(errorLevelOf('process.error')).toBe('internal');
    expect(errorLevelOf('error')).toBe('internal');
  });

  test('hides internal errors by default, shows run/tool/permission', () => {
    expect(isEventVisible({ type: 'run.failed' }, 'user')).toBe(true);
    expect(isEventVisible({ type: 'tool.call.failed' }, 'user')).toBe(true);
    expect(isEventVisible({ type: 'ask.respond.failed' }, 'user')).toBe(true);
    expect(isEventVisible({ type: 'hook.error' }, 'user')).toBe(false);
    expect(isEventVisible({ type: 'process.error' }, 'user')).toBe(false);
    expect(isEventVisible({ type: 'error' }, 'user')).toBe(false);
    // 非错误事件始终通过
    expect(isEventVisible({ type: 'llm.request' }, 'user')).toBe(true);
  });

  test('errorLevel all or showInternal reveals internal errors', () => {
    expect(isEventVisible({ type: 'hook.error' }, 'all')).toBe(true);
    expect(isEventVisible({ type: 'hook.error' }, 'user', true)).toBe(true);
  });
});

describe('errorMetaOf', () => {
  test('reads additive fields and ignores missing ones', () => {
    expect(
      errorMetaOf({
        error_code: 'provider_timeout',
        category: 'provider',
        phase: 'llm',
        retryable: true,
        http_status: 504,
      }),
    ).toEqual({
      code: 'provider_timeout',
      category: 'provider',
      phase: 'llm',
      retryable: true,
      httpStatus: 504,
    });
    expect(errorMetaOf({ error: 'old shape' })).toBeUndefined();
    expect(errorMetaOf(null)).toBeUndefined();
  });

  test('formats compact chips and accepts camelCase aliases', () => {
    expect(formatErrorMeta({ code: 'x', category: 'run', phase: 'finalize' })).toBe(
      'x · run · finalize',
    );
    expect(formatErrorMeta(undefined)).toBe('');
    expect(errorMetaOf({ errorCode: 'e', httpStatus: 500 })).toEqual({
      code: 'e',
      httpStatus: 500,
    });
  });
});
