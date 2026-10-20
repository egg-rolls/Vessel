import { describe, expect, it } from 'bun:test';
import type { RunEvent } from '../src/index';
import { createDefaultTraceRedactor } from '../src/index';

function event(data: Record<string, unknown>): RunEvent {
  return { type: 'llm.request', run_id: 'r1', data, ts: 1 };
}

describe('default trace redactor (0.5 E7)', () => {
  const redactor = createDefaultTraceRedactor();

  it('redacts sensitive keys at any depth', () => {
    const result = redactor.redact(
      event({
        api_key: 'a',
        nested: { access_token: 'b', password: 'c', authorization: 'Bearer x' },
        list: [{ app_secret: 'd' }, { ok: 'keep' }],
      }),
    );
    const data = result.data as Record<string, unknown>;
    expect(data.api_key).toBe('***');
    expect((data.nested as Record<string, unknown>).access_token).toBe('***');
    expect((data.nested as Record<string, unknown>).password).toBe('***');
    expect((data.nested as Record<string, unknown>).authorization).toBe('***');
    expect((data.list as Array<Record<string, unknown>>)[0]?.app_secret).toBe('***');
    expect((data.list as Array<Record<string, unknown>>)[1]?.ok).toBe('keep');
  });

  it('redacts Bearer / JWT / AWS AccessKey strings (0.10 R2-14)', () => {
    const result = redactor.redact(
      event({
        bearer: 'Authorization: Bearer abcdefghijklmnop.qrstu',
        jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
        aws: 'AKIAIOSFODNN7EXAMPLE',
        asia: 'ASIAIOSFODNN7EXAMPLE',
        ordinary: 'Bearer of good news',
      }),
    );
    const data = result.data as Record<string, unknown>;
    expect(data.bearer).toBe('***');
    expect(data.jwt).toBe('***');
    expect(data.aws).toBe('***');
    expect(data.asia).toBe('***');
    // 低置信度文本保持原样（Bearer 后不足 8 个 token 字符）
    expect(data.ordinary).toBe('Bearer of good news');
  });

  it('redacts sk- prefixed strings', () => {
    const result = redactor.redact(event({ value: 'sk-abcdef123456', text: 'healthy' }));
    const data = result.data as Record<string, unknown>;
    expect(data.value).toBe('***');
    expect(data.text).toBe('healthy');
  });

  it('masks app_id / appId / APP_ID keeping the first four characters', () => {
    const result = redactor.redact(
      event({
        app_id: 'cli_abcdef',
        appId: 'app_abcdef',
        APP_ID: 'ABC_abcdef',
        ordinary: 'keep-me',
      }),
    );
    const data = result.data as Record<string, unknown>;
    expect(data.app_id).toBe('cli_***');
    expect(data.appId).toBe('app_***');
    expect(data.APP_ID).toBe('ABC_***');
    expect(data.ordinary).toBe('keep-me');
  });

  it('leaves non-string appId values unchanged', () => {
    const result = redactor.redact(event({ appId: 1234, APP_ID: null }));
    const data = result.data as Record<string, unknown>;
    expect(data.appId).toBe(1234);
    expect(data.APP_ID).toBeNull();
  });

  it('masks appId in nested objects and arrays', () => {
    const result = redactor.redact(
      event({
        nested: { appId: 'nested_secret' },
        list: [{ APP_ID: 'array_secret' }, { appId: 'second_secret' }],
      }),
    );
    const data = result.data as Record<string, unknown>;
    expect((data.nested as Record<string, unknown>).appId).toBe('nest***');
    const list = data.list as Array<Record<string, unknown>>;
    expect(list[0]?.APP_ID).toBe('arra***');
    expect(list[1]?.appId).toBe('seco***');
  });

  it('does not mutate the original event', () => {
    const original = event({ token: 'secret', nested: { password: 'x' } });
    const snapshot = JSON.stringify(original);
    redactor.redact(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('fails closed on cycles and excessive depth', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = redactor.redact(event({ cyclic }));
    expect(JSON.stringify(result)).toContain('[redacted]');
  });
});
