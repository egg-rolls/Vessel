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

  it('redacts sk- prefixed strings', () => {
    const result = redactor.redact(event({ value: 'sk-abcdef123456', text: 'healthy' }));
    const data = result.data as Record<string, unknown>;
    expect(data.value).toBe('***');
    expect(data.text).toBe('healthy');
  });

  it('masks app_id keeping the first four characters', () => {
    const result = redactor.redact(event({ app_id: 'cli_abcdef' }));
    expect((result.data as Record<string, unknown>).app_id).toBe('cli_***');
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
