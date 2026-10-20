import { describe, expect, it } from 'bun:test';
import type { RunEvent } from '@vessel/core';
import { createTraceRedactor } from '../src/redactor.js';

function event(data: Record<string, unknown>): RunEvent {
  return {
    type: 'tool.call.completed',
    run_id: 'run_1',
    data,
    ts: 123,
    seq: 7,
    tenant_id: 'acme',
  };
}

describe('createTraceRedactor', () => {
  it('redacts sensitive keys, app_id and token counts safely', () => {
    const redactor = createTraceRedactor();
    const result = redactor.redact(
      event({
        api_key: 'sk-live-abcdefghijklmnop',
        token: 'plain-token',
        password: 'hunter2',
        authorization: 'Bearer abc',
        app_secret: 'feishu-secret',
        app_id: 'cli_123456',
        total_tokens: 42,
        ok: true,
      }),
    );

    expect(result.data).toMatchObject({
      api_key: '***',
      token: '***',
      password: '***',
      authorization: '***',
      app_secret: '***',
      app_id: 'cli_***',
      total_tokens: 42,
      ok: true,
    });
  });

  it('redacts app id regardless of key casing and separator style', () => {
    const redactor = createTraceRedactor();
    const result = redactor.redact(
      event({
        app_id: 'cli_123456',
        appId: 'cli_abcdef',
        APP_ID: 'cli_ZZZZZZ',
        APPID: 'cli_999999',
      }),
    );

    expect(result.data).toEqual({
      app_id: 'cli_***',
      appId: 'cli_***',
      APP_ID: 'cli_***',
      APPID: 'cli_***',
    });
  });

  it('leaves non-string app id values unchanged', () => {
    const redactor = createTraceRedactor();
    const result = redactor.redact(event({ appId: 42, APP_ID: false }));
    expect(result.data).toEqual({ appId: 42, APP_ID: false });
  });

  it('redacts secret-shaped strings and nested arrays', () => {
    const redactor = createTraceRedactor();
    const result = redactor.redact(
      event({
        message: 'use sk-abcdefghijklmnopqrstuvwx now',
        nested: [{ password: 'pw' }, { note: 'Bearer abcdefghijklmnop' }],
      }),
    );

    expect((result.data as Record<string, unknown>).message).toBe('use sk-***REDACTED*** now');
    expect(result.data.nested).toEqual([{ password: '***' }, { note: 'Bearer ***REDACTED***' }]);
  });

  it('preserves the event envelope and does not mutate the input', () => {
    const source = event({ api_key: 'sk-live-abcdefghijklmnop', total_tokens: 3 });
    const snapshot = JSON.parse(JSON.stringify(source));
    const redactor = createTraceRedactor();
    const result = redactor.redact(source);

    expect(result.type).toBe(source.type);
    expect(result.run_id).toBe(source.run_id);
    expect(result.ts).toBe(source.ts);
    expect(result.seq).toBe(source.seq);
    expect(result.tenant_id).toBe(source.tenant_id);
    expect(source).toEqual(snapshot);
  });

  it('is idempotent', () => {
    const redactor = createTraceRedactor();
    const once = redactor.redact(event({ api_key: 'sk-live-abcdefghijklmnop' }));
    const twice = redactor.redact(once);
    expect(twice).toEqual(once);
  });

  it('supports extra patterns and disabling builtins', () => {
    const redactor = createTraceRedactor({
      enableBuiltin: false,
      extraPatterns: [{ name: 'employee-id', pattern: 'EMP-[0-9]{4}' }],
    });
    const result = redactor.redact(
      event({ note: 'EMP-1234', api_key: 'sk-live-abcdefghijklmnop' }),
    );
    expect(result.data).toEqual({
      note: '***REDACTED***',
      api_key: '***',
    });
  });
});
