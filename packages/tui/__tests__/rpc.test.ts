import { describe, expect, it } from 'bun:test';
import {
  formatRpcError,
  isRpcError,
  isRpcErrorCode,
  readRpcCode,
  redactForDisplay,
} from '../src/rpc.js';

describe('RPC 错误识别', () => {
  it('识别冻结错误码', () => {
    expect(isRpcErrorCode('tenant_locked')).toBe(true);
    expect(isRpcErrorCode('nope')).toBe(false);
    expect(isRpcErrorCode(undefined)).toBe(false);
  });

  it('isRpcError / readRpcCode 读取 code', () => {
    const error = { code: 'quota_exceeded', message: 'too many runs', details: { secret: 'x' } };
    expect(isRpcError(error)).toBe(true);
    expect(readRpcCode(error)).toBe('quota_exceeded');
    expect(readRpcCode(new Error('plain'))).toBeUndefined();
  });

  it('formatRpcError 只输出 code + message，不输出 details', () => {
    const formatted = formatRpcError({
      code: 'tenant_locked',
      message: 'tenant default is locked',
      details: { token: 'secret-token' },
    });
    expect(formatted).toBe('✗ [tenant_locked] tenant default is locked');
    expect(formatted).not.toContain('secret-token');
  });

  it('非 RPC 错误沿用分类器', () => {
    expect(formatRpcError(new Error('fetch failed: ENOTFOUND'))).toContain('[network]');
  });
});

describe('redactForDisplay', () => {
  it('脱敏敏感键与 app_id', () => {
    const input = {
      provider: { name: 'openai', api_key: 'sk-abc123', model: 'gpt' },
      serve: { token: 'abc' },
      feishu: { app_id: 'cli_123456', app_secret: 'zzz' },
      trace: { level: 'full' },
    };

    const redacted = redactForDisplay(input) as Record<string, Record<string, string>>;
    expect(redacted.provider?.api_key).toBe('***');
    expect(redacted.provider?.model).toBe('gpt');
    expect(redacted.serve?.token).toBe('***');
    expect(redacted.feishu?.app_id).toBe('cli_***');
    expect(redacted.feishu?.app_secret).toBe('***');
    expect(redacted.trace?.level).toBe('full');
  });

  it('字符串中的 sk- 与 Bearer 被打码', () => {
    const redacted = redactForDisplay({
      note: 'use sk-live-abc123 with Bearer abc.def',
    }) as { note: string };
    expect(redacted.note).toBe('use sk-*** with Bearer ***');
  });

  it('数组与嵌套对象保持形状', () => {
    const redacted = redactForDisplay({
      items: [{ token: 't1' }, { value: 2 }],
    }) as { items: Array<Record<string, unknown>> };
    expect(redacted.items[0]?.token).toBe('***');
    expect(redacted.items[1]?.value).toBe(2);
  });

  it('不修改入参', () => {
    const input = { api_key: 'sk-abc123' };
    redactForDisplay(input);
    expect(input.api_key).toBe('sk-abc123');
  });

  it('保留 null 与原始类型', () => {
    expect(redactForDisplay(null)).toBeNull();
    expect(redactForDisplay(42)).toBe(42);
    expect(redactForDisplay(true)).toBe(true);
  });

  it('camelCase 敏感键全部命中', () => {
    const redacted = redactForDisplay({
      appSecret: 'app-secret',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      authToken: 'auth-token',
      clientSecret: 'client-secret',
      authorization: 'Bearer abc',
      appId: 'cli_123456',
      appid: 'cli_654321',
    }) as Record<string, unknown>;

    for (const key of [
      'appSecret',
      'accessToken',
      'refreshToken',
      'authToken',
      'clientSecret',
      'authorization',
    ]) {
      expect(redacted[key]).toBe('***');
    }
    expect(redacted.appId).toBe('cli_***');
    expect(redacted.appid).toBe('cli_***');
  });

  it('usage 的 tokens 字段不被误伤', () => {
    const redacted = redactForDisplay({
      total_tokens: 10,
      prompt_tokens: 3,
      completion_tokens: 7,
      max_tokens: 99,
      tokenizer: 'cl100k',
    }) as Record<string, unknown>;

    expect(redacted.total_tokens).toBe(10);
    expect(redacted.prompt_tokens).toBe(3);
    expect(redacted.completion_tokens).toBe(7);
    expect(redacted.max_tokens).toBe(99);
    expect(redacted.tokenizer).toBe('cl100k');
  });
});
