/**
 * 登录策略注册表 + 校验器 + 解析器的测试。
 *
 * 覆盖三类事实：
 * 1. **配置面对不对**：每种 kind 的正例/反例，报错必须说清「哪个 backend 的哪个字段」，
 *    并且列出**当前真实注册**的 kind（不是一份会过期的硬编码清单）；
 * 2. **`allow_user_ids` 的语义按策略走**：GitHub 只吃数值 id、Microsoft 吃 GUID
 *    （大小写不敏感）、Gitee 吃用户名或数值 id、password 不适用；
 * 3. **加 provider 的代价**：运行期注册一个 `acme_oauth` 后，校验器立刻接受它 ——
 *    证明校验逻辑查注册表，而不是查白名单。
 *
 * @module @vessel-agent/config/auth-strategies.test
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { AuthConfig, ConfigValidationError, ConfigValidationWarning } from '../types.js';
import { validateAuthSettings } from '../validator.js';
import {
  GITEE_STRATEGY,
  GITHUB_STRATEGY,
  isAllowlisted,
  MICROSOFT_STRATEGY,
  normalizeAllowUserIds,
  PASSWORD_STRATEGY,
  registerAuthStrategy,
  registeredAuthKinds,
  resetAuthStrategies,
} from './index.js';

const MICROSOFT_GUID = '8f3c1f4e-2b7a-4c1d-9a55-0f1e2d3c4b5a';
/** 个人 Microsoft 账号的 `/me` id：不是 GUID，是不透明的 16 进制串。 */
const MICROSOFT_PERSONAL_ID = '8364acbdb89d0ff1';

function validate(
  backends: unknown[],
  extra: Record<string, unknown> = {},
): {
  errors: ConfigValidationError[];
  warnings: ConfigValidationWarning[];
} {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationWarning[] = [];
  const auth = { backends, ...extra } as unknown as AuthConfig;
  validateAuthSettings(auth, errors, warnings);
  return { errors, warnings };
}

function paths(errors: ConfigValidationError[]): string[] {
  return errors.map((error) => error.path);
}

const OAUTH_BASE = {
  clientId: 'client-id-123',
  clientSecretEnv: 'VESSEL_TEST_SECRET',
};
const PUBLIC_ORIGIN = { publicOrigins: ['https://egg-rolls.top'] };

afterEach(() => {
  resetAuthStrategies();
});

describe('注册表', () => {
  test('内置四种 kind 都在，且顺序稳定', () => {
    expect(registeredAuthKinds()).toEqual([
      'github_oauth',
      'microsoft_oauth',
      'gitee_oauth',
      'password',
    ]);
  });

  test('口令策略：没有授权跳转，回调显式抛错（不装成能用）', () => {
    expect(PASSWORD_STRATEGY.authorizeUrl({} as never)).toBeNull();
    expect(() => PASSWORD_STRATEGY.handleCallback({} as never)).toThrow(/no OAuth callback/);
    expect(PASSWORD_STRATEGY.identityOf({})).toBeNull();
  });
});

