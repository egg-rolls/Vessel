/**
 * `auth.public_origin(s)` 的来源解析测试。
 *
 * 两条硬约束：
 * 1. **端口通配在这里一律拒绝**（`auth.public_origins` 是 redirect_uri 的唯一来源，
 *    必须具体；通配只对 `http.allowed_origins` 有意义）；
 * 2. 被拒的条目**不许静默**：`resolveAuthSettings` 必须给出「哪个字段、写的是什么、
 *    为什么不行」的告警 —— 静默丢弃过一次的后果是「白名单为空 ⇒ 谁都登录不了」。
 *
 * @module @vessel-agent/config/auth-origins.test
 */

import { describe, expect, test } from 'bun:test';
import { resolveAuthSettings } from './auth.js';
import { authOriginRejectReason, parseAuthOrigin } from './auth-origins.js';
import type { AuthConfig } from './types.js';

describe('parseAuthOrigin：合法条目归一', () => {
  test('常见写法都归一成 scheme://host[:port]', () => {
    const cases: Array<[string, string]> = [
      ['https://egg-rolls.top', 'https://egg-rolls.top'],
      ['  https://egg-rolls.top/  ', 'https://egg-rolls.top'],
      ['https://egg-rolls.top:443', 'https://egg-rolls.top'],
      ['https://EGG-ROLLS.top', 'https://egg-rolls.top'],
      ['http://127.0.0.1:8642', 'http://127.0.0.1:8642'],
      ['http://localhost:8642/', 'http://localhost:8642'],
    ];
    for (const [raw, want] of cases) expect(parseAuthOrigin(raw)).toBe(want);
  });
});

describe('parseAuthOrigin：拒绝的写法都有明确原因', () => {
  const rejected: Array<[unknown, RegExp]> = [
    ['', /must not be empty/],
    [42, /must be a string/],
    ['egg-rolls.top', /absolute origin/],
    ['ftp://egg-rolls.top', /only http\(s\)/],
    ['https://user:pw@egg-rolls.top', /credentials are not allowed/],
    ['https://egg-rolls.top/panel', /bare origin/],
    ['https://egg-rolls.top?x=1', /bare origin/],
    ['https://egg-rolls.top#frag', /bare origin/],
    // 0.61：端口通配**不属于**这里（它只对访问控制有意义）。
    ['http://127.0.0.1:*', /port wildcard .* is not allowed here/],
    ['http://localhost:*', /port wildcard .* is not allowed here/],
    ['https://egg-rolls.top:*', /port wildcard .* is not allowed here/],
  ];

  for (const [raw, pattern] of rejected) {
    test(`${JSON.stringify(raw)} → ${String(pattern)}`, () => {
      const reason = authOriginRejectReason(raw);
      expect(reason).not.toBeNull();
      expect(reason ?? '').toMatch(pattern);
      expect(parseAuthOrigin(raw)).toBeNull();
    });
  }

  test('合法条目没有原因', () => {
    expect(authOriginRejectReason('https://egg-rolls.top')).toBeNull();
    expect(authOriginRejectReason('http://127.0.0.1:8642')).toBeNull();
  });
});

describe('resolveAuthSettings：不静默', () => {
  function resolve(auth: Record<string, unknown>): {
    publicOrigins: string[];
    warnings: string[];
  } {
    const resolved = resolveAuthSettings({ auth: auth as unknown as AuthConfig });
    return { publicOrigins: resolved.publicOrigins, warnings: resolved.warnings };
  }

  test('通配条目被拒 + 有告警，合法条目照旧保留', () => {
    const { publicOrigins, warnings } = resolve({
      publicOrigins: ['https://egg-rolls.top', 'http://127.0.0.1:*', 'http://127.0.0.1:8642'],
    });
    expect(publicOrigins).toEqual(['https://egg-rolls.top', 'http://127.0.0.1:8642']);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('auth.publicOrigins[1]');
    expect(warnings[0]).toContain('http://127.0.0.1:*');
    expect(warnings[0]).toContain('port wildcard');
  });

  test('public_origin 写错也有告警（不是静默变成 null）', () => {
    const { publicOrigins, warnings } = resolve({ publicOrigin: 'https://a.top/x' });
    expect(publicOrigins).toEqual([]);
    expect(warnings.some((line) => line.includes('auth.publicOrigin'))).toBe(true);
    expect(warnings.some((line) => line.includes('bare origin'))).toBe(true);
  });

  test('两根来源合并去重，顺序稳定', () => {
    const { publicOrigins } = resolve({
      publicOrigin: 'https://egg-rolls.top',
      publicOrigins: ['https://egg-rolls.top/', 'http://127.0.0.1:8642'],
    });
    expect(publicOrigins).toEqual(['https://egg-rolls.top', 'http://127.0.0.1:8642']);
  });
});
