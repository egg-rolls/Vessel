/**
 * 汇总接口适配层的单测：**降级判定**是这一单最容易被改坏的地方
 * （接口上线前后、老 gateway、坏载荷三种输入都要落在「不报错、界面照常」上）。
 *
 * 用 `bun test apps/web/src/domains/auth` 跑（web 目前没有 vitest，见交付说明）。
 */

import { describe, expect, test } from 'bun:test';
import {
  AUTH_SUMMARY_METHOD,
  type AuthSummary,
  fallbackStrategy,
  fetchAuthSummary,
  isMissingSummaryError,
  joinLoginStrategies,
  parseAuthSummary,
} from './auth-summary';

const CONTRACT_SAMPLE = {
  identity: { name: 'Ada Lovelace', id: 'u_1', role: 'owner' },
  node: { id: 'n_1', name: 'studio', state: 'up' },
  team: { id: 't_1', name: 'Vessel' },
  backends: [
    { id: 'password', label: 'Sign in with a password', kind: 'password' },
    { id: 'github', label: 'Sign in with GitHub', kind: 'github_oauth' },
  ],
  auth_mode: 'cookie',
} as const;

/** 按 `GatewayHttpError` / WS 错误的两种形状造错误（不 import gateway：本模块要能独立跑）。 */
function httpError(code: string, status?: number): Error {
  return Object.assign(new Error(`${code}: boom`), { name: 'GatewayHttpError', code, status });
}

describe('parseAuthSummary', () => {
  test('完整契约 → 原样落成前端形状', () => {
    const summary = parseAuthSummary(CONTRACT_SAMPLE);
    expect(summary).not.toBeNull();
    expect(summary?.identity).toEqual({
      id: 'u_1',
      name: 'Ada Lovelace',
      role: 'owner',
      avatarUrl: null,
    });
    expect(summary?.node).toEqual({ id: 'n_1', name: 'studio', state: 'up' });
    expect(summary?.team).toEqual({ id: 't_1', name: 'Vessel' });
    expect(summary?.backends).toHaveLength(2);
    expect(summary?.authMode).toBe('cookie');
  });

  test('没有 identity / 没有 id ⇒ null（半张身份卡比没有更容易误导）', () => {
    expect(parseAuthSummary({})).toBeNull();
    expect(parseAuthSummary({ identity: { name: 'no id' } })).toBeNull();
    expect(parseAuthSummary(null)).toBeNull();
    expect(parseAuthSummary('payload')).toBeNull();
    expect(parseAuthSummary([])).toBeNull();
  });

  test('可选块缺失不致命：node / team / backends / auth_mode 都可以没有', () => {
    const summary = parseAuthSummary({ identity: { id: 'u_1', name: 'Solo' } });
    expect(summary).not.toBeNull();
    expect(summary?.node).toBeNull();
    expect(summary?.team).toBeNull();
    expect(summary?.backends).toEqual([]);
    expect(summary?.authMode).toBeNull();
  });

  test('节点状态归一：未知值落到 unknown，别名认成 up / down', () => {
    const state = (raw: string) =>
      parseAuthSummary({ identity: { id: 'u' }, node: { id: 'n', state: raw } })?.node?.state;
    expect(state('online')).toBe('up');
    expect(state('offline')).toBe('down');
    expect(state('weird')).toBe('unknown');
  });

  test('backend 列表去重、缺 kind 落 unknown（顺序保持服务端给的顺序）', () => {
    const summary = parseAuthSummary({
      identity: { id: 'u' },
      backends: [
        { id: 'github', label: 'GitHub' },
        { id: 'github', label: 'duplicate' },
        { id: 'totp', kind: 'TOTP', label: 'TOTP' },
        { label: 'no id' },
      ],
    });
    expect(summary?.backends.map((backend) => backend.id)).toEqual(['github', 'totp']);
    expect(summary?.backends[0]?.kind).toBe('unknown');
    expect(summary?.backends[1]?.kind).toBe('totp');
  });

  test('auth_mode 只认三个合法值', () => {
    const mode = (raw: unknown) =>
      parseAuthSummary({ identity: { id: 'u' }, auth_mode: raw })?.authMode;
    expect(mode('bearer')).toBe('bearer');
    expect(mode('none')).toBe('none');
    expect(mode('token')).toBeNull();
  });
});

