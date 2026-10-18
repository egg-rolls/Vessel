import { describe, expect, it } from 'bun:test';
import { maskAppId, maskSecrets, resolveFeishuConfig, sanitizeAgentId } from '../src/config.js';
import { FeishuError } from '../src/errors.js';

describe('resolveFeishuConfig', () => {
  it('applies defaults and environment overrides', () => {
    const config = resolveFeishuConfig(
      { enabled: true, appId: 'file_id', appSecret: 'file_secret' },
      { VESSEL_FEISHU_APP_ID: 'env_id', VESSEL_FEISHU_APP_SECRET: 'env_secret' },
    );
    expect(config.appId).toBe('env_id');
    expect(config.appSecret).toBe('env_secret');
    expect(config.domain).toBe('feishu');
    expect(config.sessionPrefix).toBe('feishu');
    expect(config.replyTimeoutMs).toBe(300_000);
    expect(config.maxReplyChars).toBe(4000);
    expect(config.maxMembers).toBe(8);
    expect(config.allowedChatIds).toEqual([]);
  });

  it('ignores empty environment values', () => {
    const config = resolveFeishuConfig(
      { appId: 'file_id', appSecret: 'file_secret' },
      { VESSEL_FEISHU_APP_ID: '', VESSEL_FEISHU_APP_SECRET: '' },
    );
    expect(config.appId).toBe('file_id');
    expect(config.appSecret).toBe('file_secret');
  });

  it('rejects invalid ranges and values', () => {
    expect(() => resolveFeishuConfig({ domain: 'nope' as never })).toThrow(FeishuError);
    expect(() => resolveFeishuConfig({ sessionPrefix: 'a:b' })).toThrow(FeishuError);
    expect(() => resolveFeishuConfig({ sessionPrefix: 'a/b' })).toThrow(FeishuError);
    expect(() => resolveFeishuConfig({ maxMembers: 0 })).toThrow(FeishuError);
    expect(() => resolveFeishuConfig({ maxMembers: 65 })).toThrow(FeishuError);
    expect(() => resolveFeishuConfig({ replyTimeoutMs: 0 })).toThrow(FeishuError);
    expect(() => resolveFeishuConfig({ maxReplyChars: 0 })).toThrow(FeishuError);
  });

  it('marks config errors with the config phase', () => {
    try {
      resolveFeishuConfig({ domain: 'nope' as never });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(FeishuError);
      expect((error as FeishuError).phase).toBe('config');
      expect((error as FeishuError).code).toBe('channel_auth_failed');
    }
  });
});

describe('masking and agent ids', () => {
  it('masks app ids', () => {
    expect(maskAppId('cli_abcd1234')).toBe('cli_***');
    expect(maskAppId('abc')).toBe('***');
    expect(maskAppId('')).toBe('***');
  });

  it('masks secrets in arbitrary text', () => {
    const text = 'app cli_abcd1234 secret super-secret';
    const masked = maskSecrets(text, 'cli_abcd1234', 'super-secret');
    expect(masked).not.toContain('cli_abcd1234');
    expect(masked).not.toContain('super-secret');
    expect(masked).toContain('cli_***');
  });

  it('sanitizes agent ids and truncates over 64 characters', () => {
    expect(sanitizeAgentId('oc_abc')).toBe('feishu_oc_abc');
    expect(sanitizeAgentId('oc:abc/def')).toBe('feishu_ocabcdef');

    const long = 'x'.repeat(100);
    const id = sanitizeAgentId(long);
    expect(id.length).toBe(64);
    expect(id.startsWith('feishu_')).toBe(true);
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(id)).toBe(true);

    expect(sanitizeAgentId('!!!')).toMatch(/^feishu_[0-9a-f]{8}$/);
  });
});