describe('校验器：每种 kind 的正例 / 反例', () => {
  test('github：数值 id 通过（数字与十进制字符串都行）', () => {
    const { errors } = validate(
      [{ kind: 'github_oauth', ...OAUTH_BASE, allowUserIds: [174765587, '174765588'] }],
      PUBLIC_ORIGIN,
    );
    expect(errors).toEqual([]);
  });

  test('github：字符串 login 被拒（exactly 今天用户遇到的那条）', () => {
    const { errors } = validate(
      [{ kind: 'github_oauth', ...OAUTH_BASE, allowUserIds: ['octocat'] }],
      PUBLIC_ORIGIN,
    );
    expect(paths(errors)).toEqual(['auth.backends[0].allowUserIds[0]']);
    const message = errors[0]?.message ?? '';
    // 说清哪个 backend、哪个字段、期望什么形状、错在哪。
    expect(message).toContain('auth.backends[0].allowUserIds[0]');
    expect(message).toContain('kind: github_oauth');
    expect(message).toContain('all digits');
    expect(message).toContain('numeric GitHub user id');
    expect(message).toContain('174765587');
  });

  test('github：0 / 负数 / 非数字字符串都拒', () => {
    const { errors } = validate(
      [{ kind: 'github_oauth', ...OAUTH_BASE, allowUserIds: [0, -5, '12a'] }],
      PUBLIC_ORIGIN,
    );
    expect(paths(errors)).toEqual([
      'auth.backends[0].allowUserIds[0]',
      'auth.backends[0].allowUserIds[1]',
      'auth.backends[0].allowUserIds[2]',
    ]);
  });

  test('microsoft：GUID 通过，大小写都行，个人账号的 16 进制 id 也通过', () => {
    const { errors } = validate(
      [
        {
          kind: 'microsoft_oauth',
          ...OAUTH_BASE,
          allowUserIds: [MICROSOFT_GUID, MICROSOFT_GUID.toUpperCase(), MICROSOFT_PERSONAL_ID],
        },
      ],
      PUBLIC_ORIGIN,
    );
    expect(errors).toEqual([]);
  });

  test('microsoft：数字被拒（Graph 的 id 是字符串），文案点名 Graph', () => {
    const { errors } = validate(
      [{ kind: 'microsoft_oauth', ...OAUTH_BASE, allowUserIds: [12345] }],
      PUBLIC_ORIGIN,
    );
    expect(paths(errors)).toEqual(['auth.backends[0].allowUserIds[0]']);
    const message = errors[0]?.message ?? '';
    expect(message).toContain('must be a string');
    expect(message).toContain('Microsoft Graph object id');
    expect(message).toContain('case-insensitively');
  });

  test('gitee：用户名与数值 id 都通过，邮箱形态被拒', () => {
    const ok = validate(
      [{ kind: 'gitee_oauth', ...OAUTH_BASE, allowUserIds: ['octocat', 1234567, '7654321'] }],
      PUBLIC_ORIGIN,
    );
    expect(ok.errors).toEqual([]);
    const bad = validate(
      [{ kind: 'gitee_oauth', ...OAUTH_BASE, allowUserIds: ['a@b.com'] }],
      PUBLIC_ORIGIN,
    );
    expect(paths(bad.errors)).toEqual(['auth.backends[0].allowUserIds[0]']);
    expect(bad.errors[0]?.message ?? '').toContain('Gitee numeric user id OR Gitee login name');
  });

  test('password：配了 allowUserIds 就是错误（语义不适用）', () => {
    const { errors } = validate([{ kind: 'password', allowUserIds: [174765587] }]);
    expect(paths(errors)).toEqual(['auth.backends[0].allowUserIds']);
    const message = errors[0]?.message ?? '';
    expect(message).toContain('kind: password');
    expect(message).toContain('not applicable');
    expect(message).toContain('auth.backends[0].username');
  });

  test('password：正常配置零错误', () => {
    const { errors } = validate([{ kind: 'password', username: 'admin' }]);
    expect(errors).toEqual([]);
  });

  test('未知 kind：报错列出**已注册**的 kind，且不再连带报 clientId 的错', () => {
    const { errors } = validate([{ kind: 'microsooft_oauth' }], PUBLIC_ORIGIN);
    expect(paths(errors)).toEqual(['auth.backends[0].kind']);
    const message = errors[0]?.message ?? '';
    expect(message).toContain('"microsooft_oauth"');
    for (const kind of registeredAuthKinds()) expect(message).toContain(kind);
    expect(message).toContain('registry.ts');
  });

  test('缺省 kind = github_oauth（0.56 写法的兼容）', () => {
    const { errors } = validate([{ ...OAUTH_BASE, allowUserIds: [174765587] }], PUBLIC_ORIGIN);
    expect(errors).toEqual([]);
  });

  test('OAuth 后端缺 publicOrigins：单独报一条，文案点名 OAuth', () => {
    const { errors } = validate([
      { kind: 'microsoft_oauth', ...OAUTH_BASE, allowUserIds: [MICROSOFT_GUID] },
    ]);
    expect(paths(errors)).toEqual(['auth.publicOrigins']);
    expect(errors[0]?.message ?? '').toContain('when an OAuth backend is configured');
  });

  test('口令后端不需要 publicOrigins', () => {
    const { errors } = validate([{ kind: 'password' }]);
    expect(errors).toEqual([]);
  });
});