describe('isMissingSummaryError', () => {
  test('404 / 405 / 方法未注册 ⇒ 预期内的「还没上线」', () => {
    expect(isMissingSummaryError(httpError('not_found', 404))).toBe(true);
    expect(isMissingSummaryError(httpError('method_not_allowed', 405))).toBe(true);
    expect(isMissingSummaryError(httpError('method_not_found'))).toBe(true);
    expect(isMissingSummaryError(new Error('not_found: auth.whoami'))).toBe(true);
  });

  test('500 / 网络 / 普通错误不算「没上线」（调用方仍然降级，但原因不同）', () => {
    expect(isMissingSummaryError(httpError('internal', 500))).toBe(false);
    expect(isMissingSummaryError(new Error('Failed to fetch'))).toBe(false);
    expect(isMissingSummaryError(undefined)).toBe(false);
  });
});

describe('fetchAuthSummary', () => {
  test('成功：一次调用，方法名来自常量', async () => {
    const calls: string[] = [];
    const result = await fetchAuthSummary(async (method) => {
      calls.push(method);
      return CONTRACT_SAMPLE;
    });
    expect(calls).toEqual([AUTH_SUMMARY_METHOD]);
    expect(result.kind).toBe('ok');
  });

  test('404 ⇒ degraded/missing，不抛错、不重试', async () => {
    let calls = 0;
    const result = await fetchAuthSummary(async () => {
      calls += 1;
      throw httpError('not_found', 404);
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ kind: 'degraded', failure: 'missing' });
  });

  test('连不上 ⇒ degraded/unreachable', async () => {
    const result = await fetchAuthSummary(async () => {
      throw new Error('Failed to fetch');
    });
    expect(result).toEqual({ kind: 'degraded', failure: 'unreachable' });
  });

  test('载荷不成形 ⇒ degraded/invalid', async () => {
    const result = await fetchAuthSummary(async () => ({ ok: true }));
    expect(result).toEqual({ kind: 'degraded', failure: 'invalid' });
  });
});

describe('joinLoginStrategies', () => {
  const summary = parseAuthSummary(CONTRACT_SAMPLE) as AuthSummary;

  test('按 id 对齐起步地址；口令策略没有 302 起步地址', () => {
    const strategies = joinLoginStrategies(summary.backends, [
      { id: 'password', kind: 'password', label: 'p', startPath: '/login' },
      { id: 'github', kind: 'github_oauth', label: 'g', startPath: '/auth/github/start' },
    ]);
    expect(strategies).toEqual([
      { id: 'password', label: 'Sign in with a password', kind: 'password', startPath: null },
      {
        id: 'github',
        label: 'Sign in with GitHub',
        kind: 'github_oauth',
        startPath: '/auth/github/start',
      },
    ]);
  });

  test('id 对不上时按 kind 兜底；都对不上 ⇒ startPath = null', () => {
    const strategies = joinLoginStrategies(
      [
        { id: 'gh-2', label: 'GitHub', kind: 'github_oauth' },
        { id: 'mystery', label: 'Mystery', kind: 'saml' },
      ],
      [{ id: 'github', kind: 'github_oauth', label: 'g', startPath: '/auth/github/start' }],
    );
    expect(strategies[0]?.startPath).toBe('/auth/github/start');
    expect(strategies[1]?.startPath).toBeNull();
  });

  test('策略列表为空 ⇒ 空数组（面板据此显示「没有启用登录方式」）', () => {
    expect(joinLoginStrategies([], [])).toEqual([]);
  });
});

describe('fallbackStrategy', () => {
  test('没有起步地址 ⇒ null（不造死按钮）', () => {
    expect(fallbackStrategy('GitHub', '')).toBeNull();
    expect(fallbackStrategy('GitHub', '   ')).toBeNull();
    expect(fallbackStrategy('GitHub', null)).toBeNull();
  });

  test('登录页自身当起步地址时归一成 null（已登录时跳过去只会看到同一个应用）', () => {
    expect(fallbackStrategy('Password', '/login')?.startPath).toBeNull();
    expect(fallbackStrategy('GitHub', '/auth/github/start')?.startPath).toBe('/auth/github/start');
  });
});