describe('加一个 provider = 加一个策略文件 + 注册一行', () => {
  const ACME = {
    ...GITHUB_STRATEGY,
    id: 'acme',
    kind: 'acme_oauth',
    label: 'Sign in with Acme',
  };

  test('运行期注册 acme_oauth 后，校验器立刻接受它（没有改 validator）', () => {
    const before = validate([{ kind: 'acme_oauth' }], PUBLIC_ORIGIN);
    expect(paths(before.errors)).toEqual(['auth.backends[0].kind']);

    registerAuthStrategy(ACME);

    const after = validate(
      [
        {
          kind: 'acme_oauth',
          ...OAUTH_BASE,
          allowUserIds: [174765587],
          label: 'Acme 单点登录',
        },
      ],
      PUBLIC_ORIGIN,
    );
    expect(after.errors).toEqual([]);

    const unknown = validate([{ kind: 'nope_oauth' }], PUBLIC_ORIGIN);
    expect(unknown.errors[0]?.message ?? '').toContain('acme_oauth');
  });

  test('重复注册同一个 kind 抛错（避免两个策略抢一个 kind）', () => {
    registerAuthStrategy(ACME);
    expect(() => registerAuthStrategy({ ...ACME, id: 'acme2' })).toThrow(/already registered/);
  });
});

describe('allow_user_ids 的匹配语义', () => {
  test('microsoft：大小写不敏感', () => {
    const ids = normalizeAllowUserIds(MICROSOFT_STRATEGY, [MICROSOFT_GUID.toUpperCase()]).ids;
    expect(ids).toEqual([MICROSOFT_GUID.toLowerCase()]);
    expect(
      isAllowlisted(MICROSOFT_STRATEGY, ids, {
        userId: MICROSOFT_GUID,
        username: 'someone@example.com',
      }),
    ).toBe(true);
  });

  test('github：只按数值 id 精确匹配，展示名不参与', () => {
    const ids = normalizeAllowUserIds(GITHUB_STRATEGY, [174765587]).ids;
    expect(ids).toEqual(['174765587']);
    expect(isAllowlisted(GITHUB_STRATEGY, ids, { userId: '174765587', username: 'octocat' })).toBe(
      true,
    );
    expect(isAllowlisted(GITHUB_STRATEGY, ids, { userId: '999', username: '174765587' })).toBe(
      false,
    );
  });

  test('gitee：用户名白名单能命中 login 别名', () => {
    const ids = normalizeAllowUserIds(GITEE_STRATEGY, ['OctoCat']).ids;
    expect(ids).toEqual(['octocat']);
    expect(
      isAllowlisted(GITEE_STRATEGY, ids, {
        userId: '1234567',
        username: 'OctoCat',
        aliases: ['OctoCat'],
      }),
    ).toBe(true);
  });

  test('写错的条目被记下来（解析器据此告警，而不是静默丢掉）', () => {
    const { ids, rejected } = normalizeAllowUserIds(MICROSOFT_STRATEGY, [12345, MICROSOFT_GUID]);
    expect(ids).toEqual([MICROSOFT_GUID.toLowerCase()]);
    expect(rejected).toEqual([12345]);
  });
});

describe('身份归一（identityOf）', () => {
  test('github：数值 id 才是身份', () => {
    expect(GITHUB_STRATEGY.identityOf({ id: 174765587, login: 'octocat' })).toEqual({
      userId: '174765587',
      username: 'octocat',
    });
    expect(GITHUB_STRATEGY.identityOf({ id: '174765587', login: 'octocat' })).toBeNull();
    expect(GITHUB_STRATEGY.identityOf({ id: 0 })).toBeNull();
  });

  test('microsoft：GUID 与个人账号的 16 进制 id 都认，展示名按 displayName 降级', () => {
    expect(MICROSOFT_STRATEGY.identityOf({ id: MICROSOFT_GUID })).toEqual({
      userId: MICROSOFT_GUID,
      username: `microsoft-${MICROSOFT_GUID}`,
    });
    expect(
      MICROSOFT_STRATEGY.identityOf({ id: MICROSOFT_PERSONAL_ID, displayName: '用的名字' }),
    ).toEqual({ userId: MICROSOFT_PERSONAL_ID, username: '用的名字' });
    expect(MICROSOFT_STRATEGY.identityOf({ id: '' })).toBeNull();
  });

  test('gitee：数值 id 是主身份，login 进 aliases', () => {
    expect(GITEE_STRATEGY.identityOf({ id: 42, login: 'OctoCat', name: '名字' })).toEqual({
      userId: '42',
      username: 'OctoCat',
      aliases: ['OctoCat'],
    });
  });
});

describe('authorizeUrl：每个 provider 的固定参数', () => {
  const params = {
    clientId: 'cid',
    redirectUri: 'https://egg-rolls.top/auth/x/callback',
    state: 'st',
    codeChallenge: 'cc',
  };

  test('github：无 scope，带 allow_signup=false', () => {
    const url = new URL(GITHUB_STRATEGY.authorizeUrl(params) ?? '');
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('allow_signup')).toBe('false');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  test('microsoft：必须带 response_type=code 与 User.Read scope', () => {
    const url = new URL(MICROSOFT_STRATEGY.authorizeUrl(params) ?? '');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('scope')).toContain('User.Read');
  });

  test('gitee：带 response_type=code 与 user_info scope', () => {
    const url = new URL(GITEE_STRATEGY.authorizeUrl(params) ?? '');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('user_info');
  });

  test('端点可覆盖（验收桩 / 私有部署）', () => {
    const url = new URL(
      MICROSOFT_STRATEGY.authorizeUrl({
        ...params,
        endpoints: { authorize: 'http://127.0.0.1:9999/a', token: 't', user: 'u' },
      }) ?? '',
    );
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:9999/a');
  });
});

describe('handleCallback：两条腿（stub fetch，无真实端点）', () => {
  const base = {
    redirectUri: 'https://egg-rolls.top/auth/microsoft/callback',
    codeVerifier: 'verifier',
    clientId: 'cid',
    clientSecret: 'shhh',
  };

  function stubFetch(input: { token?: unknown; user?: unknown; userStatus?: number }): {
    fetchImpl: typeof fetch;
    calls: string[];
  } {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      calls.push(href);
      if (href.includes('access_token') || href.includes('/token')) {
        return new Response(JSON.stringify(input.token ?? { access_token: 'at-123' }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(input.user ?? {}), { status: input.userStatus ?? 200 });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  test('成功：code → token → /me → 身份（Microsoft）', async () => {
    const { fetchImpl } = stubFetch({ user: { id: MICROSOFT_GUID, displayName: '张三' } });
    const result = await MICROSOFT_STRATEGY.handleCallback({
      ...base,
      code: 'the-code',
      fetchImpl,
    });
    expect(result).toEqual({
      ok: true,
      identity: { userId: MICROSOFT_GUID, username: '张三' },
    });
  });

  test('缺 code：code_missing，且不发请求', async () => {
    const { fetchImpl, calls } = stubFetch({});
    const result = await MICROSOFT_STRATEGY.handleCallback({ ...base, code: null, fetchImpl });
    expect(result).toEqual({ ok: false, failure: 'code_missing' });
    expect(calls).toEqual([]);
  });

  test('token 端点返回错误：token_exchange_failed', async () => {
    const { fetchImpl } = stubFetch({ token: { error: 'invalid_grant' } });
    const result = await GITHUB_STRATEGY.handleCallback({ ...base, code: 'c', fetchImpl });
    expect(result).toEqual({ ok: false, failure: 'token_exchange_failed' });
  });

  test('用户端点 401：user_fetch_failed', async () => {
    const { fetchImpl } = stubFetch({ userStatus: 401 });
    const result = await GITHUB_STRATEGY.handleCallback({ ...base, code: 'c', fetchImpl });
    expect(result).toEqual({ ok: false, failure: 'user_fetch_failed' });
  });

  test('日志里不出现 token / secret', async () => {
    const lines: string[] = [];
    const { fetchImpl } = stubFetch({ user: { id: MICROSOFT_GUID } });
    await GITHUB_STRATEGY.handleCallback({
      ...base,
      code: 'c',
      fetchImpl,
      log: (line) => lines.push(line),
    });
    const joined = lines.join('\n');
    expect(joined).not.toContain('at-123');
    expect(joined).not.toContain('shhh');
  });
});
